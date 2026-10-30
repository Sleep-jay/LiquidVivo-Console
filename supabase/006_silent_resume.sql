begin;
-- Only the Edge service can call this, after independently validating a signed
-- license as proof. It reconnects an installation, never changes website ownership.
create or replace function public.lv_cloud_resume(p_actor uuid,p_code text,p_license_id uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare d public.lv_devices;
begin
  if p_code is null or p_code !~ '^LV2-[A-Z2-7]{51}[AQ]$' then return false;end if;
  if not exists(select 1 from auth.users where id=p_actor) then return false;end if;
  select * into d from public.lv_devices where device_hash=encode(extensions.digest('LiquidVivo/console/device/v1'||chr(10)||p_code,'sha256'),'hex') for update;
  if not found or d.blocked or d.cloud_sponsor_revoked then return false;end if;
  if exists(select 1 from private.lv_installations where user_id=p_actor and device_id<>d.id) then return false;end if;
  if not exists(select 1 from public.lv_entitlements where id=p_license_id and device_id=d.id and revoked_at is null
    and starts_at<=now() and (ends_at is null or ends_at>now())) then return false;end if;
  insert into private.lv_installations(user_id,device_id) values(p_actor,d.id) on conflict(user_id) do nothing;
  delete from private.lv_app_pairings where user_id=p_actor and device_id=d.id;
  return true;
end $$;
revoke all on function public.lv_cloud_resume(uuid,text,uuid) from public,anon,authenticated;
grant execute on function public.lv_cloud_resume(uuid,text,uuid) to service_role;
commit;
