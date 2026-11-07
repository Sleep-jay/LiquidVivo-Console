import test from 'node:test';
import assert from 'node:assert/strict';
import {codePayload,codeFields,campaignGrants} from '../src/campaigns.js';
import {trialRemaining} from '../src/member.js';
test('trial term and redemption window are independent, with account default one',()=>{
 for(const seconds of [86400,172800,604800,2592000]){
  const f=new FormData();for(const [k,v] of Object.entries({code:'TRIAL-CODE',max_uses:'100',expires_at:'2030-01-01T00:00',grant_duration_seconds:String(seconds)}))f.set(k,v);
  const p=codePayload(f);assert.equal(p.grant_duration_seconds,seconds);assert.equal(p.per_account_limit,1);assert.ok(p.expires_at);
  f.set('per_account_limit','0');assert.throws(()=>codePayload(f));
 }
});
test('new codes default to 24h while existing fixed-term codes keep their mode',()=>{
 const campaign={title:'Trial',ends_at:'2030-01-01T00:00:00Z'};
 assert.match(codeFields(null,campaign,String,String),/value="86400" selected>24小时/);
 assert.match(codeFields({grant_duration_seconds:null},campaign,String,String),/value="" selected>至活动结束/);
});
test('web entitlement mirrors personal expiry capped by campaign end',()=>{
 const c={id:'c',enabled:true,starts_at:'2026-11-01T00:00:00Z',ends_at:'2026-12-01T00:00:00Z'};
 const m={id:'m',campaign_id:'c',starts_at:'2026-11-07T00:00:00Z',ends_at:'2026-11-08T00:00:00Z'};
 assert.equal(campaignGrants([c],[m])[0].ends_at,'2026-11-08T00:00:00.000Z');
 assert.equal(trialRemaining(m.ends_at,Date.parse(m.starts_at)),'剩余 1 天 0 小时 0 分钟');
 assert.equal(trialRemaining(m.ends_at,Date.parse(m.ends_at)),'已到期');
});
