-- Existing campaigns also become code-only. No existing device is auto-enrolled.
begin;
create table if not exists public.lv_campaign_codes(
 id uuid primary key default gen_random_uuid(),campaign_id uuid not null references public.lv_campaigns(id),
 code text not null check(length(code) between 4 and 64 and code !~ '[[:cntrl:][:space:]]'),
 enabled boolean not null default true,max_uses integer not null default 1 check(max_uses between 1 and 100000),
 used_count integer not null default 0 check(used_count>=0),expires_at timestamptz not null,
 edit_version bigint not null default 1,created_at timestamptz not null default now(),
 unique(code),check(code=upper(btrim(code)))
);
create table if not exists public.lv_campaign_claims(
 id uuid primary key default gen_random_uuid(),campaign_id uuid not null references public.lv_campaigns(id),
 device_id uuid not null references public.lv_devices(id),code_id uuid not null references public.lv_campaign_codes(id),
 redeemed_by uuid not null references auth.users(id),revoked_at timestamptz,
 created_at timestamptz not null default now(),unique(campaign_id,device_id)
);
create table if not exists private.lv_redemption_attempts(
 user_id uuid primary key references auth.users(id) on delete cascade,
 window_start timestamptz not null default now(),attempts integer not null default 0
);
alter table public.lv_campaign_codes enable row level security;
alter table public.lv_campaign_claims enable row level security;
alter table private.lv_redemption_attempts enable row level security;
revoke all on public.lv_campaign_codes,public.lv_campaign_claims from public,anon,authenticated;
grant select on public.lv_campaign_codes,public.lv_campaign_claims to authenticated;
revoke all on private.lv_redemption_attempts from public,anon,authenticated,service_role;
drop policy if exists campaign_code_read on public.lv_campaign_codes;
create policy campaign_code_read on public.lv_campaign_codes for select to authenticated using(public.lv_admin_session_ready());
drop policy if exists campaign_claim_read on public.lv_campaign_claims;
create policy campaign_claim_read on public.lv_campaign_claims for select to authenticated using(public.lv_user_session_active() and
 (public.lv_admin_session_ready() or exists(select 1 from public.lv_devices d where d.id=device_id and d.owner_id=auth.uid())));
drop policy if exists campaign_read on public.lv_campaigns;
create policy campaign_read on public.lv_campaigns for select to authenticated using(public.lv_user_session_active() and
 (public.lv_admin_session_ready() or exists(select 1 from public.lv_campaign_claims m join public.lv_devices d on d.id=m.device_id where m.campaign_id=lv_campaigns.id and d.owner_id=auth.uid())));

create or replace function public.lv_campaign_code_save(p_id uuid,p_campaign uuid,p_data jsonb,p_version bigint default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare c public.lv_campaigns; v public.lv_campaign_codes; text_code text; deadline timestamptz; quota integer;
begin
 perform private.require_admin();
 select * into c from public.lv_campaigns where id=p_campaign for update;if not found then raise exception '活动不存在';end if;
 text_code=upper(btrim(p_data->>'code'));deadline=(p_data->>'expires_at')::timestamptz;quota=(p_data->>'max_uses')::integer;
 if text_code is null or length(text_code) not between 4 and 64 or text_code ~ '[[:cntrl:][:space:]]' or deadline is null or deadline>c.ends_at or deadline<=c.starts_at or quota is null or quota not between 1 and 100000 or jsonb_typeof(p_data->'enabled') is distinct from 'boolean' then raise exception '兑换码、次数、有效期或状态无效';end if;
 if p_id is null then
  insert into public.lv_campaign_codes(campaign_id,code,enabled,max_uses,expires_at) values(p_campaign,text_code,(p_data->>'enabled')::boolean,quota,deadline) returning id into p_id;
 else
  select * into v from public.lv_campaign_codes where id=p_id and campaign_id=p_campaign for update;
  if not found then raise exception '兑换码不存在';end if;
  if p_version is distinct from v.edit_version then raise exception '兑换码已被修改，请刷新后重试' using errcode='40001';end if;
  if quota<v.used_count then raise exception '使用次数上限不能小于已兑换次数';end if;
  update public.lv_campaign_codes set code=text_code,enabled=(p_data->>'enabled')::boolean,max_uses=quota,expires_at=deadline,edit_version=edit_version+1 where id=p_id;
 end if;
 insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'campaign_code_save',1);
 return p_id;
end $$;

create or replace function public.lv_campaign_edit(p_id uuid,p_data jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare fs text[];
begin
 perform private.require_admin();
 if jsonb_typeof(p_data->'enabled') is distinct from 'boolean' then raise exception '活动状态无效';end if;
 select array_agg(value) into fs from jsonb_array_elements_text(p_data->'features');
 update public.lv_campaigns set title=p_data->>'title',features=fs,starts_at=(p_data->>'starts_at')::timestamptz,
 ends_at=(p_data->>'ends_at')::timestamptz,enabled=(p_data->>'enabled')::boolean where id=p_id;
 if not found then raise exception '活动不存在';end if;
 insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'campaign_edit',1);
end $$;

create or replace function public.lv_campaign_members_manage(p_campaign uuid,p_devices uuid[],p_action text) returns integer
language plpgsql security definer set search_path='' as $$
declare n integer;
begin
 perform private.require_admin();
 if p_action is null or p_action not in ('revoke','restore') or p_devices is null or cardinality(p_devices) not between 1 and 1000 then raise exception '操作或设备选择无效';end if;
 perform 1 from public.lv_campaigns where id=p_campaign for update;if not found then raise exception '活动不存在';end if;
 update public.lv_campaign_claims set revoked_at=case when p_action='revoke' then coalesce(revoked_at,now()) else null end
 where campaign_id=p_campaign and device_id=any(p_devices);
 get diagnostics n=row_count;
 insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'campaign_members_'||p_action,n);return n;
