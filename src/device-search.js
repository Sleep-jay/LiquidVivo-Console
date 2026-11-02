export function normalizedDeviceCode(query){
 const code=String(query||'').normalize('NFKC').replace(/[\s\u200b-\u200d\ufeff]/gu,'').replace(/[‐‑‒–—−]/gu,'-').toUpperCase();
 return /^LV[12]-[A-Z2-7]{51}[AQ]$/.test(code)?code:null;
}
export async function deviceQueryHash(query){
 const code=normalizedDeviceCode(query);if(!code)return null;
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('LiquidVivo/console/device/v1\n'+code)))].map(v=>v.toString(16).padStart(2,'0')).join('');
}
