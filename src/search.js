import {pinyin} from 'pinyin-pro';

const cache=new Map();
const normalize=value=>String(value??'').normalize('NFKC').toLowerCase().normalize('NFD').replace(/\p{M}/gu,'').replace(/[^\p{L}\p{N}\p{Extended_Pictographic}]/gu,'');
function phonetic(s){return s.replace(/zh/g,'z').replace(/ch/g,'c').replace(/sh/g,'s').replace(/l/g,'n').replace(/ang/g,'an').replace(/eng/g,'en').replace(/ing/g,'in');}
function index(value){
  const text=String(value??'').slice(0,6000);
  if(cache.has(text))return cache.get(text);
  const syllables=pinyin(text,{toneType:'none',type:'array',v:true});
  const result={raw:normalize(text),full:normalize(syllables.join('')),initials:normalize(syllables.map(s=>s[0]||'').join('')),near:normalize(syllables.map(phonetic).join(''))};
  if(cache.size>=3000)cache.delete(cache.keys().next().value);
  cache.set(text,result);return result;
}
function subsequence(q,s){let i=0;for(const c of s){if(c===q[i])i++;if(i===q.length)return true;}return false;}
// Bounded approximate substring match. One typo for 4–7 chars, two from 8 chars.
function typo(q,s){
  if(q.length<4||q.length>64||!s.length)return false;
  const limit=q.length>=8?2:1;let prev=Array.from({length:q.length+1},(_,i)=>i);
  for(const c of s.slice(0,6000)){
    const next=[0];for(let j=1;j<=q.length;j++)next[j]=Math.min(next[j-1]+1,prev[j]+1,prev[j-1]+(q[j-1]===c?0:1));
    if(next[q.length]<=limit)return true;prev=next;
  }return false;
}
export function searchScore(values,query){
  const tokens=String(query??'').trim().split(/\s+/).filter(Boolean).slice(0,12);
  if(!tokens.length)return 0;
  const fields=(Array.isArray(values)?values:[values]).filter(v=>v!==null&&v!==undefined).map(index);
  let total=0;
  for(const token of tokens){
    const q=index(token);if(!q.raw)continue;let best=Infinity;
    for(const field of fields){
      if(field.raw.includes(q.raw)){best=0;break;}
      if(field.full.includes(q.full)||field.full.includes(q.raw))best=Math.min(best,1);
      if(q.raw.length>=2&&field.initials.includes(q.raw))best=Math.min(best,2);
      if(q.near.length>=3&&field.near.includes(q.near))best=Math.min(best,3);
      if(q.raw.length>=3&&subsequence(q.raw,field.raw))best=Math.min(best,4);
      if(typo(q.raw,field.raw)||typo(q.full,field.full))best=Math.min(best,5);
    }
    if(!Number.isFinite(best))return Infinity;total+=best;
  }return total;
}
export const matches=(values,query)=>Number.isFinite(searchScore(values,query));
export function searchItems(items,query,fields){
  return items.map((item,i)=>({item,i,score:searchScore(fields(item),query)})).filter(x=>Number.isFinite(x.score)).sort((a,b)=>a.score-b.score||a.i-b.i).map(x=>x.item);
}
