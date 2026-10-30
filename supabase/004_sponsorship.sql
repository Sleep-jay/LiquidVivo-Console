-- Manual receipt review. Run once after migrations 001–003.
begin;
create table public.lv_sponsor_orders (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null,
  user_id uuid not null references auth.users(id),
  device_id uuid not null references public.lv_devices(id),
  provider text not null check(provider in ('wechat','alipay')),
  transaction_ref text not null check(transaction_ref ~ '^[A-Za-z0-9_-]{8,128}$'),
  declared_cents integer not null check(declared_cents between 1500 and 1000000),
  received_cents integer check(received_cents between 1500 and 1000000),
  currency text not null default 'CNY' check(currency='CNY'),
  product text not null default 'sponsor_permanent_v1' check(product='sponsor_permanent_v1'),
  features text[] not null default array['notification_island','status_bar']::text[]
    check(features=array['notification_island','status_bar']::text[]),
  entitlement_id uuid references public.lv_entitlements(id),
  status text not null default 'pending' check(status in ('pending','approved','rejected')),
  response text not null default '' check(length(response)<=1000),
  created_at timestamptz not null default now(),
  reviewed_at timestamptz, reviewed_by uuid references auth.users(id),
  unique(user_id,request_id),
  check((status='pending' and entitlement_id is null and reviewed_at is null and reviewed_by is null and received_cents is null)
    or (status='approved' and entitlement_id is not null and received_cents is not null and reviewed_at is not null and reviewed_by is not null)
    or (status='rejected' and entitlement_id is null and received_cents is null and reviewed_at is not null and reviewed_by is not null))
);
create unique index lv_order_receipt_once on public.lv_sponsor_orders(provider,lower(transaction_ref)) where status<>'rejected';
create index on public.lv_sponsor_orders(user_id,created_at desc);
alter table public.lv_entitlements add column source_order_id uuid unique references public.lv_sponsor_orders(id);

create table public.lv_feedback (
  id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
  title text not null check(length(title) between 1 and 120),
  body text not null check(length(body) between 1 and 4000),
  reply text not null default '' check(length(reply)<=4000),
  status text not null default 'open' check(status in ('open','replied','closed')),
  created_at timestamptz not null default now(), replied_at timestamptz, replied_by uuid references auth.users(id)
);
create index on public.lv_feedback(user_id,created_at desc);
alter table public.lv_sponsor_orders enable row level security;
alter table public.lv_feedback enable row level security;
revoke all on public.lv_sponsor_orders,public.lv_feedback from public,anon,authenticated;
grant select on public.lv_sponsor_orders,public.lv_feedback to authenticated;
create policy sponsor_order_read on public.lv_sponsor_orders for select to authenticated
  using(user_id=auth.uid() or public.lv_admin_session_ready());
create policy feedback_read on public.lv_feedback for select to authenticated
  using(user_id=auth.uid() or public.lv_admin_session_ready());

create function public.lv_submit_sponsorship(p_request_id uuid,p_device_id uuid,p_provider text,p_ref text,p_cents integer)
returns uuid language plpgsql security definer set search_path='' as $$
declare did uuid; existing public.lv_sponsor_orders; oid uuid;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  if p_request_id is null then raise exception '请求编号无效'; end if;
  -- Lock the binding so a concurrent admin unbind cannot change the recipient mid-request.
  select id into did from public.lv_devices where id=p_device_id and owner_id=auth.uid() and not blocked for update;
  if did is null then raise exception '请先绑定可用设备'; end if;
  select * into existing from public.lv_sponsor_orders where user_id=auth.uid() and request_id=p_request_id;
  if found then
    if existing.device_id<>did or existing.provider<>p_provider or existing.transaction_ref<>p_ref or existing.declared_cents<>p_cents then
      raise exception '重复请求的内容不一致'; end if;
    return existing.id;
  end if;
  if (select count(*) from public.lv_sponsor_orders where user_id=auth.uid() and created_at>now()-interval '1 day')>=10 then
    raise exception '今日提交次数已达上限，请等待审核'; end if;
  if exists(select 1 from public.lv_sponsor_orders where user_id=auth.uid() and status='pending') then
    raise exception '你已有待核对申请，请先等待管理员处理'; end if;
  insert into public.lv_sponsor_orders(request_id,user_id,device_id,provider,transaction_ref,declared_cents)
    values(p_request_id,auth.uid(),did,p_provider,p_ref,p_cents) returning id into oid;
  return oid;
