import {encodeReleaseNotes,decodeReleaseNotes} from './release-notes.js';
import {pageOf,pagerHtml} from './pagination.js';
import {createAutoRefresh} from './auto-refresh.js';
import {audienceFields,bindAudiencePicker,messageTargets} from './message-audience.js';
import {searchItems,matches} from './search.js';
import {deviceFilterOptions,matchesDeviceFilter,deviceSearchFields} from './device-filters.js';
import {messageKinds,messageStates,messageState,messageCards,messagePayload} from './message-management.js';
import {accountFilters,accountMatches,accountSearchFields,accountList,accountActions,accountForm,accountActionData} from './accounts.js';
import {authFlowType} from './recovery.js';
import {campaignGrants,codeFields,codePayload,campaignCodesView,campaignCodeState} from './campaigns.js';
import {validatePushMessage,pushJobHtml,pushErrors} from './push-management.js';
import { createClient } from '@supabase/supabase-js';
import { config } from './config.js';
import { gatewayFetch } from './gateway-fetch.js';
import { diagnoseGateway } from './gateway-diagnostics.js';
import './style.css';
import './plain.css';
import './member.css';
import './sponsorship.css';
import {sponsorView,feedbackView,yuanToCents,paymentChannels,paymentImage} from './sponsorship.js';
import { memberShell, memberDevices, memberMessages } from './member.js';
import { createEmailConfirmation } from './email-verification.js';

const root = document.querySelector('#app');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const storeKey = 'lv-auto-login';
const storage = {
  getItem: k => sessionStorage.getItem(k) ?? localStorage.getItem(k),
  setItem: (k,v) => { const persistent = localStorage.getItem(storeKey)==='yes'; (persistent?localStorage:sessionStorage).setItem(k,v); (persistent?sessionStorage:localStorage).removeItem(k); },
  removeItem: k => { sessionStorage.removeItem(k); localStorage.removeItem(k); },
};
const api = createClient(config.url, config.publishableKey, {global:{fetch:gatewayFetch},auth:{storage,storageKey:config.authStorageKey,persistSession:true,autoRefreshToken:true,detectSessionInUrl:true,flowType:authFlowType(globalThis.location?.hash)}});
let session, admin=false, section='devices', devices=[], entitlements=[], messages=[], campaigns=[], audit=[], selected=new Set(), sort='created_at', direction=-1;
let authMode='login', authBusy=false, recovery=false;
let sponsorOrders=[],feedbackItems=[],sponsorReady=false,messageReady=false;
let campaignClaims=[],campaignCodes=[],campaignReady=false;
let pushJobs=[];
let accounts=[],accountSelected=new Set(),accountCursor=null,accountTotal=0,accountReady=false,accountBusy=false,accountError='',includeInstallations=false,accountLoadToken=0,registrationPolicy=null;
let deviceQuery='',deviceFilter='all';
const listStates=new Map();
const listState=()=>{if(!listStates.has(section))listStates.set(section,{query:'',filter:'all'});return listStates.get(section);};
const emailConfirmation=createEmailConfirmation({auth:api.auth,rpc,storage:sessionStorage,diagnose:()=>diagnoseGateway(config)});
let bootFlight=null, workspaceReady=false, viewEpoch=0;
let devicePage=1,devicePageSize=10;
const icons = {devices:'▦',campaigns:'◷',messages:'▤',audit:'↗',users:'♙',account:'◉',sponsor:'♡',feedback:'▱'};
const names = {devices:'设备与权益',campaigns:'限免活动',messages:'消息与内容',audit:'操作记录',users:'账号管理',account:'账号设置',sponsor:'赞助审核',feedback:'用户反馈'};
const time = v => v ? new Date(v).toLocaleString('zh-CN',{hour12:false}) : '尚未联系';
const localDate = v => { const d=new Date(v); return new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,16); };
const dateField=(name,label,value)=>`<label>${label}<input name="${name}" type="datetime-local" value="${localDate(value)}" required></label>`;
const features=()=>`<fieldset><legend>开放功能</legend><label class="check"><input type="checkbox" name="feature" value="notification_island" checked>通知上岛</label><label class="check"><input type="checkbox" name="feature" value="status_bar" checked>状态栏定制</label></fieldset>`;
function toast(text){const el=document.querySelector('#toast');el.textContent=text;el.classList.add('visible');clearTimeout(toast.timer);toast.timer=setTimeout(()=>el.classList.remove('visible'),5500);}
function errorText(e){const t=e?.message||'操作失败，请重试';if(/relation .* does not exist|function .*not find|schema cache/i.test(t))return '后台缺少所需接口。首次使用请执行 001、002；管理员邮箱确认还需要执行 003_admin_email.sql。';if(/Invalid login credentials/i.test(t))return '邮箱或密码不正确。';if(/Email not confirmed/i.test(t))return '请先打开邮件完成邮箱验证。';if(/rate limit/i.test(t))return '请求过于频繁，请稍后重试。';return t;}
async function rpc(name,args){const {data,error}=await api.rpc(name,args);if(error)throw error;return data;}
async function hashDevice(code){if(!/^LV[12]-[A-Z2-7]{51}[AQ]$/.test(code))throw Error('请粘贴完整的 LV1 / LV2 设备码。');return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('LiquidVivo/console/device/v1\n'+code)))].map(v=>v.toString(16).padStart(2,'0')).join('');}
function shell(content,side=true){return `<div class="ambient" aria-hidden="true"><i></i><i></i></div>${side?`<aside class="sidebar"><a class="brand" href="#"><span class="brand-mark">L<span>V</span></span><span>LiquidVivo<small>CONTROL ROOM</small></span></a><div class="side-label">工作空间</div><nav>${Object.entries(names).map(([key,label])=>`<button class="nav ${section===key?'active':''}" data-section="${key}"><span>${icons[key]}</span>${label}${key==='devices'?`<small>${devices.length}</small>`:''}</button>`).join('')}</nav><div class="side-bottom"><span class="status-dot"></span>${admin?'管理员工作空间':'我的设备空间'}<p>${esc(session?.user.email)}</p><button class="text-button" id="logout">退出登录 ↗</button></div></aside>`:''}<main class="${side?'workspace':'auth-space'}">${content}</main>`;}
function authPage(){workspaceReady=false;viewEpoch++;autoRefresh.stop();selected.clear();deviceQuery='';deviceFilter='all';listStates.clear();accounts=[];accountSelected.clear();accountReady=false;registrationPolicy=null;accountLoadToken++;admin=false;root.innerHTML=shell(`<div class="auth-art"><a class="brand" href="#"><span class="brand-mark">L<span>V</span></span>LiquidVivo</a><div><span class="eyebrow">LESS NOISE. MORE CONTROL.</span><h1>每一份支持，<br>都有回应。</h1><p>你的设备、权益与消息，<br>在一个安静、有序的空间里。</p></div><div class="glass-orbit" aria-hidden="true"><div class="glass-pebble"></div><span>Liquid, in every detail.</span></div><small>LIQUIDVIVO / MEMBER & DEVICE CONSOLE</small></div><section class="auth-card glass"><span class="eyebrow">${recovery?'ACCOUNT RECOVERY':'WELCOME TO LIQUIDVIVO'}</span><h2>${recovery?'设置新密码':authMode==='signup'?'注册':authMode==='reset'?'找回密码':'登录'}</h2><p class="muted">${recovery?'为你的账号设置一个新的安全密码。':authMode==='signup'?'验证邮箱后，绑定系统中已有的设备。':authMode==='reset'?'我们会向你的邮箱发送重置链接。':'使用邮箱登录 LiquidVivo。'}</p><form id="auth-form">${recovery?'':`<label>邮箱<input name="email" type="email" autocomplete="username" placeholder="you@example.com" required maxlength="254"></label>`}${authMode==='reset'&&!recovery?'':`<label>密码<div class="password-field"><input id="password" name="password" type="password" autocomplete="${authMode==='signup'||recovery?'new-password':'current-password'}" minlength="12" maxlength="128" placeholder="至少 12 位，建议使用密码管理器" required><button type="button" id="show-password" aria-label="显示密码">◉</button></div></label>`}${authMode==='login'&&!recovery?`<div class="form-row"><label class="check"><input type="checkbox" name="remember" ${localStorage.getItem(storeKey)==='yes'?'checked':''}>在此设备自动登录</label><button class="text-button" type="button" data-auth="reset">忘记密码？</button></div>`:''}<p class="form-error" role="alert" id="auth-error"></p><button class="primary wide" type="submit">${recovery?'保存新密码':authMode==='signup'?'创建账号':authMode==='reset'?'发送重置邮件':'登录'} <span>↗</span></button></form><div class="auth-switch">${authMode==='login'?'还没有账号？':''}<button class="text-button" data-auth="${authMode==='login'?'signup':'login'}">${authMode==='login'?'创建账号':'返回登录'}</button></div><div class="fine-print">密码由身份服务处理，本站不保存明文密码。<br>普通账号须完成设备绑定才能查看设备权益。</div></section>`,false);
 root.querySelectorAll('[data-auth]').forEach(b=>b.onclick=()=>{authMode=b.dataset.auth;authPage();});
 root.querySelector('#show-password')?.addEventListener('click',()=>{const input=root.querySelector('#password');input.type=input.type==='password'?'text':'password';});
 root.querySelector('#auth-form').onsubmit=async e=>{e.preventDefault();if(authBusy)return;authBusy=true;const b=e.submitter;b.disabled=true;const f=new FormData(e.target);try{
   let result;
   if(recovery){result=await api.auth.updateUser({password:f.get('password')});if(result.error)throw result.error;recovery=false;toast('密码已更新');await boot();return;}
   if(authMode==='reset'){result=await api.auth.resetPasswordForEmail(f.get('email'),{redirectTo:location.origin+location.pathname});if(result.error)throw result.error;toast('如邮箱已注册，将收到重置邮件，请检查收件箱。');return;}
   if(authMode==='signup'){result=await api.auth.signUp({email:f.get('email'),password:f.get('password'),options:{emailRedirectTo:location.origin+location.pathname}});if(result.error)throw result.error;toast('请检查邮箱并完成验证，然后登录绑定设备。');if(result.data.session)await boot();return;}
   localStorage.setItem(storeKey,f.get('remember')?'yes':'no');
   result=await api.auth.signInWithPassword({email:f.get('email'),password:f.get('password')});if(result.error)throw result.error;await boot();
 }catch(err){document.querySelector('#auth-error').textContent=errorText(err);}finally{authBusy=false;if(b.isConnected)b.disabled=false;}};
}
function dialog(title,body,onSubmit,button='保存'){viewEpoch++;document.querySelector('dialog')?.remove();const el=document.createElement('dialog');el.className='modal glass';el.innerHTML=`<form><header><h2>${esc(title)}</h2><button type="button" class="close" aria-label="关闭">×</button></header>${body}<p class="form-error" role="alert"></p><footer><button type="button" class="secondary cancel">取消</button><button class="primary" type="submit">${esc(button)}</button></footer></form>`;document.body.append(el);el.querySelectorAll('.close,.cancel').forEach(b=>b.onclick=()=>el.close());el.addEventListener('close',()=>el.remove());el.querySelector('form').onsubmit=async e=>{e.preventDefault();e.submitter.disabled=true;try{await onSubmit(new FormData(e.target));el.close();}catch(err){el.querySelector('.form-error').textContent=errorText(err);}finally{if(e.submitter.isConnected)e.submitter.disabled=false;}};el.showModal();return el;}
function boot(){if(!bootFlight)bootFlight=bootOnce().finally(()=>{bootFlight=null;});return bootFlight;}
async function bootOnce(){workspaceReady=false;viewEpoch++;autoRefresh.stop();try{const {data,error}=await api.auth.getSession();if(error)throw error;session=data.session;if(recovery){authPage();return;}if(!session){authPage();return;}if(!await rpc('lv_user_session_active')){await api.auth.signOut({scope:'local'});session=null;authPage();toast('会话已失效，请重新登录。');return;}admin=await rpc('lv_is_admin');if(admin&&!await rpc('lv_admin_session_ready')){emailConfirmationPage();return;}await load();if(recovery){authPage();return;}render();workspaceReady=true;autoRefresh.start();if(admin&&section==='users')void refreshAccounts();}catch(e){root.innerHTML=shell(`<section class="empty"><h2>暂时无法连接工作空间</h2><p>${esc(errorText(e))}</p><button class="primary" id="retry">重新连接</button><button class="secondary" id="logout">退出登录</button></section>`,false);document.querySelector('#retry').onclick=boot;document.querySelector('#logout').onclick=logout;}}
function emailConfirmationPage(){
 workspaceReady=false;viewEpoch++;autoRefresh.stop();
 const email=session.user.email,userId=session.user.id;
 root.innerHTML=shell(`<section class="mfa-card glass"><h2>管理员邮箱确认</h2><p>验证码将发送到 <strong>${esc(email)}</strong>。不需要安装验证器或扫描二维码。</p><p>点击发送后，到 QQ 邮箱查看验证码，再回到这里填写。确认有效期为 12 小时。</p><button id="send-email-code" class="secondary wide" type="button">发送邮箱验证码</button><form id="email-code-form"><label>邮件中的验证码<input name="code" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" required minlength="6" maxlength="10"></label><p class="form-error" role="alert" id="email-error"></p><button class="primary wide">确认并进入管理台</button></form><p class="muted">验证码不要转发给他人。邮件未收到时，请检查垃圾邮件或稍后重发。</p><button class="text-button" id="logout">退出登录</button></section>`,false);
 document.querySelector('#logout').onclick=logout;
 const send=document.querySelector('#send-email-code'),error=document.querySelector('#email-error');
 function cooldown(){if(!send.isConnected)return;const seconds=Math.ceil((emailConfirmation.lastSent()+60000-Date.now())/1000);send.disabled=seconds>0;send.textContent=seconds>0?`请 ${seconds} 秒后重发`:'发送邮箱验证码';if(seconds>0)setTimeout(cooldown,1000);}
 cooldown();
 send.onclick=async()=>{send.disabled=true;error.textContent='';try{await emailConfirmation.send(email,userId);toast('验证码已发送，请查看邮箱。');}catch(e){error.textContent=errorText(e);}finally{cooldown();}};
 document.querySelector('#email-code-form').onsubmit=async e=>{e.preventDefault();const b=e.submitter;b.disabled=true;error.textContent='';try{await emailConfirmation.verify(email,userId,new FormData(e.target).get('code').trim());toast('邮箱确认成功');await boot();}catch(err){error.textContent=errorText(err);}finally{if(b.isConnected)b.disabled=false;}};
}

