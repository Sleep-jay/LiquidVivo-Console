-- Trial time starts at redemption, independently of code redemption deadline.
begin;
alter table public.lv_campaign_codes add column if not exists per_account_limit integer not null default 1 check(per_account_limit between 1 and 100000);
alter table public.lv_campaign_codes add column if not exists grant_duration_seconds integer check(grant_duration_seconds in (86400,172800,604800,2592000));
alter table public.lv_campaign_claims add column if not exists starts_at timestamptz;
alter table public.lv_campaign_claims add column if not exists ends_at timestamptz;
create table if not exists private.lv_campaign_account_uses(campaign_id uuid references public.lv_campaigns(id),user_id uuid references auth.users(id),uses integer not null check(uses>0),primary key(campaign_id,user_id));
create table if not exists private.lv_campaign_redemptions(request_id uuid primary key,campaign_id uuid references public.lv_campaigns(id),code_id uuid references public.lv_campaign_codes(id),user_id uuid references auth.users(id),device_id uuid references public.lv_devices(id),code_text text not null,title text not null,ends_at timestamptz not null,created_at timestamptz not null default now());
alter table private.lv_campaign_account_uses enable row level security;
alter table private.lv_campaign_redemptions enable row level security;
revoke all on private.lv_campaign_account_uses,private.lv_campaign_redemptions from public,anon,authenticated,service_role;
-- Backfill observed legacy claims, without resetting existing counters on rerun.
insert into private.lv_campaign_account_uses select m.campaign_id,m.redeemed_by,sum(coalesce(u.uses,1))::integer from public.lv_campaign_claims m left join private.lv_campaign_code_device_uses u on u.code_id=m.code_id and u.device_id=m.device_id group by m.campaign_id,m.redeemed_by on conflict do nothing;
create or replace function public.lv_campaign_code_save(p_id uuid,p_campaign uuid,p_data jsonb,p_version bigint default null)
returns uuid language plpgsql security definer set search_path='' as $$
declare c public.lv_campaigns; v public.lv_campaign_codes; text_code text; deadline timestamptz; quota integer; device_quota integer; lifetime integer; account_quota integer; trial integer;
begin
 perform private.require_admin();
 select * into c from public.lv_campaigns where id=p_campaign for update;if not found then raise exception '活动不存在';end if;
 account_quota=coalesce((p_data->>'per_account_limit')::integer,1); trial=nullif(p_data->>'grant_duration_seconds','')::integer;
 if account_quota not between 1 and 100000 or (trial is not null and trial not in (86400,172800,604800,2592000)) then raise exception '账号领取上限或体验时长无效';end if;
 text_code=upper(btrim(p_data->>'code'));lifetime=nullif(p_data->>'validity_seconds','')::integer; device_quota=coalesce((p_data->>'per_device_limit')::integer,1); if lifetime is not null and lifetime not between 60 and 31536000 then raise exception '有效时长须为一分钟至一年';end if; if device_quota not between 1 and 100000 then raise exception '设备次数无效';end if; deadline=case when lifetime is null then (p_data->>'expires_at')::timestamptz else greatest(now(),c.starts_at)+make_interval(secs=>lifetime) end;quota=(p_data->>'max_uses')::integer;
 if text_code is null or length(text_code) not between 4 and 64 or text_code ~ '[[:cntrl:][:space:]]' or deadline is null or deadline<=c.starts_at or quota is null or quota not between 1 and 100000 or jsonb_typeof(p_data->'enabled') is distinct from 'boolean' then raise exception '兑换码、次数、有效期或状态无效';end if;
 if p_id is null then
  insert into public.lv_campaign_codes(campaign_id,code,enabled,max_uses,expires_at,validity_seconds,per_device_limit,per_account_limit,grant_duration_seconds) values(p_campaign,text_code,(p_data->>'enabled')::boolean,quota,deadline,lifetime,device_quota,account_quota,trial) returning id into p_id;
 else
  select * into v from public.lv_campaign_codes where id=p_id and campaign_id=p_campaign for update;
  if not found then raise exception '兑换码不存在';end if;
  if p_version is distinct from v.edit_version then raise exception '兑换码已被修改，请刷新后重试' using errcode='40001';end if;
  if quota<v.used_count then raise exception '使用次数上限不能小于已兑换次数';end if;
  update public.lv_campaign_codes set code=text_code,enabled=(p_data->>'enabled')::boolean,max_uses=quota,expires_at=deadline,validity_seconds=lifetime,per_device_limit=device_quota,per_account_limit=account_quota,grant_duration_seconds=trial,edit_version=edit_version+1 where id=p_id;
 end if;
 insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'campaign_code_save',1);
 return p_id;
