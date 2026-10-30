begin;
create table if not exists private.lv_account_controls(
  user_id uuid primary key references auth.users(id) on delete cascade,
  blocked boolean not null default false,
  invalid_before timestamptz not null default '-infinity',
  note text not null default '' check(length(note)<=2000)
);
create table if not exists private.lv_registration_policy(
  id integer primary key check(id=1),registration_open boolean not null default true,
  hourly_limit integer not null default 30 check(hourly_limit between 1 and 1000),
  daily_limit integer not null default 100 check(daily_limit between 1 and 10000)
);
insert into private.lv_registration_policy(id) values(1) on conflict do nothing;
create table if not exists private.lv_account_operations(
  request_id uuid primary key,actor uuid not null,actor_session uuid not null,
  target_id uuid not null references auth.users(id) on delete cascade,
  action text not null check(action in ('block','unblock','logout','reset_email','set_password','change_email','unbind','bind','note')),
  status text not null default 'pending' check(status in ('pending','completed','failed')),
  created_at timestamptz not null default now(),expires_at timestamptz not null default now()+interval '2 minutes'
);
create unique index if not exists lv_account_operation_pending on private.lv_account_operations(target_id) where status='pending';
alter table private.lv_account_controls enable row level security;
alter table private.lv_registration_policy enable row level security;
alter table private.lv_account_operations enable row level security;
revoke all on private.lv_account_controls,private.lv_registration_policy,private.lv_account_operations from public,anon,authenticated,service_role;

create or replace function public.lv_user_session_active() returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from auth.users u join auth.sessions s on s.user_id=u.id
   left join private.lv_account_controls c on c.user_id=u.id
   where u.id=auth.uid() and s.id::text=auth.jwt()->>'session_id'
   and (u.banned_until is null or u.banned_until<=now()) and not coalesce(c.blocked,false)
   and s.created_at>coalesce(c.invalid_before,'-infinity'::timestamptz))
$$;
create or replace function public.lv_admin_session_ready() returns boolean
language sql stable security definer set search_path='' as $$
 select public.lv_user_session_active() and public.lv_is_admin() and exists(
   select 1 from private.lv_admin_email_sessions s where s.user_id=auth.uid()
   and s.session_id::text=auth.jwt()->>'session_id' and s.verified_until>now())
$$;

-- A stale JWT is denied even before its normal expiration time.
do $guard$
declare t text; f record; definition text; marker text;
begin
 for t in select tablename from pg_tables where schemaname='public' and tablename like 'lv\_%' escape '\' loop
   execute format('drop policy if exists account_session_guard on public.%I',t);
   execute format('create policy account_session_guard on public.%I as restrictive for all to authenticated using(public.lv_user_session_active()) with check(public.lv_user_session_active())',t);
 end loop;
 -- Security-definer member mutations also need the same check; no frontend-only gate.
 marker='if not public.lv_user_session_active() then raise exception ''请重新登录'' using errcode=''42501'';end if;';
 for f in select p.oid from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in ('lv_bind_device','lv_submit_sponsorship','lv_submit_feedback') loop
   definition=pg_get_functiondef(f.oid);
   if position(marker in definition)=0 then
     definition=regexp_replace(definition,'\mbegin\M','begin'||chr(10)||marker,'i');
     execute definition;
   end if;
 end loop;
end $guard$;

create or replace function private.lv_registration_guard() returns trigger
language plpgsql security definer set search_path='' as $$
declare policy private.lv_registration_policy; n integer;
begin
  -- Anonymous App installation sessions are not website registrations.
  if new.is_anonymous then return new;end if;
  if tg_op='UPDATE' and not old.is_anonymous then return new;end if;
  perform pg_advisory_xact_lock(hashtext('LiquidVivo/registered-signups/v1'));
  select * into policy from private.lv_registration_policy where id=1;
  if not found or not policy.registration_open then raise exception '注册暂未开放' using errcode='P0001';end if;
  select count(*) into n from auth.users where not is_anonymous and created_at>now()-interval '1 hour';
  if n>=policy.hourly_limit then raise exception '注册请求过于频繁，请稍后重试' using errcode='P0001';end if;
  select count(*) into n from auth.users where not is_anonymous and created_at>now()-interval '24 hours';
  if n>=policy.daily_limit then raise exception '注册请求过于频繁，请稍后重试' using errcode='P0001';end if;
  return new;
end $$;
drop trigger if exists liquidvivo_registration_guard on auth.users;
create trigger liquidvivo_registration_guard before insert or update of is_anonymous on auth.users for each row execute function private.lv_registration_guard();

