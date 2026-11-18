export const signupPath='/confirm-signup';
const consoleUrl='https://sleep-jay.github.io/LiquidVivo-Console/';

export const signupPage=`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>确认注册 · LiquidVivo</title>
<style>
:root{color-scheme:light dark;--bg:#f1f1f2;--card:#fff;--ink:#18181b;--muted:#56565e;--line:#d9d9de}
@media(prefers-color-scheme:dark){:root{--bg:#151517;--card:#202023;--ink:#f6f6f7;--muted:#b9b9c0;--line:#3e3e44}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,sans-serif}
main{width:min(100%,450px);padding:32px;background:var(--card);border:1px solid var(--line);border-radius:24px}.brand{font-weight:700;letter-spacing:.06em}h1{margin:26px 0 8px;font-size:28px;line-height:1.25}p{color:var(--muted)}a,button{display:inline-block;border:1px solid var(--line);border-radius:12px;padding:10px 18px;color:var(--ink);background:var(--bg);font:inherit;text-decoration:none}a:focus-visible,button:focus-visible{outline:2px solid currentColor;outline-offset:3px}[hidden]{display:none}
</style></head><body><main id="signup-confirmation"><div class="brand">LiquidVivo</div>
<h1 id="title">正在确认注册</h1><p id="detail" role="status">请稍候，正在验证你的邮箱。</p>
<button type="button" id="retry" hidden>重试确认</button>
<a href="${consoleUrl}">返回登录</a>
<noscript><p>当前浏览器未运行网页脚本。请在支持 JavaScript 的浏览器中打开邮件中的确认按钮。</p></noscript>
</main><script>
const title=document.querySelector('#title'), detail=document.querySelector('#detail'), retry=document.querySelector('#retry');
const token=new URLSearchParams(location.hash.slice(1)).get('token');
if(token)history.replaceState(null,'',location.pathname);
async function confirmSignup(){
  retry.hidden=true;
  if(!token){title.textContent='确认链接不完整';detail.textContent='请通过最新的 LiquidVivo 注册邮件重新打开确认按钮。';return;}
  title.textContent='正在确认注册';detail.textContent='请稍候，正在验证你的邮箱。';
  try{
    const response=await fetch(location.pathname,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token}),credentials:'omit'});
    if(response.ok){title.textContent='注册成功';detail.textContent='邮箱已验证，请返回登录 LiquidVivo。';return;}
    if(response.status===400){title.textContent='确认链接不可用';detail.textContent='链接可能已使用或过期。请返回尝试登录，或重新发送注册确认邮件。';return;}
    if(response.status===429){title.textContent='确认请求过于频繁';detail.textContent='请稍等片刻再试。';retry.hidden=false;return;}
    throw Error('verification unavailable');
  }catch{title.textContent='暂时无法确认注册';detail.textContent='请检查网络连接后重试。';retry.hidden=false;}
}
retry.addEventListener('click',confirmSignup);
confirmSignup();
</script></body></html>`;

export async function verifySignup(body,upstream,publishableKey){
  let token;
  try{({token}=JSON.parse(new TextDecoder().decode(body)));}catch{return 400;}
  if(typeof token!=='string'||!/^[A-Za-z0-9_-]{32,128}$/.test(token))return 400;
  try{
    const result=await fetch(upstream+'/auth/v1/verify',{
      method:'POST',headers:{'Content-Type':'application/json',apikey:publishableKey},
      body:JSON.stringify({token_hash:token,type:'signup'}),redirect:'error',signal:AbortSignal.timeout(10000)
    });
    await result.body?.cancel();
    if(result.ok)return 204;
    if(result.status===400||result.status===403||result.status===422)return 400;
    return result.status===429?429:502;
  }catch{return 502;}
}