end $$;

create or replace function public.lv_campaign_redeem(p_code text,p_device uuid,p_request uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.lv_campaigns; v public.lv_campaign_codes; m public.lv_campaign_claims; a private.lv_redemption_attempts; did uuid; device_uses integer; account_uses integer; finish timestamptz; prior private.lv_campaign_redemptions;
begin
 if not public.lv_user_session_active() or not exists(select 1 from auth.users where id=auth.uid() and not is_anonymous and email_confirmed_at is not null) then raise exception '请先登录并验证网页账号邮箱' using errcode='42501';end if;
 select id into did from public.lv_devices where id=p_device and owner_id=auth.uid() and not blocked and not cloud_sponsor_revoked for update;
 if did is null then raise exception '请先绑定可用设备';end if;
 insert into private.lv_redemption_attempts(user_id) values(auth.uid()) on conflict do nothing;
 select * into a from private.lv_redemption_attempts where user_id=auth.uid() for update;
 if a.window_start<=now()-interval '1 hour' then a.attempts=0;a.window_start=now();end if;
 if a.attempts>=10 then return jsonb_build_object('ok',false,'error','rate_limited');end if;
 update private.lv_redemption_attempts set window_start=a.window_start,attempts=a.attempts+1 where user_id=auth.uid();
 if p_request is not null then
 select * into prior from private.lv_campaign_redemptions where request_id=p_request;
 if found then
 if prior.user_id<>auth.uid() or prior.device_id<>p_device or prior.code_text<>upper(btrim(p_code)) then raise exception '兑换请求不匹配';end if;
 return jsonb_build_object('ok',true,'duplicate',true,'title',prior.title,'ends_at',prior.ends_at);
 end if;end if;
 if p_code is null or length(p_code) not between 4 and 64 then return jsonb_build_object('ok',false,'error','unavailable');end if;
 -- Lock campaign before code, consistent with administrator edits and quota updates.
 select campaign_id into did from public.lv_campaign_codes where code=upper(btrim(p_code));
 select * into c from public.lv_campaigns where id=did for update;
 if not found then return jsonb_build_object('ok',false,'error','unavailable');end if;
 select * into v from public.lv_campaign_codes where code=upper(btrim(p_code)) and campaign_id=c.id for update;
 if not found then return jsonb_build_object('ok',false,'error','unavailable');end if;
 select coalesce(sum(uses),0)::integer into account_uses from private.lv_campaign_account_uses where campaign_id=c.id and user_id=auth.uid();
 if account_uses>=v.per_account_limit then return jsonb_build_object('ok',false,'error','account_limit');end if;
 select * into m from public.lv_campaign_claims where campaign_id=c.id and device_id=p_device;
 select coalesce((select uses from private.lv_campaign_code_device_uses where code_id=v.id and device_id=p_device),0) into device_uses;

 if m.revoked_at is not null or not c.enabled or now()<c.starts_at or now()>=c.ends_at or not v.enabled or now()>=v.expires_at or v.used_count>=v.max_uses then return jsonb_build_object('ok',false,'error','unavailable');end if;
 -- A running trial cannot be stacked or moved to another device. Retries use request_id.
 if exists(select 1 from public.lv_campaign_claims where campaign_id=c.id and redeemed_by=auth.uid() and revoked_at is null and least(coalesce(ends_at,c.ends_at),c.ends_at)>now()) or (m.id is not null and least(coalesce(m.ends_at,c.ends_at),c.ends_at)>now()) then return jsonb_build_object('ok',false,'error','already_active');end if;
 finish=case when v.grant_duration_seconds is null then c.ends_at else least(c.ends_at,now()+make_interval(secs=>v.grant_duration_seconds)) end;
 insert into public.lv_campaign_claims(campaign_id,device_id,code_id,redeemed_by,starts_at,ends_at) values(c.id,p_device,v.id,auth.uid(),now(),finish) on conflict(campaign_id,device_id) do update set code_id=excluded.code_id,redeemed_by=excluded.redeemed_by,starts_at=excluded.starts_at,ends_at=excluded.ends_at;
 insert into private.lv_campaign_account_uses(campaign_id,user_id,uses) values(c.id,auth.uid(),1) on conflict(campaign_id,user_id) do update set uses=lv_campaign_account_uses.uses+1;
 insert into private.lv_campaign_redemptions(request_id,campaign_id,code_id,user_id,device_id,code_text,title,ends_at) values(coalesce(p_request,gen_random_uuid()),c.id,v.id,auth.uid(),p_device,v.code,c.title,finish);
 insert into private.lv_campaign_code_device_uses(code_id,device_id,uses) values(v.id,p_device,1) on conflict(code_id,device_id) do update set uses=lv_campaign_code_device_uses.uses+1;
 update public.lv_campaign_codes set used_count=used_count+1,edit_version=edit_version+1 where id=v.id;
 insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'campaign_redeem',1);
 return jsonb_build_object('ok',true,'title',c.title,'ends_at',finish);
