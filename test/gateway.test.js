import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../gateway/worker.js';
test('gateway pins upstream and preserves signed content without caching',async()=>{
 const original=globalThis.fetch;let target;
 globalThis.fetch=async(url,options)=>{target=url;assert.equal(options.redirect,'manual');return new Response('{"signed":"fixture"}',{headers:{'Content-Type':'application/json','Set-Cookie':'secret=not-forwarded','Cache-Control':'public'}});};
 try{
  const response=await worker.fetch(new Request('https://api.example.com/functions/v1/cloud-sync',{method:'POST',body:'{}'}));
  assert.equal(target,'https://drboqyxccvvsxcbusvrv.supabase.co/functions/v1/cloud-sync');assert.equal(await response.text(),'{"signed":"fixture"}');
  assert.equal(response.headers.get('cache-control'),'no-store');assert.equal(response.headers.get('set-cookie'),null);
 }finally{globalThis.fetch=original;}
});
test('gateway rejects arbitrary paths, direct table writes and foreign browser origins',async()=>{
 for(const [url,options,status] of [
  ['https://api.example.com/proxy?target=https://evil.example',{},404],
  ['https://api.example.com/rest/v1/lv_entitlements',{method:'POST',body:'{}'},404],
  ['https://api.example.com/auth/v1/token',{method:'POST',headers:{Origin:'https://evil.example'},body:'{}'},403],
  ['http://api.example.com/auth/v1/settings',{},400]
 ])assert.equal((await worker.fetch(new Request(url,options))).status,status);
});
test('gateway bounds request bodies and validates browser preflight routes',async()=>{
 const response=await worker.fetch(new Request('https://api.example.com/functions/v1/cloud-sync',{method:'POST',body:'x'.repeat(131073)}));assert.equal(response.status,413);
 const preflight=await worker.fetch(new Request('https://api.example.com/auth/v1/token',{method:'OPTIONS',headers:{Origin:'https://sleep-jay.github.io','Access-Control-Request-Method':'POST'}}));
 assert.equal(preflight.status,204);assert.equal(preflight.headers.get('Access-Control-Allow-Origin'),'https://sleep-jay.github.io');
});
