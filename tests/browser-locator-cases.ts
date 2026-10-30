import type { IncomingMessage, ServerResponse } from 'node:http';
import { object, type BrowserObject } from '../main/browser/types';
import { assert, assertEqual, Harness } from './harness';

export function serveLocatorFixture(request: IncomingMessage, response: ServerResponse, base: string): boolean {
  if (!request.url?.startsWith('/advanced-locator')) return false;
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  const remote = base.replace('127.0.0.1', 'localhost');
  if (request.url === '/advanced-locator-frame') {
    response.end('<style>body{margin:8px}button{width:170px;height:40px}</style><button id="frame-action" onclick="this.dataset.clicked=\'yes\'"></button><script>document.querySelector("button").textContent=window.name;if(location.hostname==="localhost")document.querySelector("button").dataset.remote="yes";</script>'); return true;
  }
  if (request.url === '/advanced-locator-nest') { response.end('<style>body{margin:4px}iframe{width:230px;height:80px}</style><iframe name="Nested remote" src="'+remote+'/advanced-locator-frame"></iframe>'); return true; }
  response.end('<!doctype html><title>Locator fixture</title><style>body{margin:12px;font:16px sans-serif}button{margin:3px}iframe{display:block;width:260px;height:85px;margin:8px;border:4px solid black}#nested-frame{height:110px}#crop-button{width:120px;height:40px;background:blue;color:white}#bulk button{height:20px;margin:1px}</style>' +
    '<div id="actions"><button id="save-all">SAVE all items</button><button id="save-now">Save now</button><a href="#link" id="save-link">Save link</a><button id="crop-button" onclick="this.dataset.clicked=\'yes\'">Crop action</button></div>' +
    '<label for="email">Work Email</label><input id="email" aria-label="Email Address"><div class="nested"><p class="nested"><span id="prose">Order   complete</span></p></div>' +
    '<button id="disabled" disabled>Disabled choice</button><button id="hidden" hidden>Hidden choice</button>' +
    '<section class="row"><span>Paid customer</span><span class="badge">paid</span><button>Edit</button></section><section class="row"><span>Trial customer</span><button>Edit</button></section>' +
    '<p id="raw" data-proof="literal value">shown\n<span hidden>HIDDEN</span>  '+('x'.repeat(2400))+'</p><p id="empty"></p><p id="huge">'+('z'.repeat(21000))+'</p>' +
    '<button id="duplicate" onclick="this.dataset.clicked=\'yes\'">Outer duplicate</button><div id="shadow"></div><p id="plain">Plain prose for a coordinate probe</p>' +
    '<iframe id="same" name="Same origin" src="/advanced-locator-frame"></iframe><iframe id="remote-one" name="First remote" src="'+remote+'/advanced-locator-frame"></iframe><iframe id="remote-two" name="Second remote" src="'+remote+'/advanced-locator-frame"></iframe><iframe id="nested-frame" src="/advanced-locator-nest"></iframe>' +
    '<div id="bulk">'+Array.from({length:240},(_,index)=>'<button>Bulk '+index+'</button>').join('')+'</div>' +
    '<script>document.querySelector("#shadow").attachShadow({mode:"open"}).innerHTML="<button id=duplicate onclick=this.dataset.clicked=\'yes\'>Shadow duplicate</button>";</script>'); return true;
}

