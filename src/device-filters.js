export const deviceFilters={all:'全部设备',sponsored:'已赞助（永久权益）',unsponsored:'未赞助（无永久权益）',campaign:'限免活动用户',temporary:'仅限时权益',none:'无有效权益',active:'有有效权益',blocked:'受限设备',unbound:'未绑定账号'};
export function deviceState(device,grants,now=Date.now()){
  const active=grants.filter(g=>g.device_id===device.id&&!g.revoked_at&&Date.parse(g.starts_at)<=now&&(!g.ends_at||Date.parse(g.ends_at)>now));
  return {sponsored:active.some(g=>!g.ends_at),temporary:active.length>0&&!active.some(g=>!g.ends_at),active:active.length>0};
}
export function matchesDeviceFilter(device,filter,grants,now=Date.now()){
  const s=deviceState(device,grants,now);
  switch(filter){
    case 'all':return true;case 'sponsored':return s.sponsored;case 'unsponsored':return !s.sponsored;
    case 'temporary':return s.temporary;case 'none':return !s.active;case 'active':return s.active;
    case 'campaign':return grants.some(g=>g.campaign_id&&g.device_id===device.id&&!g.revoked_at&&Date.parse(g.starts_at)<=now&&Date.parse(g.ends_at)>now);
    case 'blocked':return !!device.blocked;case 'unbound':return !device.owner_id;default:return false;
  }
}
export const deviceSearchFields=d=>[d.label,d.note,d.device_hash,d.id,d.app_version,...(d.campaign_titles||[]),d.blocked?'受限 黑名单 blocked':'正常',d.owner_id?'已绑定 bound':'未绑定 unbound'];
export function deviceFilterOptions(value='all'){
  return Object.entries(deviceFilters).map(([key,label])=>`<option value="${key}" ${key===value?'selected':''}>${label}</option>`).join('');
}
