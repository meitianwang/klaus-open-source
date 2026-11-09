import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  if (request.url.startsWith('/advanced-same-site')) {
    // Parent page for the same-site cross-origin frame case: the child origin
    // is a second loopback port, which shares the site but not the origin, so
    // the frame renders inside the page's own process.
    const childPort = new URL(request.url, 'http://fixture.invalid').searchParams.get('child') ?? '';
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><meta charset="utf-8"><title>Same-site parent</title>' +
      '<style>body{margin:10px;font:16px sans-serif}iframe{border:0}</style>' +
      '<h1>Same-site parent</h1><label>Parent field<input id="parent-field" aria-label="Parent field"></label>' +
      `<iframe id="child-frame" src="http://127.0.0.1:${childPort}/child" style="position:absolute;left:40px;top:150px;width:420px;height:170px"></iframe>`);
    return true;
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

  h.test('advanced: ax_state and ax_action observe and drive the page on this backend', async () => {
    await call('navigate', { url: context.base() + '/advanced' });
    // The model-facing envelope and the indexed actions run through the same
    // host dispatcher on every backend, so each surface (built-in view and
    // external Chrome relay) must produce the identical contract.
    const first = await context.call('ax_state', {});
    assert(first.isError !== true, `ax_state succeeds: ${JSON.stringify(first.error)}`);
    const blocks = (first.content ?? []) as unknown as BrowserObject[];
    const text = String(object(blocks[0]).text);
    const firstStructured = object(first.structuredContent);
    const firstValue = object(firstStructured.value);
    assertEqual(object(blocks[0]).type, 'text', 'the state ships as one text block');
    assertEqual(blocks.length, 1, 'state mode attaches no capture');
    assert(text.includes('Title: Advanced fixture'), 'the title header renders');
    assert(text.includes(`URL: ${context.base()}/advanced`), 'the url header renders');
    assert(/^\s*\[\d+\]/m.test(text), `elements carry integer indices; value=${JSON.stringify(firstValue)} text=${JSON.stringify(text.slice(0, 500))}`);
    assert(/\[\d+\] button "Offscreen action" actions: Scroll to Visible/.test(text), 'the offscreen control exposes its secondary action');
    assertEqual(firstStructured.axText, undefined, 'the envelope moves axText out of structuredContent');
    assertEqual(firstValue.state, 'full', 'the first capture of a document is full state');
    assert(typeof firstValue.snapshotId === 'string' && firstValue.snapshotId !== '', 'the capture publishes a snapshot id');
    const nameRow = /\[(\d+)\] textbox "Name"/.exec(text);
    const submitRow = /\[(\d+)\] button "Submit"/.exec(text);
    assert(nameRow && submitRow, 'the labelled input and the submit button have index rows');

    const setValue = object((await call('ax_action', { action: 'set_value', elementIndex: Number(nameRow![1]), value: 'ax-aligned' })).value);
    assertEqual(setValue.ok, true, 'indexed set_value succeeds');
    assertEqual(await evaluate('document.querySelector("#name").value'), 'ax-aligned', 'set_value wrote the real input');
    const second = object((await call('ax_state', {})).value);
    assert(Number(second.changed) >= 1, 'the recapture reports the changed input value');
    assert(String(second.snapshotId) !== String(firstValue.snapshotId), 'every capture publishes a fresh snapshot id');

    const clicked = object((await call('ax_action', { action: 'click', elementIndex: Number(submitRow![1]) })).value);
    assertEqual(clicked.ok, true, 'indexed click succeeds');
    assertEqual(await evaluate('window.submitted'), true, 'the click was real backend input: the form submit handler ran');
    await evaluate('window.submitted=false');
    const stale = await context.call('ax_action', { action: 'click', elementIndex: Number(submitRow![1]), snapshotId: 'stale' });
    assertEqual(stale.isError, true, 'a foreign snapshot id is refused');
    assertEqual(object(stale.error).code, 'stale_snapshot', 'the refusal names the stale snapshot');
    assertEqual(await evaluate('window.submitted'), false, 'the refused click never reached the page');

    const both = await context.call('ax_state', { mode: 'both', save: false });
    assert(both.isError !== true, `mode both succeeds: ${JSON.stringify(both.error)}`);
    const bothBlocks = (both.content ?? []) as unknown as BrowserObject[];
    assert(bothBlocks.some(block => object(block).type === 'image' && String(object(block).data).length > 0), 'mode both attaches a real capture from this backend');
    assert(String(object(bothBlocks[0]).text).includes('Title: Advanced fixture'), 'mode both keeps the state text');

    const shot = object((await call('screenshot', { save: false })).value);
    const scale = Number(shot.scale);
    assert(Number.isFinite(scale) && scale > 0, `the screenshot reports its image scale (got ${JSON.stringify(shot.scale)})`);

    await evaluate(`(() => {
      const btn = document.createElement('button');
      btn.id = 'ax-accordion';
      btn.textContent = 'Accordion toggle';
      btn.setAttribute('aria-expanded', 'false');
      btn.addEventListener('click', (ev) => {
        window.__lastMetaClick = ev.metaKey === true;
        const next = btn.getAttribute('aria-expanded') === 'true' ? 'false' : 'true';
        btn.setAttribute('aria-expanded', next);
      });
      document.body.prepend(btn);
    })()`);
    const expandedState = await context.call('ax_state', { disableDiffing: true });
    const expandedText = String(object(((expandedState.content ?? []) as unknown as BrowserObject[])[0]).text);
    const accRow = /\[(\d+)\] button "Accordion toggle"[^\n]*collapsed actions: Expand/.exec(expandedText);
    const checkRow = /\[(\d+)\] checkbox "Agree"/.exec(expandedText);
    assert(accRow && checkRow, `accordion and checkbox rows render: ${expandedText.slice(0, 500)}`);

    const toggledCheck = object((await call('ax_action', { action: 'set_value', elementIndex: Number(checkRow![1]), value: 'false' })).value);
    assertEqual(toggledCheck.ok, true, 'checkbox set_value false succeeds');
    assertEqual(await evaluate('document.querySelector("#agree").checked'), false, 'checkbox unchecked via set_value');

    const expandedAction = object((await call('ax_action', { action: 'secondary_action', elementIndex: Number(accRow![1]), name: 'Expand' })).value);
    assertEqual(expandedAction.ok, true, 'Expand secondary_action succeeds');
    assertEqual(await evaluate('document.querySelector("#ax-accordion").getAttribute("aria-expanded")'), 'true', 'Expand clicked the control and flipped aria-expanded');

    const afterExpand = await context.call('ax_state', { disableDiffing: true });
    const afterExpandText = String(object(((afterExpand.content ?? []) as unknown as BrowserObject[])[0]).text);
    const openRow = /\[(\d+)\] button "Accordion toggle"[^\n]*expanded actions: Collapse/.exec(afterExpandText);
    assert(openRow !== null, `expanded state exposes Collapse: ${afterExpandText.slice(0, 500)}`);
    await call('ax_action', { action: 'click', elementIndex: Number(openRow![1]), key: 'super' });
    assertEqual(await evaluate('window.__lastMetaClick'), true, 'modifier-only super click dispatches with metaKey');
  });

  h.test('advanced: same-site cross-origin frames stay observable and actionable', async () => {
    // A second loopback port shares the fixture's site but not its origin, so
    // Chromium renders the frame inside the page's own process: no child target
    // is ever attached, and every observation must route through the frame id.
    const child = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      response.end('<!doctype html><meta charset="utf-8"><title>Child frame</title><body style="margin:8px;font:16px sans-serif">' +
        '<label>Child name<input id="child-name" aria-label="Child name"></label>' +
        '<button id="child-go" aria-label="Child go" onclick="this.textContent=\'clicked \'+(window.__childClicks=(window.__childClicks||0)+1)">Child go</button>' +
        '<p>Child paragraph text</p></body>');
    });
    await new Promise<void>(resolve => child.listen(0, '127.0.0.1', resolve));
    const childPort = (child.address() as AddressInfo).port;
    try {
      await call('navigate', { url: `${context.base()}/advanced-same-site?child=${childPort}` });

      const found = object(await value('locator', { role: 'textbox', name: 'Child name', timeoutMs: 10000 }));
      assertEqual(found.count, 1, 'locator finds the same-site cross-origin input');
      const element = object((found.elements as BrowserObject[])[0]);
      assert(typeof element.frameTargetId === 'string' && element.frameTargetId !== '', 'the match records its frame route');

      const snap = object(await value('snapshot', {}));
      assert(String(snap.text).includes('Child paragraph text'), 'snapshot text merges the frame document');
      const snapNodes = (snap.elements as BrowserObject[]).filter(node => node.frameTargetId === element.frameTargetId);
      assert(snapNodes.some(node => node.name === 'Child go'), 'snapshot elements carry frame-scoped controls');

      const page = object(await value('read_page', { filter: 'interactive' }));
      assert((page.elements as BrowserObject[]).some(node => node.frameTargetId === element.frameTargetId && node.name === 'Child name'), 'read_page merges frame controls');

      const state = await context.call('ax_state', { disableDiffing: true });
      assert(state.isError !== true, `ax_state succeeds: ${JSON.stringify(state.error)}`);
      const stateText = String(object(((state.content ?? []) as unknown as BrowserObject[])[0]).text);
      const childRow = /\[(\d+)\] textbox "Child name"/.exec(stateText);
      const goRow = /\[(\d+)\] button "Child go"/.exec(stateText);
      assert(childRow && goRow, `ax_state indexes the frame controls: ${stateText.slice(0, 400)}`);

      const typed = object((await call('ax_action', { action: 'type_text', elementIndex: Number(childRow![1]), text: 'ax-typed' })).value);
      assertEqual(typed.ok, true, 'indexed type_text succeeds');
      assertEqual(object(await value('locator', { action: 'input_value', selector: '#child-name' })).value, 'ax-typed', 'type_text wrote the frame input');

      const clicked = object((await call('ax_action', { action: 'click', elementIndex: Number(goRow![1]) })).value);
      assertEqual(clicked.ok, true, 'indexed click succeeds');
      const afterClick = object(await value('locator', { selector: '#child-go' }));
      assertEqual(String(object((afterClick.elements as BrowserObject[])[0]).text), 'clicked 1', 'the indexed click landed on the frame button at mapped coordinates');

      await call('click', { selector: '#child-go' });
      const afterSecond = object(await value('locator', { selector: '#child-go' }));
      assertEqual(String(object((afterSecond.elements as BrowserObject[])[0]).text), 'clicked 2', 'selector click reaches the frame button');

      await call('click', { selector: '#child-name' });
      await call('type', { text: ' and focus-typed' });
      assertEqual(object(await value('locator', { action: 'input_value', selector: '#child-name' })).value, 'ax-typed and focus-typed', 'selector-less typing follows focus into the frame');

      await call('form_input', { fields: [{ selector: '#child-name', value: 'form-filled', clear: true }] });
      assertEqual(object(await value('locator', { action: 'input_value', selector: '#child-name' })).value, 'form-filled', 'form_input fills the frame field');

      // element_info descends by coordinates: compose the top-level point from
      // the frame owner's rect and the button's frame-local box (the child
      // document is unreachable from the top world by design).
      const goBox = object((object(await value('locator', { selector: '#child-go' })).elements as BrowserObject[])[0]!);
      const frameBox = object(await evaluate(`(()=>{const r=document.querySelector('#child-frame').getBoundingClientRect();return {x:r.x,y:r.y}})()`) as BrowserObject);
      const probed = object(await value('element_info', {
        x: Number(frameBox.x) + Number(goBox.x) + Number(goBox.width) / 2,
        y: Number(frameBox.y) + Number(goBox.y) + Number(goBox.height) / 2,
      }));
      assert(String(probed.url ?? '').includes(`127.0.0.1:${childPort}`), `element_info descends into the same-site frame (url=${String(probed.url ?? '')})`);
    } finally {
      // Leave the page before closing the child server so later reloads in
      // this tab do not race a dead frame origin.
      await call('navigate', { url: context.base() + '/advanced' }).catch(() => {});
      await new Promise<void>(resolve => child.close(() => resolve()));
    }
  });
}
