import test from 'node:test';
import assert from 'node:assert/strict';
import {accountMatches,accountSearchFields,accountList,accountForm,accountActionData} from '../src/accounts.js';
import {searchItems} from '../src/search.js';
import {authFlowType} from '../src/recovery.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const user={id:'account-id',email:'person@example.test',note:'小鱼',devices:[{id:'device-id',label:'手机',device_code:'LV2-EXAMPLE'}],password_set:true,email_confirmed_at:'2026-10-30',created_at:'2026-10-30',session_count:1};
test('account categories and shared phonetic search match device codes, notes and emails',()=>{
 assert.equal(accountMatches(user,'bound'),true);assert.equal(accountMatches(user,'unbound'),false);
 assert.equal(accountMatches({...user,blocked:true},'blocked'),true);
 assert.equal(accountMatches({...user,email_confirmed_at:null},'unverified'),true);
 assert.equal(accountMatches({...user,is_anonymous:true,email_confirmed_at:null},'unverified'),false);
 assert.equal(searchItems([user],'xiaoyu',accountSearchFields).length,1);
 assert.equal(searchItems([user],'LV2-EXAMPLE',accountSearchFields).length,1);
});
test('account content is escaped and administrator selection is disabled',()=>{
 const html=accountList({users:[{...user,is_admin:true,note:'<script>secret</script>'}],selected:new Set(),esc,time:String,total:1});
 assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);assert.match(html,/已设置密码/);
 assert.match(html,/data-account-check="account-id"[^>]*disabled/);assert.match(html,/data-account-manage="account-id" disabled/);
});
test('password replacement is masked, requires matching values and never reuses account data',()=>{
 const html=accountForm(user,[],esc);assert.match(html,/type="password" autocomplete="new-password"/);
 assert.doesNotMatch(html,/name="new_password"[^>]*value=/);
 const form=new FormData();form.set('action','set_password');form.set('new_password','short');
 assert.throws(()=>accountActionData(form),/12/);form.set('new_password','new-password-123');
 assert.throws(()=>accountActionData(form),/不一致/);form.set('password_confirm','new-password-123');
 assert.deepEqual(accountActionData(form),{password:'new-password-123'});
 form.set('action','block');assert.deepEqual(accountActionData(form),{});
});
test('anonymous installation sessions cannot be presented as email/password accounts',()=>{
 const html=accountForm({...user,is_anonymous:true},[],esc);
 assert.doesNotMatch(html,/<option value="(?:reset_email|set_password|change_email|bind)">/);
});
test('only complete server recovery callbacks select implicit validation; normal login retains PKCE',()=>{
 assert.equal(authFlowType('#type=recovery&access_token=test&refresh_token=test'),'implicit');
 for(const hash of ['', '#type=recovery', '#type=signup&access_token=test&refresh_token=test', '#code=pkce-code'])assert.equal(authFlowType(hash),'pkce');
});
