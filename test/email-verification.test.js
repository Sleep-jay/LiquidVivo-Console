import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmailConfirmation} from '../src/email-verification.js';
function setup(){
 const map=new Map(),calls=[];
 const storage={getItem:k=>map.get(k),setItem:(k,v)=>map.set(k,v),removeItem:k=>map.delete(k)};
 const auth={async signInWithOtp(args){calls.push(['send',args]);return {};},async verifyOtp(args){calls.push(['verify',args]);return {data:{user:{id:'owner'}}};}};
 const rpc=async(name,args)=>{calls.push([name,args]);return name==='lv_admin_begin_email'?'a'.repeat(64):'deadline';};
 let now=100000;
 const client=createEmailConfirmation({auth,rpc,storage,now:()=>now});
 return {client,calls,auth,storage,map,advance:()=>{now+=16*60000;}};
}
test('sending creates server password check and never auto-registers account',async()=>{
 const f=setup();await f.client.send('owner@example.com','owner');
 assert.equal(f.calls[0][0],'lv_admin_begin_email');
 assert.deepEqual(f.calls[1][1],{email:'owner@example.com',options:{shouldCreateUser:false}});
});
test('invalid or expired local step never calls email verification',async()=>{
 const f=setup();await assert.rejects(f.client.verify('x','owner','123456'),/失效/);
 await f.client.send('x','owner');f.advance();await assert.rejects(f.client.verify('x','owner','123456'),/失效/);
 assert.equal(f.calls.filter(x=>x[0]==='verify').length,0);
});
test('wrong code retains pending step but never grants admin session',async()=>{
 const f=setup();await f.client.send('x','owner');f.auth.verifyOtp=async()=>({error:Error('Invalid OTP')});
 await assert.rejects(f.client.verify('x','owner','123456'),/Invalid OTP/);
 assert.equal(f.calls.filter(x=>x[0]==='lv_admin_complete_email').length,0);assert.equal(f.map.size,1);
});
test('success requires backend confirmation and consumes local step',async()=>{
 const f=setup();await f.client.send('x','owner');assert.equal(await f.client.verify('x','owner','123456'),'deadline');
 assert.equal(f.calls.at(-1)[0],'lv_admin_complete_email');assert.equal(f.map.size,0);
});
test('cross-account OTP result cannot be used to confirm another admin',async()=>{
 const f=setup();await f.client.send('x','owner');f.auth.verifyOtp=async()=>({data:{user:{id:'other'}}});
 await assert.rejects(f.client.verify('x','owner','123456'),/账号不一致/);
 assert.equal(f.calls.filter(x=>x[0]==='lv_admin_complete_email').length,0);
});
