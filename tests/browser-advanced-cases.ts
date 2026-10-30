import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { object, type BrowserObject } from '../main/browser/types';
import { assert, assertEqual, Harness } from './harness';
import { registerInputTests, serveInputFixture } from './browser-input-cases';
import { registerDownloadTests, serveDownloadFixture } from './browser-download-cases';
import { registerReadingTests, serveReadingFixture } from './browser-reading-cases';
import { registerLocatorTests, serveLocatorFixture } from './browser-locator-cases';
import { registerFileUploadTests, serveFileUploadFixture } from './browser-file-upload-cases';

export function serveAdvancedFixture(request: IncomingMessage, response: ServerResponse, base: string): boolean {
  if (!request.url?.startsWith('/advanced')) return false;
  if (serveFileUploadFixture(request,response,base)) return true;
  if (serveDownloadFixture(request,response,base)) return true;
  if (serveReadingFixture(request,response,base)) return true;
  if (serveLocatorFixture(request,response,base)) return true;
  if (serveInputFixture(request,response,base)) return true;
  if (request.url === '/advanced-data') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{"fixtureBody":"observed response"}'); return true; }
  if (request.url === '/advanced-image.svg') {
    if (!request.headers.cookie?.includes('advanced_cookie=yes')) { response.writeHead(403); response.end('No login'); return true; }
    response.writeHead(200, { 'Content-Type': 'image/svg+xml' }); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>'); return true;
  }
  if (request.url === '/advanced-missing.svg') { response.writeHead(404); response.end('Missing image'); return true; }
  if (request.url === '/advanced-frame') {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<label>Frame value<input id="frame-value"></label><button id="frame-click" onclick="this.textContent=\'clicked\'">Frame click</button><input id="frame-file" type="file">'); return true;
  }
  if (request.url === '/advanced-slow') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.write('<h1>Slow'); const timer = setInterval(() => response.write(' '),100); response.once('close',()=>clearInterval(timer)); return true; }
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': 'advanced_cookie=yes; Path=/; SameSite=Lax' });
  response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Advanced fixture</title>' +
    '<style>body{margin:10px;font:16px sans-serif}input,select,button{margin:4px}iframe{width:500px;height:75px;display:block}</style>' +
    '<button id="offscreen" style="position:fixed;top:-200px" onclick="window.offscreenClicks=(window.offscreenClicks||0)+1">Offscreen action</button>' +
    '<form id="form"><label>Name<input id="name" value="before"></label><label>Quantity<input id="qty" type="number"></label><label>Agree<input id="agree" type="checkbox" checked></label><label for="separate-agree">Separate agree</label><input id="separate-agree" type="checkbox"><select id="select"><option value="one">First</option><option value="two">Second</option></select><button id="submit" type="submit">Submit</button></form>' +
    '<input id="upload" type="file" multiple style="display:none"><button id="pick">Choose files</button><button id="no-picker">No picker</button>' +
    '<div id="shadow"></div><iframe id="same-frame" src="/advanced-frame"></iframe><iframe id="remote-frame" src="' + base.replace('127.0.0.1','localhost') + '/advanced-frame"></iframe>' +
    '<article id="content"><h2>Report</h2><p>Hello <strong>world</strong>, <a href="/next">next page</a>.</p><ul><li>First</li><li>Second</li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table><p id="unicode">🙂你好世界</p></article>' +
    '<img id="asset" src="/advanced-image.svg" alt="Protected asset"><img src="/advanced-missing.svg" alt="Missing asset">' +
    '<form id="web-form" tool-name="save_profile" tool-description="Save fixture profile"><input name="display" required><input name="enabled" type="checkbox"><select name="mode"><option value="a">A</option><option value="b">B</option></select><button>Save</button></form>' +
    '<script>window.formEvents=[];window.keyEvents=[];document.addEventListener("keydown",e=>keyEvents.push({key:e.key,code:e.code,target:e.target.id}),true);document.querySelector("#form").oninput=e=>formEvents.push(e.target.id);document.querySelector("#form").onsubmit=e=>{e.preventDefault();window.submitted=true};document.querySelector("#pick").onclick=()=>document.querySelector("#upload").click();document.querySelector("#shadow").attachShadow({mode:"open"}).innerHTML=\'<label for="local">Shadow label</label><input id="local">\';document.querySelector("#web-form").onsubmit=e=>{e.preventDefault();window.saved={display:e.target.display.value,enabled:e.target.enabled.checked,mode:e.target.mode.value}};Object.defineProperty(navigator,"modelContext",{configurable:true,value:{tools:[{name:"sum",execute:input=>input.a+input.b,inputSchema:{type:"object"}}]}});</script>');
  return true;
}

