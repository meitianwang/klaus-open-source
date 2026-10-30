import { app, BrowserWindow, WebContentsView } from 'electron';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NativeContentFind } from '../main/app/native-content-find';

const profile = process.env.KLAUS_CONTENT_FIND_PROFILE;
if (!profile) throw new Error('An isolated KLAUS_CONTENT_FIND_PROFILE is required.');
mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
app.on('window-all-closed', () => {});

async function main() {
  await app.whenReady();
  const preload = join(profile!, 'fixture-preload.cjs');
  writeFileSync(preload, `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('fixtureFind',{find:async(query,options)=>{const result=await ipcRenderer.invoke('fixture:find',query,options);if(result.error)throw new Error(result.error);return result},stop:()=>ipcRenderer.invoke('fixture:stop'),layout:()=>ipcRenderer.invoke('fixture:layout')});`);
  const window = new BrowserWindow({ width: 1050, height: 850, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, preload } });
  const first = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  const second = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  let target = first.webContents;
  const native = new NativeContentFind({ target: id => id === window.webContents.id ? target : null });
  const evaluate = <T = unknown>(script: string): Promise<T> => window.webContents.executeJavaScript(script, true);
  async function waitFor(expression: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate<boolean>(expression)) return;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Find fixture timed out: ${expression}`);
  }
  const query = async (value: string) => {
    await evaluate(`(()=>{const input=document.querySelector('.klaus-content-find:not([hidden])>input');input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  };
  window.webContents.ipc.handle('fixture:find', async (_event, query, options) => {
    try { return await native.find(window.webContents.id, query, options); }
    catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  });
  window.webContents.ipc.handle('fixture:stop', () => native.stop(window.webContents.id));
  window.webContents.ipc.handle('fixture:layout', async () => {
    if (window.isDestroyed()) return;
    const bounds = await evaluate<{ x: number; y: number; width: number; height: number }>('(()=>{const r=document.getElementById("browser-panel-host").getBoundingClientRect();return{x:Math.round(r.left),y:Math.round(r.top),width:Math.max(1,Math.round(r.width)),height:Math.max(1,Math.round(r.height))};})()');
    if (!first.webContents.isDestroyed()) first.setBounds(bounds);
  });
  const bundle = readFileSync(join(__dirname, '../content-find-renderer.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'"><style>body{font:14px sans-serif;margin:20px}#content{height:180px;overflow:auto}#browser-section{height:350px;display:flex;flex-direction:column}#browser-panel-host{flex:1;min-height:0;border:1px solid #888}#browser-section[hidden]{display:none}</style><div id="find-slot"></div><div id="content"><p id="source" tabindex="0">Alpha <em>beta</em> ALPHA beta.</p><p><span hidden>alpha</span><button>alpha</button><span>gamma alpha</span></p></div><section id="browser-section" hidden><div>Browser toolbar</div><div id="browser-panel-host"></div></section><script>${bundle}</script><script>window.fixtureMode=false;window.fixtureChinese=false;window.fixtureDocument=null;window.controller=KlausContentFind.createContentFind({scope:()=>document.getElementById('content'),document:()=>window.fixtureDocument,chinese:()=>window.fixtureChinese,nativeTarget:()=>window.fixtureMode,nativeFind:(q,o)=>window.fixtureFind.find(q,o),stopNativeFind:()=>window.fixtureFind.stop(),mount:()=>document.getElementById(window.fixtureMode?'browser-section':'find-slot'),onLayout:()=>window.fixtureFind.layout()});</script>`;
  try {
    await window.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html)); window.show();
    const original = await evaluate<string>('document.getElementById("content").innerHTML');
    await evaluate(`(()=>{const p=document.getElementById('source');p.focus();const range=document.createRange();range.setStart(p.firstChild,0);range.setEnd(p.firstChild,5);getSelection().removeAllRanges();getSelection().addRange(range);})()`);
    await evaluate('window.controller.open()');
    assert.equal(await evaluate('document.querySelector(".klaus-content-find>input").value'), 'Alpha');
    await waitFor('document.querySelector(".klaus-content-find-status").textContent==="1 of 3"');
    assert.equal(await evaluate('document.getElementById("content").innerHTML'), original);
    assert.equal(await evaluate('Array.from(CSS.highlights.values())[0].size'), 3);
    await evaluate('document.querySelector(".klaus-content-find>input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true}))');
    assert.equal(await evaluate('document.querySelector(".klaus-content-find-status").textContent'), '2 of 3');
    await evaluate('document.querySelector(".klaus-content-find>input").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",shiftKey:true,bubbles:true}))');
    assert.equal(await evaluate('document.querySelector(".klaus-content-find-status").textContent'), '1 of 3');
    await evaluate('document.querySelector(".klaus-content-find label input").click()');
    assert.equal(await evaluate('document.querySelector(".klaus-content-find-status").textContent'), '1 of 1');
    await evaluate('document.querySelector(".klaus-content-find label input").click()');
    await query('Alpha beta');
    await waitFor('document.querySelector(".klaus-content-find-status").textContent==="1 of 2"');
    assert.deepEqual(await evaluate('Array.from(Array.from(CSS.highlights.values())[0],range=>range.toString())'), ['Alpha beta', 'ALPHA beta']);
    await query('betagamma'); assert.equal(await evaluate('document.querySelector(".klaus-content-find-status").textContent'), 'No matches');
    await query('alpha'); await evaluate('window.controller.next()');
    await evaluate('(()=>{const p=document.createElement("p");p.id="streamed";p.textContent="alpha streaming";document.getElementById("content").append(p);})()');
    await waitFor('document.querySelector(".klaus-content-find-status").textContent==="2 of 4"');
    await evaluate('window.fixtureChinese=true;window.dispatchEvent(new CustomEvent("klaus:lang-change"))');
    assert.equal(await evaluate('document.querySelector(".klaus-content-find>input").getAttribute("aria-label")'), '查找');
    assert.equal(await evaluate('document.querySelector(".klaus-content-find-status").textContent'), '2 / 4');
    await evaluate('document.querySelector(".klaus-content-find>input").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    assert.equal(await evaluate('window.controller.isOpen()'), false);
    assert.equal(await evaluate('CSS.highlights.size'), 0);
    await evaluate('window.fixtureChinese=false;window.revealed=[];window.fixtureDocument={text:"virtual match\\n".repeat(100),reveal:(start,end)=>{window.revealed.push({start,end});document.getElementById("source").focus()}};void 0');
    await evaluate('getSelection().removeAllRanges();window.controller.open()');
    await query('virtual');
    await waitFor('document.querySelector(".klaus-content-find-status").textContent==="1 of 100"');
    await evaluate('window.controller.next()');
    assert.deepEqual(await evaluate('window.revealed.at(-1)'), { start: 14, end: 21 });
    assert.equal(await evaluate('document.activeElement===document.querySelector(".klaus-content-find>input")'), true);
    await evaluate('window.fixtureDocument.text+="virtual appended";window.controller.refresh()');
    assert.equal(await evaluate('document.querySelector(".klaus-content-find-status").textContent'), '2 of 101');
    await evaluate('window.controller.close();window.fixtureDocument=null');
    await first.webContents.loadURL('data:text/html,<h1>Needle alpha needle needle</h1>');
    await second.webContents.loadURL('data:text/html,<h1>Other page</h1>');
    assert.equal(await first.webContents.executeJavaScript('typeof window.fixtureFind'), 'undefined');
    window.contentView.addChildView(first);
    await evaluate('window.fixtureMode=true;window.fixtureChinese=false;document.getElementById("browser-section").hidden=false');
    await first.webContents.executeJavaScript('(()=>{const node=document.querySelector("h1").firstChild,r=document.createRange();r.setStart(node,0);r.setEnd(node,6);getSelection().removeAllRanges();getSelection().addRange(r);})()');
    const before = await evaluate<number>('document.getElementById("browser-panel-host").getBoundingClientRect().top');
    await evaluate('window.controller.open()');
    await waitFor('/^[1-3] of 3$/.test(document.querySelector(".klaus-content-find-status").textContent)');
    const nativeOrdinal = await evaluate<number>('Number(document.querySelector(".klaus-content-find-status").textContent.split(" ")[0])');
    assert.equal(await evaluate('document.querySelector(".klaus-content-find>input").value'), 'Needle');
    const after = await evaluate<number>('document.getElementById("browser-panel-host").getBoundingClientRect().top');
    assert.ok(after > before + 30, 'The browser viewport starts below the in-flow find bar');
    await waitFor(`document.getElementById('browser-panel-host').getBoundingClientRect().top===${after}`);
    assert.ok(first.getBounds().y >= Math.round(after));
    await evaluate('window.controller.next()');
    await waitFor(`document.querySelector(".klaus-content-find-status").textContent==="${nativeOrdinal % 3 + 1} of 3"`);
    await evaluate('window.controller.previous()');
    await waitFor(`document.querySelector(".klaus-content-find-status").textContent==="${nativeOrdinal} of 3"`);
    await evaluate('document.querySelector(".klaus-content-find label input").click()');
    await waitFor('document.querySelector(".klaus-content-find-status").textContent==="1 of 1"');
    target = second.webContents;
    await query('Other');
    await waitFor('!window.controller.isOpen()');
    await evaluate('window.controller.dispose()');
    console.log('content-find GUI: real DOM ranges, selection seed, literal cross-node queries, count/navigation/case, streaming refresh, full virtualized document counts/reveal, locale, Escape cleanup, native browser seed/matches, viewport layout and stale target rejection passed');
  } finally {
    native.close();
    if (!first.webContents.isDestroyed()) first.webContents.close({ waitForBeforeUnload: false });
    if (!second.webContents.isDestroyed()) second.webContents.close({ waitForBeforeUnload: false });
    if (!window.isDestroyed()) window.destroy();
  }
}
void main().then(() => app.exit(0), error => { console.error(error); app.exit(1); });