create or replace function public.lv_admin_accounts(p_after uuid default null,p_include_anonymous boolean default false)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare items jsonb;
begin
 perform private.require_admin();
 select coalesce(jsonb_agg(to_jsonb(x) order by x.id),'[]'::jsonb) into items from (
   select u.id,u.email,u.created_at,u.last_sign_in_at,u.email_confirmed_at,u.is_anonymous,u.banned_until,
     coalesce(c.blocked,false) or coalesce(u.banned_until>now(),false) as blocked,
     coalesce(c.note,'') as note,coalesce(u.encrypted_password,'')<>'' as password_set,
     exists(select 1 from public.lv_admins a where a.user_id=u.id) as is_admin,
     (select count(*) from auth.sessions s where s.user_id=u.id and s.created_at>coalesce(c.invalid_before,'-infinity'::timestamptz)) as session_count,
     coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'label',d.label,'device_hash',d.device_hash,'blocked',d.blocked,
        'device_code',i.device_code)) from public.lv_devices d left join private.lv_cloud_identity i on i.device_id=d.id
       where d.owner_id=u.id or (u.is_anonymous and exists(select 1 from private.lv_installations a where a.user_id=u.id and a.device_id=d.id))),'[]'::jsonb) as devices
   from auth.users u left join private.lv_account_controls c on c.user_id=u.id
   where (p_include_anonymous or not u.is_anonymous) and (p_after is null or u.id>p_after)
   order by u.id limit 250
 ) x;
 return jsonb_build_object('items',items,'total',(select count(*) from auth.users where p_include_anonymous or not is_anonymous),
   'anonymous_count',(select count(*) from auth.users where is_anonymous),
   'next_cursor',case when jsonb_array_length(items)=250 then items->249->>'id' else null end);
end $$;
create or replace function public.lv_admin_registration_policy(p_settings jsonb default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare policy private.lv_registration_policy;
begin
 perform private.require_admin();
 if p_settings is not null then
   if jsonb_typeof(p_settings->'registration_open') is distinct from 'boolean' then raise exception '注册设置无效';end if;
   update private.lv_registration_policy set registration_open=(p_settings->>'registration_open')::boolean,
     hourly_limit=(p_settings->>'hourly_limit')::integer,daily_limit=(p_settings->>'daily_limit')::integer where id=1;
   insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'registration_policy',1);
 end if;
 select * into policy from private.lv_registration_policy where id=1;return to_jsonb(policy);
