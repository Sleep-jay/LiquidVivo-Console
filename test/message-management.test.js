import test from 'node:test';
import assert from 'node:assert/strict';
import {messageState,messageCards,messagePayload} from '../src/message-management.js';
const now=Date.parse('2026-10-30T00:00:00Z'),message={id:'a',title:'Notice',body:'Body',kind:'dialog',target_ids:[],all_devices:true,enabled:true,starts_at:'2026-10-29T00:00:00Z',ends_at:'2026-10-31T00:00:00Z'};
const esc=s=>String(s??'').replaceAll('<','&lt;').replaceAll('"','&quot;');
test('active, stopped, expired, scheduled and trashed messages have distinct states',()=>{
  assert.equal(messageState(message,now),'active');assert.equal(messageState({...message,enabled:false},now),'stopped');
  assert.equal(messageState({...message,ends_at:'2026-10-29T00:00:00Z'},now),'expired');
  assert.equal(messageState({...message,starts_at:'2026-10-31T00:00:00Z'},now),'scheduled');
  assert.equal(messageState({...message,deleted_at:'2026-10-29T00:00:00Z'},now),'trash');
});
test('expired/stopped messages can still be edited and deleted; trash only offers restore',()=>{
  const options={esc,time:s=>s,now};
  for(const enabled of [false,true]){const html=messageCards([{...message,enabled,ends_at:'2026-10-29T00:00:00Z'}],options);assert.match(html,/data-message-edit/);assert.match(html,/data-message-trash/);}
  const trash=messageCards([{...message,deleted_at:'2026-10-29T00:00:00Z'}],options);assert.match(trash,/data-message-restore/);assert.doesNotMatch(trash,/data-message-edit|data-message-trash/);
});
test('message form validates dates, HTTPS and update version before server mutation',()=>{
  const f=new FormData();for(const [k,v] of Object.entries({title:' T ',body:' B ',kind:'dialog',start:'2026-10-30T01:00',end:'2026-10-30T02:00',link:'',version:''}))f.set(k,v);
  assert.equal(messagePayload(f,{all_devices:true,target_ids:[]}).title,'T');
  f.set('end',f.get('start'));assert.throws(()=>messagePayload(f,{}),/结束时间/);f.set('end','2026-10-30T02:00');
  f.set('link','http://example.com');assert.throws(()=>messagePayload(f,{}),/HTTPS/);
  f.set('link','https://example.com');f.set('kind','update');assert.throws(()=>messagePayload(f,{}),/版本更新/);
});
