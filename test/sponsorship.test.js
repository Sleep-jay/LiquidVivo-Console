import test from 'node:test';
import assert from 'node:assert/strict';
import {yuanToCents,sponsorView,feedbackView} from '../src/sponsorship.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
test('currency is converted exactly to integer cents and rejects floats/exponents/underpayment',()=>{
 assert.equal(yuanToCents('15'),1500);assert.equal(yuanToCents('15.01'),1501);assert.equal(yuanToCents('20.5'),2050);
 for(const amount of ['14.99','NaN','1e3','15.001','-15','15000','0x100','Infinity'])assert.throws(()=>yuanToCents(amount));
});
test('unverified submission is displayed as pending, not successful payment',()=>{
 const html=sponsorView({admin:false,devices:[{id:'d'}],orders:[{status:'pending',provider:'wechat',transaction_ref:'123456789',received_cents:null,declared_cents:1500}],esc,time:()=>'',ready:true});
 assert.match(html,/待核对/);assert.match(html,/尚未核验/);assert.ok(!html.includes('data-review='));assert.match(html,/收款码待配置/);
});
test('unbound users cannot submit a sponsorship request from the interface',()=>{
 const html=sponsorView({admin:false,devices:[],orders:[],esc,time:()=>'',ready:true});
 assert.match(html,/id="submit-sponsorship" class="primary" disabled/);
});
test('feedback renders replies as text and only admins see reply action',()=>{
 const item={id:'one',title:'<img onerror=bad>',body:'<script>bad()</script>',reply:'<b>reply</b>',status:'replied'};
 const html=feedbackView({admin:false,items:[item],esc,time:()=>'',ready:true,hasDevice:true});
 assert.ok(!html.includes('<script>'));assert.ok(!html.includes('<img'));assert.match(html,/&lt;b&gt;reply/);assert.ok(!html.includes('data-reply='));
});
