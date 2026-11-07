-- Additive migration. Relative validity is the redemption window, starting at save or campaign start, whichever is later.
begin;
alter table public.lv_campaign_codes add column if not exists validity_seconds integer check(validity_seconds between 60 and 31536000);
alter table public.lv_campaign_codes add column if not exists per_device_limit integer not null default 1 check(per_device_limit between 1 and 100000);
create table if not exists private.lv_campaign_code_device_uses(code_id uuid references public.lv_campaign_codes(id),device_id uuid references public.lv_devices(id),uses integer not null check(uses>0),primary key(code_id,device_id));
alter table private.lv_campaign_code_device_uses enable row level security;
revoke all on private.lv_campaign_code_device_uses from public,anon,authenticated,service_role;
insert into private.lv_campaign_code_device_uses select code_id,device_id,1 from public.lv_campaign_claims on conflict do nothing;
create or replace function public.lv_campaign_code_save(p_id uuid,p_campaign uuid,p_data jsonb,p_version bigint default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare c public.lv_campaigns; v public.lv_campaign_codes; text_code text; deadline timestamptz; quota integer; device_quota integer; lifetime integer;
begin
 perform private.require_admin();
 select * into c from public.lv_campaigns where id=p_campaign for update;if not found then raise exception '活动不存在';end if;
 text_code=upper(btrim(p_data->>'code'));lifetime=nullif(p_data->>'validity_seconds','')::integer; device_quota=coalesce((p_data->>'per_device_limit')::integer,1); if lifetime is not null and lifetime not between 60 and 31536000 then raise exception '有效时长须为一分钟至一年';end if; if device_quota not between 1 and 100000 then raise exception '设备次数无效';end if; deadline=case when lifetime is null then (p_data->>'expires_at')::timestamptz else greatest(now(),c.starts_at)+make_interval(secs=>lifetime) end;quota=(p_data->>'max_uses')::integer;
 if text_code is null or length(text_code) not between 4 and 64 or text_code ~ '[[:cntrl:][:space:]]' or deadline is null or deadline<=c.starts_at or quota is null or quota not between 1 and 100000 or jsonb_typeof(p_data->'enabled') is distinct from 'boolean' then raise exception '兑换码、次数、有效期或状态无效';end if;
 if p_id is null then
  insert into public.lv_campaign_codes(campaign_id,code,enabled,max_uses,expires_at,validity_seconds,per_device_limit) values(p_campaign,text_code,(p_data->>'enabled')::boolean,quota,deadline,lifetime,device_quota) returning id into p_id;
 else
  select * into v from public.lv_campaign_codes where id=p_id and campaign_id=p_campaign for update;
  if not found then raise exception '兑换码不存在';end if;
  if p_version is distinct from v.edit_version then raise exception '兑换码已被修改，请刷新后重试' using errcode='40001';end if;
  if quota<v.used_count then raise exception '使用次数上限不能小于已兑换次数';end if;
  update public.lv_campaign_codes set code=text_code,enabled=(p_data->>'enabled')::boolean,max_uses=quota,expires_at=deadline,validity_seconds=lifetime,per_device_limit=device_quota,edit_version=edit_version+1 where id=p_id;
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
declare c public.lv_campaigns; v public.lv_campaign_codes; m public.lv_campaign_claims; a private.lv_redemption_attempts; did uuid; device_uses integer;
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
 select coalesce((select uses from private.lv_campaign_code_device_uses where code_id=v.id and device_id=p_device),0) into device_uses;
 if device_uses>=v.per_device_limit then return jsonb_build_object('ok',false,'error','device_limit');end if;
 if m.revoked_at is not null or not c.enabled or now()<c.starts_at or now()>=c.ends_at or not v.enabled or now()>=v.expires_at or v.used_count>=v.max_uses then return jsonb_build_object('ok',false,'error','unavailable');end if;
 insert into public.lv_campaign_claims(campaign_id,device_id,code_id,redeemed_by) values(c.id,p_device,v.id,auth.uid()) on conflict(campaign_id,device_id) do update set code_id=excluded.code_id;
 insert into private.lv_campaign_code_device_uses(code_id,device_id,uses) values(v.id,p_device,1) on conflict(code_id,device_id) do update set uses=lv_campaign_code_device_uses.uses+1;
 update public.lv_campaign_codes set used_count=used_count+1,edit_version=edit_version+1 where id=v.id;
 insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'campaign_redeem',1);
 return jsonb_build_object('ok',true,'title',c.title,'ends_at',c.ends_at);
end $$;

notify pgrst,'reload schema';
commit;
