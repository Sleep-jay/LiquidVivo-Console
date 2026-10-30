// Server-sent recovery mail has no browser PKCE verifier. Let the SDK validate
// that specific callback; ordinary sign-in and browser-requested recovery use PKCE.
export function authFlowType(hash){
 const p=new URLSearchParams(String(hash||'').replace(/^#/,''));
 return p.get('type')==='recovery'&&p.has('access_token')&&p.has('refresh_token')?'implicit':'pkce';
}
