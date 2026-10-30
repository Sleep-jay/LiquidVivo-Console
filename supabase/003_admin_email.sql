-- Run after 001 and 002. Replace authenticator requirement with password + email OTP.
begin;
create table if not exists private.lv_admin_email_checks (
  token_hash bytea primary key, user_id uuid not null references auth.users(id) on delete cascade,
  expires_at timestamptz not null, created_at timestamptz not null default now(), consumed_at timestamptz
);
create table if not exists private.lv_admin_email_sessions (
  session_id uuid primary key references auth.sessions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  verified_until timestamptz not null
);
alter table private.lv_admin_email_checks enable row level security;
alter table private.lv_admin_email_sessions enable row level security;
revoke all on private.lv_admin_email_checks,private.lv_admin_email_sessions from public,anon,authenticated;

create or replace function private.lv_recent_auth(p_method text,p_seconds integer) returns boolean
language sql stable set search_path='' as $$
  select exists(select 1 from jsonb_array_elements(coalesce(auth.jwt()->'amr','[]'::jsonb)) a
    where a->>'method'=p_method and (a->>'timestamp')::numeric
      between extract(epoch from now())-p_seconds and extract(epoch from now())+30)
$$;

create or replace function public.lv_admin_session_ready() returns boolean
language sql stable security definer set search_path='' as $$
  select public.lv_is_admin() and exists(select 1 from private.lv_admin_email_sessions s
    where s.user_id=auth.uid() and s.session_id::text=auth.jwt()->>'session_id' and s.verified_until>now())
$$;

create or replace function public.lv_admin_begin_email() returns text
language plpgsql security definer set search_path='' as $$
declare token text;
begin
  if not public.lv_is_admin() then raise exception '无管理员权限' using errcode='42501'; end if;
  if not private.lv_recent_auth('password',300) then raise exception '请先退出并使用密码重新登录，再发送邮箱验证码'; end if;
  if exists(select 1 from private.lv_admin_email_checks where user_id=auth.uid() and created_at>now()-interval '60 seconds') then
    raise exception '请等待 60 秒再发送'; end if;
  delete from private.lv_admin_email_checks where expires_at<now();
  -- A resend invalidates this account's previous unconsumed pending checks.
  update private.lv_admin_email_checks set consumed_at=now() where user_id=auth.uid() and consumed_at is null;
  token=encode(extensions.gen_random_bytes(32),'hex');
  insert into private.lv_admin_email_checks(token_hash,user_id,expires_at)
    values(extensions.digest(token,'sha256'),auth.uid(),now()+interval '15 minutes');
  return token;
end $$;

create or replace function public.lv_admin_complete_email(p_token text) returns timestamptz
language plpgsql security definer set search_path='' as $$
declare c private.lv_admin_email_checks; sid uuid; deadline timestamptz;
begin
  if not public.lv_is_admin() or not private.lv_recent_auth('otp',600) then
    raise exception '需要有效的管理员邮箱验证码确认' using errcode='42501'; end if;
  if length(p_token)<>64 or p_token !~ '^[0-9a-f]{64}$' then raise exception '登录确认已失效，请重新使用密码登录'; end if;
  select * into c from private.lv_admin_email_checks where token_hash=extensions.digest(p_token,'sha256') for update;
  if not found or c.user_id<>auth.uid() or c.expires_at<=now() or c.consumed_at is not null then
    raise exception '登录确认已失效，请重新使用密码登录'; end if;
  if not exists(select 1 from jsonb_array_elements(coalesce(auth.jwt()->'amr','[]'::jsonb)) a
    where a->>'method'='otp' and (a->>'timestamp')::numeric>=extract(epoch from c.created_at)-30) then
    raise exception '请使用本次发送的邮箱验证码'; end if;
  sid=(auth.jwt()->>'session_id')::uuid;
  if sid is null then raise exception '会话无效'; end if;
  deadline=now()+interval '12 hours';
  insert into private.lv_admin_email_sessions(session_id,user_id,verified_until) values(sid,auth.uid(),deadline)
    on conflict(session_id) do update set user_id=excluded.user_id,verified_until=excluded.verified_until;
  update private.lv_admin_email_checks set consumed_at=now() where token_hash=c.token_hash;
  insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'admin_email_verified',1);
  return deadline;
end $$;

create or replace function private.require_admin() returns void language plpgsql security definer set search_path='' as $$
begin
  if not public.lv_admin_session_ready() then raise exception '管理员操作需要邮箱验证码确认' using errcode='42501'; end if;
end $$;

drop policy if exists device_read on public.lv_devices;
create policy device_read on public.lv_devices for select to authenticated using(owner_id=auth.uid() or public.lv_admin_session_ready());
drop policy if exists entitlement_read on public.lv_entitlements;
create policy entitlement_read on public.lv_entitlements for select to authenticated using(
  exists(select 1 from public.lv_devices d where d.id=device_id and d.owner_id=auth.uid()) or public.lv_admin_session_ready());
drop policy if exists campaign_read on public.lv_campaigns;
create policy campaign_read on public.lv_campaigns for select to authenticated using(
  (enabled and exists(select 1 from public.lv_devices where owner_id=auth.uid())) or public.lv_admin_session_ready());
drop policy if exists message_read on public.lv_messages;
create policy message_read on public.lv_messages for select to authenticated using(public.lv_admin_session_ready() or
  (enabled and now() between starts_at and ends_at and exists(select 1 from public.lv_devices d where d.owner_id=auth.uid() and (all_devices or d.id=any(target_ids)))));
drop policy if exists receipt_read on public.lv_receipts;
create policy receipt_read on public.lv_receipts for select to authenticated using(public.lv_admin_session_ready() or
  exists(select 1 from public.lv_devices d where d.id=device_id and d.owner_id=auth.uid()));
drop policy if exists audit_read on public.lv_audit;
create policy audit_read on public.lv_audit for select to authenticated using(public.lv_admin_session_ready());

revoke all on function private.lv_recent_auth(text,integer),private.require_admin() from public,anon,authenticated;
revoke all on function public.lv_admin_session_ready(),public.lv_admin_begin_email(),public.lv_admin_complete_email(text) from public,anon;
grant execute on function public.lv_admin_session_ready(),public.lv_admin_begin_email(),public.lv_admin_complete_email(text) to authenticated;
commit;
select '管理员邮箱确认权限已启用' as result;
