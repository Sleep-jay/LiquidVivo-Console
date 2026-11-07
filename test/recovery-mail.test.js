import test from 'node:test';import assert from 'node:assert/strict';
import {createRecoveryMailer,normalizedAuthEmail} from '../src/recovery.js';
test('recovery sends canonical email only with recovery redirect and starts cooldown after acceptance',async()=>{
 let now=1000,calls=[];const mail=createRecoveryMailer({now:()=>now,auth:{resetPasswordForEmail:async(...args)=>{calls.push(args);return {};}}});
 await mail.send(' USER@Example.test ','https://site.test/?action=reset-password');
 assert.equal(calls[0][0],'user@example.test');assert.equal(calls[0][1].redirectTo,'https://site.test/?action=reset-password');assert.equal(mail.remaining('USER@example.test'),60);
 await assert.rejects(mail.send('user@example.test','unused'),/60 秒/);assert.equal(calls.length,1);now+=60000;await mail.send('user@example.test','redirect');assert.equal(calls.length,2);
});
test('recovery distinguishes limits, SMTP rejection, and network failures without recording a successful send',async()=>{
 for(const [error,pattern] of [[{status:429,message:'rate limit'},/过于频繁/],[{status:500,message:'smtp'},/邮件服务/],[{message:'Failed to fetch'},/HTTP 410/]]){
  const mail=createRecoveryMailer({auth:{resetPasswordForEmail:async()=>({error})},diagnose:async()=>'腾讯云接口 HTTP 410'});
  await assert.rejects(mail.send('user@example.test','redirect'),pattern);assert.equal(mail.remaining('user@example.test'),0);
 }
 assert.throws(()=>normalizedAuthEmail('bad-email'),/完整/);
});
test('concurrent clicks cannot send two recovery requests',async()=>{
 let finish;const mail=createRecoveryMailer({auth:{resetPasswordForEmail:()=>new Promise(r=>{finish=r;})}});
 const first=mail.send('user@example.test','redirect');await assert.rejects(mail.send('user@example.test','redirect'),/正在提交/);finish({});await first;
});