end $$;


-- Preserve all other cloud exchange branches. Abort on an unexpected function shape.
do $cloud$
declare definition text; before text; after text;
begin
 definition=pg_get_functiondef('public.lv_cloud_exchange(uuid,text,text,text,text,jsonb)'::regprocedure);
 before='select m.id,c.features,c.starts_at,c.ends_at,m.created_at from public.lv_campaigns c join public.lv_campaign_claims m on m.campaign_id=c.id where m.device_id=d.id and m.revoked_at is null and c.enabled and c.starts_at<=now() and c.ends_at>now() order by c.ends_at desc limit 8';
 after='select m.id,c.features,greatest(c.starts_at,coalesce(m.starts_at,c.starts_at)) as starts_at,least(c.ends_at,coalesce(m.ends_at,c.ends_at)) as ends_at,m.created_at from public.lv_campaigns c join public.lv_campaign_claims m on m.campaign_id=c.id where m.device_id=d.id and m.revoked_at is null and c.enabled and greatest(c.starts_at,coalesce(m.starts_at,c.starts_at))<=now() and least(c.ends_at,coalesce(m.ends_at,c.ends_at))>now() order by least(c.ends_at,coalesce(m.ends_at,c.ends_at)) desc limit 8';
 if position(before in definition)>0 then definition=replace(definition,before,after);elsif position(after in definition)=0 then raise exception '云端体验接口版本不一致';end if;
 -- Expiry is carried in the signed grant. Do not mark naturally expired IDs as permanently revoked:
 -- a later permitted redemption may issue a new term for that claim.
 execute definition;
end $cloud$;
revoke all on function public.lv_campaign_redeem(text,uuid,uuid) from public,anon;
grant execute on function public.lv_campaign_redeem(text,uuid,uuid) to authenticated;
create or replace function public.lv_campaign_redeem(p_code text,p_device uuid) returns jsonb language sql security definer set search_path='' as $$select public.lv_campaign_redeem(p_code,p_device,null::uuid)$$;
revoke all on function public.lv_campaign_redeem(text,uuid) from public,anon;
grant execute on function public.lv_campaign_redeem(text,uuid) to authenticated;
create or replace function public.lv_campaign_trials_ready() returns boolean language plpgsql security definer set search_path='' as $$begin perform private.require_admin();return true;end$$;
revoke all on function public.lv_campaign_trials_ready() from public,anon;
grant execute on function public.lv_campaign_trials_ready() to authenticated;
notify pgrst,'reload schema';
commit;
