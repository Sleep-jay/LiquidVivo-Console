begin;
alter table public.lv_devices add column cloud_sponsor_revoked boolean not null default false;
create table private.lv_cloud_identity (
  device_id uuid primary key references public.lv_devices(id) on delete cascade,
  device_code text not null check(device_code ~ '^LV[12]-[A-Z2-7]{51}[AQ]$'),
  imported boolean not null default false
);
create table private.lv_installations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  device_id uuid not null references public.lv_devices(id) on delete cascade,
  created_at timestamptz not null default now()
);
create table private.lv_app_pairings (
  token_hash bytea primary key,user_id uuid not null references auth.users(id) on delete cascade,
  device_id uuid not null references public.lv_devices(id) on delete cascade,
  expires_at timestamptz not null
);
create table private.lv_imported_licenses (
  license_id uuid primary key,device_id uuid not null references public.lv_devices(id),license_text text not null check(length(license_text)<=16384)
);
create table private.lv_cloud_revision(id integer primary key check(id=1),revision bigint not null);
insert into private.lv_cloud_revision values(1,1);
alter table private.lv_cloud_identity enable row level security;
alter table private.lv_installations enable row level security;
alter table private.lv_app_pairings enable row level security;
alter table private.lv_imported_licenses enable row level security;
alter table private.lv_cloud_revision enable row level security;
revoke all on private.lv_cloud_identity,private.lv_installations,private.lv_app_pairings,private.lv_imported_licenses,private.lv_cloud_revision from public,anon,authenticated,service_role;

create function private.lv_touch_revision() returns trigger language plpgsql security definer set search_path='' as $$
begin update private.lv_cloud_revision set revision=revision+1 where id=1;return null;end $$;
create trigger lv_cloud_devices_revision after insert or update or delete on public.lv_devices for each statement execute function private.lv_touch_revision();
create trigger lv_cloud_grants_revision after insert or update or delete on public.lv_entitlements for each statement execute function private.lv_touch_revision();
create trigger lv_cloud_messages_revision after insert or update or delete on public.lv_messages for each statement execute function private.lv_touch_revision();
create trigger lv_cloud_campaigns_revision after insert or update or delete on public.lv_campaigns for each statement execute function private.lv_touch_revision();
create function private.lv_cloud_grant_change() returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='INSERT' then update public.lv_devices set cloud_sponsor_revoked=false where id=new.device_id;
  elsif new.revoked_at is not null and old.revoked_at is null then update public.lv_devices set cloud_sponsor_revoked=true where id=new.device_id;end if;
  return new;
end $$;
create trigger lv_cloud_grant_policy after insert or update on public.lv_entitlements for each row execute function private.lv_cloud_grant_change();

