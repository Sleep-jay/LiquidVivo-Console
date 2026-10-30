import test from 'node:test';
import assert from 'node:assert/strict';
import {audienceFields,messageTargets} from '../src/message-audience.js';
const devices=[{id:'a',label:'Phone A',note:'自己',device_hash:'1234567890abcdef'},{id:'b',label:'Phone B',device_hash:'abcdef1234567890'}];
const esc=s=>String(s??'').replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
const form=(audience,ids=[])=>{const f=new FormData();f.set('audience',audience);ids.forEach(id=>f.append('target',id));return f;};
test('direct message publishing always offers the device picker without prior selection',()=>{
  const html=audienceFields(devices,[],esc);assert.match(html,/<option value="selected" >指定设备/);
  assert.match(html,/name="target" value="a"/);assert.match(html,/自己/);
});
test('device-page batch publishing preselects the supplied devices',()=>{
  const html=audienceFields(devices,['b'],esc);assert.match(html,/<option value="selected" selected>/);
  assert.match(html,/name="target" value="b" checked/);assert.doesNotMatch(html,/name="target" value="a" checked/);
});
test('all-device publishing clears specific IDs from the payload',()=>{
  assert.deepEqual(messageTargets(form('all',['a']),devices),{all_devices:true,target_ids:[]});
});
test('specific publishing preserves only explicit unique targets and rejects an empty selection',()=>{
  assert.deepEqual(messageTargets(form('selected',['b','b']),devices),{all_devices:false,target_ids:['b']});
  assert.throws(()=>messageTargets(form('selected'),devices),/至少选择一台/);
  assert.throws(()=>messageTargets(form('selected',['missing']),devices),/设备列表已变化/);
  assert.throws(()=>messageTargets(form('invalid'),devices),/投放范围/);
});
test('device labels and notes are escaped as text and attribute content',()=>{
  const html=audienceFields([{...devices[0],label:'<script>',note:'" onmouseover="bad'}],[],esc);
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('data-search="<'));
  assert.match(html,/&lt;script>/);assert.match(html,/&quot;/);
});
