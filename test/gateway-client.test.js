import test from 'node:test';
import assert from 'node:assert/strict';
import {createClient} from '@supabase/supabase-js';
import {config} from '../src/config.js';
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
