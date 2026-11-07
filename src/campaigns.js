export function campaignGrants(campaigns,claims){
 return claims.flatMap(m=>{const c=campaigns.find(c=>c.id===m.campaign_id);return c&&c.enabled&&!m.revoked_at?[{...c,id:m.id,device_id:m.device_id,campaign_id:c.id,campaign_title:c.title}]:[];});
}
export function campaignCodeState(code,now=Date.now()){
 return !code.enabled?'disabled':Date.parse(code.expires_at)<=now?'expired':code.used_count>=code.max_uses?'exhausted':'enabled';
}
export function codeFields(code,campaign,esc,localDate){
 return `<label>兑换码内容<input name="code" value="${esc(code?.code||'')}" minlength="4" maxlength="64" autocomplete="off" required></label><p>4–64 个字符，不含空格；英文字母不区分大小写。请使用难以猜到的内容。修改或停用兑换码不取消已领取资格。</p><label>状态<select name="enabled"><option value="yes" ${code?.enabled!==false?'selected':''}>可兑换</option><option value="no" ${code?.enabled===false?'selected':''}>已停用</option></select></label><label>总兑换次数上限<input type="number" name="max_uses" min="${Math.max(1,code?.used_count||0)}" max="100000" value="${code?.max_uses||1}" required></label><label>每台设备最多兑换次数<input type="number" name="per_device_limit" min="1" max="100000" value="${code?.per_device_limit||1}" required></label><label>有效期方式<select name="validity_seconds"><option value="" ${!code?.validity_seconds?'selected':''}>指定截止时间</option>${[[86400,'一天'],[172800,'两天'],[604800,'一星期'],[2592000,'一个月（30天）']].map(([v,t])=>`<option value="${v}" ${code?.validity_seconds===v?'selected':''}>${t}</option>`).join('')}</select></label><p>时长从本次保存与活动开始时间中较晚者起算。超过活动结束时间仍不能兑换；重复兑换不会延长活动权益。</p><label>兑换截止时间（选择指定时间时使用）<input name="expires_at" type="datetime-local" value="${localDate(code?.expires_at||campaign.ends_at)}" required></label><p>所属活动：${esc(campaign.title)}；已领取 ${code?.used_count||0} 次。资格持续至活动结束，停用活动会停止后续同步发放。</p>`;
}
export function codePayload(form){
 const code=String(form.get('code')||'').trim().toUpperCase(),max_uses=Number(form.get('max_uses')),per_device_limit=Number(form.get('per_device_limit')||1),validity_seconds=Number(form.get('validity_seconds'))||null,date=Date.parse(form.get('expires_at'));
 if([...code].length<4||[...code].length>64||/\s|[\u0000-\u001f\u007f]/u.test(code))throw Error('兑换码须为 4–64 个字符，不能含空格或控制字符。');
 if(!Number.isInteger(max_uses)||max_uses<1||max_uses>100000||(validity_seconds!==null&&![86400,172800,604800,2592000].includes(validity_seconds))||(!validity_seconds&&!Number.isFinite(date))||!Number.isInteger(per_device_limit)||per_device_limit<1||per_device_limit>100000)throw Error('领取上限或截止时间无效。');
 return {code,enabled:form.get('enabled')==='yes',max_uses,per_device_limit,validity_seconds,expires_at:Number.isFinite(date)?new Date(date).toISOString():null};
}
export function campaignCodesView(campaign,codes,esc,time){
 const titles={enabled:'可兑换',disabled:'已停用',expired:'已过期',exhausted:'次数用完'};
 return `<p>活动：${esc(campaign.title)}</p><button type="button" data-code-new="${esc(campaign.id)}" class="secondary">＋ 创建兑换码</button><label>搜索兑换码<input data-code-search type="search" placeholder="支持模糊匹配"></label><label>兑换码分类<select data-code-filter><option value="all">全部状态</option>${Object.entries(titles).map(([key,title])=>`<option value="${key}">${title}</option>`).join('')}</select></label><div class="table-scroll"><table><thead><tr><th>兑换码</th><th>状态</th><th>已用 / 总上限</th><th>每设备上限</th><th>截止</th><th>操作</th></tr></thead><tbody>${codes.map(c=>`<tr data-code-row="${esc(c.id)}"><td class="mono">${esc(c.code)}</td><td>${titles[campaignCodeState(c)]}</td><td>${c.used_count} / ${c.max_uses}</td><td>${c.per_device_limit||1} 次</td><td>${time(c.expires_at)}</td><td><button type="button" class="text-button" data-code-edit="${esc(c.id)}">编辑内容 / 状态</button></td></tr>`).join('')||'<tr><td colspan="6">尚无兑换码，设备无法领取此活动</td></tr>'}</tbody></table></div>`;
}
