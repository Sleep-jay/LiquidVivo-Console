// Owner-controlled HTTPS gateway. The upstream is fixed; never accept a target URL.
// No root/child signing key, service_role, request-body logging, or entitlement cache.
const UPSTREAM='https://drboqyxccvvsxcbusvrv.supabase.co';
const MAX_BODY=131072;
const METHODS=new Set(['GET','HEAD','POST','PUT','DELETE']);
function allowed(path,method){
 if(path==='/functions/v1/cloud-sync')return method==='POST';
 if(/^\/rest\/v1\/rpc\/lv_[a-z_]+$/.test(path))return method==='POST';
 if(/^\/rest\/v1\/lv_[a-z_]+$/.test(path))return ['GET','HEAD'].includes(method);
 if(path==='/auth/v1/otp')return method==='POST';
 if(/^\/auth\/v1\/(signup|token|user|verify|logout|recover|resend|reauthenticate|settings)$/.test(path))return METHODS.has(method);
 return false;
}
function cors(origin,site){
 const h=new Headers({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Vary':'Origin'});
 if(origin===site)h.set('Access-Control-Allow-Origin',origin);
 return h;
}
function failure(status,code,h){h.set('Content-Type','application/json');return new Response(JSON.stringify({error:code}),{status,headers:h});}
export default {
 async fetch(request,env={},ctx={}){
  const origin=request.headers.get('Origin');
  const site=env.WEBSITE_ORIGIN||'https://sleep-jay.github.io';
  const h=cors(origin,site);const url=new URL(request.url);
  if(url.protocol!=='https:')return failure(400,'https_required',h);
  if(origin&&origin!==site)return failure(403,'origin_denied',h);
  if(request.method==='OPTIONS'){
   const method=request.headers.get('Access-Control-Request-Method');
   if(!origin||!allowed(url.pathname,method))return failure(403,'route_denied',h);
   h.set('Access-Control-Allow-Methods','GET,HEAD,POST,PUT,DELETE,OPTIONS');
   h.set('Access-Control-Allow-Headers','authorization,apikey,content-type,x-client-info,prefer,range,x-supabase-api-version,accept-profile,content-profile');
   return new Response(null,{status:204,headers:h});
  }
  if(!allowed(url.pathname,request.method))return failure(404,'route_denied',h);
  for(const key of ['accept-profile','content-profile']){
   const value=request.headers.get(key);if(value&&value!=='public')return failure(403,'schema_denied',h);
  }
  if(env.REQUEST_LIMITER){
   const result=await env.REQUEST_LIMITER.limit({key:request.headers.get('CF-Connecting-IP')||'unknown'});
   if(!result.success)return failure(429,'rate_limited',h);
  }
  if(Number(request.headers.get('Content-Length')||0)>MAX_BODY)return failure(413,'request_too_large',h);
  let body;
  if(!['GET','HEAD'].includes(request.method)&&request.body){
   const reader=request.body.getReader();const parts=[];let length=0;
   while(true){const {value,done}=await reader.read();if(done)break;length+=value.length;
    if(length>MAX_BODY){await reader.cancel();return failure(413,'request_too_large',h);}parts.push(value);}
   body=new Uint8Array(length);let offset=0;for(const part of parts){body.set(part,offset);offset+=part.length;}
  }
  const headers=new Headers();
  for(const key of ['authorization','apikey','content-type','x-client-info','prefer','range','x-supabase-api-version','accept-profile','content-profile']){
   const value=request.headers.get(key);if(value)headers.set(key,value);
  }
  headers.set('Cache-Control','no-store');
  try{
   const upstream=await fetch(UPSTREAM+url.pathname+url.search,{method:request.method,headers,body,
    redirect:'manual',signal:AbortSignal.timeout(30000)});
   if(upstream.status>=300&&upstream.status<400){await upstream.body?.cancel();return failure(502,'upstream_redirect_denied',h);}
   for(const key of ['content-type','content-range','range-unit','x-supabase-api-version','retry-after']){
    const value=upstream.headers.get(key);if(value)h.set(key,value);
   }
   h.set('Access-Control-Expose-Headers','content-range,range-unit,retry-after');
   return new Response(upstream.body,{status:upstream.status,headers:h});
  }catch{return failure(502,'upstream_unavailable',h);}
 }
};
