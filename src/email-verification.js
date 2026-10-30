const KEY='lv-admin-pending-email';
export function createEmailConfirmation({auth,rpc,storage,now=Date.now}) {
  return {
    async send(email,userId){
      const token=await rpc('lv_admin_begin_email');
      storage.setItem(KEY,JSON.stringify({token,userId,expires:now()+15*60000,sent:now()}));
      const {error}=await auth.signInWithOtp({email,options:{shouldCreateUser:false}});
      if(error)throw error;
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
