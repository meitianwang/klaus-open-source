import { randomUUID } from 'node:crypto';
import { domScript, elementScript, namesElement, resolveElement } from './dom';
import { BrowserError, object, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';

export function readLimit(input:unknown,fallback:number,max:number,field:string):number{
  if(input===undefined)return fallback;
  if(typeof input!=='number'||!Number.isSafeInteger(input)||input<1||input>max)throw new BrowserError('invalid_request',`${field} must be an integer from 1 to ${max}.`);
  return input;
}

/** A whole-document read merges at most this many additionally addressed frames. */
const FRAME_MERGE_LIMIT = 8;

async function readScope(cdp:BrowserCdp,fields:BrowserObject):Promise<{cdp:BrowserCdp;expression:string;whole:boolean}>{
  const criteria=fields.scope!==undefined?{...fields,selector:fields.scope}:fields;
  if(namesElement(criteria)||criteria.text!==undefined){const found=await resolveElement(cdp,{...criteria,visible:false});return {cdp:found.cdp,expression:elementScript(found.fields),whole:false};}
  return {cdp,expression:'document.body',whole:true};
}

function snapshotScript(rootExpression:string,prefix:string,limit:number,cap:number,includeText:boolean,includeLinks:boolean):string{
  return domScript(`
    const root=${rootExpression};if(!root)throw new Error('The snapshot scope was removed');
    const selector='a,area,button,input,textarea,select,summary,[role],[onclick],[tabindex],[contenteditable="true"]';
    const nodes=Array.from(new Set([...(root.matches(selector)?[root]:[]),...query(selector,root)])).filter(visible);
    const elements=nodes.slice(0,${limit}).map(e=>({ref:markRef(e,${JSON.stringify(prefix)}),...info(e),...(e.id?{id:e.id}:{}),${includeLinks?'...(e.getAttribute(\'href\')?{href:e.getAttribute(\'href\')}:{}),':''}box:box(e)}));
    const result={url:location.href,title:document.title,nodes:elements,elements,count:elements.length,total:nodes.length,truncated:nodes.length>elements.length};
    ${includeText?`const text=roots(root).map(r=>(r.body||r).innerText||(r.nodeType===11?r.textContent:'')||'').join('\\n');const glyphs=Array.from(text);result.text=glyphs.slice(0,${cap}).join('');result.textTruncated=glyphs.length>${cap};`:''}
    return result;`);
}

function readScript(rootExpression:string,prefix:string,depth:number,limit:number,cap:number,interactive:boolean):string{
  return domScript(`
    const root=${rootExpression};if(!root)throw new Error('The read scope was removed');
    const depth=${depth};const within=(e,base)=>{let at=e,steps=0;for(;at&&at!==base;at=at.parentNode){if(at.nodeType===1&&++steps>depth&&depth)return false;}return true;};
    const all=[];const seen=new Set();
    const selector=${JSON.stringify(interactive?'a,area,button,input,textarea,select,summary,label,option,[role],[onclick],[tabindex],[contenteditable="true"],img,video,audio,canvas,h1,h2,h3,h4,h5,h6,table,tr,td,th,ul,ol,li,nav,main,aside,form,dialog,section,progress,output,fieldset,details,hr':'h1,h2,h3,h4,h5,h6,p,li,td,th,pre,blockquote')};
    for(const r of roots(root)){
      const base=r.body||r;const nodes=[...(base.matches?.(selector)?[base]:[]),...base.querySelectorAll(selector)];
      for(const e of nodes){if(seen.has(e)||!within(e,base)||!visible(e))continue;seen.add(e);${interactive?`if(!enabled(e))continue;all.push({ref:markRef(e,${JSON.stringify(prefix)}),...info(e)});`:`const text=(e.innerText||e.textContent||'').trim();if(text)all.push({ref:markRef(e,${JSON.stringify(prefix)}),tag:e.tagName.toLowerCase(),text});`}}
    }
    ${interactive?'':`if(!all.length&&!depth){const text=(root.innerText||root.textContent||'').trim();if(text)all.push({ref:markRef(root,${JSON.stringify(prefix)}),tag:root.tagName.toLowerCase(),text});}`}
    const total=all.length;const kept=[];let chars=0,truncated=all.length>${limit};
    for(const item of all.slice(0,${limit})){${interactive?'kept.push(item);':`const text=Array.from(item.text);const remaining=${cap}-chars;if(remaining<=0){truncated=true;break;}const shown=text.slice(0,remaining);kept.push({...item,text:shown.join(''),...(shown.length<text.length?{textTruncated:true}:{})});chars+=shown.length;if(shown.length<text.length)truncated=true;`}}
    return {url:location.href,title:document.title,${interactive?'filter:"interactive",elements:kept':'nodes:kept,chars'},count:kept.length,total,truncated};`);
}

export async function snapshotPage(cdp:BrowserCdp,fields:BrowserObject):Promise<BrowserObject>{
  const frameTargets=cdp.remoteFrameIds();const scope=await readScope(cdp,fields);cdp=scope.cdp;
  const cap=readLimit(fields.maxChars??fields.maxCharacters,20000,200000,'maxChars');
  const limit=readLimit(fields.limit,200,1000,'limit');
  const includeText=fields.includeText!==false;
  const includeLinks=fields.includeLinks!==false;
  const result=object(await cdp.evaluate(snapshotScript(scope.expression,`e-${randomUUID()}-`,limit,cap,includeText,includeLinks)));
  result.frameTargets=frameTargets;
  // A cross-origin frame keeps its document out of the addressed world; merge
  // its own snapshot so its controls stay visible and addressable by ref.
  if(scope.whole&&fields.frames!==false){
    let rows=Number(result.count??0);
    let textChars=includeText&&typeof result.text==='string'?Array.from(result.text).length:0;
    for(const frameId of frameTargets.slice(0,FRAME_MERGE_LIMIT)){
      if(rows>=limit&&(!includeText||textChars>=cap))break;
      try{
        const frameResult=object(await cdp.evaluate(snapshotScript('document.body',`e-${randomUUID()}-`,Math.max(0,limit-rows),Math.max(0,cap-textChars),includeText,includeLinks),frameId));
        const nodes=(Array.isArray(frameResult.elements)?frameResult.elements:[]).map(value=>({...object(value),frameTargetId:frameId}));
        if(nodes.length){
          (result.elements as BrowserObject[]).push(...nodes);
          (result.nodes as BrowserObject[]).push(...nodes.map(node=>({...node})));
          rows+=nodes.length;result.count=rows;
          result.total=Number(result.total??0)+Number(frameResult.total??0);
        }
        if(includeText&&typeof frameResult.text==='string'&&frameResult.text){
          result.text=`${typeof result.text==='string'?result.text:''}\n\n[frame ${String(frameResult.url??'')}]\n${frameResult.text}`;
          textChars=Array.from(String(result.text)).length;
        }
        if(frameResult.truncated===true||frameResult.textTruncated===true)result.truncated=true;
      }catch{/* a frame that cannot be read contributes nothing */}
    }
    if(includeText&&typeof result.text==='string'){
      const glyphs=Array.from(result.text);
      if(glyphs.length>cap){result.text=glyphs.slice(0,cap).join('');result.textTruncated=true;}
    }
  }
  return result;
}

export async function readPage(cdp:BrowserCdp,fields:BrowserObject):Promise<BrowserObject>{
  if(fields.filter!==undefined&&!['all','interactive'].includes(String(fields.filter)))throw new BrowserError('invalid_request','read_page filter must be all or interactive.');
  if(fields.includeText===false)return object(await cdp.evaluate('({url:location.href,title:document.title})'));
  const scope=await readScope(cdp,fields);cdp=scope.cdp;
  const depth=fields.depth===0||fields.depth===undefined?0:readLimit(fields.depth,0,64,'depth');
  const interactive=fields.filter==='interactive';
  const cap=readLimit(fields.maxChars??fields.maxCharacters??(interactive?undefined:fields.limit),60000,200000,'maxChars');
  const limit=readLimit(interactive?fields.limit:undefined,interactive?200:500,1000,'limit');
  const result=object(await cdp.evaluate(readScript(scope.expression,`e-${randomUUID()}-`,depth,limit,cap,interactive)));
  if(scope.whole&&fields.frames!==false){
    let rows=Number(result.count??0);
    let chars=Number(result.chars??0);
    for(const frameId of cdp.remoteFrameIds().slice(0,FRAME_MERGE_LIMIT)){
      if(rows>=limit&&(interactive||chars>=cap))break;
      try{
        const frameResult=object(await cdp.evaluate(readScript('document.body',`e-${randomUUID()}-`,depth,Math.max(0,limit-rows),Math.max(0,cap-chars),interactive),frameId));
        const list=interactive?'elements':'nodes';
        const items=(Array.isArray(frameResult[list])?frameResult[list]:[]).map(value=>({...object(value),frameTargetId:frameId}));
        if(items.length){
          (result[list] as BrowserObject[]).push(...items);
          rows+=items.length;result.count=rows;
          result.total=Number(result.total??0)+Number(frameResult.total??0);
        }
        if(!interactive){chars+=Number(frameResult.chars??0);result.chars=chars;}
        if(frameResult.truncated===true)result.truncated=true;
      }catch{/* a frame that cannot be read contributes nothing */}
    }
  }
  return result;
}
