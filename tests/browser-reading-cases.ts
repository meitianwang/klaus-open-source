import type { IncomingMessage, ServerResponse } from 'node:http';
import { object, type BrowserObject } from '../main/browser/types';
import { assert, assertEqual, Harness, waitFor } from './harness';

let unexpectedReads=0;
export function serveReadingFixture(request:IncomingMessage,response:ServerResponse,base:string):boolean{
  if(!request.url?.startsWith('/advanced-reading'))return false;
  if(request.url==='/advanced-reading-effect'){unexpectedReads++;response.end('unexpected effect');return true;}
  if(request.url==='/advanced-reading-child-fetch'){
    response.writeHead(200,{'Content-Type':'text/plain'});response.end('child fetch body');return true;
  }
  if(request.url==='/advanced-reading-child-stream'){
    response.writeHead(200,{'Content-Type':'text/plain'});response.write('ready');
    const timer=setInterval(()=>response.write('data'),40);response.once('close',()=>clearInterval(timer));return true;
  }
  if(request.url==='/advanced-reading-quiet'||request.url==='/advanced-reading-stream'){
    response.writeHead(200,{'Content-Type':'text/plain'});response.write('ready');
    if(request.url.endsWith('stream')){const timer=setInterval(()=>response.write('data'),40);response.once('close',()=>clearInterval(timer));}return true;
  }
  if(request.url==='/advanced-reading-frame'){
    response.writeHead(200,{'Content-Type':'text/html'});response.end('<p id="frame-prose">Frame prose</p><button>Frame action</button><script>window.framePrivate="not in isolated world";window.emitChildSignals=()=>{console.log("child-console");setTimeout(()=>{throw new Error("child-exception")},0);fetch("/advanced-reading-child-fetch").then(r=>r.text()).then(t=>window.childFetch=t).catch(()=>{});};window.startChildStream=()=>{window.childStream=new AbortController();fetch("/advanced-reading-child-stream",{signal:window.childStream.signal}).then(r=>r.text()).catch(()=>{})};</script>');return true;
  }
  response.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});
  response.end('<!doctype html><title>Reading fixture</title><style>body{font:16px sans-serif}iframe{display:block;width:300px;height:90px}</style>'+
    '<h1>Main heading</h1><section id="section"><h2>Section heading</h2><div><p id="unicode">🙂你好世界</p><a id="link" href="/next">Next link</a><button id="button" onclick="this.dataset.clicked=\'yes\'">Section action</button></div></section>'+
    '<button id="outside">Outside action</button><button id="disabled" disabled>Disabled action</button><input id="password" type="password" value="never-a-name"><div id="shadow"></div><iframe id="same" src="/advanced-reading-frame"></iframe><iframe id="remote" src="'+base.replace('127.0.0.1','localhost')+'/advanced-reading-frame"></iframe>'+
    '<script>window.pagePrivate="not in isolated world";document.querySelector("#shadow").attachShadow({mode:"open"}).innerHTML="<p>Shadow prose</p><button>Shadow action</button>";</script>');return true;
}

