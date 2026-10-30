-- Execute once in the project SQL Editor. No license keys or device identifiers are embedded.
begin;
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
create extension if not exists pgcrypto with schema extensions;

create table public.lv_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table public.lv_devices (
  id uuid primary key default gen_random_uuid(),
  device_hash text not null unique check (device_hash ~ '^[0-9a-f]{64}$'),
  owner_id uuid unique references auth.users(id) on delete set null,
  label text not null default '' check (length(label)<=120),
  note text not null default '' check (length(note)<=2000),
  blocked boolean not null default false,
  app_version text not null default '' check (length(app_version)<=40),
  last_seen timestamptz,
  created_at timestamptz not null default now()
);
create table public.lv_pairings (
  device_id uuid primary key references public.lv_devices(id) on delete cascade,
  token_hash bytea not null,
  expires_at timestamptz not null,
  consumed_at timestamptz
);
create table public.lv_entitlements (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references public.lv_devices(id),
  features text[] not null check (cardinality(features) between 1 and 2 and features <@ array['notification_island','status_bar']::text[]),
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  check (ends_at is null or ends_at>starts_at)
);
create table public.lv_campaigns (
  id uuid primary key default gen_random_uuid(), title text not null check (length(title) between 1 and 120),
  features text[] not null check (cardinality(features) between 1 and 2 and features <@ array['notification_island','status_bar']::text[]),
  starts_at timestamptz not null, ends_at timestamptz not null,
  enabled boolean not null default true, created_at timestamptz not null default now(),
  check (ends_at>starts_at)
);
create table public.lv_messages (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 120),
  body text not null check (length(body) between 1 and 4000),
  kind text not null check (kind in ('dialog','banner','changelog','update','notification')),
  all_devices boolean not null,
  target_ids uuid[] not null default '{}',
  link text not null default '' check (link='' or (length(link)<=1000 and link ~ '^https://')),
  version_code integer check(version_code>0),
  starts_at timestamptz not null, ends_at timestamptz not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  check(ends_at>starts_at),
  check((all_devices and cardinality(target_ids)=0) or (not all_devices and cardinality(target_ids) between 1 and 1000))
);
create table public.lv_receipts (
  message_id uuid not null references public.lv_messages(id), device_id uuid not null references public.lv_devices(id),
  received_at timestamptz, displayed_at timestamptz,
  primary key(message_id,device_id)
);
create table public.lv_audit (
  id bigint generated always as identity primary key,
  actor uuid not null, action text not null, target_count integer not null,
  created_at timestamptz not null default now()
);
create index on public.lv_messages (created_at desc);
create index on public.lv_entitlements (device_id);

create function public.lv_is_admin() returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.lv_admins where user_id=auth.uid())
$$;
create function private.require_admin() returns void language plpgsql security definer set search_path='' as $$
begin
  if not public.lv_is_admin() or coalesce(auth.jwt()->>'aal','')<>'aal2' then
    raise exception '管理员操作需要二次验证' using errcode='42501';
  end if;
end $$;

alter table public.lv_admins enable row level security;
alter table public.lv_devices enable row level security;
alter table public.lv_pairings enable row level security;
alter table public.lv_entitlements enable row level security;
alter table public.lv_campaigns enable row level security;
alter table public.lv_messages enable row level security;
alter table public.lv_receipts enable row level security;
alter table public.lv_audit enable row level security;
revoke all on public.lv_admins,public.lv_devices,public.lv_pairings,public.lv_entitlements,public.lv_campaigns,public.lv_messages,public.lv_receipts,public.lv_audit from anon,authenticated;
grant select on public.lv_admins,public.lv_devices,public.lv_entitlements,public.lv_campaigns,public.lv_messages,public.lv_receipts,public.lv_audit to authenticated;
create policy admin_self on public.lv_admins for select to authenticated using(user_id=auth.uid());
create policy device_read on public.lv_devices for select to authenticated using(
  owner_id=auth.uid() or (public.lv_is_admin() and auth.jwt()->>'aal'='aal2'));
create policy entitlement_read on public.lv_entitlements for select to authenticated using(
  exists(select 1 from public.lv_devices d where d.id=device_id and d.owner_id=auth.uid())
  or (public.lv_is_admin() and auth.jwt()->>'aal'='aal2'));
create policy campaign_read on public.lv_campaigns for select to authenticated using(
  (enabled and exists(select 1 from public.lv_devices where owner_id=auth.uid()))
  or (public.lv_is_admin() and auth.jwt()->>'aal'='aal2'));
create policy message_read on public.lv_messages for select to authenticated using(
  (public.lv_is_admin() and auth.jwt()->>'aal'='aal2') or
  (enabled and now() between starts_at and ends_at and exists(select 1 from public.lv_devices d
    where d.owner_id=auth.uid() and (all_devices or d.id=any(target_ids)))));
create policy receipt_read on public.lv_receipts for select to authenticated using(
  (public.lv_is_admin() and auth.jwt()->>'aal'='aal2') or exists(select 1 from public.lv_devices d where d.id=device_id and d.owner_id=auth.uid()));
create policy audit_read on public.lv_audit for select to authenticated using(public.lv_is_admin() and auth.jwt()->>'aal'='aal2');