async function load({canApply=()=>true,signal}={}){
 const request=q=>signal?q.abortSignal(signal):q;
 const lists=await Promise.all(['lv_devices','lv_entitlements','lv_messages','lv_campaigns',...(admin?['lv_audit']:[])].map(table=>request(table==='lv_devices'&&admin?api.rpc('lv_admin_devices'):api.from(table).select(table==='lv_devices'?'id,device_hash,owner_id,label,blocked,app_version,last_seen,created_at':'*').order('created_at',{ascending:false}).limit(1000))));
 for(const r of lists)if(r.error)throw r.error;
 let ready=false;
 if(admin){const r=await request(api.rpc('lv_admin_message_management_ready'));if(r.error&&!['PGRST202','42883'].includes(r.error.code))throw r.error;ready=r.data===true&&!r.error;}
 const extra=await Promise.all(['lv_sponsor_orders','lv_feedback'].map(table=>request(api.from(table).select('*').order('created_at',{ascending:false}).limit(1000))));
 for(const result of extra)if(result.error&&!['PGRST205','42P01'].includes(result.error.code))throw result.error;
 const campaignData=await Promise.all(['lv_campaign_claims',...(admin?['lv_campaign_codes']:[])].map(table=>request(api.from(table).select('*').order('created_at',{ascending:false}).limit(1000))));
 for(const r of campaignData)if(r.error&&!['PGRST205','42P01'].includes(r.error.code))throw r.error;
 const pushList=admin?await request(api.from('lv_push_jobs').select('id,message_id,created_at,canceled_at').order('created_at',{ascending:false}).limit(1000)):null;
 if(pushList?.error&&!['PGRST205','42P01'].includes(pushList.error.code))throw pushList.error;
 // Commit a complete snapshot only while the initiating view/session is still current.
 if(!canApply())return false;
 [devices,entitlements,messages,campaigns,audit]=lists.map(r=>r.data);audit ||= [];
 campaignReady=campaignData.every(r=>!r.error);campaignClaims=campaignData[0]?.data||[];campaignCodes=campaignData[1]?.data||[];
 pushJobs=pushList?.data||[];
 entitlements.push(...campaignGrants(campaigns,campaignClaims));
 devices=devices.map(d=>({...d,campaign_titles:entitlements.filter(g=>g.device_id===d.id&&g.campaign_id).map(g=>g.campaign_title)}));
 selected=new Set([...selected].filter(id=>devices.some(d=>d.id===id)));
 messageReady=ready;
 sponsorReady=extra.every(r=>!r.error);[sponsorOrders,feedbackItems]=extra.map(r=>r.data||[]);
 return true;
}
function canAutoRefresh(){
 return workspaceReady&&!bootFlight&&!document.querySelector('dialog[open]')&&
   !root.querySelector('#refresh:disabled')&&
   (!root.contains(document.activeElement)||!document.activeElement.matches('input:not(#search),textarea,select'));
}
async function refreshWorkspace(){
 const epoch=viewEpoch,userId=session?.user.id,currentSection=section;
 const canApply=()=>canAutoRefresh()&&epoch===viewEpoch&&session?.user.id===userId&&section===currentSection;
 const signal=AbortSignal.timeout(20000);
 // Revalidate server-side role/confirmation before applying another snapshot.
 const role=await api.rpc('lv_is_admin').abortSignal(signal);if(role.error)throw role.error;
 if(!canApply())return;
 const active=await api.rpc('lv_user_session_active').abortSignal(signal);if(active.error)throw active.error;if(!canApply())return;if(active.data!==true){await boot();return;}
 if(role.data!==admin){await boot();return;}
 if(admin){const ready=await api.rpc('lv_admin_session_ready').abortSignal(signal);if(ready.error)throw ready.error;if(!canApply())return;if(!ready.data){emailConfirmationPage();return;}}
 if(!await load({canApply,signal}))return;
 if(admin&&section==='users'){await refreshAccounts({quiet:true});return;}
 if(admin&&section==='devices'){
   // Keep search input, focus, sorting, page and cross-page selection in place.
   rows();
   const counts=[devices.length,devices.filter(d=>activeGrants(d).length).length,devices.filter(d=>d.blocked).length];
   root.querySelectorAll('.stats strong').forEach((el,i)=>{el.firstChild.textContent=counts[i];});
   const count=root.querySelector('[data-section="devices"] small');if(count)count.textContent=devices.length;
 }else{
   const x=window.scrollX,y=window.scrollY;render();window.scrollTo(x,y);
 }
}
const autoRefresh=createAutoRefresh({refresh:refreshWorkspace,canRefresh:canAutoRefresh,document,window});

