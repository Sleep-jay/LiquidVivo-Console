const KEY='lv-admin-pending-email';
export function createEmailConfirmation({auth,rpc,storage,now=Date.now,diagnose=async()=>''}) {
  return {
    async send(email,userId){
      let stage='登记邮箱确认';
      try {
      const token=await rpc('lv_admin_begin_email');
      const pending={token,userId,expires:now()+15*60000,sent:0};
      storage.setItem(KEY,JSON.stringify(pending));
      stage='请求发送邮件';
      const {error}=await auth.signInWithOtp({email,options:{shouldCreateUser:false}});
      if(error)throw error;
      pending.sent=now();
      storage.setItem(KEY,JSON.stringify(pending));
      } catch(error) {
        const message=String(error?.message||error||'请求失败');
        let network='';
        if(/fetch|network|timeout|load failed/i.test(message)) {
          try {network=await diagnose();}catch {network='连接检查失败';}
        }
        throw Error(`${stage}失败：${message}${network?'；'+network:''}`);
      }
    },
    async verify(email,userId,code){
      if(!/^[0-9]{6,10}$/.test(code))throw Error('请输入邮件中的数字验证码');
      let pending;
      try{pending=JSON.parse(storage.getItem(KEY)||'null');}catch{pending=null;}
      if(!pending||pending.userId!==userId||pending.expires<=now())throw Error('确认步骤已失效，请重新发送；如提示需要密码，请退出后重新登录。');
      const {data,error}=await auth.verifyOtp({email,token:code,type:'email'});
      if(error)throw error;
      if(data.user?.id!==userId)throw Error('确认账号不一致，请退出后重新登录');
      const result=await rpc('lv_admin_complete_email',{p_token:pending.token});
      storage.removeItem(KEY);
      return result;
    },
    lastSent(){try{return JSON.parse(storage.getItem(KEY)||'null')?.sent||0;}catch{return 0;}},
    clear(){storage.removeItem(KEY);},
  };
}
