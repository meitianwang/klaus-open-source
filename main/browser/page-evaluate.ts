import { timeoutMs } from './policy';
import { BrowserError, json, object, string, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';
import type { Json } from '../ipc/contract';

interface ContextIdentity { id:number; frame:string; uniqueId:string; source?:string }
const worlds=new WeakMap<BrowserCdp,Map<string,ContextIdentity>>();
const WORLD_NAME='klaus-read-only';

function worldIdentities(cdp:BrowserCdp):Map<string,ContextIdentity>{
  const root=cdp.captureScope?.root??cdp;let contexts=worlds.get(root);
  if(contexts)return contexts;
  contexts=new Map();worlds.set(root,contexts);const current=contexts;
  root.onEvent((method,params,source)=>{
    if(method==='Runtime.executionContextCreated'){
      const context=object(params.context);const frame=object(context.auxData).frameId;
      if(context.name===WORLD_NAME&&typeof context.id==='number'&&typeof context.uniqueId==='string'&&typeof frame==='string')current.set(`${frame}:${context.id}`,{id:context.id,frame,uniqueId:context.uniqueId,source});
    }else if(method==='Runtime.executionContextDestroyed'||method==='Runtime.executionContextsCleared'){
      for(const [key,context] of current)if(context.source===source&&(method==='Runtime.executionContextsCleared'||context.id===params.executionContextId||context.uniqueId===params.executionContextUniqueId))current.delete(key);
    }
  });
  return contexts;
}

export function evaluationExpression(fields:BrowserObject):string{
  const expression=string(fields.expression??fields.script,'expression');
  if(fields.args===undefined||fields.args===null)return expression;
  return `(()=>{const fn=(${expression});if(typeof fn!=='function')throw new Error('eval args require a function expression');return fn(${JSON.stringify(fields.args)});})()`;
}

export function boundedEvaluation(value:unknown,depth=8):Json{
  const shorten=(item:unknown,remaining:number):Json=>{
    if(item===null||typeof item!=='object')return json(item);
    if(remaining===0)return {truncated:true,reason:'maximum result depth'};
    return Array.isArray(item)?item.map(entry=>shorten(entry,remaining-1)):Object.fromEntries(Object.entries(item).map(([key,entry])=>[key,shorten(entry,remaining-1)]));
  };
  const result=shorten(value,depth);const encoded=JSON.stringify(result);
  return Buffer.byteLength(encoded)<=200000?result:{truncated:true,reason:'result exceeds 200000 bytes',preview:Array.from(encoded).slice(0,4000).join('')};
}

/** V8 refuses evaluation when it cannot exclude a side effect. No source regex
 * or fallback into the page world can silently weaken this request. */
export async function evaluatePage(cdp:BrowserCdp,fields:BrowserObject):Promise<Json>{
  const expression=evaluationExpression(fields);const readOnly=fields.readOnly===true||fields.isolated===true;
  if(!readOnly)return json(await cdp.evaluate(expression));
  const contexts=worldIdentities(cdp);
  await cdp.command('Runtime.enable');
  const tree=object((await cdp.command('Page.getFrameTree')).frameTree);const frameId=object(tree.frame).id;
  if(typeof frameId!=='string')throw new BrowserError('stale_target','This page has no current document for read-only evaluation.');
  const world=await cdp.command('Page.createIsolatedWorld',{frameId,worldName:WORLD_NAME,grantUniveralAccess:false});
  const key=`${frameId}:${String(world.executionContextId)}`;const until=Date.now()+1000;
  while(!contexts.has(key)&&Date.now()<until)await new Promise(resolve=>setTimeout(resolve,10));
  const context=contexts.get(key);
  if(!context)throw new BrowserError('unavailable','Chromium did not provide the unique isolated context identity. No read-only fallback was performed.');
  const result=await cdp.command('Runtime.evaluate',{expression,uniqueContextId:context.uniqueId,returnByValue:true,awaitPromise:true,throwOnSideEffect:true,timeout:timeoutMs(fields.timeoutMs,5000),silent:true,userGesture:false});
  if(result.exceptionDetails){const exception=object(result.exceptionDetails);throw new BrowserError('read_only_refused',String(object(exception.exception).description??exception.text??'Chromium could not rule out side effects.'));}
  const remote=object(result.result);
  return boundedEvaluation(remote.value??(remote.unserializableValue!==undefined?{type:remote.type!,unserializableValue:remote.unserializableValue}:null));
}
