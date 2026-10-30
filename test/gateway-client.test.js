import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@supabase/supabase-js';
import {config} from '../src/config.js';
import {gatewayFetch} from '../src/gateway-fetch.js';
test('Supabase SDK retains gateway prefix for Auth and RPC and keeps original session storage identity',async()=>{
  const paths=[];
  const client=createClient(config.url,config.publishableKey,{
    auth:{persistSession:false,autoRefreshToken:false,storageKey:config.authStorageKey},
    global:{fetch:async(url)=>{paths.push(String(url));return new Response('false',{headers:{'content-type':'application/json'}});}}
  });
  await client.auth.getUser('test-only-bearer');
  await client.rpc('lv_is_admin');
  assert.deepEqual(paths,[config.url+'/auth/v1/user',config.url+'/rest/v1/rpc/lv_is_admin']);
  assert.equal(config.authStorageKey,'sb-drboqyxccvvsxcbusvrv-auth-token');
  assert.equal(config.syncIntervalSeconds,3600);
});
test('real SDK database headers fit the deployed browser preflight allowlist',async()=>{
  const original=globalThis.fetch;const calls=[];
  const allowed=new Set(['authorization','apikey','content-type','x-client-info','prefer','range','x-supabase-api-version']);
  globalThis.fetch=async(url,options)=>{
    const headers=new Headers(options.headers);
    for(const name of headers.keys())assert.ok(allowed.has(name),`Browser preflight would reject ${name}`);
    assert.ok(headers.has('authorization'));assert.equal(headers.get('apikey'),config.publishableKey);
    calls.push(String(url));
    return new Response('[]',{headers:{'content-type':'application/json'}});
  };
  try{
    const client=createClient(config.url,config.publishableKey,{
      auth:{persistSession:false,autoRefreshToken:false},global:{fetch:gatewayFetch}
    });
    await client.rpc('lv_is_admin');
    await client.from('lv_devices').select('id').limit(1);
    assert.deepEqual(calls,[config.url+'/rest/v1/rpc/lv_is_admin',config.url+'/rest/v1/lv_devices?select=id&limit=1']);
  }finally{globalThis.fetch=original;}
});
test('gateway compatibility fetch preserves body, bearer, cancellation and non-public schemas',async()=>{
  const original=globalThis.fetch;const signal=new AbortController().signal;
  globalThis.fetch=async(url,options)=>{
    assert.equal(options.signal,signal);assert.equal(options.method,'POST');assert.equal(options.body,'{"fixture":true}');
    assert.equal(options.headers.get('authorization'),'Bearer fixture');
    assert.equal(options.headers.get('content-profile'),'private');
    return new Response('{}');
  };
  try{await gatewayFetch('https://fixture.invalid',{method:'POST',signal,body:'{"fixture":true}',
    headers:{Authorization:'Bearer fixture','Content-Profile':'private'}});}finally{globalThis.fetch=original;}
});
