const pageSize=250;

export async function loadAdminDevices(request){
  const devices=[];
  let cursor=null;
  for(;;){
    const params=cursor?{p_before:cursor.created_at,p_before_id:cursor.id}:{};
    const page=await request('lv_admin_device_page',params);
    if(page.error){
      if(!cursor&&['PGRST202','42883'].includes(page.error.code)){
        const legacy=await request('lv_admin_devices');
        return {...legacy,cleanupReady:false};
      }
      return page;
    }
    if(!Array.isArray(page.data)||page.data.length>pageSize)throw Error('设备分页响应无效');
    devices.push(...page.data);
    if(page.data.length<pageSize)return {data:devices,cleanupReady:true};
    const next=page.data.at(-1);
    if(!next.id||!next.created_at||next.id===cursor?.id)throw Error('设备分页游标无效');
    cursor=next;
  }
}