exception when unique_violation then raise exception '该订单号已提交，请检查自己的赞助记录或联系管理员';
end $$;

create function public.lv_review_sponsorship(p_id uuid,p_approve boolean,p_received_cents integer,p_response text)
returns uuid language plpgsql security definer set search_path='' as $$
declare o public.lv_sponsor_orders; eid uuid; d public.lv_devices;
begin
  perform private.require_admin();
  if p_approve is null then raise exception '审核决定无效'; end if;
  select * into o from public.lv_sponsor_orders where id=p_id for update;
  if not found then raise exception '记录不存在'; end if;
  if o.status='approved' and p_approve then return o.entitlement_id; end if;
  if o.status<>'pending' then raise exception '该申请已经处理，请刷新'; end if;
  if p_approve then
    select * into d from public.lv_devices where id=o.device_id for update;
    if d.blocked or d.owner_id is distinct from o.user_id then raise exception '设备受限或绑定已变化，请先核对'; end if;
    if p_received_cents is null or p_received_cents<1500 then raise exception '实际到账至少 15 元才能发放永久权益'; end if;
    -- Extra support records the payment but reuses an existing covering permanent grant.
    select id into eid from public.lv_entitlements where device_id=o.device_id and revoked_at is null
      and ends_at is null and starts_at<=now() and features @> o.features order by created_at limit 1;
    if eid is null then
      insert into public.lv_entitlements(device_id,features,starts_at,ends_at,source_order_id)
        values(o.device_id,o.features,now(),null,o.id) returning id into eid;
    end if;
    update public.lv_sponsor_orders set status='approved',entitlement_id=eid,received_cents=p_received_cents,
      response=coalesce(p_response,''),reviewed_at=now(),reviewed_by=auth.uid() where id=o.id;
  else
    if length(trim(coalesce(p_response,'')))=0 then raise exception '请填写未通过原因'; end if;
    update public.lv_sponsor_orders set status='rejected',response=p_response,reviewed_at=now(),reviewed_by=auth.uid() where id=o.id;
  end if;
  insert into public.lv_audit(actor,action,target_count) values(auth.uid(),case when p_approve then 'sponsor_approved' else 'sponsor_rejected' end,1);
  return eid;
end $$;

create function public.lv_submit_feedback(p_title text,p_body text) returns uuid
language plpgsql security definer set search_path='' as $$
declare fid uuid;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  if not exists(select 1 from public.lv_devices where owner_id=auth.uid() and not blocked) then raise exception '请先绑定可用设备'; end if;
  if (select count(*) from public.lv_feedback where user_id=auth.uid() and created_at>now()-interval '1 day')>=10 then raise exception '今日反馈次数已达上限'; end if;
  -- Serialize per-account writes without relying on a client-side submission limit.
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,0));
  if (select count(*) from public.lv_feedback where user_id=auth.uid() and created_at>now()-interval '1 day')>=10 then raise exception '今日反馈次数已达上限'; end if;
  insert into public.lv_feedback(user_id,title,body) values(auth.uid(),trim(p_title),trim(p_body)) returning id into fid;
  return fid;
end $$;
create function public.lv_reply_feedback(p_id uuid,p_reply text,p_closed boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform private.require_admin();
  if length(trim(coalesce(p_reply,'')))=0 then raise exception '请填写回复'; end if;
  update public.lv_feedback set reply=p_reply,status=case when p_closed then 'closed' else 'replied' end,replied_at=now(),replied_by=auth.uid() where id=p_id;
  if not found then raise exception '反馈不存在'; end if;
  insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'feedback_reply',1);
end $$;

revoke all on function public.lv_submit_sponsorship(uuid,uuid,text,text,integer),public.lv_review_sponsorship(uuid,boolean,integer,text),
  public.lv_submit_feedback(text,text),public.lv_reply_feedback(uuid,text,boolean) from public,anon;
grant execute on function public.lv_submit_sponsorship(uuid,uuid,text,text,integer),public.lv_review_sponsorship(uuid,boolean,integer,text),
  public.lv_submit_feedback(text,text),public.lv_reply_feedback(uuid,text,boolean) to authenticated;
commit;
select '赞助申请、人工核对及反馈功能已创建' as result;
