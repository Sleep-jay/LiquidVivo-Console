begin;

alter table public.lv_entitlements add column if not exists account_id uuid references auth.users(id) on delete restrict;
create index if not exists lv_entitlements_account on public.lv_entitlements(account_id) where account_id is not null;

-- Paid orders are stronger ownership evidence than the current device binding.
with paid_owner as (
  select distinct on (entitlement_id) entitlement_id,user_id
  from public.lv_sponsor_orders
  where status='approved' and entitlement_id is not null
  order by entitlement_id,reviewed_at,id
)
update public.lv_entitlements e set account_id=p.user_id
from paid_owner p, public.lv_devices d
where e.id=p.entitlement_id and e.account_id is null and e.device_id=d.id
  and not d.blocked and not d.cloud_sponsor_revoked and e.revoked_at is null;

-- Preserve the original grant ID, feature list, dates and revocation history.
update public.lv_entitlements e set account_id=d.owner_id
from public.lv_devices d
where e.device_id=d.id and e.account_id is null and d.owner_id is not null
  and not d.blocked and not d.cloud_sponsor_revoked and e.revoked_at is null;

create or replace function private.lv_assign_bound_sponsor() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.owner_id is not null and not new.blocked and not new.cloud_sponsor_revoked then
    update public.lv_entitlements set account_id=new.owner_id
    where device_id=new.id and account_id is null and revoked_at is null;
  end if;
  return new;
end
$$;
drop trigger if exists lv_assign_bound_sponsor on public.lv_devices;
create trigger lv_assign_bound_sponsor after update of owner_id on public.lv_devices
for each row when (old.owner_id is distinct from new.owner_id) execute function private.lv_assign_bound_sponsor();

create or replace function private.lv_assign_new_sponsor() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if new.account_id is null then
    select d.owner_id into new.account_id from public.lv_devices d
    where d.id=new.device_id and not d.blocked for update;
  end if;
  return new;
end
$$;
drop trigger if exists lv_assign_new_sponsor on public.lv_entitlements;
create trigger lv_assign_new_sponsor before insert on public.lv_entitlements
for each row execute function private.lv_assign_new_sponsor();

revoke all on function private.lv_assign_bound_sponsor(),private.lv_assign_new_sponsor() from public,anon,authenticated,service_role;

create or replace function private.lv_cloud_grant_change() returns trigger
language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then
    update public.lv_devices set cloud_sponsor_revoked=false
    where owner_id=new.account_id or (new.account_id is null and id=new.device_id);
  elsif new.revoked_at is not null and old.revoked_at is null then
    update public.lv_devices set cloud_sponsor_revoked=true
    where owner_id=new.account_id or (new.account_id is null and id=new.device_id);
  end if;
  return new;
end
$$;

create or replace function public.lv_review_sponsorship(p_id uuid,p_approve boolean,p_received_cents integer,p_response text)
returns uuid language plpgsql security definer set search_path='' as $$
declare o public.lv_sponsor_orders; eid uuid;
begin
  perform private.require_admin();
  if p_approve is null then raise exception '审核决定无效'; end if;
  select * into o from public.lv_sponsor_orders where id=p_id for update;
  if not found then raise exception '记录不存在'; end if;
  if o.status='approved' and p_approve then return o.entitlement_id; end if;
  if o.status<>'pending' then raise exception '该申请已经处理，请刷新'; end if;
  if p_approve then
    if p_received_cents is null or p_received_cents<1500 then raise exception '实际到账至少 15 元才能发放永久权益'; end if;
    -- Serialize permanent grants for this payer even if the recorded device changes.
    perform pg_advisory_xact_lock(hashtextextended('lv_sponsor_account:'||o.user_id::text,0));
    if not exists (
      select 1 from auth.users u left join private.lv_account_controls c on c.user_id=u.id
      where u.id=o.user_id and u.is_anonymous is false and u.email_confirmed_at is not null
        and (u.banned_until is null or u.banned_until<=now()) and not coalesce(c.blocked,false)
    ) then raise exception '赞助账号受限或邮箱尚未验证';end if;
    select id into eid from public.lv_entitlements where account_id=o.user_id and revoked_at is null
      and ends_at is null and starts_at<=now() and features @> o.features order by created_at limit 1;
    if eid is null then
      insert into public.lv_entitlements(device_id,account_id,features,starts_at,ends_at,source_order_id)
        values(o.device_id,o.user_id,o.features,now(),null,o.id) returning id into eid;
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

