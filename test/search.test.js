import test from 'node:test';
import assert from 'node:assert/strict';
import {matches,searchScore,searchItems} from '../src/search.js';
test('search normalizes width, case, whitespace and separates multiple required tokens',()=>{
  assert.ok(matches(['Phone A','自己'],'ＰＨＯＮＥ 自己'));assert.ok(!matches(['Phone A'],'phone missing'));
  assert.ok(matches(['anything'],''));assert.ok(!matches(['anything'],'🧪 missing'));
});
test('search supports Chinese homophones, full pinyin and initials',()=>{
  for(const q of ['小渣鱼','xiaozayu','xzy'])assert.ok(matches(['小杂鱼'],q),q);
  assert.ok(matches(['张三'],'zhangsan'));assert.ok(matches(['张三'],'章三'));
});
test('near sounds and bounded typos work without admitting unrelated short queries',()=>{
  assert.ok(matches(['张三'],'zangsan'));assert.ok(matches(['蓝天'],'nantian'));
  assert.ok(matches(['notification'],'notificaton'));assert.ok(!matches(['abcdef'],'zz'));
  assert.ok(!matches(['设备甲'],'完全不相干的消息'));
});
test('exact matches rank before phonetic or fuzzy matches, with stable ties',()=>{
  const items=[{text:'章三'},{text:'张三'},{text:'张三'}];
  assert.deepEqual(searchItems(items,'张三',x=>x.text),[items[1],items[2],items[0]]);
  assert.ok(searchScore('张三','张三')<searchScore('章三','张三'));
});

test("emoji device notes remain searchable rather than matching every record",()=>{assert.ok(matches(["🤡"],"🤡"));assert.ok(!matches(["普通设备"],"🤡"));});
