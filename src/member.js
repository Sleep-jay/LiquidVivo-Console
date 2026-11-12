import {decodeReleaseNotes} from './release-notes.js';
// Member-only presentation. No device inventory, bulk actions, or management navigation.
export function memberShell({content,email,section,esc}) {
  const tabs={devices:'我的设备',sponsor:'赞助支持',messages:'我的消息',feedback:'意见反馈',account:'账号设置'};
  return `<div class="member-app"><header class="member-header"><a class="brand" href="#"><span class="brand-mark">L<span>V</span></span>LiquidVivo <small>用户中心</small></a><nav aria-label="用户中心">${Object.entries(tabs).map(([key,title])=>`<button data-section="${key}" class="${section===key?'active':''}">${title}</button>`).join('')}</nav><button id="logout" class="text-button">退出登录</button></header><main class="member-main">${content}</main><footer class="member-footer">${esc(email)} · LiquidVivo 用户中心</footer></div>`;
}
export function trialRemaining(end,now=Date.now()){const minutes=Math.max(0,Math.ceil((Date.parse(end)-now)/60000));return minutes===0?'已到期':`剩余 ${Math.floor(minutes/1440)} 天 ${Math.floor(minutes%1440/60)} 小时 ${minutes%60} 分钟`;}
export function memberDevices({devices,entitlements,campaigns,time,esc}) {
  const now=Date.now();
  const titles={notification_island:'通知上岛',status_bar:'状态栏定制'};
  const active = e=>!e.revoked_at&&new Date(e.starts_at).getTime()<=now&&(!e.ends_at||new Date(e.ends_at).getTime()>now);
  const accountGrants=entitlements.filter(e=>e.account_id&&active(e));
  const grantRows=grants=>grants.map(e=>`<div class="member-grant"><span>${esc(e.features.map(f=>titles[f]||f).join('、'))}${e.campaign_title?' · 活动：'+esc(e.campaign_title):''}</span><small>${e.ends_at?'至 '+time(e.ends_at)+(e.campaign_title?' · '+trialRemaining(e.ends_at,now):''):'永久'}</small></div>`).join('');
  const accountSection=accountGrants.length?`<section class="panel member-device"><h2>账号赞助权益</h2><div class="member-grants">${grantRows(accountGrants)}</div></section>`:'';
  return `<header class="topbar"><div><h1>我的设备</h1><p>查看绑定状态和属于你的权益。</p></div><button id="redeem-campaign" class="secondary">兑换限免活动</button><button id="bind-device" class="secondary">连接 / 恢复 App</button><button id="refresh" class="secondary">↻ 刷新</button></header>${accountSection}${devices.length?devices.map(d=>{
    const grants=entitlements.filter(e=>!e.account_id&&e.device_id===d.id&&active(e));
    return `<section class="panel member-device"><div class="member-device-heading"><span class="device-avatar">▯</span><div><h2>${esc(d.label||'我的设备')}</h2><p>已绑定至当前账号</p></div><span class="badge ${d.blocked?'danger':'neutral'}">${d.blocked?'设备受限':'已绑定'}</span></div><dl><dt>设备标识摘要</dt><dd class="mono">${esc(d.device_hash.slice(0,16))}…</dd><dt>最近联系</dt><dd>${time(d.last_seen)}</dd><dt>应用版本</dt><dd>${esc(d.app_version||'尚未上报')}</dd></dl>${grants.length?`<div class="member-grants"><h3>我的云端权益</h3>${grantRows(grants)}</div>`:''}</section>`;
  }).join(''):`<section class="panel member-unbound"><span class="device-avatar">▯</span><h2>还没有绑定设备</h2><p>使用 App 赞助中心显示的设备码和一次性配对码，绑定你的设备。</p><button data-bind-device class="primary">绑定我的设备</button><button data-claim-legacy class="secondary">迁移旧赞助</button><small>已有离线赞助可以通过迁移关联到当前账号。</small></section>`}`;
}
export function memberMessages({messages,time,esc}) {
  const types={dialog:'公告',banner:'公告',notification:'通知',changelog:'更新日志',update:'版本更新'};
  return `<header class="topbar"><div><h1>我的消息</h1><p>查看发给你的通知和更新内容。</p></div><button id="refresh" class="secondary">↻ 刷新</button></header><div class="member-message-list">${messages.length?messages.map(m=>`<article class="panel member-message"><div class="card-top"><span class="badge neutral">${esc(types[m.kind]||'消息')}</span><small>${time(m.starts_at)}</small></div><h2>${esc(m.title)}</h2><p>${esc(decodeReleaseNotes(m.body)?decodeReleaseNotes(m.body).zh+'\n\n'+decodeReleaseNotes(m.body).en:m.body)}</p>${m.link&&/^https:\/\//.test(m.link)?`<a class="secondary" target="_blank" rel="noopener noreferrer" href="${esc(m.link)}">${m.kind==='update'?'查看更新':'查看详情'} ↗</a>`:''}</article>`).join(''):'<section class="panel member-unbound"><h2>暂无消息</h2><p>发给当前设备的消息会显示在这里。</p></section>'}</div>`;
}
