import test from 'node:test';
import assert from 'node:assert/strict';
import {deviceState,matchesDeviceFilter} from '../src/device-filters.js';
const now=Date.parse('2026-10-30T00:00:00Z'),device={id:'a',blocked:true,owner_id:null};
const grant={device_id:'a',starts_at:'2026-01-01T00:00:00Z',ends_at:null,revoked_at:null};
test('sponsorship is independent of blocking and account binding',()=>{
  for(const f of ['sponsored','active','blocked','unbound'])assert.ok(matchesDeviceFilter(device,f,[grant],now),f);
  assert.ok(!matchesDeviceFilter(device,'unsponsored',[grant],now));
});
test('temporary, expired, future and revoked grants are classified separately',()=>{
  const temporary={...grant,ends_at:'2027-01-01T00:00:00Z'};
  assert.deepEqual(deviceState(device,[temporary],now),{sponsored:false,temporary:true,active:true});
  assert.ok(matchesDeviceFilter(device,'unsponsored',[temporary],now));assert.ok(!matchesDeviceFilter(device,'none',[temporary],now));
  for(const bad of [{...grant,ends_at:'2026-10-29T00:00:00Z'},{...grant,starts_at:'2027-01-01T00:00:00Z'},{...grant,revoked_at:'2026-10-29T00:00:00Z'},{...grant,device_id:'other'}])assert.ok(matchesDeviceFilter(device,'none',[bad],now));
});