interface Context {
  call(kind: string, fields?: BrowserObject): Promise<BrowserObject>;
  base(): string;
  directory: string;
  clipboard?: boolean;
  nativeDownloads?: boolean;
}
export function registerAdvancedBrowserTests(h: Harness, context: Context): void {
  const call = async (kind: string, fields: BrowserObject = {}): Promise<BrowserObject> => {
    const result = await context.call(kind, fields);
    if (result.isError === true) throw new Error(JSON.stringify(result.error));
    return object(result.structuredContent);
  };
  const value = async (kind: string, fields: BrowserObject = {}): Promise<unknown> => (await call(kind, fields)).value;
  const evaluate = (expression: string): Promise<unknown> => value('eval', { expression });
  const rejects = async (kind: string, fields: BrowserObject): Promise<void> => {
    let failed = false; try { await call(kind,fields); } catch { failed=true; }
    assert(failed, kind + ' must reject this request');
  };

  h.test('advanced: typed form controls preserve boolean, number, option and input events', async () => {
    await call('new_tab',{url:context.base()+'/advanced'});
    await call('form_input',{fields:[{selector:'#name',value:'Agent name',clear:true},{selector:'#qty',value:42},{selector:'#agree',value:false},{selector:'#select',value:{label:'Second'}}]});
    assertEqual(await evaluate('JSON.stringify([document.querySelector("#name").value,document.querySelector("#qty").value,document.querySelector("#agree").checked,document.querySelector("#select").value,!!window.submitted])'),JSON.stringify(['Agent name','42',false,'two',false]),'actual form values; no implied submission');
    assert(String(await evaluate('JSON.stringify(formEvents)')).includes('name'),'real input events fired');
    await call('form_input',{fields:[{selector:'#name',value:'Submitted name',clear:true}],submit:{selector:'#submit'}});
    assertEqual(await evaluate('window.submitted'),true,'explicit form submission');
    await rejects('form_input',{fields:[{selector:'#missing',value:'fail'}]});
    const changed=object(await value('set_checked',{text:'Separate agree',checked:true}));
    assertEqual(changed.changed,true,'separate label resolves to its checkbox and reports a change');
    const unchanged=object(await value('set_checked',{text:'Separate agree',checked:true}));
    assertEqual(unchanged.changed,false,'idempotent checkbox update reports no change');
    const selected=object(await value('select_option',{selector:'#select',value:'Second'}));
    assertEqual(JSON.stringify(selected.selected),JSON.stringify(['two']),'select_option returns stable selected values');
    assertEqual(JSON.stringify(selected.labels),JSON.stringify(['Second']),'select_option returns visible labels');
    const missing=await context.call('select_option',{selector:'#select',value:'Absent'});
    assert(missing.isError===true&&String(object(missing.error).message).includes('First')&&String(object(missing.error).message).includes('Second'),'missing option reports the available choices');
    await evaluate('window.keyEvents=[]');
    await rejects('click',{selector:'#offscreen',timeoutMs:100});
    assertEqual(await evaluate('JSON.stringify({events:window.keyEvents,clicks:window.offscreenClicks??null})'),JSON.stringify({events:[],clicks:null}),'unreachable pointer action never activates a control through the keyboard');
  });

  h.test('advanced: semantic locators reach shadow, same-origin and owned cross-process frames', async () => {
    await call('type',{locator:{label:'Shadow label'},text:'shadow text'});
    assertEqual(await evaluate('document.querySelector("#shadow").shadowRoot.querySelector("input").value'),'shadow text','shadow input value');
    await call('type',{selector:'#same-frame >>> #frame-value',text:'same frame'});
    assertEqual(await evaluate('document.querySelector("#same-frame").contentDocument.querySelector("input").value'),'same frame','same-origin input value');
    const snapshot=object(await value('snapshot')); const targets=snapshot.frameTargets;
    assert(Array.isArray(targets)&&typeof targets[0]==='string','cross-process iframe reported');
    const frameTargetId=targets[0];
    await call('type',{frameTargetId,locator:{label:'Frame value'},text:'remote frame'});
    assertEqual(await value('eval',{frameTargetId,expression:'document.querySelector("#frame-value").value'}),'remote frame','OOPIF input value');
    await call('click',{frameTargetId,selector:'#frame-click'});
    assertEqual(await value('eval',{frameTargetId,expression:'document.querySelector("#frame-click").textContent'}),'clicked','OOPIF real pointer click');
    const matches=object(await value('locator',{role:'button',name:'Choose files'}));
    assertEqual(matches.count,1,'semantic locator narrows to one button');
  });

  h.test('advanced: hidden file inputs and chooser controls attach actual files and clean interception', async () => {
    const first=join(context.directory,'upload-a.txt'),second=join(context.directory,'upload-b.txt');
    writeFileSync(first,'alpha');writeFileSync(second,'beta');
    const result=object(await value('file_upload',{selector:'#upload',files:[first,second]}));
    assertEqual((result.files as unknown[]).length,2,'two uploaded files');
    assertEqual(await evaluate('Array.from(document.querySelector("#upload").files).map(f=>f.name+":"+f.size).join(",")'),'upload-a.txt:5,upload-b.txt:4','actual FileList names and lengths');
    const chooser=object(await value('file_upload',{selector:'#pick',files:[second]}));
    assertEqual(chooser.via,'file-chooser','button opened the real chooser interception');
    assertEqual(await evaluate('document.querySelector("#upload").files[0].name'),'upload-b.txt','chooser attached file');
    await rejects('file_upload',{selector:'#no-picker',files:[first],timeoutMs:100});
    await rejects('file_upload',{selector:'#upload',files:[context.directory]});
    await call('file_upload',{selector:'#pick',files:[first]});
    assertEqual(await evaluate('document.querySelector("#upload").files[0].name'),'upload-a.txt','failed chooser did not retain interception');
  });

  h.test('advanced: batch retains completed side effects and stops before later operations', async () => {
    const failed=await context.call('batch',{operations:[{type:'type',selector:'#name',text:'batch value',clear:true},{type:'click',selector:'#missing'},{type:'type',selector:'#name',text:'must not run',clear:true}]});
    assertEqual(failed.isError,true,'a stopped batch is an MCP failure');
    const response=object(failed.structuredContent),result=object(response.value);
    assertEqual(response.partial,true,'completed side effects remain a typed partial result');
    assertEqual(object(response.error).code,'host_error','typed failure crosses the engine boundary');
    assertEqual(result.completed,1,'one completed batch operation');assertEqual(object(result.stopped).step,2,'failed step reported');
    assertEqual(await evaluate('document.querySelector("#name").value'),'batch value','completed side effect retained');
    await rejects('batch',{operations:[{type:'batch',steps:[]}]});
  });

  h.test('advanced: current engine aliases perform actions instead of returning a match list', async () => {
    await call('locator',{selector:'#name',action:'fill',value:'Facade fill'});
    assertEqual(await evaluate('document.querySelector("#name").value'),'Facade fill','locator.fill replaces the live value');
    await call('form_input',{selector:'#agree',value:true});
    assertEqual(await evaluate('document.querySelector("#agree").checked'),true,'single-field engine form_input');
    const batch=object(await value('batch',{actions:[{type:'locator',selector:'#name',action:'fill',value:'Batched facade'}]}));
    assertEqual(batch.completed,1,'engine batch.actions');assertEqual(await evaluate('document.querySelector("#name").value'),'Batched facade','batched action performs its mutation');
    const pages=object(await value('tabs_content',{urls:[context.base()+'/advanced-frame'],timeoutMs:0}));
    assertEqual(pages.temporaryTabsClosed,true,'URL spelling closes its temporary page with zero additional wait');
  });

  h.test('advanced: console filters and response bodies describe observed page events', async () => {
    await call('console',{action:'clear'});
    await evaluate('console.warn("Fixture warning");console.error("Fixture error");console.log("Fixture chatter")');
    const logs=await call('console',{levels:['warning','error'],limit:2});
    const entries=(logs.entries as BrowserObject[]).map(object);assertEqual(entries.length,2,'console level filter applied before limit');
    assert(entries.every(entry=>['warn','warning','error'].includes(String(entry.level))),'chatter excluded');
    assert(entries.every(entry=>Number.isSafeInteger(entry.timestampMs)&&Number(entry.timestampMs)>=0),'fractional CDP timestamps fit the typed response');
    await evaluate('(async()=>{await fetch("/advanced-data").then(r=>r.text());await new Promise(r=>setTimeout(r,100));return true})()');
    const network=await call('network',{urlFilter:'/advanced-data',includeBodies:true});
    const requests=(network.requests as BrowserObject[]).map(object);assert(requests.length>0,'matching network request observed');
    assert(requests.every(row=>String(row.url).includes('/advanced-data')),'URL filter applied');
    assert(requests.some(row=>String(row.body).includes('observed response')),'actual response body survives operation boundary');
    assert(requests.every(row=>typeof row.requestId==='string'&&Number.isSafeInteger(row.startedAtMs)),'request identity and timing reach the typed response');
    assert(requests.some(row=>row.resourceType==='Fetch'&&Number.isSafeInteger(row.endedAtMs)&&object(row.responseHeaders)['Content-Type']==='application/json'),'network lifecycle retains resource type, completion and response headers');
  });

  h.test('advanced: content export preserves Markdown structure and Unicode caps, and produces PDF/MHTML', async () => {
    const markdownResponse=await call('content_export',{format:'markdown',scope:'#content'});const markdown=object(markdownResponse.value);
    assert(String(markdown.content).includes('## Report')&&String(markdown.content).includes('**world**')&&String(markdown.content).includes('| A | B |'),'structural Markdown output');
    assertEqual(markdownResponse.text,markdown.content,'text export is promoted to the typed browser response');
    const capped=object(await value('content_export',{format:'text',scope:'#unicode',maxChars:2}));
    assertEqual(capped.content,'🙂你','Unicode code-point budget');assertEqual(capped.truncated,true,'truncation reported');
    await rejects('content_export',{format:'html',scope:'#missing'});
    const pdf=object(await value('content_export',{format:'pdf'}));
    assert(Buffer.from(String(pdf.dataUrl).split(',')[1]||'','base64').subarray(0,4).equals(Buffer.from('%PDF')),'real PDF bytes');
    const mhtml=object(await value('content_export',{format:'mhtml'}));assert(String(mhtml.data).includes('MIME-Version'),'real page archive');
  });

  h.test('advanced: asset bundles use page cookies and retain individual fetch failures', async () => {
    const inventory=object(await value('page_assets'));const assets=(inventory.assets as BrowserObject[]).map(object);
    const chosen=assets.filter(asset=>String(asset.url).includes('/advanced-image.svg')||String(asset.url).includes('/advanced-missing.svg'));
    assertEqual(chosen.length,2,'both successful and missing asset inventoried');
    const bundle=object(await value('page_assets',{action:'bundle',assetIds:chosen.map(asset=>asset.id!)}));
    assertEqual(object(bundle.summary).downloadedCount,1,'logged-in image saved');assertEqual(object(bundle.summary).failedCount,1,'missing asset reported');
    const saved=object((bundle.assets as BrowserObject[])[0]);assert(readFileSync(String(saved.path),'utf8').includes('<svg'),'saved original image bytes');
    const manifest=object(JSON.parse(readFileSync(String(bundle.manifestPath),'utf8')));assertEqual((manifest.failures as unknown[]).length,1,'failure persisted in manifest');
  });

  h.test('advanced: page-declared tools run through their real form and readable script registry', async () => {
    const found=object(await value('webmcp'));assertEqual(found.available,true,'page tools discovered');
    await call('webmcp',{name:'save_profile',input:{display:'Agent profile',enabled:true,mode:'b'}});
    assertEqual(await evaluate('JSON.stringify(saved)'),JSON.stringify({display:'Agent profile',enabled:true,mode:'b'}),'form tool submitted typed fields');
    const sum=object(await value('webmcp',{name:'sum',input:{a:2,b:3}}));assertEqual(sum.value,5,'page script result');
    await rejects('webmcp',{name:'missing'});
    await evaluate('Object.defineProperty(navigator,"modelContext",{configurable:true,value:{registerTool(){}}})');
    const opaque=object(await value('webmcp'));assertEqual(opaque.opaque,true,'opaque native registry distinguished from empty');
  });

  h.test('advanced: temporary URL reads preserve selection and close failed pages', async () => {
    const before=await value('tabs');
    const result=object(await value('read_urls',{urls:[context.base()+'/advanced-frame',context.base()+'/advanced-slow'],maxChars:50,timeoutMs:500}));
    const pages=(result.pages as BrowserObject[]).map(object);
    assertEqual(pages[0]?.ok,true,'first URL read');assertEqual(pages[1]?.ok,true,'slow URL returns partial content');
    assertEqual(pages[1]?.timedOut,true,'slow URL reports that navigation timed out');
    assertEqual(result.selectedTabUnchanged,true,'logical selected page unchanged');assertEqual(result.temporaryTabsClosed,true,'temporary pages closed');
    assertEqual(JSON.stringify(await value('tabs')),JSON.stringify(before),'owned tabs unchanged');
    assertEqual(await evaluate('document.title'),'Advanced fixture','original page remains active');
  });

  h.test('advanced: viewport override resets to the original native size', async () => {
    const before=String(await evaluate('innerWidth+":"+innerHeight'));
    await call('resize',{viewport:{width:640,height:480}});
    assertEqual(await evaluate('innerWidth+":"+innerHeight'),'640:480','requested layout viewport applied');
    await call('resize',{viewport:null});
    assertEqual(await evaluate('innerWidth+":"+innerHeight'),before,'native viewport restored');
    await call('resize',{action:'reset'});
    assertEqual(await evaluate('innerWidth+":"+innerHeight'),before,'repeated reset is stable');
  });

  if(context.clipboard)h.test('advanced: clipboard editing commands carry text and rich data and restore page focus',async()=>{
    await evaluate('document.querySelector("#name").focus()');
    await call('clipboard',{action:'write_text',text:'Clipboard 🙂 text'});
    const plain=await call('clipboard',{action:'read_text'});assertEqual(object(plain.value).text,'Clipboard 🙂 text','plain text clipboard round trip');
    assertEqual(plain.text,'Clipboard 🙂 text','clipboard read is promoted to the typed browser response');
    await call('clipboard',{action:'write',items:[{mimeType:'text/html',text:'<b>Rich clipboard</b>'}]});
    const read=object(await value('clipboard',{action:'read_items'}));assert((read.entries as BrowserObject[]).some(entry=>entry.mimeType==='text/html'&&String(entry.text).includes('Rich clipboard')),'rich clipboard round trip');
    assertEqual(await evaluate('document.activeElement.id'),'name','original page focus restored');
    assertEqual(await evaluate('document.querySelectorAll("[id^=__klausClipboard_]").length'),0,'scratch elements removed');
  });
  registerInputTests(h,context);
  registerDownloadTests(h,context);
  registerReadingTests(h,context);
  registerLocatorTests(h,context);
  registerFileUploadTests(h,context);
}
