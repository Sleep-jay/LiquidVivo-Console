import test from 'node:test';
import assert from 'node:assert/strict';
import {memberShell,memberDevices,memberMessages,personalAccountData} from '../src/member.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const base={esc,time:v=>v||'尚未联系'};
test('member navigation excludes administrative sections',()=>{
 const html=memberShell({content:'content',email:'member@example.com',section:'devices',esc});
 assert.match(html,/用户中心/);
 for(const key of ['devices','messages','account'])assert.match(html,new RegExp(`data-section="${key}"`));
 for(const text of ['data-section="campaigns"','data-section="audit"','data-section="users"','账号管理','工作空间','全站统计'])assert.ok(!html.includes(text));
});
test('unbound member gets pairing entry without inventory or bulk controls',()=>{
 const html=memberDevices({...base,devices:[],entitlements:[],campaigns:[]});
 assert.match(html,/id="bind-device"/);
 for(const text of ['device-rows','全选','反选','黑名单','管理员备注'])assert.ok(!html.includes(text));
});
test('member presentation never includes administrator notes or account IDs',()=>{
 const html=memberDevices({...base,devices:[{id:'one',owner_id:'private-owner-id',label:'My phone',device_hash:'a'.repeat(64),note:'private-admin-note'}],entitlements:[],campaigns:[]});
 assert.ok(!html.includes('private-admin-note'));assert.ok(!html.includes('private-owner-id'));
});
test('expired trial cannot hide valid permanent entitlement',()=>{
 const html=memberDevices({...base,devices:[{id:'one',device_hash:'a'.repeat(64)}],entitlements:[
  {device_id:'one',features:['notification_island'],starts_at:'2000-01-01',ends_at:null},
  {device_id:'one',features:['status_bar'],starts_at:'2000-01-01',ends_at:'2001-01-01'}],campaigns:[]});
 assert.match(html,/通知上岛/);assert.match(html,/永久/);assert.ok(!html.includes('状态栏定制'));
});
test('account sponsorship remains visible with no bound device',()=>{
 const html=memberDevices({...base,devices:[],entitlements:[
  {account_id:'private-account',device_id:'old-phone',features:['status_bar'],starts_at:'2000-01-01',ends_at:null}
 ],campaigns:[]});
 assert.match(html,/账号赞助权益/);
 assert.match(html,/状态栏定制/);
 assert.match(html,/绑定我的设备/);
 assert.doesNotMatch(html,/private-account|old-phone/);
});
test('messages escape active markup and exclude non-HTTPS links',()=>{
 const html=memberMessages({...base,messages:[{kind:'dialog',title:'<img src=x onerror=alert(1)>',body:'<script>bad()</script>',link:'javascript:alert(1)'}]});
 assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.ok(!html.includes('href="javascript:'));
 assert.match(html,/&lt;script&gt;/);assert.ok(!html.includes('停止投放'));
});

test('administrator personal account excludes other accounts and preserves own grants without a device',()=>{
 const snapshot=personalAccountData({userId:'self',devices:[{id:'own',owner_id:'self'},{id:'other',owner_id:'someone'}],entitlements:[
  {id:'account-grant',account_id:'self',device_id:'old'},
  {id:'legacy-grant',device_id:'own'},
  {id:'foreign-grant',account_id:'someone',device_id:'own'},
  {id:'foreign-legacy',device_id:'other'}
 ]});
 assert.deepEqual(snapshot.devices.map(d=>d.id),['own']);
 assert.deepEqual(snapshot.entitlements.map(e=>e.id),['account-grant','legacy-grant']);
 assert.equal(personalAccountData({userId:'self',devices:[],entitlements:[{account_id:'self'}]}).entitlements.length,1);
});
test('embedded administrator device panel has working bind and migration hooks with no duplicate refresh',()=>{
 const html=memberDevices({...base,devices:[],entitlements:[],campaigns:[],embedded:true});
 assert.match(html,/id="bind-device"/);assert.match(html,/data-claim-legacy/);
 assert.match(html,/当前账号暂无有效赞助权益/);
 assert.doesNotMatch(html,/id="refresh"|id="redeem-campaign"/);
});
