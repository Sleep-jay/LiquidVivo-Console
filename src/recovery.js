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
