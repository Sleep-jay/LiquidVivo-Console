const NAME = 'LiquidVivo 管理员';

export function totpQrSource(value) {
  let svg=String(value||'');
  for(const prefix of ['data:image/svg+xml;utf-8,','data:image/svg+xml,'])
    if(svg.startsWith(prefix)){svg=svg.slice(prefix.length);break;}
  if(svg.startsWith('%3C')||svg.startsWith('%3c'))svg=decodeURIComponent(svg);
  if(svg.length>100000||!svg.trimStart().startsWith('<svg'))throw Error('验证器二维码格式无效，请重新连接。');
  return 'data:image/svg+xml,'+encodeURIComponent(svg);
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
