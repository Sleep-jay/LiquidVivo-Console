export function encodeReleaseNotes(version,zh,en){
  const data={format:'lv_release_notes_v1',version:String(version||'').trim(),zh:String(zh||'').trim(),en:String(en||'').trim()};
  if(!data.version||data.version.length>64||!data.zh||!data.en)throw Error('请填写日志版本、中文正文和英文正文。');
  const text=JSON.stringify(data);if(text.length>4000)throw Error('中英文日志合计超过 4000 字符，请缩短正文。');return text;
}
export function decodeReleaseNotes(body){try{const p=JSON.parse(body);return p.format==='lv_release_notes_v1'?p:null;}catch{return null;}}
