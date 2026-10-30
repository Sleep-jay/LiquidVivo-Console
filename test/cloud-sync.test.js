import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {generateKeyPairSync,sign,verify,createPublicKey} from 'node:crypto';

const source=readFileSync(new URL('../supabase/functions/cloud-sync/index.ts',import.meta.url),'utf8')
 .replace(/^import \{ createClient \}[^\n]*\n/m,'');
const js=stripTypeScriptTypes(source,{mode:'strip'});
const child=generateKeyPairSync('ed25519'),root=generateKeyPairSync('ed25519');
const b64=data=>Buffer.from(data).toString('base64url');
const canonical=p=>JSON.stringify(Object.fromEntries(Object.keys(p).sort().map(k=>[k,p[k]])));
const pub=child.publicKey.export({format:'der',type:'spki'}).subarray(-32);
const certPayload=canonical({algorithm:'Ed25519',format_version:1,issuer_key_id:'test-only-root',key_id:'test-only-child',
 permissions:'notification_island.status_bar.policy',product:'LiquidVivo',public_key:b64(pub)});
const cert=JSON.stringify({payload:b64(certPayload),signature:b64(sign(null,Buffer.from('LiquidVivo/cloud-delegation/v1\n'+certPayload),root.privateKey))});
const env={LV_CLOUD_PKCS8:b64(child.privateKey.export({format:'der',type:'pkcs8'})),LV_CLOUD_DELEGATION:cert,
 SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-only'};
const code='LV2-'+'A'.repeat(52),nonce='0123456789abcdef0123456789abcdef';
function fixture(exchange={}){
 let handler,calls=0;
 const data={revision:'10',device_code:code,blocked:false,sponsor_revoked:false,bound:true,installation_authorized:true,
  revoked_license_ids:[],pairing_token:'',legacy_licenses:[],messages:[],grants:[{
   id:'b8c65347-ae5f-482d-a505-5ac8add32cd5',features:['status_bar','notification_island'],starts_at:'2026-01-01T00:00:00+00:00',ends_at:null}],...exchange};
 const client={auth:{getUser:async token=>token==='valid-jwt'?{data:{user:{id:'test-user'}}}:{data:{user:null},error:'bad-token'}},
  rpc:async(name,args)=>{calls++;assert.equal(name,'lv_cloud_exchange');assert.equal(args.p_actor,'test-user');return {data,error:null};}};
 new Function('Deno','createClient',js)({env:{get:n=>env[n]},serve:h=>handler=h},()=>client);
 const request=(body={},token='valid-jwt')=>handler(new Request('https://fixture.invalid/cloud-sync',{
  method:'POST',headers:token?{authorization:'Bearer '+token}:{},body:JSON.stringify({device_code:code,legacy_code:'',version:'603',label:'Test phone',nonce,receipts:[],...body})}));
 return {request,calls:()=>calls};
}
function payload(text,domain){
 const e=JSON.parse(text),raw=Buffer.from(e.payload,'base64url');
 assert.equal(verify(null,Buffer.concat([Buffer.from(domain),raw]),child.publicKey,Buffer.from(e.signature,'base64url')),true);
 assert.equal(Buffer.from(e.delegation,'base64url').toString(),cert);
 return JSON.parse(raw);
}
test('cloud handler signs canonical permanent grants and device/nonce-bound policy',async()=>{
 const f=fixture(),response=await f.request();assert.equal(response.status,200);
 const p=payload(await response.text(),'LiquidVivo/cloud-policy/v1\n');assert.equal(p.nonce,nonce);assert.equal(p.device_code,code);
 const license=payload(p.licenses[0],'LiquidVivo/license/v1\n');assert.equal(license.expires_at,null);
 assert.deepEqual(license.features,['notification_island','status_bar']);
 assert.equal(Buffer.from(JSON.parse(p.licenses[0]).payload,'base64url').toString(),canonical(license));
 assert.equal(f.calls(),1);
});
test('invalid bearer and input cannot invoke privileged database exchange',async()=>{
 const f=fixture();assert.equal((await f.request({},'bad-jwt')).status,401);
 assert.equal((await f.request({},null)).status,401);assert.equal((await f.request({device_code:'wrong'})).status,503);
 assert.equal(f.calls(),0);
});
test('health challenge verifies actual signer without creating a fake device',async()=>{
 const f=fixture(),r=await f.request({operation:'health'},null);assert.equal(r.status,200);
 assert.deepEqual(payload(await r.text(),'LiquidVivo/cloud-health/v1\n'),{kind:'health_v1',nonce,product:'LiquidVivo'});
 assert.equal(f.calls(),0);
});
test('timed campaign stays separate from permanent grant',async()=>{
 const grants=[{id:'b8c65347-ae5f-482d-a505-5ac8add32cd5',features:['notification_island'],starts_at:'2026-01-01T00:00:00Z',ends_at:null},
 {id:'b8c65347-ae5f-482d-a505-5ac8add32cd6',features:['status_bar'],starts_at:'2026-10-30T00:00:00Z',ends_at:'2026-10-31T00:00:00Z'}];
 const r=await fixture({grants}).request(),p=payload(await r.text(),'LiquidVivo/cloud-policy/v1\n');
 assert.equal(payload(p.licenses[0],'LiquidVivo/license/v1\n').expires_at,null);
 assert.equal(payload(p.licenses[1],'LiquidVivo/license/v1\n').expires_at,'2026-10-31T00:00:00Z');
});
test('revocation IDs and blocked decision are covered by signed policy',async()=>{
 const r=await fixture({blocked:true,sponsor_revoked:true,revoked_license_ids:['b8c65347-ae5f-482d-a505-5ac8add32cd5'],grants:[]}).request();
 const p=payload(await r.text(),'LiquidVivo/cloud-policy/v1\n');assert.equal(p.blocked,true);assert.equal(p.sponsor_revoked,true);
 assert.equal(p.revoked_license_ids.length,1);assert.equal(p.licenses.length,0);
});
test('unsafe feature mapping never emits a license',async()=>{
 const r=await fixture({grants:[{id:'b8c65347-ae5f-482d-a505-5ac8add32cd5',features:['arbitrary_feature']}]}).request();assert.equal(r.status,503);
});
