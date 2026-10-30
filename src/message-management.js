export const messageKinds={dialog:'应用内弹窗',banner:'应用内横幅',notification:'系统通知',changelog:'更新日志',update:'版本更新提示'};
export function messageState(m,now=Date.now()){
  if(m.deleted_at)return 'trash';if(!m.enabled)return 'stopped';if(Date.parse(m.ends_at)<=now)return 'expired';if(Date.parse(m.starts_at)>now)return 'scheduled';return 'active';
}
export const messageStates={all:'全部消息',active:'投放中',scheduled:'未开始',expired:'已结束',stopped:'已停止',trash:'回收站'};
export function messageCards(list,{esc,time,ready=true,now=Date.now()}){
  const labels={active:'投放中',scheduled:'未开始',expired:'已结束',stopped:'已停止',trash:'回收站'};
  return list.map(m=>{
    const state=messageState(m,now),trash=state==='trash';
    return `<article class="content-card"><div class="card-top"><span class="badge neutral">${labels[state]}</span><small>${esc(messageKinds[m.kind]||m.kind)}</small></div><h2>${esc(m.title)}</h2><p>${esc(m.body)}</p><div class="item-meta">${time(m.starts_at)}<br>至 ${time(m.ends_at)}</div><div class="item-meta">${m.all_devices?'所有设备':`${m.target_ids.length} 台指定设备`}</div>${trash?`<p>删除于 ${time(m.deleted_at)}<br>到期清理：${time(new Date(Date.parse(m.deleted_at)+7*86400000).toISOString())}</p><button class="text-button" data-message-restore="${esc(m.id)}" ${ready&&Date.parse(m.deleted_at)+7*86400000>now?'':'disabled'}>恢复为已停止</button>`:`<div class="content-actions"><button class="text-button" data-message-edit="${esc(m.id)}" ${ready?'':'disabled'}>编辑</button>${m.enabled?`<button class="text-button" data-message-stop="${esc(m.id)}" ${ready?'':'disabled'}>停止投放</button>`:''}<button class="text-button danger-text" data-message-trash="${esc(m.id)}" ${ready?'':'disabled'}>删除</button></div>`}</article>`;
  }).join('')||'<section class="empty"><h2>没有匹配的消息</h2><p>可调整搜索词或分类；回收站中的消息保留七天。</p></section>';
}
export function messagePayload(form,targets){
  const starts=new Date(form.get('start')),ends=new Date(form.get('end'));
  if(!Number.isFinite(+starts)||!Number.isFinite(+ends)||ends<=starts)throw Error('结束时间必须晚于开始时间。');
  const kind=form.get('kind'),link=String(form.get('link')||'').trim(),version=form.get('version');
  if(!Object.hasOwn(messageKinds,kind))throw Error('请选择展示方式。');
  if(link&&!/^https:\/\//.test(link))throw Error('跳转地址只支持 HTTPS。');
  if(kind==='update'&&(!version||!link))throw Error('版本更新提示需要下载地址和目标 versionCode。');
  const code=version?Number(version):null;if(code!==null&&(!Number.isSafeInteger(code)||code<1||code>2147483647))throw Error('目标 versionCode 无效。');
  const title=String(form.get('title')||'').trim(),body=String(form.get('body')||'').trim();
  if(!title||title.length>120||!body||body.length>4000)throw Error('请填写有效标题和正文（标题最多 120 字，正文最多 4000 字）。');
  return {title,body,kind,...targets,link,version_code:code,starts_at:starts.toISOString(),ends_at:ends.toISOString()};
}
