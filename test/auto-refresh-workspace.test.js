import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createAutoRefresh} from '../src/auto-refresh.js';
import {authFlowType} from '../src/recovery.js';
import {campaignGrants} from '../src/campaigns.js';

// Exercise the actual load/refresh functions with controlled transport and DOM.
function workspace({errorTable,waitForExtra}={}){
  const root={querySelector:()=>null,querySelectorAll:()=>[],contains:()=>false};
  const api={auth:{onAuthStateChange(){}},rpc:name=>query(name),from:name=>query(name)};
  function query(name){
    const result=()=>({data:['lv_is_admin','lv_admin_session_ready','lv_user_session_active'].includes(name)?true:
      name==='lv_admin_devices'?[{id:'new-device',device_hash:'abc',last_seen:'2026-10-30T12:00:00Z'}]:[],
      error:name===errorTable?{message:'network failure'}:null});
    const q={select:()=>q,order:()=>q,limit:()=>q,abortSignal:()=>q,
      then:(resolve,reject)=>(name==='lv_feedback'&&waitForExtra?waitForExtra:Promise.resolve()).then(result).then(resolve,reject)};
    return q;
  }
  const context=vm.createContext({createAutoRefresh,authFlowType,campaignGrants,createClient:()=>api,config:{},gatewayFetch(){},
    createEmailConfirmation:()=>({}),sessionStorage:{},localStorage:{},AbortSignal,
    setTimeout,clearTimeout,document:{querySelector:()=>null,activeElement:null},window:{},
  });
  context.document.querySelector=selector=>selector==='#app'?root:null;
  const source=readFileSync(new URL('../src/main.js',import.meta.url),'utf8')
    .replace(/^import .*;\r?\n/gm,'').replace('void boot();','');
  vm.runInContext(source,context);
  vm.runInContext(`session={user:{id:'admin'}};admin=true;workspaceReady=true;
    devices=[{id:'old-device'}];selected=new Set(['new-device']);
    globalThis.rowUpdates=0;globalThis.renders=0;
    rows=()=>{rowUpdates++;};render=()=>{renders++;};`,context);
  return {run:code=>vm.runInContext(code,context)};
}
test('a failed auxiliary request does not partially replace the visible device snapshot',async()=>{
  const w=workspace({errorTable:'lv_feedback'});
  await assert.rejects(w.run('load()'));assert.equal(w.run('devices[0].id'),'old-device');
});
test('successful automatic device refresh updates rows without rebuilding search/filter controls',async()=>{
  const w=workspace();await w.run('refreshWorkspace()');
  assert.equal(w.run('devices[0].id'),'new-device');assert.equal(w.run('rowUpdates'),1);
  assert.equal(w.run('renders'),0);assert.equal(w.run('selected.has("new-device")'),true);
});
test('logout or view change during an in-flight refresh discards its result',async()=>{
  let resolve;const waitForExtra=new Promise(r=>{resolve=r;});const w=workspace({waitForExtra});
  const pending=w.run('refreshWorkspace()');await new Promise(r=>setImmediate(r));
  w.run('viewEpoch++;workspaceReady=false;session=null;');resolve();await pending;
  assert.equal(w.run('devices[0].id'),'old-device');assert.equal(w.run('rowUpdates'),0);
});
test('opening an editor during an in-flight snapshot prevents applying stale data',async()=>{
  let resolve;const waitForExtra=new Promise(r=>{resolve=r;});const w=workspace({waitForExtra});
  const pending=w.run('refreshWorkspace()');await new Promise(r=>setImmediate(r));
  w.run('viewEpoch++;');resolve();await pending;
  assert.equal(w.run('devices[0].id'),'old-device');
});