function activeGrants(d){return entitlements.filter(e=>e.device_id===d.id&&!e.revoked_at&&new Date(e.starts_at)<=new Date()&&(!e.ends_at||new Date(e.ends_at)>new Date()));}
function status(d){if(d.blocked)return ['danger','已拉黑'];const grants=activeGrants(d);if(grants.some(e=>!e.ends_at))return ['green','永久权益'];if(grants.length)return ['blue','限时权益'];return ['neutral','无云端权益'];}
function badge(d){const [style,text]=status(d);return `<span class="badge ${style}">${text}</span>`;}
function toolbar(title,desc,action=''){return `<header class="topbar"><div><span class="eyebrow">LIQUIDVIVO / ${admin?'CONTROL ROOM':'MEMBER SPACE'}</span><h1>${title}</h1><p>${desc}</p></div><div class="top-actions"><button id="refresh" class="secondary">↻ 刷新</button>${action}</div></header>`;}
function deviceView(){const all=admin?`<button class="primary" id="add-device">＋ 登记已有设备</button>`:'';return toolbar(admin?'设备与权益':'我的设备',admin?'查看设备、账号绑定与云端权益。':'查看已绑定设备与云端权益。',all)+`<div class="stats"><article><span>已登记设备</span><strong>${devices.length}<small>台</small></strong><p>当前可访问的设备记录</p></article><article><span>有效云端权益</span><strong>${devices.filter(d=>activeGrants(d).length).length}<small>台</small></strong><p>离线激活码不会自动出现在这里</p></article><article><span>设备限制</span><strong>${devices.filter(d=>d.blocked).length}<small>台</small></strong><p>与授权撤销分开管理</p></article></div><section class="panel"><div class="table-tools"><label class="search"><span>⌕</span><input id="search" value="${esc(deviceQuery)}" placeholder="搜索设备、备注或标识摘要" aria-label="搜索设备"></label><select id="filter" aria-label="筛选设备">${deviceFilterOptions(deviceFilter)}</select></div>${admin?`<div class="selection-bar"><span id="selection-count">已选择 ${selected.size} 台</span><button data-select="all">全选筛选结果</button><button data-select="only">仅选择筛选结果</button><button data-select="invert">反选</button><button data-select="none">清空</button><div></div><button id="batch-grant">设置权益</button><button id="batch-note">备注</button><button id="batch-message">发消息</button><button id="batch-campaign">限免活动管理</button><button id="batch-more">更多操作 ↓</button></div>`:''}<div data-device-pager></div><div class="table-scroll"><table><thead><tr>${admin?'<th><input id="select-page" type="checkbox" aria-label="选择当前页设备"></th>':''}<th><button data-sort="label">设备 ↕</button></th><th>权益</th><th>账号绑定</th><th><button data-sort="last_seen">最近联系 ↕</button></th><th>备注</th><th>操作</th></tr></thead><tbody id="device-rows"></tbody></table></div><div data-device-pager></div><div class="table-foot">表头勾选仅选择当前页；全选筛选结果与反选覆盖所有分页。最多载入 1,000 条。</div></section>${!admin&&!devices.length?`<section class="binding-callout"><h2>绑定你的设备</h2><p>使用系统中已登记的设备码和一次性配对凭证完成绑定。</p><button class="primary" id="bind-device">绑定已有设备 ↗</button></section>`:''}`;}
function listControls(options={all:'全部'},label='搜索内容'){
 const state=listState();return `<section class="panel list-tools"><label class="search"><span>⌕</span><input id="list-search" value="${esc(state.query)}" placeholder="${esc(label)} · 支持拼音、近音和模糊匹配" aria-label="${esc(label)}"></label><select id="list-filter" aria-label="列表分类">${Object.entries(options).map(([key,title])=>`<option value="${key}" ${state.filter===key?'selected':''}>${esc(title)}</option>`).join('')}</select></section>`;
}
function filtered(items,fields,category=()=>true){return searchItems(items.filter(item=>category(item,listState().filter)),listState().query,fields);}
function messageView(){
 const state=listState();const list=filtered(messages,m=>[m.title,m.body,messageKinds[m.kind],m.all_devices?'所有设备':m.target_ids.map(id=>{const d=devices.find(d=>d.id===id);return d?deviceSearchFields(d).join(' '):id;}).join(' ')],
   (m,f)=>f==='trash'?!!m.deleted_at:!m.deleted_at&&(f==='all'||messageState(m)===f));
 return toolbar('消息与内容','编辑、立即推送或删除消息；删除后在回收站保留七天。',`<button class="secondary" id="new-urgent">＋ 紧急通知</button><button class="primary" id="new-item">＋ 发布消息</button>`)+
   listControls(messageStates,'搜索消息或接收设备')+(!messageReady?'<div class="sync-notice">消息编辑和七天回收站尚未部署，请完成 008_message_management.sql；旧消息仍可查看。</div>':'')+
   `<div class="content-grid">${messageCards(list,{esc,time,ready:messageReady,pushJobs})}</div>`;
}
function listView(type){
 if(type==='messages')return messageView();
 const list=filtered(campaigns,x=>[x.title,...x.features],(x,f)=>f==='all'||messageState(x)===f);
 return toolbar('限免活动','设置指定功能的免费开放时间。',admin?'<button class="primary" id="new-item">＋ 创建活动</button>':'')+
  listControls({all:'全部活动',active:'进行中',scheduled:'未开始',expired:'已结束',stopped:'已停止'},'搜索限免活动')+
  (!campaignReady?'<p class="sync-notice">兑换功能尚未部署，请完成 010_campaign_redemption.sql。</p>':'')+
  `<div class="content-grid">${list.map(x=>`<article class="content-card"><div class="card-top"><span class="badge neutral">${esc(({active:'进行中',scheduled:'未开始',expired:'已结束',stopped:'已停止'})[messageState(x)])}</span><small>凭兑换码领取</small></div><h2>${esc(x.title)}</h2><p>${esc(x.features.map(f=>f==='status_bar'?'状态栏定制':'通知上岛').join(' · '))}</p><div class="item-meta">${time(x.starts_at)}<br>至 ${time(x.ends_at)}<br>已领取 ${campaignClaims.filter(m=>m.campaign_id===x.id).length} 台设备</div><div class="content-actions"><button class="text-button" data-campaign-edit="${x.id}">编辑活动 / 状态</button><button class="text-button" data-campaign-codes="${x.id}">管理兑换码</button><button class="text-button" data-campaign-members="${x.id}">管理活动用户</button></div></article>`).join('')||'<section class="empty"><h2>没有匹配的活动</h2></section>'}</div>`;
}

