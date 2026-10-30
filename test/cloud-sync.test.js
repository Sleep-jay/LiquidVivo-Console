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
 LV_ROOT_KEYS:JSON.stringify({'test-only-root':b64(root.publicKey.export({format:'der',type:'spki'}).subarray(-32))}),
 SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'test-only'};
const code='LV2-'+'A'.repeat(52),nonce='0123456789abcdef0123456789abcdef';
function fixture(exchange={},pushResult={data:"registered",error:null}){
 let handler,calls=0,resumes=0;const pushCalls=[];
 const data={revision:'10',device_code:code,blocked:false,sponsor_revoked:false,bound:true,installation_authorized:true,
  revoked_license_ids:[],pairing_token:'',legacy_licenses:[],messages:[],grants:[{
   id:'b8c65347-ae5f-482d-a505-5ac8add32cd5',features:['status_bar','notification_island'],starts_at:'2026-01-01T00:00:00+00:00',ends_at:null}],...exchange};
 const client={auth:{getUser:async token=>token==='valid-jwt'?{data:{user:{id:'test-user'}}}:{data:{user:null},error:'bad-token'}},
  rpc:async(name,args)=>{if(name==='lv_user_session_active')return {data:exchange.session_active!==false,error:null};calls++;assert.equal(args.p_actor,'test-user');
   if(name==='lv_cloud_push_registration'){pushCalls.push(args);return pushResult;}
   if(name==='lv_cloud_resume'){resumes++;const ok=!data.blocked&&!data.sponsor_revoked&&!data.revoked_license_ids.includes(args.p_license_id);if(ok)data.installation_authorized=true;return {data:ok,error:null};}
   assert.equal(name,'lv_cloud_exchange');return {data,error:null};}};
 new Function('Deno','createClient',js)({env:{get:n=>env[n]},serve:h=>handler=h},()=>client);
 const request=(body={},token='valid-jwt')=>handler(new Request('https://fixture.invalid/cloud-sync',{
  method:'POST',headers:token?{authorization:'Bearer '+token}:{},body:JSON.stringify({device_code:code,legacy_code:'',version:'603',label:'Test phone',nonce,receipts:[],...body})}));
 return {request,calls:()=>calls,resumes:()=>resumes,pushCalls};
}
function proof(){
 const p={algorithm:'Ed25519',format_version:1,device_binding_version:2,device_code:code,expires_at:null,
  features:['notification_island'],issued_at:'2026-01-01T00:00:00Z',key_id:'test-only-child',
  license_id:'b8c65347-ae5f-482d-a505-5ac8add32cd5',product:'LiquidVivo',sponsor_tier:'supporter'};
 const raw=canonical(p);return JSON.stringify({payload:b64(raw),signature:b64(sign(null,Buffer.from('LiquidVivo/license/v1\n'+raw),child.privateKey)),delegation:b64(cert)});
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

test('inactive installation session cannot use service-role exchange or resume',async()=>{
 const f=fixture({session_active:false,installation_authorized:false});
 const r=await f.request({license_proof:proof()});assert.equal(r.status,401);
 assert.equal((await r.json()).error,'session_inactive');assert.equal(f.calls(),0);
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
test('reinstallation silently reconnects using a verified existing license without website login',async()=>{
 const f=fixture({installation_authorized:false,grants:[]});const r=await f.request({license_proof:proof()});
 assert.equal(r.status,200);assert.equal(f.resumes(),1);
 assert.equal(payload(await r.text(),'LiquidVivo/cloud-policy/v1\n').installation_authorized,true);
});
test('tampered proof cannot reconnect an installation',async()=>{
 const f=fixture({installation_authorized:false,grants:[]});const p=JSON.parse(proof());p.signature=(p.signature.startsWith('A')?'B':'A')+p.signature.slice(1);
 const r=await f.request({license_proof:JSON.stringify(p)});assert.equal(r.status,200);assert.equal(f.resumes(),0);
 assert.equal(payload(await r.text(),'LiquidVivo/cloud-policy/v1\n').installation_authorized,false);
});
test('valid old proof does not override blocked or revoked entitlement',async()=>{
 for(const restriction of [{blocked:true},{sponsor_revoked:true},{revoked_license_ids:['b8c65347-ae5f-482d-a505-5ac8add32cd5']}]){
  const f=fixture({installation_authorized:false,grants:[],...restriction});const r=await f.request({license_proof:proof()});
  assert.equal(payload(await r.text(),'LiquidVivo/cloud-policy/v1\n').installation_authorized,false);
 }
});

test('push registration is scoped to the verified installation actor and acknowledged in signed policy',async()=>{
 const f=fixture();const r=await f.request({push_registration:{provider:'vivo',enabled:true,token:'verified-device-token'}});
 assert.equal(r.status,200);assert.equal(f.pushCalls.length,1);
 assert.deepEqual(f.pushCalls[0],{p_actor:'test-user',p_provider:'vivo',p_token:'verified-device-token',p_enabled:true});
 assert.equal(payload(await r.text(),'LiquidVivo/cloud-policy/v1\n').push_registration_status,'registered');
});
test('unregistered installations cannot bind push tokens',async()=>{
 const f=fixture({installation_authorized:false,grants:[]});const r=await f.request({push_registration:{provider:'vivo',enabled:true,token:'verified-device-token'}});
 assert.equal(f.pushCalls.length,0);assert.equal(payload(await r.text(),'LiquidVivo/cloud-policy/v1\n').push_registration_status,'unauthorized');
});
test('missing push migration preserves signed offline-authority sync and reports not deployed',async()=>{
 const f=fixture({}, {data:null,error:{code:'PGRST202'}});const r=await f.request({push_registration:{provider:'vivo',enabled:true,token:'verified-device-token'}});
 assert.equal(r.status,200);const p=payload(await r.text(),'LiquidVivo/cloud-policy/v1\n');
 assert.equal(p.push_registration_status,'not_deployed');assert.equal(p.blocked,false);assert.equal(p.licenses.length,1);
});
test('disabling removes registration, and malformed provider input never reaches registration RPC',async()=>{
 const f=fixture({}, {data:'removed',error:null});const r=await f.request({push_registration:{provider:'vivo',enabled:false,token:''}});
 assert.equal(payload(await r.text(),'LiquidVivo/cloud-policy/v1\n').push_registration_status,'removed');assert.equal(f.pushCalls[0].p_enabled,false);
 for(const push of [{provider:'unknown',enabled:true,token:'valid-token-123'},{provider:'vivo',enabled:true,token:'bad token'},{provider:'vivo',enabled:false,token:'not-cleared'}]){
  const bad=fixture();assert.equal((await bad.request({push_registration:push})).status,503);assert.equal(bad.pushCalls.length,0);
 }
});
