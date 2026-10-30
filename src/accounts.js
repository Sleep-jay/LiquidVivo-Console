export const accountFilters={all:'全部账号',bound:'已绑定设备',unbound:'未绑定设备',blocked:'已停用',unverified:'邮箱未验证',admin:'管理员'};
export function accountMatches(user,filter){
  switch(filter){case 'all':return true;case 'bound':return user.devices.length>0;case 'unbound':return !user.devices.length;
    case 'blocked':return user.blocked;case 'unverified':return !user.is_anonymous&&!user.email_confirmed_at;case 'admin':return user.is_admin;default:return false;}
}
export const accountSearchFields=u=>[u.email,u.id,u.note,u.blocked?'已停用 blocked':'正常',u.is_anonymous?'App 安装会话':'网页注册账号',...u.devices.flatMap(d=>[d.label,d.device_code,d.device_hash])];
export function accountList({users,selected,esc,time,includeAnonymous,total,cursor,loaded=users.length}){
  return `<section class="panel account-list"><div class="table-tools"><span>当前结果 ${users.length} 条 · 已载入 ${loaded} / ${total} 条</span><label class="check"><input id="include-installations" type="checkbox" ${includeAnonymous?'checked':''}>同时查看 App 安装会话</label></div><p class="account-hint">App 安装会话由手机自动创建，和邮箱注册账号分别管理。密码只显示是否已设置；当前密码不能读取。</p><div class="selection-bar"><span id="account-selection">已选 ${selected.size} 个账号</span><button data-account-selection="all">全选筛选结果（非管理员）</button><button data-account-selection="none">清空</button><button data-account-batch="block">批量停用</button><button data-account-batch="unblock">批量恢复</button><button data-account-batch="logout">要求重新登录</button></div><div class="table-scroll"><table><thead><tr><th>选择</th><th>账号</th><th>状态 / 密码</th><th>绑定设备与设备码</th><th>登录记录</th><th>管理</th></tr></thead><tbody>${users.map(u=>`<tr><td><input type="checkbox" data-account-check="${esc(u.id)}" ${selected.has(u.id)?'checked':''} ${u.is_admin?'disabled':''} aria-label="选择账号 ${esc(u.email||u.id)}"></td><td><strong>${esc(u.email||'匿名安装会话')}</strong><small class="cell-sub mono">${esc(u.id)}</small>${u.note?`<small class="cell-sub">${esc(u.note)}</small>`:''}</td><td><span class="badge ${u.blocked?'danger':'neutral'}">${u.is_admin?'管理员':u.blocked?'已停用':u.email_confirmed_at||u.is_anonymous?'正常':'待验证邮箱'}</span><small class="cell-sub">${u.password_set?'已设置密码':'未设置密码'}</small><small class="cell-sub">${u.is_anonymous?'App 安装会话':'网页注册账号'}</small></td><td>${u.devices.length?u.devices.map(d=>`<details class="account-device"><summary>${esc(d.label||'已绑定设备')}${d.blocked?' · 设备受限':''}</summary><p class="mono">${esc(d.device_code||'设备尚未上报完整派生码')}</p>${d.device_code?`<button type="button" class="text-button" data-account-copy="${esc(u.id)}" data-code-device="${esc(d.id)}">复制设备码</button>`:''}</details>`).join(''):'未绑定'}</td><td>${u.last_sign_in_at?time(u.last_sign_in_at):'尚未登录'}<small class="cell-sub">注册：${time(u.created_at)}</small><small class="cell-sub">会话记录：${u.session_count}</small></td><td><button class="text-button" data-account-manage="${esc(u.id)}" ${u.is_admin?'disabled title="管理员请使用账号设置"':''}>管理账号</button></td></tr>`).join('')||'<tr><td colspan="6" class="empty-cell">没有匹配的账号</td></tr>'}</tbody></table></div>${cursor?'<div class="table-foot"><button class="secondary" id="load-more-accounts">继续载入账号</button></div>':''}</section>`;
}
export const accountActions={note:'修改管理员备注',reset_email:'发送找回密码邮件',set_password:'重新设置密码',change_email:'修改登录邮箱',logout:'要求所有会话重新登录',block:'停用账号',unblock:'恢复账号',bind:'绑定 / 更换设备',unbind:'解除设备绑定'};
export function accountForm(user,devices,esc){
  const actions=Object.entries(accountActions).filter(([a])=>!user.is_anonymous||!['reset_email','set_password','change_email','bind'].includes(a));
  return `<p>${esc(user.email||'App 安装会话')}<small class="cell-sub mono">${esc(user.id)}</small></p><label>操作<select name="action">${actions.map(([key,title])=>`<option value="${key}">${title}</option>`).join('')}</select></label>
  <fieldset data-account-fields="note"><label>管理员备注<textarea name="note" maxlength="2000">${esc(user.note)}</textarea></label></fieldset>
  <fieldset data-account-fields="set_password" hidden disabled><label>新密码<input name="new_password" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><label>再输入一次<input name="password_confirm" type="password" autocomplete="new-password" minlength="12" maxlength="128" required></label><p>现有密码不能读取。只会设置新的密码，并要求旧会话重新登录；不会保存明文密码。</p></fieldset>
  <fieldset data-account-fields="change_email" hidden disabled><label>新的登录邮箱<input name="email" type="email" value="${esc(user.email)}" maxlength="254" required></label><label class="check"><input name="ownership_checked" type="checkbox" required>我已人工核对账号与新邮箱归属</label><p>更改后要求重新登录，并尝试向新邮箱发送找回邮件。邮件发送失败会明确提示。</p></fieldset>
  <fieldset data-account-fields="bind" hidden disabled><label>目标设备<select name="device_id" required><option value="">请选择</option>${devices.filter(d=>!d.blocked&&(!d.owner_id||d.owner_id===user.id)).map(d=>`<option value="${esc(d.id)}">${esc(d.label||'设备')} · ${esc(d.note||d.device_hash.slice(0,12))}</option>`).join('')}</select></label><label>短时一次性配对凭证<input name="pairing_token" autocomplete="off" pattern="[0-9a-f]{32}" minlength="32" maxlength="32" required></label><p>设备码本身不证明归属，必须使用有效配对凭证。不会覆盖其他账号已有的绑定。</p></fieldset>
  <p>停用账号与拉黑设备分开管理，不撤销已有永久离线权益。要求重新登录会立即阻止旧会话继续访问本站数据，认证令牌本身仍按其有效期到期。</p>`;
}
export function accountActionData(form){
  const action=form.get('action');
  if(action==='set_password'){
    const password=String(form.get('new_password')||'');if(password.length<12||password.length>128)throw Error('新密码须为 12–128 个字符。');
    if(password!==form.get('password_confirm'))throw Error('两次输入的新密码不一致。');return {password};
  }
  if(action==='change_email')return {email:String(form.get('email')||'').trim().toLowerCase(),ownership_checked:form.has('ownership_checked')};
  if(action==='note')return {note:String(form.get('note')||'')};
  if(action==='bind')return {device_id:form.get('device_id'),pairing_token:String(form.get('pairing_token')||'').trim()};
  return {};
}
