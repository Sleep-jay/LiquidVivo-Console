import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const {createGatewayServer}=createRequire(import.meta.url)('../cloudbase-gateway/index.js');
const realFetch=globalThis.fetch;
async function withServer(upstream,run){
  const server=createGatewayServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  globalThis.fetch=upstream;
  try{await run(`http://127.0.0.1:${server.address().port}`);}
  finally{globalThis.fetch=realFetch;server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
test('CloudBase adapter preserves raw signed bytes, status, and browser CORS',async()=>{
  const signed='{"payload":"fixture_原文","signature":"fixture"}';
  await withServer(async(url,options)=>{
    assert.equal(url,'https://drboqyxccvvsxcbusvrv.supabase.co/functions/v1/cloud-sync');
    assert.equal(options.redirect,'manual');assert.equal(options.headers.get('authorization'),'Bearer fixture');
    assert.equal(options.headers.get('cookie'),null);
    assert.equal(new TextDecoder().decode(options.body),'{"operation":"health"}');
    return new Response(signed,{headers:{'content-type':'application/json','set-cookie':'private=x'}});
  },async(base)=>{
    const response=await realFetch(base+'/functions/v1/cloud-sync',{method:'POST',
      headers:{Origin:'https://sleep-jay.github.io',Authorization:'Bearer fixture',Cookie:'private=x'},
      body:'{"operation":"health"}'});
    assert.equal(response.status,200);assert.equal(await response.text(),signed);
    assert.equal(response.headers.get('set-cookie'),null);
    assert.equal(response.headers.get('cache-control'),'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'),'https://sleep-jay.github.io');
  });
});
test('CloudBase adapter rejects foreign origins, arbitrary routes, and oversized bodies',async()=>{
  await withServer(async()=>{assert.fail('Upstream must not be contacted');},async(base)=>{
    assert.equal((await realFetch(base+'/')).status,200);
    assert.equal((await realFetch(base+'/auth/v1/settings',{headers:{Origin:'https://evil.example'}})).status,403);
    assert.equal((await realFetch(base+'/rest/v1/lv_devices',{method:'DELETE'})).status,404);
    assert.equal((await realFetch(base+'/proxy?url=https://evil.example')).status,404);
    assert.equal((await realFetch(base+'/functions/v1/cloud-sync',{method:'POST',body:'x'.repeat(131073)})).status,413);
  });
});
test('CloudBase adapter does not follow redirects or expose upstream errors',async()=>{
  await withServer(async()=>new Response(null,{status:302,headers:{location:'https://evil.example'}}),async(base)=>{
    assert.deepEqual(await (await realFetch(base+'/auth/v1/settings')).json(),{error:'upstream_redirect_denied'});
  });
  await withServer(async()=>{throw new Error('private credentials');},async(base)=>{
    assert.deepEqual(await (await realFetch(base+'/auth/v1/settings')).json(),{error:'upstream_unavailable'});
  });
});
test('signup opens a standalone page and only POST verifies without returning a session',async()=>{
  let calls=0;
  await withServer(async(url,options)=>{
    calls++;
    assert.equal(url,'https://drboqyxccvvsxcbusvrv.supabase.co/auth/v1/verify');
    assert.deepEqual(JSON.parse(options.body),{type:'signup',token_hash:'a'.repeat(64)});
    return new Response('{"access_token":"test-session"}',{headers:{'set-cookie':'test-session=1'}});
  },async base=>{
    const path=base+'/confirm-signup';
    const page=await realFetch(path);
    assert.match(await page.text(),/注册成功/);
    assert.equal(page.headers.get('referrer-policy'),'no-referrer');
    assert.equal(calls,0);
    assert.equal((await realFetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,400);
    const verified=await realFetch(path,{method:'POST',
      headers:{'Content-Type':'application/json',Origin:'https://liquidvivo-d2g9srktc0d37a3a6-1521254198.ap-shanghai.app.tcloudbase.com'},
      body:JSON.stringify({token:'a'.repeat(64)})});
    assert.equal(verified.status,204);assert.equal(await verified.text(),'');
    assert.equal(verified.headers.get('set-cookie'),null);
    assert.equal(calls,1);
  });
});
