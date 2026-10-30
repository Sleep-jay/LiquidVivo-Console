import test from 'node:test';
import assert from 'node:assert/strict';
import {diagnoseGateway} from '../src/gateway-diagnostics.js';
test('connectivity diagnostics send only the public key to the configured gateway',async()=>{
 assert.equal(await diagnoseGateway({url:'https://fixture.invalid/api',publishableKey:'public-fixture'},async(url,options)=>{
  assert.equal(url,'https://fixture.invalid/api/auth/v1/settings');
  assert.deepEqual(options.headers,{apikey:'public-fixture'});
  assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
  return new Response('{}',{status:503});
 }),'腾讯云接口 HTTP 503');
 const result=await diagnoseGateway({url:'https://fixture.invalid/api',publishableKey:'public-fixture'},async()=>{throw Error('private details');});
 assert.ok(result.includes('无法连接'));assert.ok(!result.includes('private details'));
});