interface Context { call(kind: string, fields?: BrowserObject): Promise<BrowserObject>; base(): string }
export function registerLocatorTests(h: Harness, context: Context): void {
  const call = async (kind: string, fields: BrowserObject = {}): Promise<BrowserObject> => { const result = await context.call(kind, fields); assert(result.isError !== true, JSON.stringify(result.error)); return object(result.structuredContent); };
  const value = async (kind: string, fields: BrowserObject = {}): Promise<BrowserObject> => object((await call(kind, fields)).value);
  const evaluate = async (expression: string, fields: BrowserObject = {}): Promise<unknown> => (await call('eval', { ...fields, expression })).value;
  const list = async (fields: BrowserObject = {}): Promise<BrowserObject> => value('locator', { timeoutMs: 0, ...fields });
  const rows = (result: BrowserObject): BrowserObject[] => (result.elements as BrowserObject[]) ?? [];
  const rejects = async (kind: string, fields: BrowserObject): Promise<void> => { let failed = false; try { await call(kind, fields); } catch { failed = true; } assert(failed, kind+' must reject this request'); };
  const point = async (expression: string): Promise<BrowserObject> => object(await evaluate(`(()=>{const e=${expression};e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`));

  h.test('locator: normalized semantic matching keeps the innermost prose and respects explicit CSS', async () => {
    await call('new_tab', { url: context.base()+'/advanced-locator-page' });
    const partial = await list({ within:'#actions', role:'BUTTON', text:'save' }); assertEqual(partial.count,2,'case-insensitive partial names');
    assertEqual((await list({ within:'#actions', role:'button', text:'save ALL items', exact:true })).count,1,'exact normalized accessible name');
    const prose = await value('find', { query:'order complete', timeoutMs:0 }); assertEqual(prose.count,1,'nested prose collapsed'); assertEqual(rows(prose)[0]?.tag,'span','innermost text carrier');
    assertEqual((await list({ selector:'.nested' })).total,2,'explicit CSS preserves nested matches');
    assertEqual(rows(await list({ role:'textbox', text:'email address' }))[0]?.tag,'input','text finds a control accessible name');
    const label = rows(await list({ label:'work email' })); assertEqual(label.length,1,'label names one control'); assertEqual(label[0]?.tag,'input','label element excluded');
    assertEqual((await list({label:'email address'})).count,1,'explicit aria-label is also a control label');
  });

  h.test('locator: result budgets and element states report the actual set without silent defaults', async () => {
    const limited = await list({ selector:'#bulk button', limit:17 }); assertEqual(limited.count,17,'requested rows'); assertEqual(limited.total,240,'all matched rows counted'); assertEqual(limited.truncated,true,'truncation declared');
    assertEqual(rows(await list({ selector:'#bulk button', nth:-1, limit:1 }))[0]?.name,'Bulk 239','negative nth applied before output limit');
    assertEqual(rows(await list({locator:{within:'#bulk',role:'button',nth:5},limit:1}))[0]?.name,'Bulk 5','nth applies once across the scoped result set');
    assertEqual((await list({ selector:'#disabled' })).count,0,'default excludes disabled control');
    assertEqual((await list({ selector:'#disabled', state:'visible' })).count,1,'visible includes disabled');
    assertEqual((await list({ selector:'#hidden', state:'hidden' })).count,1,'hidden matches hidden');
    assertEqual((await list({ selector:'#hidden,#disabled', state:'attached' })).count,2,'attached includes both');
    assertEqual((await list({ selector:'#disabled', action:'is_enabled' })).enabled,false,'disabled presence is not confused with absence');
    assertEqual((await list({ selector:'#hidden', action:'is_visible' })).visible,false,'hidden presence is readable');
    const invalid: BrowserObject[] = [{state:'typo'},{limit:0},{timeoutMs:-1},{any:[]},{selector:''},{selector:'['}];
    for (const fields of invalid) await rejects('locator',{timeoutMs:0,...fields});
  });

  h.test('locator: opaque within refs, exclusion and ordered alternatives preserve element identity', async () => {
    const trial = rows(await list({ selector:'.row', hasNot:'.badge', hasNotText:'Paid' })); assertEqual(trial.length,1,'exclusion selects the trial row');
    const edit = rows(await list({ within:trial[0]!.ref!, role:'button', text:'edit' })); assertEqual(edit.length,1,'opaque ref scopes a descendant');
    await call('click',{ref:edit[0]!.ref!});
    const union = await list({ within:'#actions', any:[{selector:'#save-link'},{selector:'#save-all'},{selector:'#save-link'}] });
    assertEqual(rows(union)[0]?.tag,'a','caller preference order'); assertEqual(union.count,2,'overlapping alternatives deduplicated by node identity'); assertEqual(union.total,3,'alternative total counts before deduplication');
    const hidden = await list({ state:'hidden', or:[{selector:'#hidden'},{selector:'#save-all'}] }); assertEqual(hidden.count,1,'shared state applies to every alternative');
    await rejects('click',{any:[{selector:'#save-link'},{selector:'#save-all'}],strict:true,timeoutMs:0});
    await rejects('click',{locator:{within:'#actions',role:'button',strict:true},timeoutMs:0});
    assertEqual((await list({ within:'e-stale-owner', role:'button' })).count,0,'stale owner cannot widen into document search');
  });

  h.test('locator: raw text and attributes retain hidden content, whitespace, empty values and truncation', async () => {
    const expected = await evaluate('document.querySelector("#raw").textContent');
    assertEqual((await list({ selector:'#raw', action:'text_content' })).text,expected,'raw text is neither preview nor rendered innerText');
    assertEqual((await list({ selector:'#empty', state:'attached', action:'text_content' })).text,'','empty text stays empty');
    const huge = await list({ selector:'#huge', action:'all_text_contents' }); assertEqual(String(huge.text).length,20000,'raw text budget'); assertEqual(huge.textContentTruncated,true,'raw truncation marker');
    assertEqual((await list({ selector:'#raw', action:'get_attribute', name:'data-proof' })).attribute,'literal value','attribute name alias is not a semantic name filter');
    assertEqual(rows(await list({selector:'#raw',attribute:'absent'}))[0]?.attribute,null,'missing attribute stays null');
  });

  h.test('locator: bounded retries and text-only input actions operate on the real page', async () => {
    await evaluate('setTimeout(()=>{const e=document.createElement("button");e.id="late";e.textContent="Arrived later";e.onclick=()=>e.dataset.clicked="yes";document.body.append(e)},80);true');
    const late = await list({ text:'arrived later', timeoutMs:2000 }); assertEqual(late.count,1,'arrival observed within timeout');
    await call('click',{text:'arrived later',strict:true,timeoutMs:60000}); assertEqual(await evaluate('document.querySelector("#late").dataset.clicked'),'yes','text-only click accepts the operation timeout budget');
    await call('type',{selector:'#email',text:'this is payload',clear:true}); assertEqual(await evaluate('document.querySelector("#email").value'),'this is payload','typing text is not used to match the empty input');
    const image = await value('screenshot',{text:'Crop action',format:'png'}); const bytes=Buffer.from(String(image.dataUrl).split(',')[1]!,'base64'); assertEqual(bytes.readUInt32BE(16)/bytes.readUInt32BE(20),3,'text-only screenshot crops the requested element');
  });

  h.test('locator: pointer actions wait for temporary obstruction, enabled state and node replacement', async () => {
    await evaluate(`(()=>{const box=document.createElement('div');box.id='actionability';box.innerHTML='<button id="covered-action">Covered action</button><button id="replace-action">Replacement action</button><button id="disabled-action" disabled>Enable action</button>';document.body.prepend(box);for(const e of box.querySelectorAll('button'))e.onclick=()=>e.dataset.clicked='yes';const cover=document.createElement('div');cover.id='temporary-cover';cover.style.cssText='position:fixed;inset:0;background:white;z-index:9999';document.body.append(cover);setTimeout(()=>cover.remove(),180);return true})()`);
    await call('click',{selector:'#covered-action',timeoutMs:2000});
    assertEqual(await evaluate('document.querySelector("#covered-action").dataset.clicked'),'yes','temporary cover clears before pointer dispatch');
    await evaluate(`(()=>{const old=document.querySelector('#replace-action');old.style.visibility='hidden';setTimeout(()=>{const next=old.cloneNode(true);next.style.visibility='visible';next.onclick=()=>next.dataset.clicked='replacement';old.replaceWith(next)},100);setTimeout(()=>document.querySelector('#disabled-action').disabled=false,100);return true})()`);
    await call('click',{selector:'#replace-action',timeoutMs:2000});
    assertEqual(await evaluate('document.querySelector("#replace-action").dataset.clicked'),'replacement','original locator resolves the replacement node');
    await call('click',{selector:'#disabled-action',timeoutMs:2000});
    assertEqual(await evaluate('document.querySelector("#disabled-action").dataset.clicked'),'yes','newly enabled control receives real input');
    await evaluate('document.querySelector("#actionability").remove();true');
  });

  h.test('locator: strict ambiguity and persistent actionability failures retain actionable diagnostics', async () => {
    const ambiguous=await context.call('click',{selector:'#actions button',timeoutMs:0});
    assertEqual(object(ambiguous.error).code,'ambiguous_locator','pointer actions are strict by default');
    assert(String(object(ambiguous.error).message).includes('Matches:')&&String(object(ambiguous.error).message).includes('Save now'),'ambiguity identifies actual matching elements');
    await evaluate(`(()=>{const box=document.createElement('div');box.id='visible-fallback';box.innerHTML='<button hidden>Unique visible action</button><button>Unique visible action</button>';box.lastChild.onclick=()=>window.visibleFallbackClicked=true;document.body.prepend(box);return true})()`);
    await call('click',{text:'Unique visible action',timeoutMs:2000});
    assertEqual(await evaluate('window.visibleFallbackClicked'),true,'one visible match is selected among hidden duplicates');
    await rejects('click',{text:'Unique visible action',strict:true,timeoutMs:0});
    await evaluate('document.querySelector("#visible-fallback").remove();true');
    await evaluate(`(()=>{const e=document.createElement('button');e.id='blocked-action';e.textContent='Blocked action';e.style.cssText='position:fixed;left:30px;top:30px';e.onclick=()=>window.blockedClicked=true;document.body.append(e);const cover=document.createElement('div');cover.id='persistent-cover';cover.style.cssText='position:fixed;inset:0;background:white;z-index:9999';document.body.append(cover);return true})()`);
    try {
      const covered=await context.call('click',{selector:'#blocked-action',timeoutMs:2000});
      assertEqual(object(covered.error).code,'timeout','persistent cover reaches a bounded timeout');
      assert(String(object(covered.error).message).includes('intercept'),'interception cause survives timeout');
      assertEqual(await evaluate('window.blockedClicked??false'),false,'covered click never reports or performs success');
    } finally {
      await evaluate('document.querySelector("#persistent-cover")?.remove();document.querySelector("#blocked-action")?.remove();true');
    }
    await rejects('click',{selector:'#disabled',timeoutMs:100});
    await evaluate(`(()=>{const e=document.createElement('button');e.id='vanishing-action';e.style.visibility='hidden';document.body.append(e);setTimeout(()=>e.remove(),30);return true})()`);
    await rejects('click',{selector:'#vanishing-action',timeoutMs:150});
  });

  h.test('locator: OOPIF fallback obeys frames false and preserves alternative preference across documents', async () => {
    assertEqual((await list({selector:'[data-remote]',frames:false})).count,0,'cross-process fallback disabled');
    const remote = rows(await list({role:'button',text:'Second remote',timeoutMs:2000}))[0]; assert(typeof remote?.frameTargetId==='string','owned child identity returned');
    assertEqual(await evaluate('window.name',{frameTargetId:remote.frameTargetId}),'Second remote','locator ref belongs to the named child');
    const union = rows(await list({any:[{role:'button',text:'Second remote'},{selector:'#save-now'}]})); assertEqual(union[0]?.name,'Second remote','first alternative remains first across processes'); assertEqual(union[1]?.name,'Save now','local fallback remains next');
    const top = rows(await list({role:'button',limit:1000})); assert(!top.some(row=>typeof row.frameTargetId==='string'),'local matches do not implicitly append other process documents');
  });

  h.test('locator: moving targets settle before dispatch and parent overlays block frame input', async () => {
    await evaluate(`(()=>{const e=document.createElement('button');e.id='moving-action';e.textContent='Moving action';e.style.cssText='position:fixed;left:10px;top:50px';e.onclick=()=>{window.movingAtClick={left:e.getBoundingClientRect().left,moving:window.isMoving}};document.body.append(e);window.isMoving=true;let n=0;function move(){if(n++<7){e.style.left=(10+n*8)+'px';requestAnimationFrame(move)}else window.isMoving=false}requestAnimationFrame(move);return true})()`);
    await call('click',{selector:'#moving-action',timeoutMs:2000});
    assertEqual(object(await evaluate('window.movingAtClick')).moving,false,'pointer action waits for consecutive stable animation frames');
    await evaluate('document.querySelector("#moving-action").remove();true');
    const remote=rows(await list({role:'button',text:'Second remote',timeoutMs:2000}))[0]!;
    const frameTargetId=remote.frameTargetId;assert(typeof frameTargetId==='string','remote action has a frame identity');
    await evaluate(`(()=>{document.querySelector('#remote-two').scrollIntoView({block:'center'});const e=document.createElement('div');e.id='frame-cover';e.style.cssText='position:fixed;inset:0;background:white;z-index:9999';document.body.append(e);return true})()`);
    try {
      const blocked=await context.call('click',{frameTargetId,selector:'#frame-action',timeoutMs:150});
      assertEqual(object(blocked.error).code,'timeout','parent overlay blocks child frame input');
    } finally { await evaluate('document.querySelector("#frame-cover").remove();true'); }
    await call('click',{frameTargetId,selector:'#frame-action',timeoutMs:2000});
    assertEqual(await evaluate('document.querySelector("button").dataset.clicked',{frameTargetId}),'yes','child becomes actionable when its owner is unobstructed');
  });

  h.test('probe: point stacks reach shadow and same-origin nodes with verified selectors', async () => {
    const shadow = await value('element_info',await point('document.querySelector("#shadow").shadowRoot.querySelector("button")'));
    const button = rows(shadow)[0]; assertEqual(button?.name,'Shadow duplicate','shadow content comes before host');
    assert(String(object(button?.selector).primary).includes('>>>'),'shadow selector carries owner path');
    await call('click',{ref:button!.ref!}); assertEqual(await evaluate('document.querySelector("#shadow").shadowRoot.querySelector("button").dataset.clicked'),'yes','probe ref acts on shadow node'); assertEqual(await evaluate('document.querySelector("#duplicate").dataset.clicked||null'),null,'duplicate top id was not clicked');
    await point('document.querySelector("#same")');
    const samePoint=object(await evaluate('(()=>{const f=document.querySelector("#same"),r=f.getBoundingClientRect(),b=f.contentDocument.querySelector("button").getBoundingClientRect();return {x:r.x+f.clientLeft+b.x+b.width/2,y:r.y+f.clientTop+b.y+b.height/2}})()'));
    const same=rows(await value('element_info',samePoint))[0]; assertEqual(same?.name,'Same origin','same-origin child probed'); assert(String(object(same?.selector).primary).includes('>>>'),'frame selector keeps its scope');
    await call('click',{selector:object(same?.selector).primary!}); assertEqual(await evaluate('document.querySelector("#same").contentDocument.querySelector("button").dataset.clicked'),'yes','verified selector resolves to the probed child');
    const plain=await value('element_info',{...await point('document.querySelector("#plain")'),includeNonInteractable:true}); assert(rows(plain).some(row=>row.tag==='p'),'noninteractive prose can be requested');
    assertEqual(object((await value('element_info',{x:-1,y:-1})).outsideViewport).width!==undefined,true,'outside viewport is reported');
  });

  h.test('probe: identical-URL OOPIFs and nested frame owners never borrow a neighboring page', async () => {
    for (const [id,wanted] of [['remote-two','Second remote'],['remote-one','First remote']]) {
      await point(`document.getElementById(${JSON.stringify(id)})`);
      const at=object(await evaluate(`(()=>{const f=document.getElementById(${JSON.stringify(id)}),r=f.getBoundingClientRect();return {x:r.x+f.clientLeft+30,y:r.y+f.clientTop+25}})()`));
      const result=await value('element_info',at); const row=rows(result)[0]; assertEqual(row?.name,wanted,'actual frame owner identity'); assert(typeof row?.frameTargetId==='string','probe tags its child target');
      await call('click',{ref:row.ref!,frameTargetId:row.frameTargetId}); assertEqual(await evaluate('document.querySelector("button").dataset.clicked',{frameTargetId:row.frameTargetId}),'yes','probe ref clicks that child');
    }
    await point('document.querySelector("#nested-frame")');
    const at=object(await evaluate('(()=>{const f=document.querySelector("#nested-frame"),r=f.getBoundingClientRect(),n=f.contentDocument.querySelector("iframe"),b=n.getBoundingClientRect();return {x:r.x+f.clientLeft+b.x+n.clientLeft+30,y:r.y+f.clientTop+b.y+n.clientTop+25}})()'));
    assertEqual(rows(await value('element_info',at))[0]?.name,'Nested remote','OOPIF nested inside same-origin frame retains its real owner');
  });
}
