import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createProbeServer}=createRequire(import.meta.url)('../cloudbase-probe/index.js');
async function withServer(upstream, run) {
  const server=createProbeServer(upstream);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {await run(`http://127.0.0.1:${server.address().port}`);}
  finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test('probe exposes only fixed read-only connectivity operations',async()=>{
  const calls=[];
  await withServer(async(url,options)=>{
    calls.push(url);assert.equal(options.redirect,'manual');
    if(options.body){const body=JSON.parse(options.body);assert.equal(body.operation,'health');assert.match(body.nonce,/^[a-f0-9]{32}$/);}
    return new Response('{}');
  },async(base)=>{
    assert.equal((await fetch(base+'/')).status,200);
    const result=await (await fetch(base+'/upstream')).json();
    assert.equal(result.ok,true);assert.equal(result.signatureVerified,false);
    assert.deepEqual(calls,['https://drboqyxccvvsxcbusvrv.supabase.co/auth/v1/settings','https://drboqyxccvvsxcbusvrv.supabase.co/functions/v1/cloud-sync']);
    assert.equal((await fetch(base+'/proxy?url=https://example.com')).status,404);
    assert.equal((await fetch(base+'/',{method:'POST',body:'{}'})).status,405);
  });
});
test('probe reports upstream errors without exposing response bodies or exceptions',async()=>{
  await withServer(async()=>new Response('private upstream details',{status:403}),async(base)=>{
    const response=await fetch(base+'/upstream');assert.equal(response.status,502);
    assert.deepEqual(await response.json(),{ok:false,stage:'auth_settings',http:403});
  });
  await withServer(async()=>{throw new Error('private failure');},async(base)=>{
    const response=await fetch(base+'/upstream');assert.equal(response.headers.get('cache-control'),'no-store');
    assert.deepEqual(await response.json(),{ok:false,stage:'auth_settings',error:'upstream_connection_failed'});
  });
});
