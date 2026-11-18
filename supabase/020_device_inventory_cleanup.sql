begin;

create index if not exists lv_devices_inventory_order
  on public.lv_devices(created_at desc,id desc);

create or replace function private.lv_device_cleanup_eligible(d public.lv_devices, cutoff timestamptz)
returns boolean language sql stable set search_path='' as $$
  select d.last_seen <= cutoff
    and d.owner_id is null and not d.blocked and not d.cloud_sponsor_revoked
    and not exists(select 1 from public.lv_entitlements x where x.device_id=d.id)
    and not exists(select 1 from public.lv_sponsor_orders x where x.device_id=d.id)
    and not exists(select 1 from private.lv_imported_licenses x where x.device_id=d.id)
    and not exists(select 1 from private.lv_cloud_identity x where x.device_id=d.id and x.imported)
    and not exists(select 1 from public.lv_receipts x where x.device_id=d.id)
    and not exists(select 1 from public.lv_campaign_claims x where x.device_id=d.id)
    and not exists(select 1 from private.lv_campaign_code_device_uses x where x.device_id=d.id)
    and not exists(select 1 from private.lv_campaign_redemptions x where x.device_id=d.id)
    and not exists(select 1 from private.lv_push_deliveries x where x.device_id=d.id)
    and not exists(select 1 from private.lv_security_events x where x.device_id=d.id)
    and not exists(select 1 from public.lv_messages x where not x.all_devices and d.id=any(x.target_ids))
    and not exists(select 1 from public.lv_pairings x where x.device_id=d.id and x.expires_at>now())
    and not exists(select 1 from private.lv_app_pairings x where x.device_id=d.id and x.expires_at>now())
    and not exists(select 1 from private.lv_installations x join auth.users u on u.id=x.user_id
      where x.device_id=d.id and u.is_anonymous is distinct from true);
$$;
revoke all on function private.lv_device_cleanup_eligible(public.lv_devices,timestamptz) from public,anon,authenticated;

create or replace function public.lv_admin_device_page(p_before timestamptz default null,p_before_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  perform private.require_admin();
  if (p_before is null)<>(p_before_id is null) then raise exception '设备分页游标无效'; end if;
  return (
    with page as materialized (
      select d.*, coalesce(d.last_seen <= now()-interval '168 hours',false) as inactive_week,
        coalesce(private.lv_device_cleanup_eligible(d,now()-interval '168 hours'),false) as cleanup_eligible
      from public.lv_devices d
      where p_before is null or (d.created_at,d.id)<(p_before,p_before_id)
      order by d.created_at desc,d.id desc limit 250
    )
    select coalesce(jsonb_agg(to_jsonb(page) order by page.created_at desc,page.id desc),'[]'::jsonb) from page
  );
end $$;

create or replace function public.lv_admin_cleanup_devices(p_ids uuid[])
returns integer language plpgsql security definer set search_path='' as $$
declare removed integer;
begin
  perform private.require_admin();
  if p_ids is null or cardinality(p_ids) not between 1 and 3000
    or cardinality(p_ids)<>(select count(distinct x) from unnest(p_ids) x)
  then raise exception '请选择 1 至 3000 台不同的设备'; end if;
  perform id from public.lv_devices where id=any(p_ids) order by id for update;
  delete from public.lv_devices d where d.id=any(p_ids)
    and private.lv_device_cleanup_eligible(d,now()-interval '168 hours');
  get diagnostics removed=row_count;
  if removed<>cardinality(p_ids) then raise exception '设备状态已变化或有受保护记录，未删除任何设备，请刷新后重新选择'; end if;
  insert into public.lv_audit(actor,action,target_count) values(auth.uid(),'cleanup_inactive_devices',removed);
  return removed;
end $$;
revoke all on function public.lv_admin_device_page(timestamptz,uuid),public.lv_admin_cleanup_devices(uuid[]) from public,anon;
grant execute on function public.lv_admin_device_page(timestamptz,uuid),public.lv_admin_cleanup_devices(uuid[]) to authenticated;
commit;
