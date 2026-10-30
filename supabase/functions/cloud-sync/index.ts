// Deploy with verify_jwt=false: getUser below validates the bearer with Auth.
// Only the delegated child key is stored in Edge secrets. Never upload the root key.
import { createClient } from "npm:@supabase/supabase-js@2.118.0";
const encoder=new TextEncoder();
const b64=(data:Uint8Array)=>btoa(String.fromCharCode(...data)).replaceAll("+","-").replaceAll("/","_").replace(/=+$/,"");
const decode=(s:string)=>Uint8Array.from(atob(s.replaceAll("-","+").replaceAll("_","/")+"=".repeat((4-s.length%4)%4)),c=>c.charCodeAt(0));
const stamp=(s:string)=>new Date(s).toISOString().replace(/\.\d{3}Z$/,"Z");
const canonical=(p:Record<string,unknown>)=>JSON.stringify(Object.fromEntries(Object.keys(p).sort().map(k=>[k,p[k]])));
const headers={"Content-Type":"application/json","Cache-Control":"no-store"};
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
    if(!token)return new Response('{"error":"authentication"}',{status:401,headers});
    const client=createClient(Deno.env.get("SUPABASE_URL")!,Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,{auth:{persistSession:false,autoRefreshToken:false}});
    const {data:user,error:authError}=await client.auth.getUser(token);
    if(authError||!user.user)return new Response('{"error":"authentication"}',{status:401,headers});
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
      pairing_token:data.pairing_token,licenses,messages:data.messages});
    if(encoder.encode(packet).length>131072)throw new Error("packet budget");
    return new Response(packet,{status:200,headers});
  }catch{
    // Do not log bearer tokens, identifiers, SQL errors or signed licenses.
    return new Response('{"error":"sync_unavailable"}',{status:503,headers});
  }
});
