begin;

-- The Edge function verifies a root-signed legacy license before calling this RPC.
create or replace function public.lv_claim_legacy_sponsor(p_actor uuid, p_license_id uuid, p_pairing_token text)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  device public.lv_devices;
begin
  -- Serialize claims for the same account, including claims for different devices.
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
  if exists(select 1 from public.lv_devices d where d.owner_id=p_actor and d.id<>device.id)
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

revoke all on function public.lv_claim_legacy_sponsor(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.lv_claim_legacy_sponsor(uuid,uuid,text) to service_role;

create or replace function public.lv_issue_legacy_sponsor_pairing(p_device_id uuid)
returns text language plpgsql security definer set search_path='' as $$
declare
  device public.lv_devices;
  token text;
begin
  perform private.require_admin();
  select * into device from public.lv_devices where id=p_device_id for update;
  if not found or device.blocked or device.cloud_sponsor_revoked or device.owner_id is not null
    or not exists(select 1 from private.lv_imported_licenses l
      join public.lv_entitlements e on e.id=l.license_id and e.device_id=l.device_id
      where l.device_id=p_device_id and e.revoked_at is null
        and e.starts_at<=now() and (e.ends_at is null or e.ends_at>now()))
  then raise exception '此设备没有可迁移的旧赞助'; end if;

  token=encode(extensions.gen_random_bytes(16),'hex');
  insert into public.lv_pairings(device_id,token_hash,expires_at)
    values(p_device_id,extensions.digest('LiquidVivo/legacy-sponsor-pair/v1:'||token,'sha256'),now()+interval '15 minutes')
    on conflict(device_id) do update set token_hash=excluded.token_hash,
      expires_at=excluded.expires_at,consumed_at=null;
  insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'legacy_sponsor_pair_issued',1);
  return token;
end $$;

revoke all on function public.lv_issue_legacy_sponsor_pairing(uuid) from public,anon;
grant execute on function public.lv_issue_legacy_sponsor_pairing(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
