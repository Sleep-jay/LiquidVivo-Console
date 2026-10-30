import test from 'node:test';
import assert from 'node:assert/strict';
import {campaignGrants,campaignCodeState,codePayload,campaignCodesView} from '../src/campaigns.js';
import {matchesDeviceFilter,deviceSearchFields} from '../src/device-filters.js';
import {memberDevices} from '../src/member.js';
const now=Date.now(),c={id:'event',title:'周末体验',features:['status_bar'],enabled:true,starts_at:new Date(now-10000).toISOString(),ends_at:new Date(now+100000).toISOString()};
test('only redeemed devices receive named campaign grants and campaign classification',()=>{
 assert.deepEqual(campaignGrants([c],[]),[]);
 const grants=campaignGrants([c],[{id:'claim',device_id:'phone',campaign_id:'event'}]);
 assert.equal(grants[0].campaign_title,'周末体验');assert.equal(matchesDeviceFilter({id:'phone'},'campaign',grants),true);
 assert.equal(matchesDeviceFilter({id:'other'},'campaign',grants),false);
 assert.deepEqual(campaignGrants([{...c,enabled:false}],[{campaign_id:'event'}]),[]);
 assert.deepEqual(campaignGrants([c],[{campaign_id:'event',revoked_at:'today'}]),[]);
 assert.ok(deviceSearchFields({campaign_titles:['周末体验']}).includes('周末体验'));
});
test('code states distinguish disabled, expired, exhausted and usable',()=>{
 const code={enabled:true,expires_at:c.ends_at,used_count:0,max_uses:1};assert.equal(campaignCodeState(code),'enabled');
 assert.equal(campaignCodeState({...code,enabled:false}),'disabled');assert.equal(campaignCodeState({...code,used_count:1}),'exhausted');assert.equal(campaignCodeState({...code,expires_at:c.starts_at}),'expired');
});
test('custom code payload validates bounds, canonicalizes case and rejects whitespace',()=>{
 const f=new FormData();f.set('code','weekend-2026');f.set('enabled','yes');f.set('max_uses','10');f.set('expires_at',c.ends_at);
 assert.equal(codePayload(f).code,'WEEKEND-2026');f.set('code','bad code');assert.throws(()=>codePayload(f),/空格/);f.set('code','valid');f.set('max_uses','1.1');assert.throws(()=>codePayload(f),/上限/);
});
test('member view does not grant unredeemed global campaigns and escapes activity names',()=>{
 const esc=s=>String(s??'').replaceAll('<','&lt;'),base={devices:[{id:'phone',device_hash:'abc'}],entitlements:[],campaigns:[{...c,title:'<script>'}],esc,time:String};
 assert.doesNotMatch(memberDevices(base),/限时开放|<script>/);assert.match(memberDevices(base),/兑换限免活动/);
 const grants=campaignGrants([{...c,title:'<script>'}],[{id:'claim',campaign_id:'event',device_id:'phone'}]);
 assert.match(memberDevices({...base,entitlements:grants}),/活动：&lt;script>/);
 assert.doesNotMatch(campaignCodesView(c,[{id:'code',code:'<CODE>',enabled:true,used_count:0,max_uses:1,expires_at:c.ends_at}],esc,String),/<CODE>/);
});
