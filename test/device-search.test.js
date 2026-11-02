import test from 'node:test';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
import {normalizedDeviceCode,deviceQueryHash} from '../src/device-search.js';
test('full LV1 and LV2 codes match the stored domain-separated device hash',async()=>{for(const version of [1,2]){const code=`LV${version}-`+'B'.repeat(51)+'A';const expected=createHash('sha256').update('LiquidVivo/console/device/v1\n'+code).digest('hex');assert.equal(await deviceQueryHash(code),expected);assert.equal(await deviceQueryHash('  '+code.toLowerCase()+'\n'),expected);assert.equal(await deviceQueryHash(code.replace('-','—')),expected);}});
test('partial codes and ordinary search terms stay on text search',async()=>{for(const q of ['LV2-ABC','手机','', 'LV2-'+'B'.repeat(51)+'Z']){assert.equal(normalizedDeviceCode(q),null);assert.equal(await deviceQueryHash(q),null);}});
import {linkedDeviceFields} from '../src/device-search.js';
test('linked device search covers orders, member feedback, message targets, broadcasts, accounts and redeemed campaigns',()=>{
 const devices=[{id:'phone',device_hash:'hash',owner_id:'member',note:'note'}];
 for(const item of [{device_id:'phone'},{user_id:'member'},{target_ids:['phone']},{all_devices:true},{devices:[{id:'phone'}]}])assert.ok(linkedDeviceFields(item,{devices}).includes('hash'));
 assert.ok(linkedDeviceFields({id:'event'},{devices,claims:[{campaign_id:'event',device_id:'phone'}],section:'campaigns'}).includes('hash'));
 assert.deepEqual(linkedDeviceFields({actor:'member'},{devices}),[],'Aggregate audit records must not invent historical device targets');
});