-- Called ONLY by the authenticated Edge Function using its server-side role.
-- Device identity is self-reported; it does not prove unforgeable physical hardware.
create function public.lv_cloud_exchange(p_actor uuid,p_code text,p_legacy text,p_version text,p_label text,p_receipts jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare h text; d public.lv_devices; existing uuid; token text; bound boolean; allowed boolean; grants jsonb; legacy jsonb; msgs jsonb; rec jsonb;
begin
  if p_code !~ '^LV2-[A-Z2-7]{51}[AQ]$' or length(p_version)>40 or length(p_label)>120 then raise exception 'Invalid device input';end if;
  if not exists(select 1 from auth.users where id=p_actor) then raise exception 'Invalid actor';end if;
  h=encode(extensions.digest('LiquidVivo/console/device/v1'||chr(10)||p_code,'sha256'),'hex');
  select device_id into existing from private.lv_installations where user_id=p_actor;
  if existing is not null and not exists(select 1 from public.lv_devices where id=existing and device_hash=h) then raise exception 'Installation already registered';end if;
  select * into d from public.lv_devices where device_hash=h for update;
  if not found then
    -- Associate an imported LV1 record only when the caller also supplies that exact derived alias.
    if p_legacy ~ '^LV1-[A-Z2-7]{51}[AQ]$' then
      select x.* into d from public.lv_devices x join private.lv_cloud_identity i on i.device_id=x.id
        where i.imported and i.device_code=p_legacy and not exists(select 1 from private.lv_installations where device_id=x.id) for update of x;
    end if;
    if d.id is null then
      insert into public.lv_devices(device_hash,label,app_version,last_seen) values(h,p_label,p_version,now()) returning * into d;
    else update public.lv_devices set device_hash=h where id=d.id returning * into d;end if;
  end if;
  allowed=existing=d.id or d.owner_id=p_actor;
  if not coalesce(allowed,false) and d.owner_id is null and not exists(select 1 from private.lv_installations where device_id=d.id) then allowed=true;end if;
  if allowed then
    insert into private.lv_installations(user_id,device_id) values(p_actor,d.id) on conflict(user_id) do nothing;
    insert into private.lv_cloud_identity(device_id,device_code) values(d.id,p_code)
      on conflict(device_id) do update set device_code=excluded.device_code;
    update public.lv_devices set last_seen=now(),app_version=p_version where id=d.id;
  end if;
  bound=d.owner_id is not null;
  token='';
  if (allowed and not bound) or not coalesce(allowed,false) then
    delete from private.lv_app_pairings where expires_at<now() or (user_id=p_actor and device_id=d.id);
    token=encode(extensions.gen_random_bytes(16),'hex');
    insert into private.lv_app_pairings(token_hash,user_id,device_id,expires_at) values(extensions.digest(token,'sha256'),p_actor,d.id,now()+interval '15 minutes');
  end if;
  grants='[]';legacy='[]';msgs='[]';
  if allowed and not d.blocked and not d.cloud_sponsor_revoked then
    select coalesce(jsonb_agg(to_jsonb(g)),'[]') into grants from (
      select id,features,starts_at,ends_at,created_at from public.lv_entitlements where device_id=d.id and revoked_at is null
        and starts_at<=now() and (ends_at is null or ends_at>now()) order by ends_at nulls first limit 24
    ) g;
    select grants||coalesce(jsonb_agg(to_jsonb(g)),'[]') into grants from (
      select id,features,starts_at,ends_at,created_at from public.lv_campaigns where enabled and starts_at<=now() and ends_at>now() order by ends_at desc limit 8
    ) g;
    select coalesce(jsonb_agg(l.license_text),'[]') into legacy from private.lv_imported_licenses l
      join public.lv_entitlements e on e.id=l.license_id and e.device_id=l.device_id
      where l.device_id=d.id and e.revoked_at is null and e.starts_at<=now() and (e.ends_at is null or e.ends_at>now());
  end if;
  if allowed then
    select coalesce(jsonb_agg(to_jsonb(m)),'[]') into msgs from (
      select id,title,body,kind,link,version_code,starts_at,ends_at from public.lv_messages
      where enabled and now() between starts_at and ends_at and (all_devices or d.id=any(target_ids)) order by created_at desc limit 20
    ) m;
    if jsonb_typeof(p_receipts)='array' and jsonb_array_length(p_receipts)<=40 then
      for rec in select value from jsonb_array_elements(p_receipts) loop
        if exists(select 1 from public.lv_messages m where m.id=(rec->>'id')::uuid and (m.all_devices or d.id=any(m.target_ids))) then
          insert into public.lv_receipts(message_id,device_id,received_at,displayed_at) values((rec->>'id')::uuid,d.id,now(),case when rec->>'state'='displayed' then now() else null end)
          on conflict(message_id,device_id) do update set received_at=coalesce(lv_receipts.received_at,excluded.received_at),displayed_at=coalesce(lv_receipts.displayed_at,excluded.displayed_at);
        end if;
      end loop;
    end if;
  end if;
  return jsonb_build_object('revision',(select revision::text from private.lv_cloud_revision where id=1),'device_code',p_code,
    'blocked',d.blocked,'sponsor_revoked',d.cloud_sponsor_revoked,'bound',bound and coalesce(allowed,false),
    'installation_authorized',coalesce(allowed,false),
    'revoked_license_ids',(select coalesce(jsonb_agg(id::text),'[]') from public.lv_entitlements where device_id=d.id and revoked_at is not null),
    'pairing_token',token,'grants',grants,'legacy_licenses',legacy,'messages',msgs);
end $$;

-- One code works for first binding and for linking a reinstalled App to the existing owner.
create or replace function public.lv_bind_device(p_hash text,p_token text) returns uuid language plpgsql security definer set search_path='' as $$
declare d public.lv_devices; pairing public.lv_pairings; app_pair private.lv_app_pairings;
begin
  if auth.uid() is null or coalesce((auth.jwt()->>'is_anonymous')::boolean,false) then raise exception '请先登录网页账号';end if;
  if p_token !~ '^[0-9a-f]{32}$' then raise exception '设备或配对凭证无效';end if;
  select * into d from public.lv_devices where device_hash=p_hash for update;
  if not found or d.blocked then raise exception '设备或配对凭证无效';end if;
  if d.owner_id is not null and d.owner_id<>auth.uid() then raise exception '设备已绑定其他账号';end if;
  if exists(select 1 from public.lv_devices where owner_id=auth.uid() and id<>d.id) then raise exception '账号已绑定其他设备';end if;
  select * into app_pair from private.lv_app_pairings where token_hash=extensions.digest(p_token,'sha256') and device_id=d.id and expires_at>now() for update;
  if found then
    if exists(select 1 from private.lv_installations where user_id=app_pair.user_id and device_id<>d.id) then raise exception '配对凭证无效';end if;
    insert into private.lv_installations(user_id,device_id) values(app_pair.user_id,d.id) on conflict(user_id) do nothing;
    delete from private.lv_app_pairings where token_hash=app_pair.token_hash;
  else
    select * into pairing from public.lv_pairings where device_id=d.id for update;
    if not found or pairing.consumed_at is not null or pairing.expires_at<=now() or pairing.token_hash<>extensions.digest(p_token,'sha256') then raise exception '设备或配对凭证无效';end if;
    update public.lv_pairings set consumed_at=now() where device_id=d.id;
  end if;
  update public.lv_devices set owner_id=auth.uid() where id=d.id;
  insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'app_pair',1);
  return d.id;
