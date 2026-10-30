export function pageOf(items,page=1,size=10){
 const pageSize=[10,20,50].includes(Number(size))?Number(size):10;
 const total=items.length,pages=Math.max(1,Math.ceil(total/pageSize));
 const current=Math.min(pages,Math.max(1,Math.trunc(Number(page))||1));
 const offset=(current-1)*pageSize;
 return {items:items.slice(offset,offset+pageSize),page:current,pages,size:pageSize,total,start:total?offset+1:0,end:Math.min(total,offset+pageSize)};
}
export function pagerHtml(p){
 return `<div class="device-pagination"><span>共 ${p.total} 台 · 显示 ${p.start}–${p.end}</span><div class="page-controls"><label>每页 <select data-page-size aria-label="每页设备数">${[10,20,50].map(n=>`<option value="${n}" ${p.size===n?'selected':''}>${n} 台</option>`).join('')}</select></label><button class="secondary" data-device-page="1" ${p.page===1?'disabled':''}>首页</button><button class="secondary" data-device-page="${p.page-1}" ${p.page===1?'disabled':''}>上一页</button><span aria-live="polite">${p.page} / ${p.pages}</span><button class="secondary" data-device-page="${p.page+1}" ${p.page===p.pages?'disabled':''}>下一页</button><button class="secondary" data-device-page="${p.pages}" ${p.page===p.pages?'disabled':''}>末页</button></div></div>`;
}
