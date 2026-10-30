-- Run AFTER the owner has registered AND confirmed the email through the website.
-- Not executable by public clients, never promote using user-editable metadata.
do $$
declare uid uuid;
begin
  select id into uid from auth.users where lower(email)='3103830475@qq.com' and email_confirmed_at is not null;
  if uid is null then raise exception '请先注册并验证管理员邮箱'; end if;
  insert into public.lv_admins(user_id) values(uid) on conflict do nothing;
end $$;
