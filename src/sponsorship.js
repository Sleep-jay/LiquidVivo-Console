// Owner-provided QR images will be local website assets. No payment credentials in the browser.
export const paymentChannels=Object.freeze({
  wechat:{name:'微信',image:null},
  alipay:{name:'支付宝',image:null},
});
export const sponsorPriceCents=1500;
export function yuanToCents(value){
  const text=String(value).trim();
  if(!/^(?:0|[1-9][0-9]{0,4})(?:\.[0-9]{1,2})?$/.test(text))throw Error('请输入最多两位小数的金额');
  const [whole,fraction='']=text.split('.');const cents=Number(whole)*100+Number(fraction.padEnd(2,'0'));
  if(cents<1500||cents>1000000)throw Error('赞助金额范围为 15 至 10,000 元');
  return cents;
}
const money=cents=>(cents/100).toFixed(2);
export function sponsorView({admin,devices,orders,time,esc,ready}){
 const statuses={pending:'待核对',approved:'已确认 · 永久权益',rejected:'未通过'};
 const channels=Object.entries(paymentChannels).map(([key,c])=>`<article class="payment-channel"><h3>${c.name}收款码</h3>${c.image?`<img src="${esc(c.image)}" alt="LiquidVivo ${c.name}收款二维码">`:'<p class="muted">收款码待配置，请暂勿付款。</p>'}</article>`).join('');
 return `<header class="topbar"><div><h1>${admin?'赞助审核':'赞助 LiquidVivo'}</h1><p>${admin?'请核对自己的真实到账账单，再确认发放。':'15 元永久解锁赞助功能，自愿多赞助同样欢迎。'}</p></div><button id="refresh" class="secondary">↻ 刷新</button></header>${!ready?'<div class="sync-notice">赞助接口尚未部署，请先执行 004_sponsorship.sql。</div>':''}${admin?'':`<section class="panel sponsor-intro"><h2>一次支持，永久权益</h2><p>通知上岛、状态栏定制。授权绑定当前设备；更换设备请联系管理员处理。</p><ol><li>先绑定已有设备。</li><li>选择微信或支付宝，支付至少 15 元。</li><li>提交付款订单号，等待管理员核对到账。</li></ol><p class="muted">多赞助部分属于额外支持，不会重复发放同一设备的权益。提交订单号不代表到账成功。</p><div class="payment-channels">${channels}</div><button id="submit-sponsorship" class="primary" ${!ready||!devices.some(d=>!d.blocked)?'disabled':''}>提交已付款申请</button>${!devices.length?'<p class="muted">请先到“我的设备”完成绑定。</p>':''}</section>`}<section class="panel sponsor-orders"><h2>${admin?'赞助申请':'我的赞助记录'}</h2><div class="table-scroll"><table><thead><tr><th>时间</th>${admin?'<th>设备</th>':''}<th>渠道 / 订单号</th><th>金额</th><th>状态</th><th>${admin?'审核':'说明'}</th></tr></thead><tbody>${orders.length?orders.map(o=>`<tr><td>${time(o.created_at)}</td>${admin?`<td>${esc(devices.find(d=>d.id===o.device_id)?.label||o.device_id)}</td>`:''}<td>${esc(paymentChannels[o.provider]?.name||o.provider)}<small class="cell-sub mono">${esc(o.transaction_ref)}</small></td><td>¥ ${money(o.received_cents??o.declared_cents)}${o.received_cents===null?'<small class="cell-sub">用户填写，尚未核验</small>':''}</td><td><span class="badge ${o.status==='rejected'?'danger':'neutral'}">${statuses[o.status]||esc(o.status)}</span></td><td>${admin&&o.status==='pending'?`<button class="text-button" data-review="${o.id}">核对并处理</button>`:esc(o.response||'—')}</td></tr>`).join(''):'<tr><td colspan="6" class="empty-cell">暂无赞助记录</td></tr>'}</tbody></table></div></section>`;
}
export function feedbackView({admin,items,esc,time,ready,hasDevice}){
 return `<header class="topbar"><div><h1>${admin?'用户反馈':'意见反馈'}</h1><p>${admin?'查看用户建议与问题，并回复处理进展。':'告诉我们你的建议，或遇到的问题。'}</p></div><div class="top-actions"><button id="refresh" class="secondary">↻ 刷新</button>${admin?'':`<button id="new-feedback" class="primary" ${ready&&hasDevice?'':'disabled'}>提交反馈</button>`}</div></header>${!ready?'<div class="sync-notice">反馈接口尚未部署，请先执行 004_sponsorship.sql。</div>':''}<div class="member-message-list">${items.length?items.map(f=>`<article class="panel member-message"><div class="card-top"><span class="badge neutral">${{open:'待回复',replied:'已回复',closed:'已结束'}[f.status]}</span><small>${time(f.created_at)}</small></div><h2>${esc(f.title)}</h2><p>${esc(f.body)}</p>${f.reply?`<div class="feedback-reply"><h3>管理员回复</h3><p>${esc(f.reply)}</p><small>${time(f.replied_at)}</small></div>`:''}${admin?`<button class="text-button" data-reply="${f.id}">回复 / 更新处理结果</button>`:''}</article>`).join(''):'<section class="panel member-unbound"><h2>暂无反馈</h2><p>请先绑定设备，再提交建议或问题。不要填写密码、验证码、激活码或完整系统日志。</p></section>'}</div>`;
}