end $$;

-- Owner-side migration entry, not exposed to browser roles.
create function private.lv_import_legacy(p_rows jsonb,p_blocked jsonb) returns integer language plpgsql security definer set search_path='' as $$
declare r jsonb; did uuid; n integer=0; h text;
begin
  if jsonb_typeof(p_rows)<>'array' or jsonb_array_length(p_rows)>1000 then raise exception 'Import budget';end if;
  for r in select value from jsonb_array_elements(p_rows) loop
    h=encode(extensions.digest('LiquidVivo/console/device/v1'||chr(10)||(r->>'device_code'),'sha256'),'hex');
    if exists(select 1 from private.lv_imported_licenses l join public.lv_devices d on d.id=l.device_id
      where l.license_id=(r->>'license_id')::uuid and (d.device_hash<>h or l.license_text<>r->>'license_text')) then
      raise exception 'Existing license identity conflict';
    end if;
    insert into public.lv_devices(device_hash,label,note) values(h,'既有赞助设备',coalesce(r->>'note',''))
      on conflict(device_hash) do update set note=case when lv_devices.note='' then excluded.note else lv_devices.note end returning id into did;
    insert into private.lv_cloud_identity(device_id,device_code,imported) values(did,r->>'device_code',true) on conflict(device_id) do nothing;
    insert into private.lv_imported_licenses(license_id,device_id,license_text) values((r->>'license_id')::uuid,did,r->>'license_text') on conflict(license_id) do nothing;
    if exists(select 1 from public.lv_entitlements where id=(r->>'license_id')::uuid and device_id<>did) then
      raise exception 'Existing entitlement identity conflict';
    end if;
    insert into public.lv_entitlements(id,device_id,features,starts_at,ends_at)
      values((r->>'license_id')::uuid,did,array(select jsonb_array_elements_text(r->'features')),(r->>'issued_at')::timestamptz,(r->>'expires_at')::timestamptz)
      on conflict(id) do nothing;
    n=n+1;
  end loop;
  for r in select value from jsonb_array_elements(p_blocked) loop
    if r->>'kind' not in ('blocked_devices','revoked_devices') or r->>'device_code' !~ '^LV[12]-[A-Z2-7]{51}[AQ]$' then
      raise exception 'Invalid policy import';
    end if;
    h=encode(extensions.digest('LiquidVivo/console/device/v1'||chr(10)||(r->>'device_code'),'sha256'),'hex');
    insert into public.lv_devices(device_hash,label,note,blocked,cloud_sponsor_revoked)
      values(h,'受限设备',coalesce(r->>'note',''),r->>'kind'='blocked_devices',r->>'kind'='revoked_devices')
      on conflict(device_hash) do update set blocked=lv_devices.blocked or excluded.blocked,
        cloud_sponsor_revoked=lv_devices.cloud_sponsor_revoked or excluded.cloud_sponsor_revoked,
        note=case when lv_devices.note='' then excluded.note else lv_devices.note end;
  end loop;
  return n;
end $$;
revoke all on function private.lv_import_legacy(jsonb,jsonb),private.lv_touch_revision(),private.lv_cloud_grant_change() from public,anon,authenticated,service_role;
revoke all on function public.lv_cloud_exchange(uuid,text,text,text,text,jsonb) from public,anon,authenticated;
grant execute on function public.lv_cloud_exchange(uuid,text,text,text,text,jsonb) to service_role;
commit;
select 'App 连接与既有授权导入接口已创建' as result;