create or replace function public.lv_manage(p_action text,p_ids uuid[],p_data jsonb) returns integer
language plpgsql security definer set search_path='' as $$
declare n integer; feature_list text[];
begin
  perform private.require_admin();
  if p_ids is null or cardinality(p_ids) not between 1 and 1000 then raise exception '请选择 1–1000 台设备'; end if;
  select count(distinct v) into n from unnest(p_ids) v;
  if n<>cardinality(p_ids) or n<>(select count(*) from public.lv_devices where id=any(p_ids)) then raise exception '设备列表已变化，请刷新'; end if;
  case p_action
    when 'block' then update public.lv_devices set blocked=true where id=any(p_ids);
    when 'unblock' then update public.lv_devices set blocked=false where id=any(p_ids);
    when 'note' then update public.lv_devices set note=p_data->>'note' where id=any(p_ids);
    when 'grant' then
      select array_agg(value) into feature_list from jsonb_array_elements_text(p_data->'features');
      perform id from public.lv_devices where id=any(p_ids) order by id for update;
      if exists(select 1 from public.lv_devices where id=any(p_ids) and (owner_id is null or blocked)) then
        raise exception '请先将所选设备绑定到可用账号';
      end if;
      insert into public.lv_entitlements(device_id,account_id,features,starts_at,ends_at)
        select id,owner_id,feature_list,now(),(p_data->>'ends_at')::timestamptz
        from public.lv_devices where id=any(p_ids);
    when 'revoke' then
      perform id from public.lv_devices where id=any(p_ids) order by id for update;
      update public.lv_entitlements e set revoked_at=now()
      where e.revoked_at is null and exists(
        select 1 from public.lv_devices d where d.id=any(p_ids)
          and (e.account_id=d.owner_id or (e.account_id is null and e.device_id=d.id))
      );
    when 'unbind' then
      update public.lv_devices set owner_id=null where id=any(p_ids);
      delete from public.lv_pairings where device_id=any(p_ids);
    else raise exception '未知操作';
  end case;
  insert into public.lv_audit(actor,action,target_count) values(auth.uid(),p_action,n);
  return n;
end $$;

drop policy if exists entitlement_read on public.lv_entitlements;
create policy entitlement_read on public.lv_entitlements for select to authenticated
using(account_id=auth.uid() or public.lv_admin_session_ready());

create or replace function public.lv_bind_device(p_hash text,p_token text) returns uuid language plpgsql security definer set search_path='' as $$
declare d public.lv_devices; pairing public.lv_pairings; app_pair private.lv_app_pairings; prior uuid; member uuid:=auth.uid();
begin
  if not public.lv_user_session_active() or not exists(
    select 1 from auth.users where id=member and is_anonymous is false and email_confirmed_at is not null
  ) then raise exception '请先登录并验证邮箱' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended('lv_member_device:'||member::text,0));
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
    or p_token is null or p_token !~ '^[0-9a-f]{32}$'
  then raise exception '设备或配对凭证无效';end if;
  select id into prior from public.lv_devices where owner_id=member;
  perform id from public.lv_devices where device_hash=p_hash or id=prior order by id for update;
  select * into d from public.lv_devices where device_hash=p_hash;
  if not found or d.blocked then raise exception '设备或配对凭证无效';end if;
  if d.owner_id is not null and d.owner_id<>auth.uid() then raise exception '设备已绑定其他账号';end if;
  if d.owner_id is null and exists (
    select 1 from private.lv_imported_licenses l
    join public.lv_entitlements e on e.id=l.license_id and e.device_id=l.device_id
    where l.device_id=d.id and e.account_id is null and e.revoked_at is null
      and (e.ends_at is null or e.ends_at>now())
  ) then raise exception '请使用迁移旧赞助入口';end if;
  select * into app_pair from private.lv_app_pairings where token_hash=extensions.digest(p_token,'sha256') and device_id=d.id and expires_at>now() for update;
  if found then
    if exists(select 1 from private.lv_installations where user_id=app_pair.user_id and device_id<>d.id) then raise exception '配对凭证无效';end if;
    insert into private.lv_installations(user_id,device_id) values(app_pair.user_id,d.id) on conflict(user_id) do nothing;
    delete from private.lv_app_pairings where token_hash=app_pair.token_hash;
  else
    if prior is not null and prior<>d.id then raise exception '请使用新手机生成的一次性配对码';end if;
    select * into pairing from public.lv_pairings where device_id=d.id for update;
    if not found or pairing.consumed_at is not null or pairing.expires_at<=now() or pairing.token_hash<>extensions.digest(p_token,'sha256') then raise exception '设备或配对凭证无效';end if;
    update public.lv_pairings set consumed_at=now() where device_id=d.id;
  end if;
  update public.lv_devices set owner_id=null where id=prior and id<>d.id and owner_id=member;
  update public.lv_devices set owner_id=member where id=d.id;
  insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'app_pair',1);
  return d.id;