create function public.lv_bind_device(p_hash text,p_token text) returns uuid
language plpgsql security definer set search_path='' as $$
declare d public.lv_devices; pairing public.lv_pairings;
begin
  if auth.uid() is null then raise exception '请先登录'; end if;
  if length(p_token)<>32 or p_token !~ '^[0-9a-f]{32}$' then raise exception '设备或配对凭证无效'; end if;
  select * into d from public.lv_devices where device_hash=p_hash for update;
  if not found then raise exception '设备或配对凭证无效'; end if;
  if d.owner_id is not null or d.blocked or exists(select 1 from public.lv_devices where owner_id=auth.uid()) then
    raise exception '设备无法绑定，请联系管理员'; end if;
  select * into pairing from public.lv_pairings where device_id=d.id for update;
  if not found or pairing.consumed_at is not null or pairing.expires_at<=now()
      or pairing.token_hash<>extensions.digest(p_token,'sha256') then raise exception '设备或配对凭证无效'; end if;
  update public.lv_devices set owner_id=auth.uid() where id=d.id;
  update public.lv_pairings set consumed_at=now() where device_id=d.id;
  insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'bind',1);
  return d.id;
end $$;

create function public.lv_provision_device(p_hash text,p_label text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare did uuid; token text;
begin
  perform private.require_admin();
  insert into public.lv_devices(device_hash,label) values(p_hash,p_label)
    on conflict(device_hash) do update set label=excluded.label returning id into did;
  if exists(select 1 from public.lv_devices where id=did and (owner_id is not null or blocked)) then
    raise exception '设备已绑定或被封禁，未签发配对凭证'; end if;
  token=encode(extensions.gen_random_bytes(16),'hex');
  insert into public.lv_pairings(device_id,token_hash,expires_at) values(did,extensions.digest(token,'sha256'),now()+interval '15 minutes')
    on conflict(device_id) do update set token_hash=excluded.token_hash,expires_at=excluded.expires_at,consumed_at=null;
  insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'provision',1);
  return jsonb_build_object('id',did,'pairing_token',token,'expires_in',900);
end $$;

create function public.lv_manage(p_action text,p_ids uuid[],p_data jsonb) returns integer
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
      insert into public.lv_entitlements(device_id,features,starts_at,ends_at)
        select v,feature_list,now(),(p_data->>'ends_at')::timestamptz from unnest(p_ids) v;
    when 'revoke' then update public.lv_entitlements set revoked_at=now() where device_id=any(p_ids) and revoked_at is null;
    when 'unbind' then
      update public.lv_devices set owner_id=null where id=any(p_ids);
      delete from public.lv_pairings where device_id=any(p_ids);
    else raise exception '未知操作';
  end case;
  insert into public.lv_audit(actor,action,target_count) values(auth.uid(),p_action,n);
  return n;
end $$;

create function public.lv_publish(p_type text,p_data jsonb) returns uuid
language plpgsql security definer set search_path='' as $$
declare item uuid; targets uuid[]; features text[];
begin
  perform private.require_admin();
  if p_type='campaign' then
    select array_agg(value) into features from jsonb_array_elements_text(p_data->'features');
    insert into public.lv_campaigns(title,features,starts_at,ends_at)
      values(p_data->>'title',features,(p_data->>'starts_at')::timestamptz,(p_data->>'ends_at')::timestamptz) returning id into item;
  elsif p_type='message' then
    select coalesce(array_agg(value::uuid),'{}'::uuid[]) into targets from jsonb_array_elements_text(p_data->'target_ids');
    if cardinality(targets)<>(select count(*) from public.lv_devices where id=any(targets)) then raise exception '目标设备不完整'; end if;
    insert into public.lv_messages(title,body,kind,all_devices,target_ids,link,version_code,starts_at,ends_at)
      values(p_data->>'title',p_data->>'body',p_data->>'kind',(p_data->>'all_devices')::boolean,targets,
        coalesce(p_data->>'link',''),(p_data->>'version_code')::integer,(p_data->>'starts_at')::timestamptz,(p_data->>'ends_at')::timestamptz) returning id into item;
  else raise exception '未知内容类型'; end if;
  insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'publish_'||p_type,1);
  return item;
end $$;
create function public.lv_disable(p_type text,p_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  perform private.require_admin();
  if p_type='campaign' then update public.lv_campaigns set enabled=false where id=p_id;
  elsif p_type='message' then update public.lv_messages set enabled=false where id=p_id;
  else raise exception '未知内容类型'; end if;
  if not found then raise exception '记录不存在'; end if;
  insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'disable_'||p_type,1);
end $$;
-- No table writes from clients. Privileged functions are the only mutation path.
revoke all on function public.lv_is_admin(),public.lv_bind_device(text,text),public.lv_provision_device(text,text),public.lv_manage(text,uuid[],jsonb),public.lv_publish(text,jsonb),public.lv_disable(text,uuid) from public,anon;
grant execute on function public.lv_is_admin(),public.lv_bind_device(text,text),public.lv_provision_device(text,text),public.lv_manage(text,uuid[],jsonb),public.lv_publish(text,jsonb),public.lv_disable(text,uuid) to authenticated;
revoke all on function private.require_admin() from public,anon,authenticated;
commit;
