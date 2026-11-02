import { locateElements, namesElement } from './dom';
import { BrowserError, type BrowserObject } from './types';
import type { BrowserCdp } from './page-operations';
import { assertBrowserActionActive, browserAction, pauseBrowserAction } from './action-cancellation';

export const MAX_BROWSER_WAIT_MS=120000;

export function boundedWaitDuration(value:unknown):number{
  if(typeof value!=='number'||!Number.isFinite(value)||value<0)throw new BrowserError('invalid_request','Wait duration must be a non-negative number of milliseconds.');
  return Math.min(value,MAX_BROWSER_WAIT_MS);
}

export function waitSubject(fields:BrowserObject):'duration'|'url'|'load'|'element'{
  const subjects:Array<'duration'|'url'|'load'|'element'>=[];
  if(fields.ms!==undefined||fields.durationMs!==undefined)subjects.push('duration');
  if(fields.url!==undefined)subjects.push('url');
  if(fields.loadState!==undefined)subjects.push('load');
  if(namesElement(fields)||fields.text!==undefined||fields.query!==undefined)subjects.push('element');
  if(subjects.length!==1)throw new BrowserError('invalid_request','wait_for needs exactly one subject: ms, url, loadState or an element.');
  return subjects[0]!;
}

export function waitedUrlMatches(actual:string,pattern:string):boolean{
  if(!pattern.includes('*'))return actual.includes(pattern);
  return new RegExp('^'+pattern.split('*').map(part=>part.replace(/[.*+?^${}()|[\]\\]/gu,'\\$&')).join('.*')+'$','u').test(actual);
}

export async function waitForPage(cdp:BrowserCdp|undefined,fields:BrowserObject,signal?:AbortSignal):Promise<BrowserObject>{
  assertBrowserActionActive(signal);
  const subject=waitSubject(fields);const duration=subject==='duration'?fields.ms??fields.durationMs:fields.timeoutMs??10000;
  const boundedDuration=boundedWaitDuration(duration);
  if(subject==='duration'){await pauseBrowserAction(boundedDuration,signal);return {waitedMs:boundedDuration};}
  if(!cdp)throw new BrowserError('stale_tab','This wait requires an active page.');
  if(subject==='url'&&(typeof fields.url!=='string'||!fields.url.trim()))throw new BrowserError('invalid_request','Wait URL must be a nonempty string or wildcard pattern.');
  const state=String(fields.state??'visible');const loadState=String(fields.loadState??'').toLowerCase();
  if(subject==='element'&&!['visible','hidden','attached','detached','enabled','disabled'].includes(state))throw new BrowserError('invalid_request','Unknown element wait state.');
  if(subject==='load'&&!['load','domcontentloaded','networkidle'].includes(loadState))throw new BrowserError('invalid_request','loadState must be load, domcontentloaded or networkidle.');
  let lastActivity=Date.now();const until=Date.now()+boundedDuration;
  const criteria:BrowserObject={...fields,visible:false};delete criteria.state;
  const activity=new Set(['Network.requestWillBeSent','Network.responseReceived','Network.dataReceived','Network.loadingFinished','Network.loadingFailed','Network.webSocketFrameReceived','Network.webSocketFrameSent','Network.eventSourceMessageReceived']);
  const stop=loadState==='networkidle'?cdp.onEvent(method=>{if(activity.has(method))lastActivity=Date.now();}):()=>{};
  try{
    for(;;){
      assertBrowserActionActive(signal);
      try{
        if(subject==='url'){const url=String(await browserAction(()=>cdp.evaluate('location.href'),signal));if(waitedUrlMatches(url,String(fields.url)))return {url};}
        else if(subject==='load'){
          const ready=await browserAction(()=>cdp.evaluate('document.readyState'),signal);
          if(loadState==='networkidle'?Date.now()-lastActivity>=500:loadState==='load'?ready==='complete':['interactive','complete'].includes(String(ready)))return {loadState,...(loadState==='networkidle'?{quietMs:500,note:'No observed request or data activity for 500 ms; an open but quiet connection may remain.'}:{})};
        }else{
          let elements=await browserAction(()=>locateElements(cdp,criteria),signal);
          if(!elements.length&&fields.frames!==false)for(const frame of cdp.frameTargets())elements.push(...await browserAction(()=>locateElements(cdp,criteria,frame),signal));
          const found=elements.length>0,visible=elements.some(e=>e.visible===true),enabled=elements.some(e=>e.enabled===true&&e.visible===true),disabled=elements.some(e=>e.enabled===false);
          if(state==='attached'?found:state==='detached'?!found:state==='visible'?visible:state==='hidden'?!visible:state==='enabled'?enabled:disabled)return {state,elements,count:elements.length};
        }
      }catch(error){if(!(error instanceof BrowserError)||!['cdp_error','evaluation_error'].includes(error.code)||!/context.*destroyed|cannot find context/iu.test(error.message))throw error;}
      if(Date.now()>=until)throw new BrowserError('timeout',`The page did not reach the requested ${subject} state before timeout.`);
      await pauseBrowserAction(Math.min(50,Math.max(1,until-Date.now())),signal);
    }
  }finally{stop();}
}
