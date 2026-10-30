-- Independent of optional push registration 007; requires console 003 and cloud 005.
begin;
alter table public.lv_messages add column if not exists deleted_at timestamptz;
alter table public.lv_messages add column if not exists edit_version bigint not null default 1;
create index if not exists lv_messages_trash_expiry on public.lv_messages(deleted_at) where deleted_at is not null;

create or replace function private.lv_message_version() returns trigger
language plpgsql set search_path='' as $$
begin
  new.edit_version=old.edit_version+1;
  if new.deleted_at is not null then new.enabled=false;end if;
  return new;
end $$;
drop trigger if exists lv_message_edit_version on public.lv_messages;
create trigger lv_message_edit_version before update on public.lv_messages for each row execute function private.lv_message_version();

create or replace function public.lv_message_manage(p_action text,p_id uuid,p_data jsonb default '{}'::jsonb,p_expected_version bigint default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare m public.lv_messages; targets uuid[];
begin
  perform private.require_admin();
  select * into m from public.lv_messages where id=p_id for update;
  if not found then raise exception '消息不存在或已到期清理';end if;
  if p_action='trash' and m.deleted_at is not null then return to_jsonb(m);end if;
  if p_action='restore' and m.deleted_at is null then return to_jsonb(m);end if;
  if p_expected_version is null or p_expected_version<>m.edit_version then
    raise exception '消息已被其他操作更新，请刷新后重新编辑' using errcode='40001';end if;
  if p_action='restore' then
    if m.deleted_at<=now()-interval '7 days' then raise exception '消息已超过七天保留期，无法恢复';end if;
    update public.lv_messages set deleted_at=null,enabled=false where id=p_id returning * into m;
  elsif m.deleted_at is not null then raise exception '请先从回收站恢复消息';
  elsif p_action='trash' then
    update public.lv_messages set deleted_at=now(),enabled=false where id=p_id returning * into m;
  elsif p_action='stop' then
    update public.lv_messages set enabled=false where id=p_id returning * into m;
  elsif p_action='edit' then
    if jsonb_typeof(p_data->'all_devices') is distinct from 'boolean' or jsonb_typeof(p_data->'enabled') is distinct from 'boolean'
      or jsonb_typeof(p_data->'target_ids') is distinct from 'array' then raise exception '消息范围或状态无效';end if;
    if jsonb_array_length(p_data->'target_ids')>1000 then raise exception '目标设备超过限制';end if;
    select coalesce(array_agg(distinct value::uuid),'{}'::uuid[]) into targets from jsonb_array_elements_text(p_data->'target_ids');
    if cardinality(targets)<>(select count(*) from public.lv_devices where id=any(targets)) then raise exception '目标设备列表已变化';end if;
    if p_data->>'kind'='update' and (coalesce(p_data->>'link','')='' or p_data->>'version_code' is null) then raise exception '版本更新需要链接和版本号';end if;
    update public.lv_messages set title=btrim(p_data->>'title'),body=btrim(p_data->>'body'),kind=p_data->>'kind',
      all_devices=(p_data->>'all_devices')::boolean,target_ids=targets,link=coalesce(p_data->>'link',''),
      version_code=(p_data->>'version_code')::integer,starts_at=(p_data->>'starts_at')::timestamptz,
      ends_at=(p_data->>'ends_at')::timestamptz,enabled=(p_data->>'enabled')::boolean where id=p_id returning * into m;
  else raise exception '未知消息操作';end if;
  insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'message_'||p_action,1);
  return to_jsonb(m);
end $$;

create or replace function public.lv_admin_message_management_ready() returns boolean
language plpgsql stable security definer set search_path='' as $$
begin perform private.require_admin();return true;end $$;

-- Tombstones cannot be returned to ordinary users, even if another RPC is added later.
drop policy if exists message_read on public.lv_messages;
create policy message_read on public.lv_messages for select to authenticated using(public.lv_admin_session_ready() or
  (deleted_at is null and enabled and now() between starts_at and ends_at and exists(
    select 1 from public.lv_devices d where d.owner_id=auth.uid() and (all_devices or d.id=any(target_ids)))));

create or replace function private.lv_purge_deleted_messages() returns integer
language plpgsql security definer set search_path='' as $$
declare doomed uuid[]; removed integer;
begin
  select coalesce(array_agg(id),'{}'::uuid[]) into doomed from (
    select id from public.lv_messages where deleted_at<=now()-interval '7 days'
    order by deleted_at limit 500 for update skip locked
  ) expired;
  delete from public.lv_receipts where message_id=any(doomed);
  delete from public.lv_messages where id=any(doomed);
  get diagnostics removed=row_count;
  return removed;
end $$;
revoke all on function private.lv_message_version(),private.lv_purge_deleted_messages() from public,anon,authenticated,service_role;
revoke all on function public.lv_message_manage(text,uuid,jsonb,bigint),public.lv_admin_message_management_ready() from public,anon;
grant execute on function public.lv_message_manage(text,uuid,jsonb,bigint),public.lv_admin_message_management_ready() to authenticated;

create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('liquidvivo-message-trash-purge','*/15 * * * *','select private.lv_purge_deleted_messages();');
commit;