end $$;

create or replace function public.lv_campaign_redeem(p_code text,p_device uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.lv_campaigns; v public.lv_campaign_codes; m public.lv_campaign_claims; a private.lv_redemption_attempts; did uuid;
begin
 if not public.lv_user_session_active() or not exists(select 1 from auth.users where id=auth.uid() and not is_anonymous and email_confirmed_at is not null) then raise exception '请先登录并验证网页账号邮箱' using errcode='42501';end if;
 select id into did from public.lv_devices where id=p_device and owner_id=auth.uid() and not blocked and not cloud_sponsor_revoked for update;
 if did is null then raise exception '请先绑定可用设备';end if;
 insert into private.lv_redemption_attempts(user_id) values(auth.uid()) on conflict do nothing;
 select * into a from private.lv_redemption_attempts where user_id=auth.uid() for update;
 if a.window_start<=now()-interval '1 hour' then a.attempts=0;a.window_start=now();end if;
 if a.attempts>=10 then return jsonb_build_object('ok',false,'error','rate_limited');end if;
 update private.lv_redemption_attempts set window_start=a.window_start,attempts=a.attempts+1 where user_id=auth.uid();
 if p_code is null or length(p_code) not between 4 and 64 then return jsonb_build_object('ok',false,'error','unavailable');end if;
 -- Lock campaign before code, consistent with administrator edits and quota updates.
 select campaign_id into did from public.lv_campaign_codes where code=upper(btrim(p_code));
 select * into c from public.lv_campaigns where id=did for update;
 if not found then return jsonb_build_object('ok',false,'error','unavailable');end if;
 select * into v from public.lv_campaign_codes where code=upper(btrim(p_code)) and campaign_id=c.id for update;
 if not found then return jsonb_build_object('ok',false,'error','unavailable');end if;
 select * into m from public.lv_campaign_claims where campaign_id=c.id and device_id=p_device;
 if found and m.revoked_at is null then return jsonb_build_object('ok',true,'duplicate',true,'title',c.title);end if;
 if m.id is not null or not c.enabled or now()<c.starts_at or now()>=c.ends_at or not v.enabled or now()>=v.expires_at or v.used_count>=v.max_uses then return jsonb_build_object('ok',false,'error','unavailable');end if;
 insert into public.lv_campaign_claims(campaign_id,device_id,code_id,redeemed_by) values(c.id,p_device,v.id,auth.uid());
 update public.lv_campaign_codes set used_count=used_count+1,edit_version=edit_version+1 where id=v.id;
 insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'campaign_redeem',1);
 return jsonb_build_object('ok',true,'title',c.title,'ends_at',c.ends_at);
end $$;

-- Replace the old all-device campaign branch, leaving license/signature identities intact.
do $cloud$
declare definition text; old_branch text; new_branch text;
begin
 definition=pg_get_functiondef('public.lv_cloud_exchange(uuid,text,text,text,text,jsonb)'::regprocedure);
 old_branch='select id,features,starts_at,ends_at,created_at from public.lv_campaigns where enabled and starts_at<=now() and ends_at>now() order by ends_at desc limit 8';
 new_branch='select m.id,c.features,c.starts_at,c.ends_at,m.created_at from public.lv_campaigns c join public.lv_campaign_claims m on m.campaign_id=c.id where m.device_id=d.id and m.revoked_at is null and c.enabled and c.starts_at<=now() and c.ends_at>now() order by c.ends_at desc limit 8';
 if position(old_branch in definition)>0 then definition=replace(definition,old_branch,new_branch);
 elsif position(new_branch in definition)=0 then raise exception '云端活动接口与已核对版本不一致，未部署';end if;
 old_branch='select coalesce(jsonb_agg(id::text),''[]'') from public.lv_entitlements where device_id=d.id and revoked_at is not null';
 new_branch='select coalesce(jsonb_agg(v.id::text),''[]'') from (select id from public.lv_entitlements where device_id=d.id and revoked_at is not null union select m.id from public.lv_campaign_claims m join public.lv_campaigns c on c.id=m.campaign_id where m.device_id=d.id and (m.revoked_at is not null or not c.enabled or now()<c.starts_at or now()>=c.ends_at)) v';
 if position(old_branch in definition)>0 then definition=replace(definition,old_branch,new_branch);
 elsif position(new_branch in definition)=0 then raise exception '云端撤销接口与已核对版本不一致，未部署';end if;
 execute definition;
end $cloud$;
-- The existing revision is advisory; every exchange still reads current data.
create or replace function private.lv_campaign_revision() returns trigger language plpgsql security definer set search_path='' as $$
begin update private.lv_cloud_revision set revision=revision+1 where id=1;return null;end $$;
drop trigger if exists campaign_claim_revision on public.lv_campaign_claims;
create trigger campaign_claim_revision after insert or update on public.lv_campaign_claims for each statement execute function private.lv_campaign_revision();
revoke all on function private.lv_campaign_revision() from public,anon,authenticated,service_role;
revoke all on function public.lv_campaign_code_save(uuid,uuid,jsonb,bigint),public.lv_campaign_edit(uuid,jsonb),public.lv_campaign_members_manage(uuid,uuid[],text),public.lv_campaign_redeem(text,uuid) from public,anon;
grant execute on function public.lv_campaign_code_save(uuid,uuid,jsonb,bigint),public.lv_campaign_edit(uuid,jsonb),public.lv_campaign_members_manage(uuid,uuid[],text),public.lv_campaign_redeem(text,uuid) to authenticated;
notify pgrst,'reload schema';
commit;
