// Server-sent recovery mail has no browser PKCE verifier. Let the SDK validate
// that specific callback; ordinary sign-in and browser-requested recovery use PKCE.
export function authFlowType(hash){
 const p=new URLSearchParams(String(hash||'').replace(/^#/,''));
 return p.get('type')==='recovery'&&p.has('access_token')&&p.has('refresh_token')?'implicit':'pkce';
}

export function recoveryRedirect(origin,pathname){return origin+pathname+'?action=reset-password';}
export function recoveryRequested(search,hash){
 return new URLSearchParams(search).get('action')==='reset-password'||new URLSearchParams(String(hash||'').replace(/^#/,'' )).get('type')==='recovery';
}
export async function resetWithCode(auth,email,code,password,confirmation){
 if(password!==confirmation)throw Error('两次输入的新密码不一致。');
 if(password.length<12||password.length>128)throw Error('新密码需要 12–128 位。');
 if(!/^[0-9]{6,10}$/.test(code))throw Error('请输入邮件中的数字验证码。');
 const verified=await auth.verifyOtp({email:email.trim(),token:code,type:'recovery'});
 if(verified.error)throw Error('重置验证码无效或已过期，请重新发送邮件。');
 if(!verified.data?.session||verified.data.user?.email?.toLowerCase()!==email.trim().toLowerCase())throw Error('未能确认重置账号，请重新申请。');
 const updated=await auth.updateUser({password});if(updated.error)throw updated.error;
}

export function normalizedAuthEmail(value){
 const email=String(value||'').trim().toLowerCase();
 if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw Error('请填写完整、正确的注册邮箱。');
 return email;
}
export function createRecoveryMailer({auth,diagnose=async()=>'',now=Date.now}){
 const sent=new Map();let busy=false;
 return {
 remaining(email){const at=sent.get(String(email||'').trim().toLowerCase());return at===undefined?0:Math.max(0,Math.ceil((at+60000-now())/1000));},
 async send(value,redirectTo){
  const email=normalizedAuthEmail(value);
  if(busy)throw Error('正在提交重置邮件请求，请稍候。');
  if(this.remaining(email)>0)throw Error(`请等待 ${this.remaining(email)} 秒后再发送重置验证码。`);
  busy=true;
  try{
   const {error}=await auth.resetPasswordForEmail(email,{redirectTo});
   if(error){
    if(error.status===429||/rate.limit/i.test(error.message||''))throw Error('重置邮件请求过于频繁，请等待一分钟；持续出现时请联系管理员检查项目发信额度。');
    if(/email_address_not_authorized/.test(error.code||''))throw Error('当前邮件服务不允许向此地址发送，请联系管理员检查 SMTP 配置。');
    if(error.status>=500||/smtp|sending.*email/i.test(error.message||''))throw Error('邮件服务暂未完成发送，请稍后重试；持续失败请联系管理员检查发信日志。');
    throw error;
   }
   sent.set(email,now());
  }catch(error){
   if(/fetch|network|timeout|load failed/i.test(String(error.message||error))){let detail='';try{detail=await diagnose();}catch{}throw Error('重置邮件请求未能确认成功，请检查网络后重试。'+(detail?' '+detail:''));}
   throw error;
  }finally{busy=false;}
 }
 };
}
