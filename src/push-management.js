export const pushStates={queued:'待发送',sending:'正在下发',accepted:'厂商已受理',rejected:'厂商拒绝 / 校验失败',uncertain:'结果不确定，需核实',no_registration:'设备未登记推送',old_client:'客户端需更新',canceled:'已取消'};
export const vendorTextLength=s=>Array.from(s).reduce((n,c)=>n+(c.codePointAt(0)>127?c.length*2:1),0);
export function validatePushMessage(m){
 if(vendorTextLength(m.title)>40||vendorTextLength(m.body)>100)throw Error('即时通知标题最多 20 个汉字、正文最多 50 个汉字（英文按半字计）。请编辑为简短的紧急通知。');
 if(!m.enabled||m.deleted_at||Date.parse(m.starts_at)>Date.now()||Date.parse(m.ends_at)<Date.now()+60000)throw Error('请选择正在投放且至少剩余一分钟的消息。');
}
export function pushJobHtml(job,esc){
 const counts=job.counts||{};
 return `<p>任务 ${esc(job.id)}</p><dl>${Object.entries(pushStates).map(([key,label])=>`<dt>${label}</dt><dd>${counts[key]||0}</dd>`).join('')}</dl>${job.last_error?'<p role="alert">推送服务鉴权或连接失败；待发送项已保留，可核对服务配置后继续。</p>':''}<p>“厂商已受理”只表示推送平台接受请求，不能当作手机已展示或用户已读。超时不确定的项目不会自动重发。</p><details><summary>按设备查看结果</summary><div class="table-scroll"><table><thead><tr><th>设备</th><th>状态</th><th>返回码</th></tr></thead><tbody>${(job.items||[]).map(x=>`<tr><td>${esc(x.label||x.device_id)}</td><td>${pushStates[x.state]||'未知'}</td><td>${x.code??'—'}</td></tr>`).join('')}</tbody></table></div></details>`;
}
export const pushErrors={push_not_configured:'推送服务尚未开通配置。目前不能向关闭 App 的手机下发通知。',push_content_too_long:'即时通知过长，请缩短标题或正文。',push_begin_rejected:'消息状态已变化、刚刚推送过或设备过多，请刷新后核对原任务。',administrator_confirmation_required:'管理员邮箱确认已失效，请重新登录确认。',push_job_unavailable:'推送任务尚未部署或不存在。'};
