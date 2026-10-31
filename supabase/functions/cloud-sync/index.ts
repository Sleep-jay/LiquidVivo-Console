// Deploy with verify_jwt=false: getUser below validates the bearer with Auth.
// Only the delegated child key is stored in Edge secrets. Never upload the root key.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
const encoder=new TextEncoder();
const b64=(data:Uint8Array)=>btoa(String.fromCharCode(...data)).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
const decode=(s:string)=>Uint8Array.from(atob(s.replaceAll("-","+").replaceAll("_","/")+"=".repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
const stamp=(s:string)=>new Date(s).toISOString().replace(/\.\d{3}Z$/,"Z");
const canonical=(p:Record<string,unknown>)=>JSON.stringify(Object.fromEntries(Object.keys(p).sort().map(k=>[k,p[k]])));
const headers={"Content-Type":"application/json","Cache-Control":"no-store"};
const pushReply=(status:number,value:Record<string,unknown>)=>new Response(JSON.stringify(value),{status,headers});
function pushSettings(){
  const appId=Deno.env.get("LV_VIVO_APP_ID")?.trim(),appKey=Deno.env.get("LV_VIVO_APP_KEY")?.trim(),appSecret=Deno.env.get("LV_VIVO_APP_SECRET")?.trim();
  return appId&&/^[1-9][0-9]{0,8}$/.test(appId)&&appKey&&appSecret?{appId:Number(appId),appKey,appSecret}:null;
}
let pushAuth:Promise<string>|undefined,pushAuthUntil=0;
async function vivoPost(path:string,body:Record<string,unknown>,authToken?:string){
  const response=await fetch("https://api-push.vivo.com.cn"+path,{method:"POST",redirect:"error",signal:AbortSignal.timeout(10000),
    headers:{"Content-Type":"application/json",...(authToken?{authToken}:{})},body:JSON.stringify(body)});
  if(!response.ok)throw Error("vendor_transport");
  const text=await response.text();if(text.length>16384)throw Error("vendor_size");
  const result=JSON.parse(text);if(!Number.isInteger(result.result))throw Error("vendor_response");return result;
}
async function vivoToken(){
  const c=pushSettings();if(!c)throw Error("push_not_configured");
  if(pushAuth&&Date.now()<pushAuthUntil)return pushAuth;
  pushAuthUntil=Date.now()+30*60*1000;
  pushAuth=(async()=>{
    // Official legacy HTTPS /message/auth contract: MD5 is vendor authentication,
    // independent of the Ed25519 signature protecting our notice contents.
    const {createHash}=await import("node:crypto"),timestamp=Date.now();
    const sign=createHash("md5").update(String(c.appId)+c.appKey+timestamp+c.appSecret).digest("hex");
    const result=await vivoPost("/message/auth",{appId:c.appId,appKey:c.appKey,timestamp,sign});
    if(result.result!==0||typeof result.authToken!=="string"||!result.authToken)throw Error("vendor_auth");return result.authToken;
  })().catch(e=>{pushAuth=undefined;throw e;});return pushAuth;
}
const vendorLength=(s:string)=>Array.from(s).reduce((n,c)=>n+(c.codePointAt(0)!>127?c.length*2:1),0);
async function pushPump(service:any,job:string){
  const worker=crypto.randomUUID(),start=Date.now();
  try{
    const token=await vivoToken();
    await service.rpc("lv_push_problem",{p_id:job,p_error:null});
    for(let batch=0;batch<4&&Date.now()-start<25000;batch++){
      const claimed=await service.rpc("lv_push_claim",{p_id:job,p_worker:worker});
      if(claimed.error||!claimed.data?.length)break;
      await Promise.all(claimed.data.map(async(item:any)=>{
        let state="uncertain",code:number|null=null,task:string|null=null;
        try{
          if(!item.token||! /^LV2-[A-Z2-7]{51}[AQ]$/.test(item.device_code||"")){state="no_registration";}
          else{
            const end=Math.min(Date.parse(item.expires_at),Date.now()+15*60000),ttl=Math.floor((end-Date.now())/1000);
            if(ttl<60){state="rejected";code=-2;}
            else{
              const full=JSON.parse(await envelope("LiquidVivo/cloud-push/v1\n",{kind:"push_notice_v1",format_version:1,product:"LiquidVivo",
                key_id:JSON.parse(new TextDecoder().decode(decode(JSON.parse(Deno.env.get("LV_CLOUD_DELEGATION")!).payload))).key_id,
                device_code:item.device_code,message_id:item.id,title:item.title,body:item.body,
                issued_at:new Date().toISOString().replace(/\.\d{3}Z$/,"Z"),expires_at:new Date(end).toISOString().replace(/\.\d{3}Z$/,"Z")}));
              // Client resolves the root-signed certificate from its last verified
              // sync. The signed payload and signature are never truncated.
              const custom={lv_notice:JSON.stringify({payload:full.payload,signature:full.signature})};
              if(encoder.encode(JSON.stringify(custom)).length>1024){state="rejected";code=-3;}
              else{
                const result=await vivoPost("/message/send",{regId:item.token,notifyType:4,title:item.title,content:item.body,
                  timeToLive:ttl,skipType:1,networkType:-1,clientCustomMap:custom,requestId:item.id},token);
                code=result.result;
                if(code===0&&typeof result.taskId==="string"){state="accepted";task=result.taskId;}
                else state=code===10303?"uncertain":"rejected";
                if(code===10000)pushAuth=undefined;
              }
            }
          }
        }catch{state="uncertain";}
        // A timeout may have reached the provider; never resend uncertain rows.
        await service.rpc("lv_push_finish",{p_id:item.id,p_worker:worker,p_state:state,p_code:code,p_task:task});
      }));
    }
  }catch{await service.rpc("lv_push_problem",{p_id:job,p_error:"vendor_auth_or_connection_failed"});}
  finally{await service.rpc("lv_push_release",{p_id:job,p_worker:worker});}
}
async function adminPush(request:Request,body:Record<string,any>){
  const uuid=(x:unknown)=>typeof x==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
  if(!["configuration","send","status","continue","cancel"].includes(body.action))return pushReply(400,{error:"invalid_push_action"});
  const bearer=request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];if(!bearer)return pushReply(401,{error:"authentication"});
  const service=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
  const scoped=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_ANON_KEY")!,{global:{headers:{Authorization:"Bearer "+bearer}},auth:{persistSession:false,autoRefreshToken:false}});
  const user=await service.auth.getUser(bearer);if(user.error||!user.data.user)return pushReply(401,{error:"authentication"});
  const ready=await scoped.rpc("lv_admin_session_ready");if(ready.error||ready.data!==true)return pushReply(403,{error:"administrator_confirmation_required"});
  if(body.action==="configuration")return pushReply(200,{configured:!!pushSettings(),minimum_client:621});
  if(!uuid(body.job_id))return pushReply(400,{error:"invalid_push_job"});
  if(body.action==="send"){
    if(!pushSettings())return pushReply(503,{error:"push_not_configured"});
    if(!uuid(body.message_id)||!Number.isSafeInteger(body.version))return pushReply(400,{error:"invalid_push_message"});
    const message=await scoped.from("lv_messages").select("title,body").eq("id",body.message_id).single();
    if(message.error)return pushReply(409,{error:"message_unavailable"});
    if(vendorLength(message.data.title)>40||vendorLength(message.data.body)>100)return pushReply(400,{error:"push_content_too_long"});
    const begin=await scoped.rpc("lv_push_begin",{p_id:body.job_id,p_message:body.message_id,p_version:body.version});
    if(begin.error)return pushReply(409,{error:"push_begin_rejected"});
  }
  const state=await scoped.rpc("lv_push_status",{p_id:body.job_id,p_cancel:body.action==="cancel"});
  if(state.error)return pushReply(409,{error:"push_job_unavailable"});
  if(["send","continue"].includes(body.action)&&state.data.counts.queued&&!state.data.canceled){
    if(!pushSettings())return pushReply(503,{error:"push_not_configured"});
    const work=pushPump(service,body.job_id);
    // Server work continues after the HTTP response; the console can resume
    // remaining queued rows after an instance interruption or its time budget.
    if(typeof EdgeRuntime!=="undefined")EdgeRuntime.waitUntil(work);else await work;
  }
  return pushReply(200,{ok:true,job:state.data});
}
// Administrative actions share the fixed gateway route, but never the policy signing path.
async function manageAccount(request:Request,body:Record<string,any>):Promise<Response>{
  const reply=(status:number,value:Record<string,unknown>)=>new Response(JSON.stringify(value),{status,headers});
  const uuid=(s:unknown)=>typeof s==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
  const actions=["block","unblock","logout","reset_email","set_password","change_email","unbind","bind","note"];
  const data=body.data??{};
  if(!actions.includes(body.action)||!uuid(body.target_id)||!uuid(body.request_id)||!data||typeof data!=="object"||Array.isArray(data))return reply(400,{error:"invalid_account_request"});
  if(body.action==="set_password"&&(typeof data.password!=="string"||data.password.length<12||data.password.length>128))return reply(400,{error:"invalid_new_password"});
  if(body.action==="change_email"&&(typeof data.email!=="string"||data.email.length>254||! /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)||data.ownership_checked!==true))return reply(400,{error:"invalid_verified_email"});
  if(body.action==="note"&&(typeof data.note!=="string"||data.note.length>2000))return reply(400,{error:"invalid_note"});
  if(body.action==="bind"&&(!uuid(data.device_id)||typeof data.pairing_token!=="string"||! /^[0-9a-f]{32}$/.test(data.pairing_token)))return reply(400,{error:"invalid_pairing"});
  const bearer=request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];
  if(!bearer)return reply(401,{error:"authentication"});
  const url=Deno.env.get("SUPABASE_URL"),secret=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"),anon=Deno.env.get("SUPABASE_ANON_KEY");
  if(!url||!secret||!anon)return reply(503,{error:"account_service_not_configured"});
  const boundedFetch=(input:RequestInfo|URL,init?:RequestInit)=>fetch(input,{...init,signal:AbortSignal.timeout(15000),redirect:"error"});
  const service=createClient(url,secret,{global:{fetch:boundedFetch},auth:{persistSession:false,autoRefreshToken:false}});
  const userClient=createClient(url,anon,{global:{fetch:boundedFetch,headers:{Authorization:"Bearer "+bearer}},auth:{persistSession:false,autoRefreshToken:false}});
  const identity=await service.auth.getUser(bearer);
  if(identity.error||!identity.data.user)return reply(401,{error:"authentication"});
  const ready=await userClient.rpc("lv_admin_session_ready");
  if(ready.error||ready.data!==true)return reply(403,{error:"administrator_confirmation_required"});
  const started=await userClient.rpc("lv_admin_account_begin",{p_action:body.action,p_target:body.target_id,p_request:body.request_id});
  if(started.error)return reply(409,{error:"account_operation_rejected"});
  if(started.data?.status==="completed")return reply(200,{ok:true,duplicate:true});
  if(started.data?.status!=="started")return reply(409,{error:"account_operation_pending_or_failed"});
  let applied=false,attempted=false,mailSent: boolean|undefined;
  try{
    let outcome:any;
    attempted=["block","unblock","set_password","change_email","reset_email"].includes(body.action);
    if(body.action==="block")outcome=await service.auth.admin.updateUserById(body.target_id,{ban_duration:"876000h"});
    if(body.action==="unblock")outcome=await service.auth.admin.updateUserById(body.target_id,{ban_duration:"none"});
    if(body.action==="set_password")outcome=await service.auth.admin.updateUserById(body.target_id,{password:data.password});
    if(body.action==="change_email")outcome=await service.auth.admin.updateUserById(body.target_id,{email:data.email.trim().toLowerCase(),email_confirm:false});
    if(body.action==="reset_email")outcome=await service.auth.resetPasswordForEmail(started.data.email,{redirectTo:"https://sleep-jay.github.io/LiquidVivo-Console/"});
    if(outcome?.error){attempted=false;throw new Error("provider_rejected");}
    applied=!!outcome;
    // Never send passwords, tokens or email contents to the operation ledger.
    const safeData=body.action==="note"?{note:data.note}:body.action==="bind"?{device_id:data.device_id,pairing_token:data.pairing_token}:{};
    const finished=await service.rpc("lv_admin_account_finish",{p_request:body.request_id,p_success:true,p_data:safeData});
    if(finished.error||finished.data!==true)throw new Error("finish_failed");
    if(body.action==="change_email"){
      try{const mail=await service.auth.resetPasswordForEmail(data.email.trim().toLowerCase(),{redirectTo:"https://sleep-jay.github.io/LiquidVivo-Console/"});mailSent=!mail.error;}catch{mailSent=false;}
    }
    return reply(200,{ok:true,...(mailSent===undefined?{}:{mail_sent:mailSent})});
  }catch{
    // Auth updates and PostgreSQL cannot share a transaction. Report uncertainty honestly.
    try{await service.rpc("lv_admin_account_finish",{p_request:body.request_id,p_success:false,p_data:{}});}catch{}
    return reply(502,{error:applied||attempted?"account_changed_confirmation_failed":"account_action_failed",partial:applied||attempted});
  }
}
let signing:Promise<CryptoKey>|undefined;
function key(){
  return signing??=crypto.subtle.importKey("pkcs8",decode(Deno.env.get("LV_CLOUD_PKCS8")??""),"Ed25519",false,["sign"]);
}
async function sign(domain:string,payload:string){
  return b64(new Uint8Array(await crypto.subtle.sign("Ed25519",await key(),encoder.encode(domain+payload))));
}
async function envelope(domain:string,p:Record<string,unknown>){
  const payload=canonical(p);
  return JSON.stringify({payload:b64(encoder.encode(payload)),signature:await sign(domain,payload),
    delegation:b64(encoder.encode(Deno.env.get("LV_CLOUD_DELEGATION")??""))});
}
async function proofLicense(text:unknown,code:string,legacy:string):Promise<string|null>{
  try{
    if(typeof text!=="string"||text.length>16384)return null;
    const e=JSON.parse(text),raw=decode(e.payload),p=JSON.parse(new TextDecoder().decode(raw));
    if(canonical(p)!==new TextDecoder().decode(raw)||p.algorithm!=="Ed25519"||p.format_version!==1||p.product!=="LiquidVivo"||
      !((p.device_binding_version===2&&p.device_code===code)||(p.device_binding_version===1&&p.device_code===legacy))||
      !/^[0-9a-f-]{36}$/.test(p.license_id)||!Array.isArray(p.features)||p.sponsor_tier!=="supporter"||
      (p.expires_at!==null&&!(Date.parse(p.expires_at)>Date.now())))return null;
    const roots=JSON.parse(Deno.env.get("LV_ROOT_KEYS")??"{}");let publicKey=roots[p.key_id];
    if(publicKey){if(e.delegation)return null;}
    else{
      const cert=JSON.parse(new TextDecoder().decode(decode(e.delegation))),certBytes=decode(cert.payload);
      const c=JSON.parse(new TextDecoder().decode(certBytes));
      if(canonical(c)!==new TextDecoder().decode(certBytes)||c.key_id!==p.key_id||c.algorithm!=="Ed25519"||c.format_version!==1||
        c.product!=="LiquidVivo"||c.permissions!=="notification_island.status_bar.policy"||!roots[c.issuer_key_id]||cert.delegation||
        p.device_binding_version!==2||p.features.some((f:string)=>!["notification_island","status_bar"].includes(f)))return null;
      const root=await crypto.subtle.importKey("raw",decode(roots[c.issuer_key_id]),"Ed25519",false,["verify"]);
      if(!await crypto.subtle.verify("Ed25519",root,decode(cert.signature),encoder.encode("LiquidVivo/cloud-delegation/v1\n"+new TextDecoder().decode(certBytes))))return null;
      publicKey=c.public_key;
    }
    const key=await crypto.subtle.importKey("raw",decode(publicKey),"Ed25519",false,["verify"]);
    return await crypto.subtle.verify("Ed25519",key,decode(e.signature),encoder.encode("LiquidVivo/license/v1\n"+new TextDecoder().decode(raw)))?p.license_id:null;
  }catch{return null;}
}
Deno.serve(async(request:Request)=>{
  if(request.method!=="POST")return new Response('{"error":"method"}',{status:405,headers});
  try{
    if(Number(request.headers.get("content-length")??0)>32768)return new Response('{"error":"size"}',{status:413,headers});
    // Bound streaming input too; Content-Length is not trusted.
    const reader=request.body?.getReader();if(!reader)throw new Error("body");
    const parts:Uint8Array[]=[];let size=0;
    while(true){const {value,done}=await reader.read();if(done)break;size+=value.length;if(size>32768){await reader.cancel();throw new Error("size");}parts.push(value);}
    const buffer=new Uint8Array(size);let offset=0;for(const part of parts){buffer.set(part,offset);offset+=part.length;}
    const body=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(buffer));
    if(body.operation==="admin_accounts")return await manageAccount(request,body);
    if(body.operation==="admin_push")return await adminPush(request,body);
    if(body.operation==="health") {
      if(typeof body.nonce!=="string"||! /^[0-9a-f]{32}$/.test(body.nonce))throw new Error("nonce");
      const proof=await envelope("LiquidVivo/cloud-health/v1\n",{kind:"health_v1",nonce:body.nonce,product:"LiquidVivo"});
      return new Response(proof,{status:200,headers});
    }
    if(typeof body.device_code!=="string"||!/^LV2-[A-Z2-7]{51}[AQ]$/.test(body.device_code)||
      typeof body.nonce!=="string"||! /^[0-9a-f]{32}$/.test(body.nonce)||
      typeof body.version!=="string"||!/^\d{1,10}$/.test(body.version)||
      typeof body.label!=="string"||body.label.length>120||
      (body.legacy_code!==""&&!/^LV1-[A-Z2-7]{51}[AQ]$/.test(body.legacy_code))||
      !Array.isArray(body.receipts)||body.receipts.length>40||body.receipts.some((r:Record<string,string>)=>
        !r||! /^[0-9a-f-]{36}$/.test(r.id)||!["received","displayed"].includes(r.state)))throw new Error("input");
    const token=request.headers.get("authorization")?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];
    const push=body.push_registration;
    if(push!==undefined&&(!push||push.provider!=="vivo"||typeof push.enabled!=="boolean"||
      typeof push.token!=="string"||(push.enabled?!/^[A-Za-z0-9:_-]{10,512}$/.test(push.token):push.token!=="")))throw new Error("push input");
    if(!token)return new Response('{"error":"authentication"}',{status:401,headers});
    const client=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data:user,error:authError}=await client.auth.getUser(token);
    if(authError||!user.user)return new Response('{"error":"authentication"}',{status:401,headers});
    const scoped=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_ANON_KEY")!,{global:{headers:{Authorization:"Bearer "+token}},auth:{persistSession:false,autoRefreshToken:false}});
    const active=await scoped.rpc("lv_user_session_active");
    if(active.error)throw new Error("session_check");
    if(active.data!==true)return new Response('{"error":"session_inactive"}',{status:401,headers});
    const args={p_actor:user.user.id,p_code:body.device_code,p_legacy:body.legacy_code,p_version:body.version,p_label:body.label,p_receipts:body.receipts};
    let {data,error}=await client.rpc("lv_cloud_exchange",args);
    if(error)throw new Error("exchange");
    if(!data.installation_authorized){
      const proof=await proofLicense(body.license_proof,body.device_code,body.legacy_code);
      if(proof){
        const resumed=await client.rpc("lv_cloud_resume",{p_actor:user.user.id,p_code:body.device_code,p_license_id:proof});
        if(!resumed.error&&resumed.data===true){const again=await client.rpc("lv_cloud_exchange",args);if(again.error)throw new Error("exchange");data=again.data;}
      }
    }
    if(!/^[0-9]{1,9}$/.test(body.version)||Number(body.version)<621){
      data.messages=(data.messages||[]).map((m:any)=>{
        if(m.kind!=="changelog")return m;
        try{const n=JSON.parse(m.body);if(n.format==="lv_release_notes_v1")return {...m,body:n.zh+"\n\n"+n.en};}catch{}
        return m;
      });
    }
    let pushStatus="not_requested";
    if(push!==undefined){
      if(!data.installation_authorized)pushStatus="unauthorized";
      else{
        const registered=await client.rpc("lv_cloud_push_registration",{p_actor:user.user.id,p_provider:push.provider,p_token:push.token,p_enabled:push.enabled});
        pushStatus=registered.error?(["PGRST202","42883"].includes(registered.error.code)?"not_deployed":"failed"):
          (["registered","removed","unauthorized"].includes(registered.data)?registered.data:"failed");
      }
    }
    const certificate=JSON.parse(Deno.env.get("LV_CLOUD_DELEGATION")??"");
    const authority=JSON.parse(new TextDecoder().decode(decode(certificate.payload)));
    const licenses:string[]=[];const imported=new Set<string>();
    for(const text of data.legacy_licenses){
      const parsed=JSON.parse(text);
      const payload=JSON.parse(new TextDecoder().decode(decode(parsed.payload)));
      // Original root-signed licenses remain unchanged and are independently
      // verified by the Android verifier, including old LV1 binding.
      if(payload.expires_at===null||Date.parse(payload.expires_at)>Date.now()){
        licenses.push(text);imported.add(payload.license_id);
      }
    }
    for(const grant of data.grants){
      if(imported.has(grant.id))continue;
      const features=[...new Set<string>(grant.features)].sort();
      if(!features.length||features.some(f=>!["notification_island","status_bar"].includes(f)))throw new Error("features");
      licenses.push(await envelope("LiquidVivo/license/v1\n",{
        algorithm:"Ed25519",device_binding_version:2,device_code:body.device_code,
        expires_at:grant.ends_at?stamp(grant.ends_at):null,features,format_version:1,
        issued_at:stamp(grant.starts_at),key_id:authority.key_id,license_id:grant.id,product:"LiquidVivo",sponsor_tier:"supporter"}));
    }
    if(licenses.length>32)throw new Error("license budget");
    const packet=await envelope("LiquidVivo/cloud-policy/v1\n",{
      kind:"policy_v1",format_version:1,product:"LiquidVivo",key_id:authority.key_id,
      revision:data.revision,nonce:body.nonce,device_code:body.device_code,issued_at:stamp(new Date().toISOString()),
      blocked:data.blocked,sponsor_revoked:data.sponsor_revoked,bound:data.bound,
      installation_authorized:data.installation_authorized,revoked_license_ids:data.revoked_license_ids,
      pairing_token:data.pairing_token,licenses,messages:data.messages,push_registration_status:pushStatus});
    if(encoder.encode(packet).length>131072)throw new Error("packet budget");
    return new Response(packet,{status:200,headers});
  }catch{
    // Do not log bearer tokens, identifiers, SQL errors or signed licenses.
    return new Response('{"error":"sync_unavailable"}',{status:503,headers});
  }
});
