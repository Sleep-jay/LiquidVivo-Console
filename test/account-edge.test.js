import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
const js=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/cloud-sync/index.ts',import.meta.url),'utf8').replace(/^import \{ createClient \}[^\n]*\n/m,''),{mode:'strip'});
const target='00000000-0000-4000-8000-000000000001',requestId='00000000-0000-4000-8000-000000000002';
function fixture({ready=true,identity=true,begin='started',providerError=false,providerThrows=false,finishError=false,mailThrows=false}={}){
 let handler;const calls=[];
 const service={auth:{getUser:async()=>({data:{user:identity?{id:'admin'}:null}}),admin:{updateUserById:async(id,data)=>{
   calls.push(['auth',id,data]);if(providerThrows)throw Error('timeout');return {error:providerError?{}:null};
 }},resetPasswordForEmail:async(email)=>{calls.push(['mail',email]);if(mailThrows)throw Error('timeout');return {error:null};}},rpc:async(name,args)=>{
   calls.push([name,args]);return {data:!finishError,error:finishError?{}:null};
 }};
 const scoped={rpc:async(name,args)=>{calls.push([name,args]);if(name==='lv_admin_session_ready')return {data:ready};return {data:{status:begin,email:'person@example.test'}};}};
 new Function('Deno','createClient',js)({env:{get:n=>({SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'service-test',SUPABASE_ANON_KEY:'anon-test'})[n]},serve:h=>handler=h},(_url,key,options)=>{
   if(key==='anon-test')assert.equal(options.global.headers.Authorization,'Bearer valid-jwt');return key==='service-test'?service:scoped;
 });
 return {calls,request:(action='block',data={},token='valid-jwt')=>handler(new Request('https://fixture.invalid/cloud-sync',{method:'POST',headers:token?{Authorization:'Bearer '+token}:{},body:JSON.stringify({operation:'admin_accounts',action,target_id:target,request_id:requestId,data})}))};
}
test('missing identity or server email confirmation cannot invoke privileged account changes',async()=>{
 for(const options of [{ready:false},{identity:false}]){const f=fixture(options);assert.ok([401,403].includes((await f.request()).status));assert.equal(f.calls.some(x=>x[0]==='auth'),false);}
 const f=fixture();assert.equal((await f.request('block',{},null)).status,401);assert.equal(f.calls.length,0);
});
test('completed or pending requests never repeat Auth mutations',async()=>{
 for(const begin of ['completed','pending','failed']){const f=fixture({begin});assert.equal((await f.request()).status,begin==='completed'?200:409);assert.equal(f.calls.some(x=>x[0]==='auth'),false);}
});
test('new password reaches Auth only and is excluded from operation/audit arguments',async()=>{
 const f=fixture(),password='new-password-test-only';assert.equal((await f.request('set_password',{password})).status,200);
 assert.deepEqual(f.calls.find(x=>x[0]==='auth'),['auth',target,{password}]);
 for(const call of f.calls.filter(x=>x[0].startsWith('lv_')))assert.equal(JSON.stringify(call).includes(password),false);
});
test('validation rejects short passwords, unverified email changes and malformed pairing',async()=>{
 for(const [action,data] of [['set_password',{password:'short'}],['change_email',{email:'new@example.test'}],['bind',{device_id:target,pairing_token:'bad'}]]){
   const f=fixture();assert.equal((await f.request(action,data)).status,400);assert.equal(f.calls.length,0);
 }
});
test('provider failure, timeout and database confirmation failure have distinct uncertainty',async()=>{
 for(const [options,partial] of [[{providerError:true},false],[{providerThrows:true},true],[{finishError:true},true]]){
   const f=fixture(options),r=await f.request();assert.equal(r.status,502);assert.equal((await r.json()).partial,partial);
 }
});
test('mail failure after email update reports completed change and unsent mail separately',async()=>{
 const f=fixture({mailThrows:true}),r=await f.request('change_email',{email:'NEW@example.test',ownership_checked:true});
 assert.equal(r.status,200);assert.deepEqual(await r.json(),{ok:true,mail_sent:false});
 assert.deepEqual(f.calls.find(x=>x[0]==='auth'),['auth',target,{email:'new@example.test',email_confirm:false}]);
});
test('local-only control actions do not call Auth password or mail endpoints',async()=>{
 for(const action of ['note','logout','unbind','bind']){
  const f=fixture(),data=action==='note'?{note:'private admin note'}:action==='bind'?{device_id:target,pairing_token:'a'.repeat(32)}:{};
  assert.equal((await f.request(action,data)).status,200);assert.equal(f.calls.some(x=>['auth','mail'].includes(x[0])),false);
 }
});
