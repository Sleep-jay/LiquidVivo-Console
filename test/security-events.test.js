import test from 'node:test';
import assert from 'node:assert/strict';
import {securityEventsView,eventReviewFields} from '../src/security-events.js';

const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
test('security evidence is escaped, bounded and never labeled as proof',()=>{
 const event={id:'example',account_id:'<script>x</script>',device_id:null,device_hash:null,rule:'r1',origin:'client',build:700,state:'pending',note:'<img src=x>'};
 const html=securityEventsView({rows:[event],filter:'all',busy:false,error:'',hasNext:false,esc,time:v=>v||'—'});
 assert.doesNotMatch(html,/<script>|<img/);
 assert.match(html,/客户端报告/);
 assert.match(html,/未核实/);
 assert.match(html,/每页 10 条/);
 assert.match(html,/data-event-page="next".*disabled/);
 const form=eventReviewFields(event,esc);
 assert.doesNotMatch(form,/block_device/);
 assert.match(form,/block_account/);
 assert.match(form,/仅保存审核/);
});
