-- Run AFTER the owner has registered AND confirmed the email through the website.
-- Not executable by public clients, never promote using user-editable metadata.
begin;
-- Members may read their own device row, but never administrator notes.
revoke select on public.lv_devices from authenticated;
grant select(id,device_hash,owner_id,label,blocked,app_version,last_seen,created_at)
on public.lv_devices to authenticated;
create or replace function public.lv_admin_devices() returns setof public.lv_devices
language plpgsql security definer set search_path='' as $$
begin
  perform private.require_admin();
  return query select * from public.lv_devices order by created_at desc limit 1000;
end $$;
revoke all on function public.lv_admin_devices() from public,anon;
grant execute on function public.lv_admin_devices() to authenticated;
do $$
declare uid uuid;
begin
  select id into uid from auth.users where lower(email)='3103830475@qq.com' and email_confirmed_at is not null;
  if uid is null then raise exception '请先注册并验证管理员邮箱'; end if;
  insert into public.lv_admins(user_id) values(uid) on conflict do nothing;
end $$;
commit;

-- Must return the expected mailbox with is_admin = true after the DO block.
select u.email, u.email_confirmed_at is not null as email_verified,
       exists(select 1 from public.lv_admins a where a.user_id=u.id) as is_admin
from auth.users u where lower(u.email)='3103830475@qq.com';