end $$;
create or replace function public.lv_admin_account_begin(p_action text,p_target uuid,p_request uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare target auth.users; op private.lv_account_operations;
begin
 perform private.require_admin();
 if p_action not in ('block','unblock','logout','reset_email','set_password','change_email','unbind','bind','note') then raise exception '未知账号操作';end if;
 select * into target from auth.users where id=p_target for update;
 if not found then raise exception '账号不存在';end if;
 if exists(select 1 from public.lv_admins where user_id=p_target) then raise exception '管理员账号请使用账号设置，不能在此停用或重置';end if;
 if target.is_anonymous and p_action in ('reset_email','set_password','change_email','bind') then raise exception '安装会话不是邮箱注册账号';end if;
 select * into op from private.lv_account_operations where request_id=p_request;
 if found then
   if op.actor<>auth.uid() or op.target_id<>p_target or op.action<>p_action then raise exception '操作编号冲突';end if;
   return jsonb_build_object('status',op.status,'email',target.email);
 end if;
 update private.lv_account_operations set status='failed' where target_id=p_target and status='pending' and expires_at<=now();
 if exists(select 1 from private.lv_account_operations where target_id=p_target and status='pending') then raise exception '此账号正在处理中，请稍后刷新';end if;
 if p_action='reset_email' and exists(select 1 from private.lv_account_operations where target_id=p_target and action=p_action and created_at>now()-interval '60 seconds') then raise exception '请稍后再发送找回邮件';end if;
 insert into private.lv_account_operations(request_id,actor,actor_session,target_id,action) values(p_request,auth.uid(),(auth.jwt()->>'session_id')::uuid,p_target,p_action);
 return jsonb_build_object('status','started','email',target.email);
end $$;
create or replace function public.lv_admin_account_finish(p_request uuid,p_success boolean,p_data jsonb default '{}') returns boolean
language plpgsql security definer set search_path='' as $$
declare op private.lv_account_operations; d public.lv_devices; pairing public.lv_pairings; app_pair private.lv_app_pairings;
begin
 select * into op from private.lv_account_operations where request_id=p_request for update;
 if not found then raise exception '操作不存在';end if;
 if op.status='completed' then return true;end if;
 if op.status<>'pending' or op.expires_at<=now() then raise exception '操作已过期，请刷新核实账号状态';end if;
 if not exists(select 1 from public.lv_admins where user_id=op.actor) or not exists(
   select 1 from private.lv_admin_email_sessions e join auth.sessions s on s.id=e.session_id
   join auth.users u on u.id=s.user_id left join private.lv_account_controls c on c.user_id=u.id
   where e.user_id=op.actor and s.user_id=op.actor and e.session_id=op.actor_session and e.verified_until>now()
   and (u.banned_until is null or u.banned_until<=now()) and not coalesce(c.blocked,false)
   and s.created_at>coalesce(c.invalid_before,'-infinity'::timestamptz)) then raise exception '管理员确认已失效';end if;
 if exists(select 1 from public.lv_admins where user_id=op.target_id) then raise exception '目标已成为管理员，请刷新';end if;
 if p_success then
   insert into private.lv_account_controls(user_id) values(op.target_id) on conflict do nothing;
   if op.action='block' then update private.lv_account_controls set blocked=true,invalid_before=now() where user_id=op.target_id;
   elsif op.action='unblock' then update private.lv_account_controls set blocked=false where user_id=op.target_id;
   elsif op.action in ('logout','set_password','change_email') then update private.lv_account_controls set invalid_before=now() where user_id=op.target_id;
   elsif op.action='note' then update private.lv_account_controls set note=coalesce(p_data->>'note','') where user_id=op.target_id;
   elsif op.action='unbind' then update public.lv_devices set owner_id=null where owner_id=op.target_id;
   elsif op.action='bind' then
     if not exists(select 1 from auth.users where id=op.target_id and email_confirmed_at is not null and not is_anonymous) then raise exception '目标账号须先验证邮箱';end if;
     if p_data->>'pairing_token' is null or p_data->>'pairing_token' !~ '^[0-9a-f]{32}$' then raise exception '配对凭证无效';end if;
     select * into d from public.lv_devices where id=(p_data->>'device_id')::uuid for update;
     if not found or d.blocked or (d.owner_id is not null and d.owner_id<>op.target_id) then raise exception '设备不可绑定或已属于其他账号';end if;
     select * into app_pair from private.lv_app_pairings where device_id=d.id and token_hash=extensions.digest(p_data->>'pairing_token','sha256') and expires_at>now() for update;
     if found then
       if exists(select 1 from private.lv_installations where user_id=app_pair.user_id and device_id<>d.id) then raise exception '配对凭证无效';end if;
       insert into private.lv_installations(user_id,device_id) values(app_pair.user_id,d.id) on conflict(user_id) do nothing;
       delete from private.lv_app_pairings where token_hash=app_pair.token_hash;
     else
       select * into pairing from public.lv_pairings where device_id=d.id for update;
       if not found or pairing.expires_at<=now() or pairing.consumed_at is not null or pairing.token_hash<>extensions.digest(p_data->>'pairing_token','sha256') then raise exception '配对凭证无效';end if;
       update public.lv_pairings set consumed_at=now() where device_id=d.id;
     end if;
     update public.lv_devices set owner_id=null where owner_id=op.target_id and id<>d.id;
     update public.lv_devices set owner_id=op.target_id where id=d.id;
   end if;
 end if;
 update private.lv_account_operations set status=case when p_success then 'completed' else 'failed' end where request_id=p_request;
 insert into public.lv_audit(actor,action,target_count) values(op.actor,'account_'||op.action||case when p_success then '' else '_failed' end,1);
 return p_success;
end $$;

revoke all on function private.lv_registration_guard() from public,anon,authenticated,service_role;
revoke all on function public.lv_user_session_active() from public,anon;
grant execute on function public.lv_user_session_active() to authenticated;
revoke all on function public.lv_admin_accounts(uuid,boolean),public.lv_admin_registration_policy(jsonb),public.lv_admin_account_begin(text,uuid,uuid) from public,anon;
grant execute on function public.lv_admin_accounts(uuid,boolean),public.lv_admin_registration_policy(jsonb),public.lv_admin_account_begin(text,uuid,uuid) to authenticated;
revoke all on function public.lv_admin_account_finish(uuid,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.lv_admin_account_finish(uuid,boolean,jsonb) to service_role;
notify pgrst,'reload schema';
commit;
