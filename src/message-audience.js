import {matches} from './search.js';
import {deviceFilterOptions,matchesDeviceFilter,deviceState} from './device-filters.js';
export function audienceFields(devices,ids,esc,{all=ids.length===0,grants=[]}={}){
  const chosen=new Set(ids);
  return `<label>投放范围<select name="audience"><option value="all" ${all?'selected':''}>所有设备（含未来登记设备）</option><option value="selected" ${all?'':'selected'}>指定设备</option></select></label>
  <section class="audience-picker" ${all?'hidden':''}>
    <label>搜索设备<input type="search" data-audience-search placeholder="搜索名称、备注或标识摘要"></label>
    <label>设备分类<select data-audience-filter>${deviceFilterOptions()}</select></label>
    <div class="audience-tools"><span data-audience-count></span><button type="button" data-audience-select>全选搜索结果</button><button type="button" data-audience-only>仅选择当前结果</button><button type="button" data-audience-clear>清空选择</button></div>
    <div class="audience-devices">${devices.map(d=>`<label class="audience-device" data-audience-row data-id="${esc(d.id)}" data-search="${esc([d.label,d.note,d.device_hash,d.id].join(' ').toLowerCase())}"><input type="checkbox" name="target" value="${esc(d.id)}" ${chosen.has(d.id)?'checked':''}><span><strong>${esc(d.label||'未命名设备')}</strong><small>${esc(d.note||'无备注')} · ${esc(d.device_hash.slice(0,12))}…${deviceState(d,grants).sponsored?' · 已赞助':deviceState(d,grants).temporary?' · 仅限时权益':' · 无永久赞助权益'}${d.blocked?' · 已拉黑':''}</small></span></label>`).join('')}</div>
    <p data-audience-empty ${devices.length?'hidden':''}>没有匹配的设备</p><p>仅投放给勾选的设备，不包含未来登记设备。</p>
  </section>`;
}

export function bindAudiencePicker(dialog,{devices=[],grants=[]}={}){
  const scope=dialog.querySelector('[name="audience"]'),picker=dialog.querySelector('.audience-picker');
  const boxes=[...picker.querySelectorAll('[name="target"]')],rows=[...picker.querySelectorAll('[data-audience-row]')];
  const count=()=>{const checked=boxes.filter(b=>b.checked),hidden=checked.filter(b=>b.closest('[data-audience-row]').hidden).length;picker.querySelector('[data-audience-count]').textContent=`已选择 ${checked.length} 台 · 当前结果 ${rows.filter(r=>!r.hidden).length} 台${hidden?` · 筛选外已选 ${hidden} 台`:''}`;};
  const toggle=()=>{picker.hidden=scope.value!=='selected';boxes.forEach(b=>{b.disabled=picker.hidden;});count();};
  scope.addEventListener('change',toggle);boxes.forEach(b=>b.addEventListener('change',count));
  const filter=()=>{
    const query=picker.querySelector('[data-audience-search]').value,category=picker.querySelector('[data-audience-filter]').value;
    rows.forEach(row=>{const d=devices.find(d=>d.id===row.dataset.id);row.hidden=!matches(row.dataset.search,query)||(d?!matchesDeviceFilter(d,category,grants):category!=='all');});
    picker.querySelector('[data-audience-empty]').hidden=rows.some(row=>!row.hidden);count();
  };
  picker.querySelector('[data-audience-search]').addEventListener('input',filter);
  picker.querySelector('[data-audience-filter]').addEventListener('change',filter);
  picker.querySelector('[data-audience-only]').onclick=()=>{rows.forEach(row=>{row.querySelector('input').checked=!row.hidden;});count();};
  picker.querySelector('[data-audience-select]').onclick=()=>{rows.filter(row=>!row.hidden).forEach(row=>{row.querySelector('input').checked=true;});count();};
  picker.querySelector('[data-audience-clear]').onclick=()=>{boxes.forEach(b=>{b.checked=false;});count();};
  toggle();
}

export function messageTargets(form,devices){
  if(form.get('audience')==='all')return {all_devices:true,target_ids:[]};
  if(form.get('audience')!=='selected')throw Error('请选择投放范围。');
  const ids=[...new Set(form.getAll('target'))],known=new Set(devices.map(d=>d.id));
  if(!ids.length)throw Error('请至少选择一台接收设备。');
  if(ids.some(id=>!known.has(id)))throw Error('设备列表已变化，请重新选择接收设备。');
  return {all_devices:false,target_ids:ids};
}
