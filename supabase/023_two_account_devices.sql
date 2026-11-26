begin;

alter table public.lv_devices add column owner_slot smallint;
update public.lv_devices set owner_slot=1 where owner_id is not null;
alter table public.lv_devices
  drop constraint lv_devices_owner_id_key,
  add constraint lv_devices_owner_slot_check check (
    (owner_id is null and owner_slot is null) or
    (owner_id is not null and owner_slot is not null and owner_slot in (1,2))
  ),
  add constraint lv_devices_owner_slot_key unique(owner_id,owner_slot);

-- Allocate a free slot without changing any other device. The unique constraint
-- also protects owner assignment from concurrent or out-of-band writers.
create function private.lv_assign_device_slot()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.owner_id is null then
    new.owner_slot=null;
    return new;
  end if;
  if tg_op='UPDATE' and new.owner_id is not distinct from old.owner_id then
    new.owner_slot=old.owner_slot;
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('lv_member_device:'||new.owner_id::text,0));
  select s.slot into new.owner_slot from generate_series(1,2) as s(slot)
  where not exists(select 1 from public.lv_devices d where d.owner_id=new.owner_id and d.owner_slot=s.slot)
  order by s.slot limit 1;
  if not found then raise exception 'Device limit reached (2)' using errcode='P0001'; end if;
  return new;
end $$;
revoke all on function private.lv_assign_device_slot() from public,anon,authenticated,service_role;
create trigger lv_assign_device_slot before insert or update of owner_id,owner_slot
on public.lv_devices for each row execute function private.lv_assign_device_slot();

create or replace function public.lv_bind_device(p_hash text,p_token text) returns uuid language plpgsql security definer set search_path='' as $$
declare d public.lv_devices; pairing public.lv_pairings; app_pair private.lv_app_pairings; member uuid:=auth.uid();
begin
  if not public.lv_user_session_active() or not exists(
    select 1 from auth.users where id=member and is_anonymous is false and email_confirmed_at is not null
  ) then raise exception '请先登录并验证邮箱' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended('lv_member_device:'||member::text,0));
  if p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
    or p_token is null or p_token !~ '^[0-9a-f]{32}$'
  then raise exception '设备或配对凭证无效';end if;
  select * into d from public.lv_devices where device_hash=p_hash for update;
  if not found or d.blocked then raise exception '设备或配对凭证无效';end if;
  if d.owner_id is not null and d.owner_id<>auth.uid() then raise exception '设备已绑定其他账号';end if;
  if d.owner_id is null and exists (
    select 1 from private.lv_imported_licenses l
    join public.lv_entitlements e on e.id=l.license_id and e.device_id=l.device_id
    where l.device_id=d.id and e.account_id is null and e.revoked_at is null
      and (e.ends_at is null or e.ends_at>now())
  ) then raise exception '请使用迁移旧赞助入口';end if;
  select * into app_pair from private.lv_app_pairings where token_hash=extensions.digest(p_token,'sha256') and device_id=d.id and expires_at>now() for update;
  if found then
    if exists(select 1 from private.lv_installations where user_id=app_pair.user_id and device_id<>d.id) then raise exception '配对凭证无效';end if;
    insert into private.lv_installations(user_id,device_id) values(app_pair.user_id,d.id) on conflict(user_id) do nothing;
    delete from private.lv_app_pairings where token_hash=app_pair.token_hash;
  else
    if d.owner_id is distinct from member and exists(select 1 from public.lv_devices where owner_id=member) then raise exception '请使用新手机生成的一次性配对码';end if;
    select * into pairing from public.lv_pairings where device_id=d.id for update;
    if not found or pairing.consumed_at is not null or pairing.expires_at<=now() or pairing.token_hash<>extensions.digest(p_token,'sha256') then raise exception '设备或配对凭证无效';end if;
    update public.lv_pairings set consumed_at=now() where device_id=d.id;
  end if;
  update public.lv_devices set owner_id=member where id=d.id;
  insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'app_pair',1);
  return d.id;
end $$;

create or replace function public.lv_connect_sponsor_account(
  p_actor uuid,p_installation uuid,p_code text,p_license_id uuid default null
) returns text language plpgsql security definer set search_path='' as $$
declare
  device public.lv_devices;
  migrated boolean:=false;