async function refreshAccounts({append=false,quiet=false}={}){
 const epoch=viewEpoch,user=session?.user.id,token=++accountLoadToken;
 const valid=()=>token===accountLoadToken&&epoch===viewEpoch&&session?.user.id===user&&admin&&section==='users';
 accountBusy=true;accountError='';if(!quiet&&valid())render();
 try{
   let next=append?accountCursor:null,result=append?[...accounts]:[],total=0;
   const rounds=append?4:Math.min(80,Math.max(4,Math.ceil(accounts.length/250)));
   for(let i=0;i<rounds;i++){
     const r=await api.rpc('lv_admin_accounts',{p_after:next,p_include_anonymous:includeInstallations}).abortSignal(AbortSignal.timeout(20000));
     if(r.error)throw r.error;if(!valid())return;
     result.push(...r.data.items);total=r.data.total;next=r.data.next_cursor;if(!next)break;
   }
   const policy=await api.rpc('lv_admin_registration_policy');if(policy.error)throw policy.error;if(!valid())return;
   accounts=[...new Map(result.map(u=>[u.id,{...u,devices:u.devices.map(d=>({...d,campaign_titles:activeGrants(d).filter(g=>g.campaign_id).map(g=>g.campaign_title)}))}])).values()];accountTotal=total;accountCursor=next;registrationPolicy=policy.data;accountReady=true;
   accountSelected=new Set([...accountSelected].filter(id=>accounts.some(u=>u.id===id&&!u.is_admin)));
 }catch(e){if(valid()){accountError=['PGRST202','42883'].includes(e.code)?'账号管理接口尚未部署，请执行 009_account_management.sql。':errorText(e);accountReady=false;}}
 finally{if(valid()){accountBusy=false;render();}}
}
function visibleAccounts(){return filtered(accounts,accountSearchFields,accountMatches);}
function accountsView(){
 return toolbar('账号管理','查看注册账号、密码设置状态和设备绑定；管理操作仅管理员可用。','<button class="secondary" id="registration-policy">注册防护</button>')+
   listControls(accountFilters,'搜索账号、备注或设备码')+(accountError?`<div class="sync-notice">${esc(accountError)}</div>`:'')+
   (accountBusy?'<p class="muted">正在更新账号列表…</p>':'')+
   accountList({users:visibleAccounts(),selected:accountSelected,esc,time,includeAnonymous:includeInstallations,total:accountTotal,cursor:accountCursor,loaded:accounts.length});
}
async function accountOperation(action,target,data={}){
 const {data:result,error}=await api.functions.invoke('cloud-sync',{body:{operation:'admin_accounts',action,target_id:target,request_id:crypto.randomUUID(),data}});
 if(error){const details=await error.context?.json?.().catch(()=>null);throw Error(details?.partial?'认证服务可能已经更新，但状态确认失败。请刷新核实，不要连续重复提交。':details?.error==='administrator_confirmation_required'?'管理员确认已失效，请重新登录确认。':details?.error==='account_operation_rejected'?'操作被拒绝：管理员账号受保护，或目标正在处理，请刷新后重试。':'账号操作未完成，请刷新核实后重试。');}
 if(!result?.ok)throw Error('账号操作未确认成功。');return result;
}
function bindAccountEvents(){
 root.querySelector('#include-installations').onchange=e=>{includeInstallations=e.target.checked;accountSelected.clear();void refreshAccounts();};
 root.querySelector('#load-more-accounts')?.addEventListener('click',()=>{if(!accountBusy)void refreshAccounts({append:true});});
 root.querySelectorAll('[data-account-check]').forEach(b=>b.onchange=()=>{b.checked?accountSelected.add(b.dataset.accountCheck):accountSelected.delete(b.dataset.accountCheck);root.querySelector('#account-selection').textContent=`已选 ${accountSelected.size} 个账号`;});
 root.querySelectorAll('[data-account-selection]').forEach(b=>b.onclick=()=>{if(b.dataset.accountSelection==='none')accountSelected.clear();else visibleAccounts().filter(u=>!u.is_admin).forEach(u=>accountSelected.add(u.id));render();});
 root.querySelectorAll('[data-account-copy]').forEach(b=>b.onclick=async()=>{const u=accounts.find(u=>u.id===b.dataset.accountCopy),d=u?.devices.find(d=>d.id===b.dataset.codeDevice);if(d?.device_code)try{await navigator.clipboard.writeText(d.device_code);toast('设备码已复制。');}catch{toast('复制失败，可展开设备信息手动复制。');}});
 root.querySelectorAll('[data-account-manage]').forEach(b=>b.onclick=()=>{
   const user=accounts.find(u=>u.id===b.dataset.accountManage);if(!user||user.is_admin)return;
   const el=dialog('管理账号',accountForm(user,devices,esc),async f=>{
     const action=f.get('action'),result=await accountOperation(action,user.id,accountActionData(f));
     await load();await refreshAccounts();toast(result.mail_sent===false?'账号已更新，但邮件发送未确认，请核实后单独发送找回邮件。':'账号操作已完成。');
   },'确认操作');
   const action=el.querySelector('[name="action"]');const fields=()=>el.querySelectorAll('[data-account-fields]').forEach(f=>{f.hidden=f.dataset.accountFields!==action.value;f.disabled=f.hidden;});action.onchange=fields;fields();
 });
 root.querySelectorAll('[data-account-batch]').forEach(b=>b.onclick=()=>{
   const ids=[...accountSelected].filter(id=>accounts.some(u=>u.id===id&&!u.is_admin));if(!ids.length){toast('请先选择非管理员账号。');return;}if(ids.length>50){toast('每次最多处理 50 个账号，请缩小筛选范围。');return;}
   const action=b.dataset.accountBatch;
   dialog(accountActions[action],`<p>将对明确勾选的 ${ids.length} 个非管理员账号执行操作。不会封禁设备或撤销永久授权。</p>`,async()=>{
     let ok=0;const failed=[];for(const id of ids)try{await accountOperation(action,id);ok++;accountSelected.delete(id);}catch{failed.push(id);}
     await load();await refreshAccounts();toast(`已完成 ${ok} 个，未完成 ${failed.length} 个。${failed.length?'未完成的账号保留勾选，请核实状态。':''}`);
   },'确认批量操作');
 });
 root.querySelector('#registration-policy').onclick=()=>{
   if(!registrationPolicy){toast('注册设置尚未加载完成。');return;}const p=registrationPolicy;
   dialog('网页注册防护',`<label class="check"><input name="registration_open" type="checkbox" ${p.registration_open?'checked':''}>允许新的网页账号注册</label><label>一小时内最多注册<input name="hourly_limit" type="number" min="1" max="1000" value="${p.hourly_limit}" required></label><label>24 小时内最多注册<input name="daily_limit" type="number" min="1" max="10000" value="${p.daily_limit}" required></label><p>限制在服务器执行，不依赖网页按钮。只针对网页注册账号，不关闭已有账号登录，也不阻止手机匿名安装会话。此项不替代认证服务的 IP 限流或验证码。</p>`,async f=>{await rpc('lv_admin_registration_policy',{p_settings:{registration_open:f.has('registration_open'),hourly_limit:Number(f.get('hourly_limit')),daily_limit:Number(f.get('daily_limit'))}});await refreshAccounts();toast('注册防护设置已保存。');});
 };
}
function accountView(){return toolbar('账号设置','管理登录与账号安全。')+`<section class="panel account-panel"><h2>登录身份</h2><dl><dt>邮箱</dt><dd>${esc(session.user.email)}</dd><dt>权限</dt><dd>${admin?'管理员 · 已完成邮箱确认':'普通用户'}</dd><dt>本机自动登录</dt><dd>${localStorage.getItem(storeKey)==='yes'?'已开启':'未开启'}</dd></dl><button class="secondary" id="recheck-role">重新验证权限</button><button class="secondary" id="change-password">修改密码</button><button class="secondary" id="logout-all">退出所有会话</button></section>`;}
function auditView(){return toolbar('操作记录','关键变更留痕，方便核对与追溯。')+listControls({all:'全部记录'},'搜索操作、时间或账号')+`<section class="panel"><table><thead><tr><th>时间</th><th>操作</th><th>影响数量</th><th>操作账号 ID</th></tr></thead><tbody>${filtered(audit,x=>[x.action,x.actor,time(x.created_at),({grant:'授权 赞助',revoke:'撤销',block:'拉黑',unblock:'解除限制',unbind:'解绑'})[x.action]||'']).map(x=>`<tr><td>${time(x.created_at)}</td><td>${esc(x.action)}</td><td>${x.target_count}</td><td class="mono">${esc(x.actor)}</td></tr>`).join('')||'<tr><td colspan="4" class="empty-cell">暂无操作记录</td></tr>'}</tbody></table></section>`;}
function render(){if(!admin&&!['devices','messages','sponsor','feedback','account'].includes(section))section='devices';const supportContent=section==='sponsor'?sponsorView({admin,devices,orders:filtered(sponsorOrders,o=>[o.transaction_ref,o.response,o.provider,devices.find(d=>d.id===o.device_id)?.label,devices.find(d=>d.id===o.device_id)?.note],(o,f)=>f==='all'||o.status===f),time,esc,ready:sponsorReady}):section==='feedback'?feedbackView({admin,items:filtered(feedbackItems,f=>[f.title,f.body,f.reply],(x,f)=>f==='all'||x.status===f),time,esc,ready:sponsorReady,hasDevice:devices.some(d=>!d.blocked)}):null;const memberContent=!admin?(supportContent??(section==='devices'?memberDevices({devices,entitlements,campaigns,time,esc}):section==='messages'?memberMessages({messages:filtered(messages,m=>[m.title,m.body,messageKinds[m.kind]],(m,f)=>f==='all'||m.kind===f),time,esc}):accountView())):'';root.innerHTML=admin?shell(supportContent??(section==='devices'?deviceView():section==='account'?accountView():section==='users'?accountsView():section==='audit'?auditView():listView(section))):memberShell({content:memberContent,email:session.user.email,section,esc});root.querySelectorAll('[data-section]').forEach(b=>b.onclick=()=>{viewEpoch++;section=b.dataset.section;render();if(admin&&section==='users')void refreshAccounts();});document.querySelector('#logout').onclick=logout;document.querySelector('#refresh').onclick=async e=>{e.target.disabled=true;await boot();};
 if(['sponsor','feedback'].includes(section)||(!admin&&section==='messages')){
   const opts=section==='sponsor'?{all:'全部赞助记录',pending:'待核对',approved:'已确认',rejected:'未通过'}:section==='feedback'?{all:'全部反馈',open:'待回复',replied:'已回复',closed:'已结束'}:{all:'全部消息',...messageKinds};
   const top=root.querySelector('.topbar');if(top)top.insertAdjacentHTML('afterend',listControls(opts,section==='sponsor'?'搜索订单或设备':section==='feedback'?'搜索反馈':'搜索消息'));
 }
 bindListControls();bindMessageManagement();bindCampaignEvents();if(admin&&section==='users')bindAccountEvents();
 // Cloud management is usable independently; never imply that old APKs consume these rows.
 const notice=document.createElement('div');notice.className='sync-notice';notice.textContent='云端规则在已接入的新版 App 中约每小时同步一次；休眠可能延迟。可在 App 赞助中心立即同步，旧版 APK 不会自动接入。';if(admin)document.querySelector('.topbar').after(notice);
 if(section==='devices')bindDeviceEvents();
 bindSupportEvents();
 document.querySelector('#new-item')?.addEventListener('click',()=>section==='messages'?messageDialog():campaignDialog());
 root.querySelectorAll('[data-disable]').forEach(b=>b.onclick=()=>dialog('停止投放',`<p>停止后，后续同步不再投放此内容。已离线的设备不会立即更新。</p>`,async()=>{await rpc('lv_disable',{p_type:b.dataset.type,p_id:b.dataset.disable});await load();render();},'确认停止'));
 document.querySelector('#recheck-role')?.addEventListener('click',boot);
 document.querySelector('#change-password')?.addEventListener('click',()=>dialog('修改密码','<label>新密码<input type="password" name="password" minlength="12" maxlength="128" autocomplete="new-password" required></label>',async f=>{const {error}=await api.auth.updateUser({password:f.get('password')});if(error)throw error;toast('密码已更新');}));
 document.querySelector('#logout-all')?.addEventListener('click',()=>dialog('退出所有会话','<p>其他设备将无法继续刷新会话；已签发的短期访问令牌可能保留到过期。</p>',async()=>{const {error}=await api.auth.signOut({scope:'global'});if(error)throw error;session=null;authPage();},'退出所有会话'));
}
function visibleDevices(){
 const sorted=devices.filter(d=>matchesDeviceFilter(d,deviceFilter,entitlements)).sort((a,b)=>String(a[sort]||'').localeCompare(String(b[sort]||''),'zh-CN')*direction);
 return searchItems(sorted,deviceQuery,deviceSearchFields);
}
function rows(){const p=pageOf(visibleDevices(),devicePage,devicePageSize);devicePage=p.page;const shown=p.items;document.querySelector('#device-rows').innerHTML=shown.map(d=>`<tr class="${selected.has(d.id)?'selected':''}">${admin?`<td><input type="checkbox" data-device="${d.id}" ${selected.has(d.id)?'checked':''} aria-label="选择 ${esc(d.label||d.id)}"></td>`:''}<td><div class="device-name"><span class="device-avatar">▯</span><div><strong>${esc(d.label||'未命名设备')}</strong><small class="mono">${esc(d.device_hash.slice(0,12))}…</small></div></div></td><td>${badge(d)}${activeGrants(d).filter(e=>e.campaign_id).map(e=>`<small class="cell-sub">活动：${esc(e.campaign_title)}</small>`).join('')}<small class="cell-sub">${activeGrants(d).some(e=>!e.ends_at)?'永久':activeGrants(d).length?`至 ${time(activeGrants(d).map(e=>e.ends_at).sort().at(-1))}`:'—'}</small></td><td><span class="binding-state">${d.owner_id?'已绑定':'未绑定'}</span></td><td>${time(d.last_seen)}<small class="cell-sub">${esc(d.app_version||'暂无版本信息')}</small></td><td class="note-cell">${esc(d.note||'—')}</td><td><button class="text-button" data-device-campaign="${d.id}">限免活动管理</button></td></tr>`).join('')||`<tr><td colspan="7" class="empty-cell">${devices.length?'没有匹配的设备':'还没有设备记录。登记后会显示在这里。'}</td></tr>`;
 document.querySelectorAll('[data-device-pager]').forEach(el=>el.innerHTML=pagerHtml(p));
 document.querySelectorAll('[data-device-page]').forEach(b=>b.onclick=()=>{devicePage=Number(b.dataset.devicePage);rows();document.querySelector("[data-device-pager]")?.scrollIntoView({block:"start",behavior:"smooth"});});
 document.querySelectorAll('[data-page-size]').forEach(b=>b.onchange=()=>{devicePageSize=Number(b.value);devicePage=1;rows();});
 document.querySelectorAll('[data-device-campaign]').forEach(b=>b.onclick=()=>deviceCampaignDialog([b.dataset.deviceCampaign]));document.querySelectorAll('[data-device]').forEach(b=>b.onchange=()=>{b.checked?selected.add(b.dataset.device):selected.delete(b.dataset.device);rows();});const count=document.querySelector('#selection-count');if(count){const inside=visibleDevices().filter(d=>selected.has(d.id)).length;count.textContent=`已选择 ${selected.size} 台${selected.size-inside?` · 筛选外 ${selected.size-inside} 台`:''}`;}const all=document.querySelector('#select-page');if(all){all.checked=shown.length>0&&shown.every(d=>selected.has(d.id));all.indeterminate=shown.some(d=>selected.has(d.id))&&!all.checked;}}
