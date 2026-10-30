const NAME = 'LiquidVivo 管理员';

export function totpQrSource(value) {
  let svg=String(value||'').trim();
  if(svg.length>160000)throw Error('验证器二维码内容过大');
  const uri=svg.match(/^data:image\/svg\+xml((?:;[^,]*)?),([\s\S]*)$/i);
  if(uri){svg=/;base64(?:;|$)/i.test(uri[1])?atob(uri[2]):uri[2];}
  if(!svg.trimStart().startsWith('<')&&/%[0-9a-f]{2}/i.test(svg))svg=decodeURIComponent(svg);
  svg=svg.replace(/^\uFEFF/,'').trimStart();
  // Real QR generators may prefix SVG with an XML declaration, comments or an SVG DTD.
  // Remove declarations before rendering as an isolated SVG image. Never insert SVG as HTML.
  for(let i=0;i<12;i++){
    const next=svg.replace(/^(?:<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE\s+svg\s+[^>\[]*>)[\s]*/i,'');
    if(next===svg)break;svg=next;
  }
  if(svg.length>100000||!/^<svg(?:\s|>)/.test(svg))throw Error('验证器二维码格式无效');
  if(typeof DOMParser!=='undefined'){
    const doc=new DOMParser().parseFromString(svg,'image/svg+xml');
    if(doc.querySelector('parsererror')||doc.documentElement.localName!=='svg'||doc.documentElement.namespaceURI!=='http://www.w3.org/2000/svg')throw Error('验证器二维码格式无效');
  }
  return 'data:image/svg+xml,'+encodeURIComponent(svg);
}

export function enrollmentPresentation(totp){
  const secret=typeof totp?.secret==='string'&&/^[A-Z2-7]{16,256}={0,6}$/.test(totp.secret)?totp.secret:null;
  let qr=null;
  try{qr=totpQrSource(totp?.qr_code);}catch{/* A display failure must not block a valid manual TOTP setup. */}
  if(!qr&&!secret)throw Error('验证器配置未完整返回，请重新连接。');
  return {qr,secret};
}

/** Single-flight per account; secrets live only in this page's memory. */
export function createMfaCoordinator(mfa) {
  let cached = null;
  let flight = null;
  let flightUser = null;
  async function read() {
    const {data,error}=await mfa.listFactors();
    if(error)throw error;
    // Supabase's typed `totp` list contains VERIFIED factors only.
    // Pending enrollments are available through `all`, not `totp`.
    return data.all.filter(f=>f.factor_type==='totp');
  }
  async function prepare(userId) {
    const factors=await read();
    const verified=factors.find(f=>f.status==='verified');
    if(verified){cached=null;return {verified,pending:null};}
    if(cached?.userId===userId&&factors.some(f=>f.id===cached.pending.id&&f.status==='unverified'))
      return {verified:null,pending:cached.pending};
    cached=null;
    // Never remove an existing verified factor or another application's enrollment.
    for(const factor of factors.filter(f=>f.status==='unverified'&&f.friendly_name===NAME)) {
      const {error}=await mfa.unenroll({factorId:factor.id});
      if(error)throw error;
    }
    const enrolled=await mfa.enroll({factorType:'totp',friendlyName:NAME});
    if(enrolled.error){
      // Another tab may have completed verification while this request was in flight.
      const current=await read();
      const existing=current.find(f=>f.status==='verified');
      if(existing)return {verified:existing,pending:null};
      if(current.some(f=>f.friendly_name===NAME))throw Error('另一页面正在设置管理员验证器。请关闭其他设置页面，再在本页面重新连接。');
      throw enrolled.error;
    }
    cached={userId,pending:enrolled.data};
    return {verified:null,pending:enrolled.data};
  }
  return {
    prepare(userId){
      if(flight){if(flightUser!==userId)return Promise.reject(Error('账号已变化，请刷新页面。'));return flight;}
      flightUser=userId;
      flight=prepare(userId).finally(()=>{flight=null;flightUser=null;});
      return flight;
    },
    clear(){cached=null;},
  };
}
