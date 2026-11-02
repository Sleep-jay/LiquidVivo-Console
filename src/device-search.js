export function normalizedDeviceCode(query){
 const code=String(query||'').normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]/gu,'').replace(/[‐‑‒–—−]/gu,'-').toUpperCase();
 return /^LV[12]-[A-Z2-7]{51}[AQ]$/.test(code)?code:null;
}
export async function deviceQueryHash(query){
 const code=normalizedDeviceCode(query);if(!code)return null;
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('LiquidVivo/console/device/v1\n'+code)))].map(v=>v.toString(16).padStart(2,'0')).join('');
}

// Relational search uses only records already visible to the current session.
export function linkedDeviceFields(item,{devices,claims=[],section=''}){
 const ids=new Set();
 if(item.device_id)ids.add(item.device_id);
 for(const d of item.devices||[])ids.add(d.id);
 for(const id of item.target_ids||[])ids.add(id);
 if(section==='campaigns')for(const c of claims)if(c.campaign_id===item.id)ids.add(c.device_id);
 if(item.user_id)for(const d of devices)if(d.owner_id===item.user_id)ids.add(d.id);
 if(item.all_devices)for(const d of devices)ids.add(d.id);
 return devices.filter(d=>ids.has(d.id)).flatMap(d=>[d.id,d.device_code,d.device_hash,d.label,d.note]);
}