function chosen(){if(!selected.size)throw Error('请先选择设备。');return [...selected];}
function bindDeviceEvents(){if(!admin){document.querySelectorAll('#bind-device,[data-bind-device]').forEach(b=>b.addEventListener('click',openMemberBind));return;}rows();document.querySelector('#search').oninput=e=>{deviceQuery=e.target.value;devicePage=1;rows();};document.querySelector('#filter').onchange=e=>{deviceFilter=e.target.value;devicePage=1;rows();};root.querySelectorAll('[data-sort]').forEach(b=>b.onclick=()=>{direction=sort===b.dataset.sort?-direction:1;sort=b.dataset.sort;devicePage=1;rows();});root.querySelectorAll('[data-select]').forEach(b=>b.onclick=()=>{if(b.dataset.select==='none')selected.clear();else if(b.dataset.select==='only')selected=new Set(visibleDevices().map(d=>d.id));else visibleDevices().forEach(d=>b.dataset.select==='invert'&&selected.has(d.id)?selected.delete(d.id):selected.add(d.id));rows();});document.querySelector('#select-page')?.addEventListener('change',e=>{pageOf(visibleDevices(),devicePage,devicePageSize).items.forEach(d=>e.target.checked?selected.add(d.id):selected.delete(d.id));rows();});
 document.querySelector('#add-device')?.addEventListener('click',()=>dialog('登记已有设备',`<p>仅登记你已核对的设备。配对凭证有效 15 分钟，不要公开发布。</p><label>设备名称<input name="label" maxlength="120" placeholder="例如：用户设备 / vivo X100" required></label><label>完整设备码<input name="code" autocomplete="off" spellcheck="false" required></label>`,async f=>{const result=await rpc('lv_provision_device',{p_hash:await hashDevice(f.get('code').trim()),p_label:f.get('label')});await load();render();setTimeout(()=>dialog('一次性配对凭证',`<p>请通过你确认的设备持有者渠道交付。新凭证会替换旧凭证。</p><label>配对凭证<input readonly value="${esc(result.pairing_token)}" autocomplete="off"></label><p>15 分钟内有效，仅能使用一次。此凭证不直接授予赞助权益。</p>`,async()=>{},'已保存'),0);},'登记并生成配对凭证'));
 document.querySelector('#bind-device')?.addEventListener('click',()=>dialog('绑定已有设备',`<label>完整设备码<input name="code" autocomplete="off" required></label><label>一次性配对凭证<input name="token" autocomplete="off" minlength="32" maxlength="32" required></label><p>凭证由管理员向已核对的设备持有者交付。设备码本身不代表设备所有权。</p>`,async f=>{await rpc('lv_bind_device',{p_hash:await hashDevice(f.get('code').trim()),p_token:f.get('token').trim()});await load();render();toast('设备绑定成功');},'确认绑定'));
 document.querySelector('#batch-grant')?.addEventListener('click',()=>{try{const ids=chosen();dialog(`设置 ${ids.length} 台设备的云端权益`,features()+`<label>截止日期<input name="end" type="datetime-local" min="${localDate(Date.now()+60000)}"></label><p>留空表示永久。新增权益不会覆盖已有永久授权。</p>`,async f=>{await rpc('lv_manage',{p_action:'grant',p_ids:ids,p_data:{features:f.getAll('feature'),ends_at:f.get('end')?new Date(f.get('end')).toISOString():null}});await load();render();});}catch(e){toast(e.message);}});
 document.querySelector('#batch-note')?.addEventListener('click',()=>{try{const ids=chosen();dialog('批量修改备注','<label>备注<textarea name="note" maxlength="2000" rows="4"></textarea></label>',async f=>{await rpc('lv_manage',{p_action:'note',p_ids:ids,p_data:{note:f.get('note')}});await load();render();});}catch(e){toast(e.message);}});
 document.querySelector('#batch-message')?.addEventListener('click',()=>{try{chosen();messageDialog([...selected]);}catch(e){toast(e.message);}});
 document.querySelector('#batch-campaign')?.addEventListener('click',()=>{try{deviceCampaignDialog(chosen());}catch(e){toast(e.message);}});
 document.querySelector('#batch-more')?.addEventListener('click',()=>{try{const ids=chosen();dialog('管理选中设备',`<label>操作<select name="action"><option value="block">拉黑设备</option><option value="unblock">解除拉黑</option><option value="revoke">撤销选中设备的全部云端权益</option><option value="unbind">解除账号绑定</option></select></label><p>只影响此后台记录。旧版离线 APK 和已有离线激活码不会自动被撤销。</p>`,async f=>{await rpc('lv_manage',{p_action:f.get('action'),p_ids:ids,p_data:{}});await load();render();},'确认执行');}catch(e){toast(e.message);}});
}
function campaignDialog(existing=null){
 const fs=features();const el=dialog(existing?'编辑活动':'创建兑换码限免活动',`<label>活动名称<input name="title" maxlength="120" required value="${esc(existing?.title||'')}"></label>${fs}${dateField('start','开始时间',existing?.starts_at||Date.now())}${dateField('end','结束时间',existing?.ends_at||Date.now()+86400000)}<label>状态<select name="enabled"><option value="yes" ${existing?.enabled!==false?'selected':''}>启用</option><option value="no" ${existing?.enabled===false?'selected':''}>停止活动</option></select></label><p>只有兑换成功的设备获得活动权益。创建后请管理兑换码；活动结束不取消永久授权。停止后 App 下次成功同步才得知变更，离线设备不保证立即失效。</p>`,async f=>{
  const data={title:f.get('title'),features:f.getAll('feature'),starts_at:new Date(f.get('start')).toISOString(),ends_at:new Date(f.get('end')).toISOString(),enabled:f.get('enabled')==='yes'};
  if(Date.parse(data.ends_at)<=Date.parse(data.starts_at)||!data.features.length)throw Error('请勾选功能，且结束时间须晚于开始时间。');
  if(existing)await rpc('lv_campaign_edit',{p_id:existing.id,p_data:data});else{const id=await rpc('lv_publish',{p_type:'campaign',p_data:data});if(!data.enabled)await rpc('lv_disable',{p_type:'campaign',p_id:id});}
  await load();render();toast('活动已保存，请在管理兑换码中设置领取凭证。');
 },'保存活动');
 if(existing)el.querySelectorAll('[name="feature"]').forEach(b=>b.checked=existing.features.includes(b.value));
}
function codeDialog(campaign,code=null){
 if(!campaignReady){toast('兑换接口尚未部署。');return;}
 dialog(code?'编辑兑换码':'创建兑换码',codeFields(code,campaign,esc,localDate),async f=>{
  const data=codePayload(f);if(Date.parse(data.expires_at)>Date.parse(campaign.ends_at)||Date.parse(data.expires_at)<=Date.parse(campaign.starts_at))throw Error('兑换截止时间须晚于活动开始，且不能超过活动结束时间。');
  await rpc('lv_campaign_code_save',{p_id:code?.id||null,p_campaign:campaign.id,p_data:data,p_version:code?.edit_version||null});await load();render();toast('兑换码已保存。');
 });
}
function codesDialog(campaign){
 const el=dialog('管理活动兑换码',campaignCodesView(campaign,campaignCodes.filter(c=>c.campaign_id===campaign.id),esc,time),async()=>{},'关闭');
 el.querySelector('[data-code-new]').onclick=()=>codeDialog(campaign);
 el.querySelectorAll('[data-code-edit]').forEach(b=>b.onclick=()=>codeDialog(campaign,campaignCodes.find(c=>c.id===b.dataset.codeEdit)));
 const codeFilter=()=>el.querySelectorAll('[data-code-row]').forEach(row=>{const c=campaignCodes.find(c=>c.id===row.dataset.codeRow);row.hidden=!matches(c.code,el.querySelector('[data-code-search]').value)||(el.querySelector('[data-code-filter]').value!=='all'&&campaignCodeState(c)!==el.querySelector('[data-code-filter]').value);});
 el.querySelector('[data-code-search]').oninput=codeFilter;el.querySelector('[data-code-filter]').onchange=codeFilter;
}
function deviceCampaignDialog(ids,campaignId=null){
 if(!campaignReady){toast('兑换接口尚未部署。');return;}
 const members=campaignClaims.filter(m=>ids.includes(m.device_id)&&(!campaignId||m.campaign_id===campaignId));
 const options=campaigns.filter(c=>members.some(m=>m.campaign_id===c.id));
 if(!members.length){dialog('限免活动管理','<p>这些设备尚未兑换活动，没有可撤销或恢复的资格。请向用户交付兑换码，由绑定账号领取。</p>',async()=>{},'关闭');return;}
 dialog(`管理 ${ids.length} 台设备的限免活动`,`<label>活动<select name="campaign">${options.map(c=>`<option value="${c.id}">${esc(c.title)}</option>`).join('')}</select></label><div class="table-scroll"><table><thead><tr><th>设备</th><th>活动名称</th><th>资格</th></tr></thead><tbody>${members.map(m=>`<tr><td>${esc(devices.find(d=>d.id===m.device_id)?.label||m.device_id)}</td><td>${esc(campaigns.find(c=>c.id===m.campaign_id)?.title)}</td><td>${m.revoked_at?'已撤销':'已领取'}</td></tr>`).join('')}</tbody></table></div><label>操作<select name="action"><option value="revoke">撤销此活动资格</option><option value="restore">恢复已领取的资格</option></select></label><p>只处理选中设备已兑换的指定活动，不授予新资格、不影响永久赞助。已停止或过期的活动不会因恢复资格而重新开放。</p>`,async f=>{
  const n=await rpc('lv_campaign_members_manage',{p_campaign:f.get('campaign'),p_devices:ids,p_action:f.get('action')});await load();render();toast(`已处理 ${n} 条活动资格。`);
 });
}
function bindCampaignEvents(){
 if(admin){
  root.querySelectorAll('[data-campaign-edit]').forEach(b=>b.onclick=()=>campaignDialog(campaigns.find(c=>c.id===b.dataset.campaignEdit)));
  root.querySelectorAll('[data-campaign-codes]').forEach(b=>b.onclick=()=>codesDialog(campaigns.find(c=>c.id===b.dataset.campaignCodes)));
  root.querySelectorAll('[data-campaign-members]').forEach(b=>b.onclick=()=>{const ids=campaignClaims.filter(m=>m.campaign_id===b.dataset.campaignMembers).map(m=>m.device_id);if(!ids.length){toast('此活动尚无兑换设备。');return;}deviceCampaignDialog(ids,b.dataset.campaignMembers);});
 }else document.querySelector('#redeem-campaign')?.addEventListener('click',()=>{
  if(!devices.length){toast('请先绑定你的设备。');return;}if(!campaignReady){toast('兑换功能暂不可用，请稍后重试。');return;}
  dialog('兑换限免活动',`<label>绑定设备<select name="device">${devices.filter(d=>!d.blocked).map(d=>`<option value="${d.id}">${esc(d.label||'我的设备')}</option>`).join('')}</select></label><label>兑换码<input name="code" minlength="4" maxlength="64" autocomplete="off" required></label><p>兑换码仅用于领取对应活动的限时权益，不会替换永久赞助。</p>`,async f=>{
   const r=await rpc('lv_campaign_redeem',{p_code:f.get('code'),p_device:f.get('device')});if(!r.ok)throw Error(r.error==='rate_limited'?'兑换尝试过于频繁，一小时后再试。':'兑换码不可用、活动未开始或已结束，请核对后再试。');await load();render();toast(`${r.duplicate?'此设备已领取':'兑换成功'}：${r.title}。App 下次成功同步后生效。`);
  },'确认兑换');
 });
}
function messageDialog(ids=[],existing=null,urgent=false){
 if(existing&&existing.target_ids.some(id=>!devices.some(d=>d.id===id))){toast('部分接收设备尚未加载，请先刷新完整设备列表。');return;}
 const value=(key,fallback='')=>esc(existing?.[key]??fallback);
 const notes=decodeReleaseNotes(existing?.body||'');
 const el=dialog(existing?'编辑消息':urgent?'发布并立刻推送紧急通知':'发布消息',`${audienceFields(devices,ids,esc,{all:existing?existing.all_devices:ids.length===0,grants:entitlements})}<label>展示方式<select name="kind">${Object.entries(messageKinds).map(([k,label])=>`<option value="${k}" ${(existing?.kind||(urgent?'notification':'dialog'))===k?'selected':''}>${label}</option>`).join('')}</select></label><label>标题<input name="title" maxlength="120" value="${value('title')}" required></label><div data-generic-body><label>正文<textarea name="body" maxlength="4000" rows="4">${value('body')}</textarea></label></div><div data-release-fields hidden><label>日志版本<input name="notes_version" maxlength="64" value="${esc(notes?.version||'')}"></label><label>中文更新日志<textarea name="notes_zh" rows="7">${esc(notes?.zh||'')}</textarea></label><label>English release notes<textarea name="notes_en" rows="7">${esc(notes?.en||'')}</textarea></label><p>新版 App 的关于 → 更新日志会自动读取此内容；标题不改变已安装的 App 版本。相同设备按开始时间选择最新有效日志。建议结束时间设得足够长，停止或删除后回退到内置日志。</p></div><label>跳转地址（可选，仅 HTTPS）<input name="link" type="url" pattern="https://.*" value="${value('link')}"></label><label>目标 versionCode（更新提示填写）<input name="version" type="number" min="1" step="1" value="${value('version_code')}"></label>${dateField('start','开始时间',existing?.starts_at||Date.now())}${dateField('end','结束时间',existing?.ends_at||Date.now()+(urgent?15*60000:7*86400000))}${existing?`<label class="check"><input name="enabled" type="checkbox" ${existing.enabled?'checked':''}>启用投放（仍受起止时间限制）</label>`:''}<p>更改与删除会在设备下次成功同步后生效。已展示的系统通知不会远程撤回；已关闭的弹窗不会因为编辑而自动再次弹出。</p>`,async f=>{
   if(f.get('kind')==='changelog')f.set('body',encodeReleaseNotes(f.get('notes_version'),f.get('notes_zh'),f.get('notes_en')));
   const data=messagePayload(f,messageTargets(f,devices));
   if(urgent){validatePushMessage({...data,enabled:true});const c=await pushRequest('configuration');if(!c.configured)throw Error(pushErrors.push_not_configured);}
   if(existing)await rpc('lv_message_manage',{p_action:'edit',p_id:existing.id,p_expected_version:existing.edit_version,p_data:{...data,enabled:f.has('enabled')}});
   else {const id=await rpc('lv_publish',{p_type:'message',p_data:data});if(urgent){await load();render();const m=messages.find(m=>m.id===id);if(m)openPushDialog(m,null,true);return;}}
   await load();render();toast(existing?'消息已保存。':'消息已发布。');
 },existing?'保存修改':urgent?'保存并立刻推送':'保存消息');
 const kind=el.querySelector('[name="kind"]');
 const updateNotesFields=()=>{const notesMode=kind.value==='changelog';el.querySelector('[data-release-fields]').hidden=!notesMode;el.querySelector('[data-generic-body]').hidden=notesMode;for(const name of ['notes_version','notes_zh','notes_en'])el.querySelector(`[name="${name}"]`).required=notesMode;el.querySelector('[name="body"]').required=!notesMode;};
 kind.addEventListener('change',updateNotesFields);updateNotesFields();
 bindAudiencePicker(el,{devices,grants:entitlements});
}
function bindListControls(){
 const input=root.querySelector('#list-search'),filter=root.querySelector('#list-filter');
 if(input)input.oninput=()=>{const start=input.selectionStart,end=input.selectionEnd;listState().query=input.value;const x=window.scrollX,y=window.scrollY;render();const next=root.querySelector('#list-search');next?.focus({preventScroll:true});next?.setSelectionRange(start,end);window.scrollTo(x,y);};
 if(filter)filter.onchange=()=>{listState().filter=filter.value;render();};
}
async function pushRequest(action,data={}){
 const {data:result,error}=await api.functions.invoke('cloud-sync',{body:{operation:'admin_push',action,...data}});
 if(error){const details=await error.context?.json?.().catch(()=>null);throw Error(pushErrors[details?.error]||'推送接口不可用，请检查服务端部署；结果未确认时请查看原任务，不要重复创建。');}
 return result;
}
function openPushDialog(message,existingJob=null,auto=false){
 const jobId=existingJob||crypto.randomUUID();let submitted=!!existingJob,closed=false,busy=false,timer;
 const el=dialog('立即推送通知',`<div data-push-status><p>立即提交到厂商通道。手机仍需已登记推送并允许通知；无法越过用户权限或保证送达。</p><p>同一消息一分钟内仅可创建一次任务。关闭此窗口后当前批次继续，剩余待发送项可打开原任务继续。</p></div><button type="button" data-push-cancel>取消待发送项</button>`,async()=>{},'关闭');
 const box=el.querySelector('[data-push-status]');
 const send=document.createElement('button');send.type='button';send.className='primary';send.textContent=submitted?'继续待发送项':'确认立刻推送';box.after(send);
 const display=job=>{box.innerHTML=pushJobHtml(job,esc);send.disabled=job.canceled||!(job.counts?.queued);};
 const run=async(action)=>{
  if(busy||closed)return;busy=true;send.disabled=true;
  try{
   if(action==='send'){validatePushMessage(message);submitted=true;}
   const result=await pushRequest(action,{job_id:jobId,...(action==='send'?{message_id:message.id,version:message.edit_version}:{})});
   if(closed)return;display(result.job);send.textContent='继续待发送项';
   clearTimeout(timer);
   if(result.job.counts?.queued||result.job.counts?.sending)timer=setTimeout(()=>void run('status'),3000);
  }catch(e){if(!closed){box.textContent=e.message;send.disabled=false;send.textContent=submitted?'核对原任务 / 继续':'确认立刻推送';}}
  finally{busy=false;}
 };
 send.onclick=()=>void run(submitted?'continue':'send');
 el.querySelector('[data-push-cancel]').onclick=()=>{if(submitted)void run('cancel');};
 el.addEventListener('close',()=>{closed=true;clearTimeout(timer);void load().then(render).catch(()=>{});},{once:true});
 if(existingJob)void run('status');else if(auto)void run('send');else void pushRequest('configuration').then(c=>{if(!closed&&!c.configured){box.textContent=pushErrors.push_not_configured;send.disabled=true;}}).catch(e=>{if(!closed){box.textContent=e.message;send.disabled=true;}});
}
function bindMessageManagement(){
 document.querySelector('#new-urgent')?.addEventListener('click',()=>messageDialog([],null,true));
 root.querySelectorAll('[data-message-push]').forEach(b=>b.onclick=()=>{const m=messages.find(m=>m.id===b.dataset.messagePush);if(m)openPushDialog(m);});
 root.querySelectorAll('[data-push-job]').forEach(b=>b.onclick=()=>openPushDialog(null,b.dataset.pushJob));
 root.querySelectorAll('[data-message-edit]').forEach(b=>b.onclick=()=>{const m=messages.find(m=>m.id===b.dataset.messageEdit);if(m)messageDialog(m.target_ids,m);});
 for(const action of ['stop','trash','restore'])root.querySelectorAll(`[data-message-${action}]`).forEach(b=>b.onclick=()=>{
   const m=messages.find(m=>m.id===b.getAttribute(`data-message-${action}`));if(!m)return;
   const title={stop:'停止投放',trash:'删除消息',restore:'恢复消息'}[action];
   const detail={stop:'停止后不再向后续同步的设备投放。',trash:'消息会停止投放并进入回收站，保留七天后自动清理，七天内可以恢复。',restore:'恢复后保持已停止状态。可进入编辑，确认内容和时间后重新启用。'}[action];
   dialog(title,`<p>${esc(m.title)}</p><p>${detail}</p>`,async()=>{await rpc('lv_message_manage',{p_action:action,p_id:m.id,p_expected_version:m.edit_version});await load();render();toast(`${title}成功。`);},title);
 });
}

