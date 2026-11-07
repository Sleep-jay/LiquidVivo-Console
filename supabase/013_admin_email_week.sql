-- Server-side, session-bound email confirmation for seven days.
begin;
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
  deadline=now()+interval '7 days';
  insert into private.lv_admin_email_sessions(session_id,user_id,verified_until) values(sid,auth.uid(),deadline)
    on conflict(session_id) do update set user_id=excluded.user_id,verified_until=excluded.verified_until;
  update private.lv_admin_email_checks set consumed_at=now() where token_hash=c.token_hash;
  insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'admin_email_verified',1);
  return deadline;
end $$;


revoke all on function public.lv_admin_complete_email(text) from public,anon;
grant execute on function public.lv_admin_complete_email(text) to authenticated;
notify pgrst,'reload schema';
commit;
