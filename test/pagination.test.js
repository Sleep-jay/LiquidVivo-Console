import test from 'node:test';
import assert from 'node:assert/strict';
import {pageOf,pagerHtml} from '../src/pagination.js';
test('56 imported devices occupy six bounded pages without duplicates or gaps',()=>{
 const rows=Array.from({length:56},(_,id)=>({id}));
 assert.deepEqual(Array.from({length:6},(_,i)=>pageOf(rows,i+1,10).items).flat(),rows);
 assert.equal(pageOf(rows,6).items.length,6);assert.equal(pageOf(rows,6).start,51);assert.equal(pageOf(rows,6).end,56);
});
test('filtering or deletion clamps an out-of-range page and handles empty results',()=>{
 assert.equal(pageOf([1,2],6).page,1);const p=pageOf([],99);assert.equal(p.start,0);assert.equal(p.end,0);assert.equal(p.pages,1);
 assert.match(pagerHtml(p),/disabled/);
});
test('page size is bounded and page selection leaves cross-page selection intact',()=>{
 const rows=Array.from({length:56},(_,id)=>({id})),selected=new Set([0,55]);
 for(const page of [1,2,6])pageOf(rows,page,10).items.forEach(row=>{if(row.id===12)selected.add(row.id)});
 assert.deepEqual([...selected],[0,55,12]);assert.equal(pageOf(rows,1,1000).items.length,10);assert.equal(pageOf(rows,3,20).items.length,16);
});
