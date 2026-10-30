import test from 'node:test';
import assert from 'node:assert/strict';
import {memberShell,memberDevices,memberMessages} from '../src/member.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const base={esc,time:v=>v||'尚未联系'};
test('member navigation excludes administrative sections',()=>{
 const html=memberShell({content:'content',email:'member@example.com',section:'devices',esc});
 assert.match(html,/用户中心/);
 for(const key of ['devices','messages','account'])assert.match(html,new RegExp(`data-section="${key}"`));
 for(const text of ['data-section="campaigns"','data-section="audit"','工作空间','全站统计'])assert.ok(!html.includes(text));
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
test('messages escape active markup and exclude non-HTTPS links',()=>{
 const html=memberMessages({...base,messages:[{kind:'dialog',title:'<img src=x onerror=alert(1)>',body:'<script>bad()</script>',link:'javascript:alert(1)'}]});
 assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.ok(!html.includes('href="javascript:'));
 assert.match(html,/&lt;script&gt;/);assert.ok(!html.includes('停止投放'));
});