end $$;

-- Return only the current account's feature deadline. There is no device input.
create or replace function public.lv_sponsor_feature_deadline(p_feature text)
returns timestamptz language sql stable security definer set search_path='' as $$
  with member as (
    select id from auth.users where id=auth.uid()
      and is_anonymous is false and email_confirmed_at is not null
      and public.lv_user_session_active()
      and p_feature in ('notification_island','status_bar')
  ), windows as (
    select coalesce(e.ends_at,'infinity'::timestamptz) as ends_at
    from public.lv_entitlements e join member u on e.account_id=u.id
    where e.revoked_at is null and e.starts_at<=now()
      and (e.ends_at is null or e.ends_at>now()) and p_feature=any(e.features)
    union all
    select least(c.ends_at,coalesce(m.ends_at,c.ends_at))
    from public.lv_campaign_claims m
    join member u on m.redeemed_by=u.id
    join public.lv_campaigns c on c.id=m.campaign_id
    where c.enabled and m.revoked_at is null
      and greatest(c.starts_at,coalesce(m.starts_at,c.starts_at))<=now()
      and least(c.ends_at,coalesce(m.ends_at,c.ends_at))>now()
      and p_feature=any(c.features)
  )
  select least(max(ends_at),now()+interval '10 minutes')
  from windows
  having count(*)>0
$$;

revoke all on function public.lv_sponsor_feature_deadline(text) from public,anon,authenticated,service_role;
grant execute on function public.lv_sponsor_feature_deadline(text) to authenticated;

-- Keep the legacy client protocol while preventing an old device that was
-- detached or reassigned from receiving a different account's grant again.
do $guard$
declare
  definition text:=pg_get_functiondef('public.lv_cloud_exchange(uuid,text,text,text,text,jsonb)'::regprocedure);
  direct_filter constant text:='from public.lv_entitlements where device_id=d.id and revoked_at is null';
  direct_guard constant text:='from public.lv_entitlements where (account_id=d.owner_id or (account_id is null and device_id=d.id)) and revoked_at is null';
  imported_filter constant text:='where l.device_id=d.id and e.revoked_at is null';
  imported_guard constant text:='and (e.account_id is null or e.account_id=d.owner_id)';
begin
  if (position(direct_filter in definition)=0 and position(direct_guard in definition)=0)
    or position(imported_filter in definition)=0 then
    raise exception 'lv_cloud_exchange definition changed; review sponsor account filters';
  end if;
  if position(direct_guard in definition)=0 then
    definition=replace(definition,direct_filter,direct_guard);
  end if;
  if position(imported_guard in definition)=0 then
    definition=replace(definition,imported_filter,imported_filter||' '||imported_guard);
  end if;
  execute definition;
end
$guard$;

notify pgrst, 'reload schema';
commit;
