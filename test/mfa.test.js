import test from 'node:test';
import assert from 'node:assert/strict';
import {createMfaCoordinator,totpQrSource} from '../src/mfa.js';
const name='LiquidVivo 管理员';
test('QR handles SDK data URI without wrapping a URI as SVG text',()=>{
 const svg='<svg xmlns="http://www.w3.org/2000/svg"></svg>';
 const expected='data:image/svg+xml,'+encodeURIComponent(svg);
 assert.equal(totpQrSource(svg),expected);
 assert.equal(totpQrSource('data:image/svg+xml;utf-8,'+svg),expected);
 assert.equal(totpQrSource(expected),expected);
 assert.throws(()=>totpQrSource('https://other.example/qr'));
});
function fixture(factors=[]){
 const calls={enroll:0,removed:[]};
 const api={
  async listFactors(){return {data:{all:[...factors],totp:factors.filter(f=>f.status==='verified')},error:null};},
  async unenroll({factorId}){calls.removed.push(factorId);factors.splice(factors.findIndex(f=>f.id===factorId),1);return {error:null};},
  async enroll(){calls.enroll++;const f={id:'new',factor_type:'totp',status:'unverified',friendly_name:name};factors.push(f);return {data:{...f,totp:{qr_code:'test-qr'}},error:null};},
 };
 return {api,calls};
}
test('recovers stale enrollment from all even when typed totp list is empty',async()=>{
 const {api,calls}=fixture([{id:'stale',factor_type:'totp',status:'unverified',friendly_name:name}]);
 const result=await createMfaCoordinator(api).prepare('owner');
 assert.deepEqual(calls.removed,['stale']);assert.equal(calls.enroll,1);assert.equal(result.pending.id,'new');
});
test('verified factor is never deleted or re-enrolled',async()=>{
 const {api,calls}=fixture([{id:'verified',factor_type:'totp',status:'verified',friendly_name:name}]);
 const result=await createMfaCoordinator(api).prepare('owner');
 assert.equal(result.verified.id,'verified');assert.equal(calls.enroll,0);assert.deepEqual(calls.removed,[]);
});
test('concurrent page initialization enrolls once and reuses same in-memory QR',async()=>{
 const {api,calls}=fixture();const c=createMfaCoordinator(api);
 const [a,b]=await Promise.all([c.prepare('owner'),c.prepare('owner')]);
 assert.equal(a.pending,b.pending);assert.equal(calls.enroll,1);
 assert.equal((await c.prepare('owner')).pending,a.pending);assert.equal(calls.enroll,1);
});
test('unenroll failure is surfaced before another conflicting enrollment',async()=>{
 const {api,calls}=fixture([{id:'stale',factor_type:'totp',status:'unverified',friendly_name:name}]);
 api.unenroll=async()=>({error:Error('denied')});
 await assert.rejects(createMfaCoordinator(api).prepare('owner'),/denied/);assert.equal(calls.enroll,0);
});
test('unrelated pending factors are preserved',async()=>{
 const {api,calls}=fixture([{id:'other',factor_type:'totp',status:'unverified',friendly_name:'Other app'}]);
 await createMfaCoordinator(api).prepare('owner');assert.deepEqual(calls.removed,[]);
});
test('cross-tab enrollment race returns an actionable error without an enroll loop',async()=>{
 let reads=0;
 const api={async listFactors(){reads++;return {data:{all:reads===1?[]:[{id:'race',factor_type:'totp',status:'unverified',friendly_name:name}]}};},
  async enroll(){return {error:Error('duplicate friendly name')};},async unenroll(){throw Error('should not remove racing record');}};
 await assert.rejects(createMfaCoordinator(api).prepare('owner'),/另一页面/);assert.equal(reads,2);
});