interface Context{call(kind:string,fields?:BrowserObject):Promise<BrowserObject>;base():string}
export function registerReadingTests(h:Harness,context:Context):void{
  const call=async(kind:string,fields:BrowserObject={}):Promise<BrowserObject>=>{const result=await context.call(kind,fields);if(result.isError===true)throw new Error(JSON.stringify(result.error));return object(result.structuredContent);};
  const value=async(kind:string,fields:BrowserObject={}):Promise<BrowserObject>=>object((await call(kind,fields)).value);
  const evaluate=async(expression:string,fields:BrowserObject={}):Promise<unknown>=>(await call('eval',{...fields,expression})).value;
  const rejects=async(kind:string,fields:BrowserObject):Promise<void>=>{let error:unknown;try{await call(kind,fields);}catch(found){error=found;}assert(error,kind+' must refuse this request');};
  h.test('reading: a duration wait creates no browser tab and scoped snapshots honor omission flags',async()=>{
    const before=(await call('tabs')).value;await call('wait_for',{ms:0});const after=(await call('tabs')).value;assertEqual(JSON.stringify(after),JSON.stringify(before),'duration wait does not create or select a tab');
    await call('new_tab',{url:context.base()+'/advanced-reading-page'});
    const first=await value('snapshot',{selector:'#section',includeText:false,includeLinks:false});
    assert(!('text' in first),'text omitted');const nodes=Array.isArray(first.nodes)?first.nodes.map(object):[];assert(nodes.length===2,'only scoped controls');assert(nodes.every(node=>!('href'in node)),'links omitted');assert(!JSON.stringify(first).includes('Outside action'),'scope did not widen');
    const second=await value('snapshot',{selector:'#section'});const again=Array.isArray(second.nodes)?second.nodes.map(object):[];assert(again.some(node=>node.href==='/next'),'link URLs included by default');assertEqual(again.find(node=>node.id==='button')?.ref,nodes.find(node=>node.id==='button')?.ref,'same live node keeps its ref');
    const whole=await value('snapshot');assert(!JSON.stringify(whole).includes('never-a-name'),'password value is not an accessible name or preview');
    const old=nodes.find(node=>node.id==='button')?.ref;assert(typeof old==='string','live button ref');
    await evaluate('(()=>{const e=document.querySelector("#button");e.replaceWith(e.cloneNode(true));return true})()');
    await rejects('click',{ref:old});assertEqual(await evaluate('document.querySelector("#button").dataset.clicked||null'),null,'removed ref did not click a replacement');
    const replacement=await value('snapshot',{selector:'#section'});assert((replacement.nodes as BrowserObject[]).find(node=>node.id==='button')?.ref!==old,'replacement receives a new identity');
  });
  h.test('reading: subtree refs, Unicode budgets, depth and interactive filtering describe actual content',async()=>{
    const read=await value('read_page',{selector:'#unicode',maxChars:3});const nodes=Array.isArray(read.nodes)?read.nodes.map(object):[];assertEqual(nodes[0]?.text,'🙂你好','Unicode budget');assertEqual(read.chars,3,'reported characters');assertEqual(read.truncated,true,'partial node marked');
    const full=await value('page_text',{refId:nodes[0]?.ref??''});assertEqual(object((full.nodes as BrowserObject[])[0]).text,'🙂你好世界','ref reads the same subtree');
    const shallow=await value('read_page',{selector:'#section',depth:1});assertEqual(JSON.stringify((shallow.nodes as BrowserObject[]).map(node=>node.text)),JSON.stringify(['Section heading']),'depth excludes nested paragraph');
    const interactive=await value('read_page',{selector:'#section',filter:'interactive'});assert(Array.isArray(interactive.elements)&&interactive.elements.map(object).some(node=>node.name==='Section action'&&typeof node.ref==='string'),'interactive refs');
    const metadata=await value('read_page',{includeText:false});assertEqual(JSON.stringify(Object.keys(metadata).sort()),JSON.stringify(['title','url']),'identity-only read');
    const whole=JSON.stringify(await value('read_page'));assert(whole.includes('Shadow prose')&&whole.includes('Frame prose'),'shadow and same-origin prose included');
    await rejects('read_page',{selector:'#missing'});await rejects('read_page',{filter:'typo'});
  });
  h.test('reading: eval passes data arguments and isolated reads cannot mutate DOM or schedule writes',async()=>{
    assertEqual((await call('eval',{script:'row=>row.a+row.b',args:{a:20,b:22}})).value,42,'function arguments applied');
    assertEqual(await evaluate('document.querySelector("#unicode").innerText',{readOnly:true}),'🙂你好世界','read-only DOM getter');
    assertEqual(await evaluate('typeof window.pagePrivate',{isolated:true}),'undefined','isolated globals');
    assertEqual(JSON.stringify(await evaluate('[typeof require,typeof process,typeof module,typeof Buffer,typeof ipcRenderer,typeof window.klaus,typeof window.__KLAUS_DESKTOP__]',{readOnly:true})),JSON.stringify(Array(7).fill('undefined')),'isolated world has no host capabilities');
    for(const expression of ['document.title="bad"','Object.assign(document.body.dataset,{changed:"yes"})','fetch("/advanced-reading-effect")','(async()=>{await 0;document.title="bad";return 1})()','Promise.resolve().then(()=>document.title="bad")'])await rejects('eval',{expression,readOnly:true});
    assertEqual(await evaluate('document.title'),'Reading fixture','DOM writes were refused');assertEqual(unexpectedReads,0,'network side effect refused');
    assertEqual(await evaluate('document.body.dataset.changed||null'),null,'computed write refused');
    const bounded=object(await evaluate('"x".repeat(210000)',{readOnly:true}));assertEqual(bounded.truncated,true,'large read is explicitly bounded');
    await rejects('eval',{expression:'42',args:{ignored:true}});
  });
  h.test('reading: isolated OOPIF evaluation uses its unique document context and survives later reads',async()=>{
    const snapshot=await value('snapshot');const frame=Array.isArray(snapshot.frameTargets)?snapshot.frameTargets[0]:undefined;assert(typeof frame==='string','owned OOPIF target');
    assertEqual(await evaluate('document.querySelector("#frame-prose").textContent',{readOnly:true,frameTargetId:frame}),'Frame prose','actual child document');
    assertEqual(await evaluate('typeof window.framePrivate',{readOnly:true,frameTargetId:frame}),'undefined','child page globals isolated');
    assertEqual(JSON.stringify(await evaluate('[typeof require,typeof process,typeof module,typeof Buffer,typeof ipcRenderer,typeof window.klaus,typeof window.__KLAUS_DESKTOP__]',{readOnly:true,frameTargetId:frame})),JSON.stringify(Array(7).fill('undefined')),'isolated OOPIF has no host capabilities');
    await rejects('eval',{expression:'document.querySelector("p").remove()',readOnly:true,frameTargetId:frame});
    assertEqual(await evaluate('document.querySelector("#frame-prose").textContent',{readOnly:true,frameTargetId:frame}),'Frame prose','child DOM remained intact');
  });
  h.test('reading: URL, load, enabled and detached waits observe real changes and reject mixed subjects',async()=>{
    await evaluate('setTimeout(()=>history.pushState({},"","#done"),70);true');assert(String((await value('wait_for',{url:'*#done',timeoutMs:2000})).url).endsWith('#done'),'URL wait');
    assertEqual((await value('wait_for',{loadState:'domcontentloaded',timeoutMs:0})).loadState,'domcontentloaded','load state immediate probe');
    await call('wait_for',{selector:'#disabled',state:'disabled',timeoutMs:0});await evaluate('setTimeout(()=>document.querySelector("#disabled").disabled=false,70);true');await call('wait_for',{selector:'#disabled',state:'enabled',timeoutMs:2000});
    await evaluate('setTimeout(()=>document.querySelector("#outside").remove(),70);true');await call('wait_for',{selector:'#outside',state:'detached',timeoutMs:2000});
    await rejects('wait_for',{url:'*',selector:'body'});await rejects('wait_for',{loadState:'typo'});
  });
  h.test('reading: networkidle waits for quiet data activity while allowing a quiet open connection',async()=>{
    await evaluate('window.quiet=new AbortController();fetch("/advanced-reading-quiet",{signal:quiet.signal}).then(r=>r.text()).catch(()=>{});true');
    await call('wait_for',{loadState:'networkidle',timeoutMs:2500});
    await evaluate('window.flow=new AbortController();fetch("/advanced-reading-stream",{signal:flow.signal}).then(r=>r.text()).catch(()=>{});true');
    try{await rejects('wait_for',{loadState:'networkidle',timeoutMs:900});}finally{await evaluate('flow.abort();quiet.abort();true');}
    await call('wait_for',{loadState:'networkidle',timeoutMs:2500});
  });
  h.test('reading: owned OOPIF console, exception, network and networkidle activity are observed',async()=>{
    await call('new_tab',{url:context.base()+'/advanced-reading-page'});
    const snapshot=await value('snapshot');const frames=Array.isArray(snapshot.frameTargets)?snapshot.frameTargets:[];const frame=frames[0];
    assert(typeof frame==='string','owned cross-process frame discovered');
    await evaluate('typeof window.emitChildSignals',{frameTargetId:frame});
    await evaluate('window.emitChildSignals();true',{frameTargetId:frame});
    await waitFor(async()=>{
      const result=object(await call('console',{frameTargetId:frame,limit:50}));
      const entries=Array.isArray(result.entries)?result.entries.map(object):[];
      return entries.some(entry=>String(entry.text).includes('child-console'));
    },5000,'child console is captured');
    const childConsole=object(await call('console',{frameTargetId:frame,limit:50}));
    const childEntries=Array.isArray(childConsole.entries)?childConsole.entries.map(object):[];
    assert(childEntries.some(entry=>String(entry.text).includes('child-console')),'child console entry carries the child frame identity');
    assert(childEntries.some(entry=>String(entry.text).includes('child-exception')||entry.level==='error'),'child exception is captured');
    const rootConsole=object(await call('console',{limit:100}));
    assert((rootConsole.entries as BrowserObject[]).map(object).some(entry=>String(entry.text).includes('child-console')),'root console view includes owned child entries');
    await waitFor(async()=>{
      const result=object(await call('network',{frameTargetId:frame,limit:100}));
      const requests=Array.isArray(result.requests)?result.requests.map(object):[];
      return requests.some(entry=>String(entry.url).includes('/advanced-reading-child-fetch'));
    },5000,'child fetch is captured');
    const childNetwork=object(await call('network',{frameTargetId:frame,limit:100}));
    assert((childNetwork.requests as BrowserObject[]).map(object).some(entry=>String(entry.url).includes('/advanced-reading-child-fetch')),'child network entry carries the child frame identity');
    const rootNetwork=object(await call('network',{limit:100}));
    assert((rootNetwork.requests as BrowserObject[]).map(object).some(entry=>String(entry.url).includes('/advanced-reading-child-fetch')),'root network view includes owned child entries');
    await evaluate('window.startChildStream();true',{frameTargetId:frame});
    let timedOut=false;try{await call('wait_for',{loadState:'networkidle',timeoutMs:900});}catch{timedOut=true;}
    assert(timedOut,'child stream activity prevents networkidle');
    await evaluate('window.childStream.abort();true',{frameTargetId:frame});
    await call('wait_for',{loadState:'networkidle',timeoutMs:2500});
  });

}