begin
  if p_code is null or p_code !~ '^LV2-[A-Z2-7]{51}[AQ]$' then return 'device_unavailable'; end if;
  perform pg_advisory_xact_lock(hashtextextended('lv_member_device:'||p_actor::text,0));
  perform 1 from auth.users u where u.id=p_actor and u.is_anonymous is false
    and u.email_confirmed_at is not null and (u.banned_until is null or u.banned_until<=now()) for update;
  if not found or exists(select 1 from private.lv_account_controls where user_id=p_actor and blocked)
    then return 'account_unavailable'; end if;
  select d.* into device from public.lv_devices d join private.lv_installations i on i.device_id=d.id
    where i.user_id=p_installation
      and d.device_hash=encode(extensions.digest('LiquidVivo/console/device/v1'||chr(10)||p_code,'sha256'),'hex') for update of d;
  if not found then return 'device_unavailable'; end if;
  if device.blocked or device.cloud_sponsor_revoked then return 'device_restricted'; end if;
  if device.owner_id is not null and device.owner_id<>p_actor then return 'owned_by_another_account'; end if;
  if device.owner_id is distinct from p_actor and
      (select count(*) from public.lv_devices where owner_id=p_actor)>=2 then
    return 'device_limit_reached';
  end if;
  perform id from public.lv_entitlements where device_id=device.id order by id for update;
  if exists(select 1 from private.lv_imported_licenses l join public.lv_entitlements e on e.id=l.license_id
      where l.device_id=device.id and e.device_id=device.id and e.account_id is null and e.revoked_at is null
        and e.starts_at<=now() and (e.ends_at is null or e.ends_at>now())) then
    if p_license_id is null then return 'original_license_required'; end if;
    if not exists(select 1 from private.lv_imported_licenses l join public.lv_entitlements e on e.id=l.license_id
      where l.license_id=p_license_id and l.device_id=device.id and e.device_id=device.id
        and e.account_id is null and e.revoked_at is null and e.starts_at<=now()
        and (e.ends_at is null or e.ends_at>now())) then return 'legacy_claim_denied'; end if;
    migrated=true;
  end if;
  if device.owner_id is distinct from p_actor then
    update public.lv_devices set owner_id=p_actor where id=device.id;
  end if;
  -- Preserve IDs, features, dates, revocation and every existing account owner.
  update public.lv_entitlements set account_id=p_actor
    where device_id=device.id and account_id is null and revoked_at is null;
  delete from private.lv_app_pairings where device_id=device.id and user_id=p_installation;
  if migrated or device.owner_id is distinct from p_actor then
    insert into public.lv_audit(actor,action,target_count) values(p_actor,'app_account_connect',1);
  end if;
  return case when migrated then 'migrated' else 'connected' end;
end $$;

create or replace function public.lv_claim_legacy_sponsor(p_actor uuid, p_license_id uuid, p_pairing_token text)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  device public.lv_devices;
begin
  perform pg_advisory_xact_lock(hashtextextended('lv_member_device:'||p_actor::text,0));
  perform 1 from auth.users u
    where u.id=p_actor and not u.is_anonymous and u.email_confirmed_at is not null
      and (u.banned_until is null or u.banned_until<=now())
    for update;
  if not found or exists(select 1 from private.lv_account_controls c
      where c.user_id=p_actor and c.blocked) then return false; end if;

  select d.* into device from private.lv_imported_licenses l
    join public.lv_devices d on d.id=l.device_id
    where l.license_id=p_license_id for update of d;
  if not found or device.blocked or device.cloud_sponsor_revoked
      or (device.owner_id is not null and device.owner_id<>p_actor) then return false; end if;

  perform 1 from public.lv_entitlements e
    where e.id=p_license_id and e.device_id=device.id and e.revoked_at is null
      and e.starts_at<=now() and (e.ends_at is null or e.ends_at>now())
    for update;
  if not found then return false; end if;
  if device.owner_id=p_actor then return true; end if;
  if (select count(*) from public.lv_devices d where d.owner_id=p_actor)>=2
    then return false; end if;

  -- Legacy files were previously returned by cloud-sync. Require a separate
  -- pairing token issued by an administrator after verifying the holder.
  if p_pairing_token is null or p_pairing_token !~ '^[0-9a-f]{32}$' then return false; end if;
  update public.lv_pairings set consumed_at=now()
    where device_id=device.id and consumed_at is null and expires_at>now()
      and token_hash=extensions.digest('LiquidVivo/legacy-sponsor-pair/v1:'||p_pairing_token,'sha256');
  if not found then return false; end if;

  update public.lv_devices set owner_id=p_actor where id=device.id;
  insert into public.lv_audit(actor,action,target_count) values(p_actor,'legacy_sponsor_claim',1);
  return true;
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
     perform pg_advisory_xact_lock(hashtextextended('lv_member_device:'||op.target_id::text,0));
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
     update public.lv_devices set owner_id=op.target_id where id=d.id;
   end if;
 end if;
 update private.lv_account_operations set status=case when p_success then 'completed' else 'failed' end where request_id=p_request;
 insert into public.lv_audit(actor,action,target_count) values(op.actor,'account_'||op.action||case when p_success then '' else '_failed' end,1);
 return p_success;
end $$;


create function public.lv_unbind_my_device(p_device uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare actor uuid:=auth.uid();
begin
  if not public.lv_user_session_active() or not exists(
    select 1 from auth.users where id=actor and is_anonymous is false and email_confirmed_at is not null
  ) then raise exception 'Verified account required' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended('lv_member_device:'||actor::text,0));
  update public.lv_devices set owner_id=null where id=p_device and owner_id=actor;
  if not found then return false; end if;
  insert into public.lv_audit(actor,action,target_count) values(actor,'member_device_unbind',1);
  return true;
end $$;
revoke all on function public.lv_unbind_my_device(uuid) from public,anon;
grant execute on function public.lv_unbind_my_device(uuid) to authenticated;

create function public.lv_sponsor_bound_device(p_actor uuid,p_installation uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(
    select 1 from private.lv_installations i
    join public.lv_devices d on d.id=i.device_id
    join auth.users u on u.id=i.user_id
    where i.user_id=p_installation and u.is_anonymous is true
      and d.owner_id=p_actor and not d.blocked and not d.cloud_sponsor_revoked
  )
$$;
revoke all on function public.lv_sponsor_bound_device(uuid,uuid) from public,anon,authenticated;
grant execute on function public.lv_sponsor_bound_device(uuid,uuid) to service_role;
notify pgrst,'reload schema';
commit;