function bindSupportEvents(){
 document.querySelector('#preview-payment-codes')?.addEventListener('click',()=>dialog('当前收款码',`<p>以下直接展示你提供的原图内容，请核对两个渠道的收款人。</p>${Object.keys(paymentChannels).map(key=>`<h3>${paymentChannels[key].name}</h3>${paymentImage(key,esc)}`).join('')}<a class="secondary" href="${esc(paymentChannels.wechat.image)}" download="LiquidVivo-收款码.jpeg">保存原图</a>`,async()=>{},'关闭'));
 root.querySelectorAll('[data-payment-qr]').forEach(b=>b.onclick=()=>{
  const key=b.dataset.paymentQr,c=paymentChannels[key];if(!c?.image)return;
  dialog(`${c.name}收款码`,`${paymentImage(key,esc)}<p>收款人：*杰。支付前请在${c.name}确认收款人，至少支付 15 元。</p><p>同一手机付款时，可保存原图，再在支付应用中选择相册识别。付款后回到网页提交账单订单号。</p><a class="secondary" href="${esc(c.image)}" download="LiquidVivo-收款码.jpeg">保存收款码原图</a>`,async()=>{},'关闭');
 });
 document.querySelector('#submit-sponsorship')?.addEventListener('click',()=>{
  const requestId=crypto.randomUUID();
  dialog('提交已付款赞助申请',`<p>最低 15 元，永久权益绑定下方设备。请从你自己的支付账单复制订单号，提交后由管理员核对到账。</p><label>绑定设备<select name="device">${devices.filter(d=>!d.blocked).map(d=>`<option value="${d.id}">${esc(d.label||d.id)}</option>`).join('')}</select></label><label>支付方式<select name="provider"><option value="wechat">微信</option><option value="alipay">支付宝</option></select></label><label>实际支付金额（元）<input name="amount" inputmode="decimal" value="15.00" required></label><label>支付订单号<input name="ref" autocomplete="off" spellcheck="false" minlength="8" maxlength="128" pattern="[A-Za-z0-9_-]{8,128}" required></label><p>请勿粘贴密码、验证码或完整账单。提交不代表支付已确认。</p>`,async f=>{await rpc('lv_submit_sponsorship',{p_request_id:requestId,p_device_id:f.get('device'),p_provider:f.get('provider'),p_ref:f.get('ref').trim(),p_cents:yuanToCents(f.get('amount'))});await load();render();toast('申请已提交，等待管理员核对到账。');},'提交待核对申请');
 });
 root.querySelectorAll('[data-review]').forEach(b=>b.onclick=()=>{
  if(!admin)return;const o=sponsorOrders.find(x=>x.id===b.dataset.review);if(!o)return;
  dialog('核对赞助到账',`<p>订单号：<span class="mono">${esc(o.transaction_ref)}</span></p><p>提交金额 ¥ ${(o.declared_cents/100).toFixed(2)}。请在你自己的微信／支付宝账单核对收款方、金额、订单号及是否已处理；不要仅相信用户填写内容。</p><label>处理结果<select name="approve"><option value="yes">到账已核实，发放永久云端权益</option><option value="no">未通过，不发放权益</option></select></label><label>核实的实际到账金额（元）<input name="received" inputmode="decimal" value="${(o.declared_cents/100).toFixed(2)}"></label><label>说明（用户可见；驳回时必填）<textarea name="response" maxlength="1000" rows="3"></textarea></label><label class="check"><input name="checked" type="checkbox" required>我已核对自己的真实账单，或确认填写了未通过原因</label><p>每份订单仅发放一次。已接入的新版 App 下次同步后领取签名授权；旧版 APK 需要先更新。</p>`,async f=>{const approve=f.get('approve')==='yes';await rpc('lv_review_sponsorship',{p_id:o.id,p_approve:approve,p_received_cents:approve?yuanToCents(f.get('received')):null,p_response:f.get('response')});await load();render();toast(approve?'已确认到账并建立永久云端权益。':'申请已标记为未通过。');},'确认处理');
 });
 document.querySelector('#new-feedback')?.addEventListener('click',()=>dialog('意见反馈',`<label>标题<input name="title" maxlength="120" required></label><label>建议或遇到的问题<textarea name="body" maxlength="4000" rows="5" required></textarea></label><p>请勿包含密码、激活码、验证码、原始序列号或私人通知内容。</p>`,async f=>{await rpc('lv_submit_feedback',{p_title:f.get('title'),p_body:f.get('body')});await load();render();toast('反馈已提交。');},'提交反馈'));
 root.querySelectorAll('[data-reply]').forEach(b=>b.onclick=()=>{if(!admin)return;const f=feedbackItems.find(x=>x.id===b.dataset.reply);if(!f)return;dialog('回复用户反馈',`<p>${esc(f.title)}</p><label>回复<textarea name="reply" maxlength="4000" rows="5" required>${esc(f.reply)}</textarea></label><label class="check"><input type="checkbox" name="closed">标记为已结束</label>`,async data=>{await rpc('lv_reply_feedback',{p_id:f.id,p_reply:data.get('reply'),p_closed:!!data.get('closed')});await load();render();},'保存回复');});
}
function openMemberBind(){dialog('绑定我的设备',`<label>完整设备码<input name="code" autocomplete="off" required></label><label>一次性配对凭证<input name="token" autocomplete="off" minlength="32" maxlength="32" required></label><p>打开新版 App 的赞助中心，点击立即同步，复制设备码和配对码。配对码 15 分钟有效；重装后也可用此入口连接已有设备。</p>`,async f=>{await rpc('lv_bind_device',{p_hash:await hashDevice(f.get('code').trim()),p_token:f.get('token').trim()});await load();render();toast('设备绑定成功');},'确认绑定');}
async function logout(){viewEpoch++;const {error}=await api.auth.signOut({scope:'local'});if(error){toast(errorText(error));return;}session=null;emailConfirmation.clear();selected.clear();authPage();}
api.auth.onAuthStateChange(event=>{if(event==='PASSWORD_RECOVERY'){recovery=true;authPage();}if(event==='SIGNED_OUT'&&session){session=null;emailConfirmation.clear();authPage();}});
void boot();
