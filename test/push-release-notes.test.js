import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {encodeReleaseNotes,decodeReleaseNotes} from '../src/release-notes.js';
import {validatePushMessage,pushJobHtml} from '../src/push-management.js';
const js=stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/cloud-sync/index.ts',import.meta.url),'utf8').replace(/^import \{ createClient \}[^\n]*\n/m,''),{mode:'strip'});
test('push configuration is server confirmed and cannot create jobs while unconfigured',async()=>{
 for(const ready of [true,false]){
  let handler;const calls=[];
  new Function('Deno','createClient',js)({env:{get:n=>({SUPABASE_URL:'https://fixture.invalid',SUPABASE_SERVICE_ROLE_KEY:'service',SUPABASE_ANON_KEY:'anon'})[n]},serve:h=>handler=h},()=>({auth:{getUser:async()=>({data:{user:{id:'admin'}}})},rpc:async(name)=>{calls.push(name);return {data:ready};}}));
  const request=action=>handler(new Request('https://fixture.invalid',{method:'POST',headers:{Authorization:'Bearer jwt'},body:JSON.stringify({operation:'admin_push',action,job_id:'70000000-0000-4000-8000-000000000001'})}));
  let res=await request('configuration');assert.equal(res.status,ready?200:403);if(ready)assert.equal((await res.json()).configured,false);
  res=await request('send');assert.equal(res.status,ready?503:403);assert.deepEqual([...new Set(calls)],['lv_admin_session_ready']);
 }
});
test('localized notes preserve text and enforce combined server budget',()=>{
 const raw=encodeReleaseNotes('2.2.445','中文 <text>','English');assert.equal(decodeReleaseNotes(raw).zh,'中文 <text>');assert.equal(decodeReleaseNotes('legacy'),null);
 assert.throws(()=>encodeReleaseNotes('v','中',''));assert.throws(()=>encodeReleaseNotes('v','中'.repeat(4000),'en'));
});
test('immediate notification constraints reject long or expired messages and escape device labels',()=>{
 assert.throws(()=>validatePushMessage({title:'中'.repeat(21),body:'ok'}));
 assert.throws(()=>validatePushMessage({title:'ok',body:'ok',enabled:false}));
 assert.match(pushJobHtml({id:'job',counts:{accepted:1},items:[{label:'<script>',state:'accepted'}]},s=>String(s).replaceAll('<','&lt;')),/&lt;script>/);
});
