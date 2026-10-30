import { randomUUID } from 'node:crypto';
import { domScript, elementScript, namesElement, resolveElement } from './dom';
import { BrowserError, object, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';

export function readLimit(input:unknown,fallback:number,max:number,field:string):number{
  if(input===undefined)return fallback;
  if(typeof input!=='number'||!Number.isSafeInteger(input)||input<1||input>max)throw new BrowserError('invalid_request',`${field} must be an integer from 1 to ${max}.`);
  return input;
}

async function readScope(cdp:BrowserCdp,fields:BrowserObject):Promise<{cdp:BrowserCdp;expression:string}>{
  const criteria=fields.scope!==undefined?{...fields,selector:fields.scope}:fields;
  if(namesElement(criteria)||criteria.text!==undefined){const found=await resolveElement(cdp,{...criteria,visible:false});return {cdp:found.cdp,expression:elementScript(found.fields)};}
  return {cdp,expression:'document.body'};
}

export async function snapshotPage(cdp:BrowserCdp,fields:BrowserObject):Promise<BrowserObject>{
  const frameTargets=cdp.frameTargets();const scope=await readScope(cdp,fields);cdp=scope.cdp;
  const cap=readLimit(fields.maxChars??fields.maxCharacters,20000,200000,'maxChars');
  const limit=readLimit(fields.limit,200,1000,'limit');const prefix=`e-${randomUUID()}-`;
  return object(await cdp.evaluate(domScript(`
    const root=${scope.expression};if(!root)throw new Error('The snapshot scope was removed');
    const selector='a,area,button,input,textarea,select,summary,[role],[onclick],[tabindex],[contenteditable="true"]';
    const nodes=Array.from(new Set([...(root.matches(selector)?[root]:[]),...query(selector,root)])).filter(visible);
    const elements=nodes.slice(0,${limit}).map(e=>({ref:markRef(e,${JSON.stringify(prefix)}),...info(e),...(e.id?{id:e.id}:{}),${fields.includeLinks===false?'':'...(e.getAttribute(\'href\')?{href:e.getAttribute(\'href\')}:{}),'}box:box(e)}));
    const result={url:location.href,title:document.title,nodes:elements,elements,count:elements.length,total:nodes.length,truncated:nodes.length>elements.length,frameTargets:${JSON.stringify(frameTargets)}};
    ${fields.includeText===false?'':`const text=roots(root).map(r=>(r.body||r).innerText||(r.nodeType===11?r.textContent:'')||'').join('\\n');const glyphs=Array.from(text);result.text=glyphs.slice(0,${cap}).join('');result.textTruncated=glyphs.length>${cap};`}
    return result;`)));
}

export async function readPage(cdp:BrowserCdp,fields:BrowserObject):Promise<BrowserObject>{
  if(fields.filter!==undefined&&!['all','interactive'].includes(String(fields.filter)))throw new BrowserError('invalid_request','read_page filter must be all or interactive.');
  if(fields.includeText===false)return object(await cdp.evaluate('({url:location.href,title:document.title})'));
  const scope=await readScope(cdp,fields);cdp=scope.cdp;
  const depth=fields.depth===0||fields.depth===undefined?0:readLimit(fields.depth,0,64,'depth');
  const cap=readLimit(fields.maxChars??fields.maxCharacters??(fields.filter==='interactive'?undefined:fields.limit),60000,200000,'maxChars');
  const limit=readLimit(fields.filter==='interactive'?fields.limit:undefined,fields.filter==='interactive'?200:500,1000,'limit');
  const prefix=`e-${randomUUID()}-`;
  return object(await cdp.evaluate(domScript(`
    const root=${scope.expression};if(!root)throw new Error('The read scope was removed');
    const depth=${depth};const within=(e,base)=>{let at=e,steps=0;for(;at&&at!==base;at=at.parentNode){if(at.nodeType===1&&++steps>depth&&depth)return false;}return true;};
    const all=[];const seen=new Set();
    const selector=${JSON.stringify(fields.filter==='interactive'?'a,area,button,input,textarea,select,summary,label,option,[role],[onclick],[tabindex],[contenteditable="true"],img,video,audio,canvas,h1,h2,h3,h4,h5,h6,table,tr,td,th,ul,ol,li,nav,main,aside,form,dialog,section,progress,output,fieldset,details,hr':'h1,h2,h3,h4,h5,h6,p,li,td,th,pre,blockquote')};
    for(const r of roots(root)){
      const base=r.body||r;const nodes=[...(base.matches?.(selector)?[base]:[]),...base.querySelectorAll(selector)];
      for(const e of nodes){if(seen.has(e)||!within(e,base)||!visible(e))continue;seen.add(e);${fields.filter==='interactive'?'if(!enabled(e))continue;all.push({ref:markRef(e,'+JSON.stringify(prefix)+'),...info(e)});':`const text=(e.innerText||e.textContent||'').trim();if(text)all.push({ref:markRef(e,${JSON.stringify(prefix)}),tag:e.tagName.toLowerCase(),text});`}}
    }
    ${fields.filter==='interactive'?'':`if(!all.length&&!depth){const text=(root.innerText||root.textContent||'').trim();if(text)all.push({ref:markRef(root,${JSON.stringify(prefix)}),tag:root.tagName.toLowerCase(),text});}`}
    const total=all.length;const kept=[];let chars=0,truncated=all.length>${limit};
    for(const item of all.slice(0,${limit})){${fields.filter==='interactive'?'kept.push(item);':`const text=Array.from(item.text);const remaining=${cap}-chars;if(remaining<=0){truncated=true;break;}const shown=text.slice(0,remaining);kept.push({...item,text:shown.join(''),...(shown.length<text.length?{textTruncated:true}:{})});chars+=shown.length;if(shown.length<text.length)truncated=true;`}}
    return {url:location.href,title:document.title,${fields.filter==='interactive'?'filter:"interactive",elements:kept':'nodes:kept,chars'},count:kept.length,total,truncated};`)));
}
