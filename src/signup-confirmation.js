export function createSignupConfirmation({auth,now=Date.now}){
 let sentAt=0;
 return {remaining:()=>Math.max(0,Math.ceil((sentAt+60000-now())/1000)),
 async resend(email,redirect){
  if(sentAt&&now()-sentAt<60000)throw Error('请等待一分钟后再重发，连续发送不会加快送达。');
  email=String(email||'').trim();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('请先填写注册时使用的邮箱。');
  const {error}=await auth.resend({type:'signup',email,options:{emailRedirectTo:redirect}});
  if(error)throw error;sentAt=now();
 },markRequested(){sentAt=now();}};
}
