import test from 'node:test';
import assert from 'node:assert/strict';
import {createAutoRefresh} from '../src/auto-refresh.js';

function fixture(refresh=async()=>{}){
  const document=new EventTarget(),window=new EventTarget();
  document.visibilityState='visible';window.navigator={onLine:true};
  let task,delay,allowed=true,calls=0;
  const control=createAutoRefresh({document,window,canRefresh:()=>allowed,
    refresh:async()=>{calls++;await refresh();},
    setTimer:(fn,ms)=>{task=fn;delay=ms;return fn;},clearTimer:()=>{task=null;}});
  return {document,window,control,get calls(){return calls;},get delay(){return delay;},
    allow:v=>{allowed=v;},tick:async()=>{const fn=task;task=null;await fn?.();}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('polls every 30 seconds and removes timers and listeners on logout',async()=>{
  const f=fixture();f.control.start();f.control.start();assert.equal(f.delay,30000);
  await f.tick();await f.tick();assert.equal(f.calls,2);
  f.control.stop();await f.tick();f.window.dispatchEvent(new Event('focus'));await settle();assert.equal(f.calls,2);
});
test('hidden, offline and editing states skip requests; visibility and network resume refresh',async()=>{
  const f=fixture();f.control.start();f.document.visibilityState='hidden';await f.tick();assert.equal(f.calls,0);
  f.document.visibilityState='visible';f.document.dispatchEvent(new Event('visibilitychange'));await settle();assert.equal(f.calls,1);
  f.window.navigator.onLine=false;await f.tick();assert.equal(f.calls,1);
  f.window.navigator.onLine=true;f.window.dispatchEvent(new Event('online'));await settle();assert.equal(f.calls,2);
  f.allow(false);await f.tick();assert.equal(f.calls,2);f.allow(true);await f.tick();assert.equal(f.calls,3);
});
test('slow requests never overlap focus, visibility or timer refreshes',async()=>{
  let finish;const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));f.control.start();
  const flight=f.tick();f.window.dispatchEvent(new Event('focus'));f.document.dispatchEvent(new Event('visibilitychange'));
  assert.equal(f.calls,1);finish();await flight;assert.equal(f.delay,30000);
});
test('failures back off to five minutes and recover to normal polling',async()=>{
  let fail=true;const f=fixture(async()=>{if(fail)throw Error('offline');});f.control.start();
  for(const ms of [60000,120000,240000,300000,300000]){await f.tick();assert.equal(f.delay,ms);}
  fail=false;await f.tick();assert.equal(f.delay,30000);
});
test('stopping during a request prevents it from restarting the timer',async()=>{
  let finish;const f=fixture(()=>new Promise(resolve=>{finish=resolve;}));f.control.start();
  const flight=f.tick();f.control.stop();finish();await flight;await f.tick();assert.equal(f.calls,1);
});
