import { app, BrowserWindow, ipcMain, protocol, session } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CanvasService } from '../main/canvas/service';
import { registerCanvasHandlers } from '../main/ipc/handlers/canvas';
import { ChannelRegistry } from '../main/ipc/registry';
import { RoleTable, type Json } from '../main/ipc/contract';
import { IpcRouter } from '../main/ipc/router';
import { handleCoreInvoke, WindowRoleRegistry } from '../main/ipc/binding';
import { HOST_CHANNELS } from '../main/ipc/host-channels';
import { appUrl, APP_SCHEME, registerAppScheme } from '../main/app/protocol';
import { record, type Data } from '../main/visuals/data';
import { assert, assertDeepEqual, assertEqual, Harness, waitFor } from './harness';
const { officialPluginRoot } = require('../../scripts/official-plugin-root.cjs') as typeof import('../scripts/official-plugin-root.cjs');

const profile = process.env.KLAUS_CANVAS_FIXTURE_PROFILE;
if (!profile) throw new Error('An isolated Canvas fixture profile is required.');
mkdirSync(profile, { recursive: true }); app.setPath('userData', profile);
registerAppScheme(); app.on('window-all-closed', () => {});

async function main(): Promise<number> {
  await app.whenReady();
  const h = new Harness();
  protocol.handle(APP_SCHEME, () => new Response('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><h1>Canvas host fixture</h1>', { headers: { 'Content-Type': 'text/html' } }));
  const window = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await window.loadURL(appUrl('index.html'));
  window.showInactive();
  await window.webContents.executeJavaScript('localStorage.setItem("host-secret", "main-only")');
  const roles = new WindowRoleRegistry(); const registry = new ChannelRegistry();
  const pushes: Array<{ channel: string; data: Json }> = [];
  const service = new CanvasService({ configRoot: profile!, resourcesRoot: resolve(__dirname, '../../resources'), window, frontendRoot: resolve(__dirname, '../../frontend-dist'), registerRenderer: (id, role) => roles.register(id, role), unregisterRenderer: id => roles.unregister(id), emit: (channel, data) => pushes.push({ channel, data }), theme: () => 'light', locale: () => 'en',
    chooseExportPath: async (name) => join(profile!, name) });
  service.provision(); registerCanvasHandlers(registry, { service });
  const router = new IpcRouter({ registry, roles: RoleTable.load() });
  ipcMain.handle(HOST_CHANNELS.coreInvoke, (event, payload: unknown) => {
    const fields = record(payload);
    return handleCoreInvoke({ roleOf: id => roles.resolver()(id), route: (caller, channel, args) => router.route(caller, channel, args), windowOp: () => { throw new Error('Canvas has no window actions.'); } }, event, String(fields.command), fields.args);
  });
  const invoke = async (channel: string, fields: Data = {}): Promise<Data> => {
    const handler = registry.lookup(channel); assert(handler, `${channel} registered`);
    return record(await handler({ role: 'main', senderId: window.webContents.id, channel, args: [fields] }));
  };
  const evaluate = (expression: string): Promise<unknown> => service.view!.webContents.executeJavaScript(expression);
  const file = join(service.store.canvases, 'one.canvas.tsx');
  const second = join(service.store.canvases, 'two.canvas.tsx');
  const imagePath = join(service.store.canvases, 'image.svg');
  const bounds = { x: 100, y: 80, width: 700, height: 520 };
  writeFileSync(imagePath, '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="red"/></svg>');
  writeFileSync(file, "import {Stack, Text, useCanvasState, canvasImage} from 'klaus/canvas'; export default function Report(){const [count,setCount]=useCanvasState('count',0);return <Stack><Text>Canvas fixture content</Text><button id='increment' onClick={()=>setCount(count+1)}>Count {count}</button><img id='local-image' src={canvasImage('./image.svg')}/></Stack>}");
  writeFileSync(second, "export default function Second(){return <h1>Second canvas content</h1>}");

  h.test('a clean dynamic check opens the current Canvas through the existing renderer request', async () => {
    const checking = service.executeCheck('task-A', { file_path: file });
    await waitFor(() => pushes.some(entry => entry.channel === 'canvas:open-panel'), 1000, 'open request emitted');
    const open = pushes.find(entry => entry.channel === 'canvas:open-panel'); assert(open, 'open request emitted');
    assertEqual(record(open.data).sessionId, 'task-A', 'task attribution retained');
    assertEqual((await invoke('canvas:panel-show', { filePath: file, bounds })).ok, true, 'native Canvas shown');
    await waitFor(async () => String(await evaluate('document.body.innerText')).includes('Canvas fixture content'), 6000, 'actual built React Canvas mounted');
    assertEqual((await invoke('canvas:open-result', { requestId: String(record(open.data).requestId), ok: true })).ok, true, 'renderer acknowledged actual presentation');
    const result = await checking; assertEqual(result.success, true, 'dynamic tool result');
    assert(String(record((result.contentItems as Json[])[0]).text).includes('Opened the Canvas'), 'tool reports the acknowledged presentation');
    assert(window.contentView.children.includes(service.view!), 'native child belongs to the main window');
  });
  h.test('the generated page has only its six invokes and cannot read main storage or create a privileged frame', async () => {
    assertDeepEqual(await evaluate('({require:typeof require,process:typeof process,module:typeof module,Buffer:typeof Buffer,ipcRenderer:typeof ipcRenderer,klaus:typeof window.klaus,listen:typeof window.__KLAUS_DESKTOP__.event,window:typeof window.__KLAUS_DESKTOP__.window,secret:localStorage.getItem("host-secret")})'), { require:'undefined',process:'undefined',module:'undefined',Buffer:'undefined',ipcRenderer:'undefined',klaus:'undefined',listen:'undefined',window:'undefined',secret:null }, 'isolated globals and session');
    assert(service.view!.webContents.session !== session.defaultSession, 'Canvas uses a dedicated Session');
    const denied = record(await evaluate('window.__KLAUS_DESKTOP__.core.invoke("ipc_invoke",{channel:"settings:kv:get",args:[{key:"secret"}]}).then(()=>({denied:false}),e=>({denied:true,error:e}))'));
    assertEqual(denied.denied, true, 'main capability refused');
    await evaluate('new Promise(r=>{const f=document.createElement("iframe");f.onload=()=>{window.frameGlobals={node:typeof f.contentWindow.require,bridge:typeof f.contentWindow.__KLAUS_DESKTOP__};r(true)};document.body.append(f)})');
    assertDeepEqual(await evaluate('window.frameGlobals'), { node:'undefined',bridge:'undefined' }, 'child frame receives no preload');
  });
  h.test('live Canvas state writes survive reload and the narrow send-to-chat call preserves flags', async () => {
    await evaluate('document.querySelector("#increment").click()');
    await waitFor(() => { try { return JSON.parse(readFileSync(file.replace(/\.tsx$/, '.data.json'), 'utf8')).count === 1; } catch { return false; } }, 3000, 'SDK coalesced state landed');
    await invoke('canvas:panel-show', { filePath: file, bounds, reload: true });
    await waitFor(async () => String(await evaluate('document.body.innerText')).includes('Count 1'), 5000, 'persisted state rendered');
    await evaluate('window.klausCanvas.sendToChat("Review the Canvas",{submit:false,newChat:true})');
    assertDeepEqual(record(pushes.findLast(entry => entry.channel === 'canvas:send-to-chat')?.data), { text:'Review the Canvas',submit:false,newChat:true }, 'chat request payload');
  });
  h.test('local images load through the scoped media route and arbitrary host files stay unreadable', async () => {
    await waitFor(async () => await evaluate('document.querySelector("#local-image").naturalWidth') === 20, 4000, 'actual local image rendered');
    assertEqual(await evaluate('fetch("/canvas-asset?path="+encodeURIComponent('+JSON.stringify(join(profile!, 'secret.svg'))+')).then(r=>r.status)'),404,'missing private file not served');
    writeFileSync(join(profile!, 'secret.svg'), '<svg>private</svg>');
    assertEqual(await evaluate('fetch("/canvas-asset?path="+encodeURIComponent('+JSON.stringify(join(profile!, 'secret.svg'))+')).then(r=>r.status)'),403,'out-of-scope image refused');
    assertEqual(await evaluate('fetch("/canvas-asset?path="+encodeURIComponent('+JSON.stringify(file)+')).then(r=>r.status)'),403,'executable source cannot become a media response');
  });
  h.test('one generated Canvas cannot read or mutate another Canvas through its page identity', async () => {
    const answer = record(await evaluate('window.klausCanvas.load('+JSON.stringify(second)+')')); assertEqual(answer.ok, false, 'foreign load refused');
    const write = record(await evaluate('window.klausCanvas.writeState('+JSON.stringify(second)+',{bad:true})')); assertEqual(write.ok, false, 'foreign state refused');
    const document = record(await evaluate('window.klausCanvas.action('+JSON.stringify(second)+',{type:"document.get"})')); assertEqual(document.ok, false, 'foreign document refused');
  });
  h.test('official prototype editor persists direct edits, runs links and exports an offline demo', async () => {
    const prototype = join(service.store.canvases, 'prototype.canvas.tsx');
    writeFileSync(prototype, readFileSync(resolve(officialPluginRoot('prototype-studio'), 'templates/prototype-studio.canvas.tsx')));
    assertEqual(service.store.check(prototype).clean, true, 'installed editor passes canvas_check');
    assertEqual((await invoke('canvas:panel-show', { filePath: prototype, bounds })).ok, true, 'prototype opens in Canvas');
    await waitFor(async () => String(await evaluate('document.body.innerText')).includes('Prototype Studio') && service.documents.get(prototype).version === 1, 6000, 'default project saved');
    assertEqual(service.documentToolSpec().name, 'canvas_document', 'agent document tool is registered');
    const agentRead = await service.executeDocument({ file_path: prototype, action: 'get' });
    assertEqual(agentRead.success, true, 'agent tool reads the same document');
    const original = JSON.parse(String((agentRead.contentItems as Data[])[0]?.text)) as Data;
    const originalVersion = Number(original.version);
    const document = original.document as Data;
    const first = (document.pages as Data[])[0]!;
    const details = { ...first, id: 'details', name: 'Details', layers: [] };
    const linked = { ...first, layers: (first.layers as Data[]).map(item => item.id === 'start' ? { ...item, action: { type: 'navigate', target: 'details' } } : item) };
    const agentEdit = await service.executeDocument({ file_path: prototype, action: 'apply', expected_version: originalVersion, document: { ...document, pages: [linked, details] } });
    assertEqual(agentEdit.success, true, 'agent tool writes a versioned prototype');
    await invoke('canvas:panel-show', { filePath: prototype, bounds, reload: true });
    await waitFor(async () => String(await evaluate('document.body.innerText')).includes('Details'), 6000, 'agent edit rendered');
    const editorImage = await service.view!.webContents.capturePage(undefined, { stayHidden: true });
    assert(!editorImage.isEmpty(), 'prototype editor paints');
    writeFileSync(join(__dirname, 'prototype-editor.png'), editorImage.toPNG());
    await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Preview").click()');
    await waitFor(async () => Boolean(await evaluate('document.querySelector(".ps.preview")')), 3000, 'preview enabled');
    await evaluate('Array.from(document.querySelectorAll(".layer.button")).find(b=>b.textContent.includes("Get started")).click()');
    await waitFor(async () => String(await evaluate('document.querySelector(".previewbar span").textContent')).includes('Details'), 3000, 'page link navigates');
    const htmlPath = join(profile!, 'New prototype.html');
    await evaluate('(()=>{const s=document.querySelector("select[aria-label^=Export]");s.value="html";s.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
    await waitFor(() => existsSync(htmlPath) && readFileSync(htmlPath, 'utf8').includes('const project='), 3000, 'offline demo exported');
    const html = readFileSync(htmlPath, 'utf8');
    assert(html.includes('const project=') && html.includes('id="page"'), 'self-contained demo source');
    const offline = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false } });
    try {
      await offline.loadFile(htmlPath);
      assertEqual(await offline.webContents.executeJavaScript('document.querySelector("#pages").value'), 'home', 'offline opens first screen');
      await offline.webContents.executeJavaScript('Array.from(document.querySelectorAll(".el")).find(e=>e.textContent.includes("Get started")).click()');
      assertEqual(await offline.webContents.executeJavaScript('document.querySelector("#pages").value'), 'details', 'offline click navigates');
    } finally { offline.destroy(); }
    await evaluate('Array.from(document.querySelectorAll("button")).find(b=>b.textContent==="Edit").click()');
    await evaluate('Array.from(document.querySelectorAll(".side .item")).find(b=>b.textContent.includes("Home")).click()');
    for (const format of ['svg', 'png']) {
      await evaluate(`(()=>{const s=document.querySelector("select[aria-label^=Export]");s.value="${format}";s.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
      await waitFor(() => existsSync(join(profile!, `Home.${format}`)) && readFileSync(join(profile!, `Home.${format}`)).length > 8, 5000, `${format} exported`);
    }
    assert(readFileSync(join(profile!, 'Home.svg'), 'utf8').startsWith('<svg'), 'SVG content');
    assertEqual(readFileSync(join(profile!, 'Home.png')).subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
    await evaluate('Array.from(document.querySelectorAll(".inspector button")).find(b=>b.textContent==="Button").click()');
    await waitFor(() => Number(service.documents.get(prototype).version) >= originalVersion + 2, 3000, 'canvas edit saved after agent edit');
    const interact = async (step: string, script: string) => { try { await evaluate(script); } catch (error) { throw new Error(`${step}: ${String(error)}; side buttons: ${JSON.stringify(await evaluate('Array.from(document.querySelectorAll(".side button")).map(b=>b.textContent)'))}`); } };
    await interact('desktop variant', 'Array.from(document.querySelectorAll(".stagebar button")).find(b=>b.textContent==="Desktop variant").click()');
    await waitFor(() => (service.documents.get(prototype).document as Data).pages instanceof Array && ((service.documents.get(prototype).document as Data).pages as Data[]).some(p => p.device === 'desktop'), 3000, 'desktop artboard persisted');
    await interact('tablet variant', 'Array.from(document.querySelectorAll(".stagebar button")).find(b=>b.textContent==="Tablet variant").click()');
    await waitFor(() => ((service.documents.get(prototype).document as Data).pages as Data[]).some(p => p.device === 'tablet'), 3000, 'tablet artboard persisted');
    await interact('select button layer', 'document.querySelector(".layer.button").click()');
    await interact('components tab', 'Array.from(document.querySelectorAll(".side button")).find(b=>b.textContent==="Components").click()');
    await interact('create component', 'Array.from(document.querySelectorAll(".side button")).find(b=>b.textContent==="Create from selection").click()');
    await waitFor(() => ((service.documents.get(prototype).document as Data).components as Data[]).length === 1, 3000, 'reusable component saved');
    const tabletBefore = (((service.documents.get(prototype).document as Data).pages as Data[]).find(p => p.device === 'tablet')!.layers as Data[]).length;
    await interact('insert component', 'Array.from(document.querySelectorAll(".side button")).find(b=>b.textContent.startsWith("+ Get started")).click()');
    await waitFor(() => (((service.documents.get(prototype).document as Data).pages as Data[]).find(p => p.device === 'tablet')!.layers as Data[]).length > tabletBefore, 3000, 'component instance inserted');
    const tablet = ((service.documents.get(prototype).document as Data).pages as Data[]).find(p => p.device === 'tablet')!;
    const responsive = (tablet.layers as Data[]).find(l => l.layout === 'scale')!;
    await interact('select artboard', 'document.querySelector(".paper").click()');
    await waitFor(async () => String(await evaluate('document.querySelector(".inspector").textContent')).includes('Artboard properties'), 3000, 'artboard inspector visible');
    await interact('resize artboard', '(()=>{const field=document.querySelector(".inspector input[type=number]");field.value="900";field.dispatchEvent(new FocusEvent("focusout",{bubbles:true}))})()');
    await waitFor(() => ((service.documents.get(prototype).document as Data).pages as Data[]).some(p => p.id === tablet.id && p.width === 900), 3000, 'artboard resize saved');
    const resized = ((service.documents.get(prototype).document as Data).pages as Data[]).find(p => p.id === tablet.id)!;
    assertEqual((resized.layers as Data[]).find(l => l.id === responsive.id)!.w, Math.round(Number(responsive.w) * 900 / Number(tablet.width)), 'scale constraint follows artboard width');
    const imported = { ...(service.documents.get(prototype).document as Data), name: 'Imported prototype' };
    await interact('import editable project', `(()=>{const input=document.querySelector('input[accept^=".json"]');const transfer=new DataTransfer();transfer.items.add(new File([${JSON.stringify(JSON.stringify(imported))}],"prototype.json",{type:"application/json"}));input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}));return true})()`);
    await waitFor(() => (service.documents.get(prototype).document as Data).name === 'Imported prototype', 3000, 'editable project imported');
    const stale = await service.executeDocument({ file_path: prototype, action: 'apply', expected_version: originalVersion, document });
    assertEqual(stale.success, false, 'stale agent edit rejected');
    const oversized = join(service.store.canvases, 'oversized.canvas.tsx');
    writeFileSync(oversized, readFileSync(prototype));
    service.documents.apply(oversized, 0, { ...document, pages: Array.from({ length: 61 }, (_, index) => ({ ...first, id: `page-${index}` })) });
    await invoke('canvas:panel-show', { filePath: oversized, bounds });
    await waitFor(async () => String(await evaluate('document.body.innerText')).includes('Project exceeds the artboard or component limit'), 3000, 'oversized project visibly refused');
    assertEqual(service.documents.get(oversized).version, 1, 'oversized document retained without silent overwrite');
    await invoke('canvas:panel-show', { filePath: second, bounds });
  });
  h.test('hide and restore preserve the view while retargeting the same bounds replaces the document', async () => {
    await invoke('canvas:panel-show', { filePath: file, bounds });
    const old = service.view!; const oldContents = old.webContents; const oldId = oldContents.id;
    await invoke('canvas:panel-hide'); assertEqual(old.getVisible(), false, 'overlay hides view');
    await invoke('canvas:panel-show', { filePath: file, bounds }); assertEqual(service.view, old, 'same file keeps its renderer');
    await invoke('canvas:panel-show', { filePath: second, bounds });
    await waitFor(async () => String(await evaluate('document.body.innerText')).includes('Second canvas content'), 4000, 'retargeted actual document');
    assert(oldContents.isDestroyed(), 'old generated renderer closed');
    assertEqual(roles.resolver()(oldId), undefined, 'closed role revoked');
    await evaluate('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    const image = await service.view!.webContents.capturePage(undefined, { stayHidden: true }); assert(!image.isEmpty(), 'native Canvas paints');
    writeFileSync(join(__dirname,'canvas-fixture.png'),image.toPNG());
  });
  h.test('navigation and a late show cannot cover an overlay or navigate into app capabilities', async () => {
    const current = service.view!.webContents.getURL();
    await evaluate('location.href="https://example.com/";true');
    await new Promise(r=>setTimeout(r,100)); assertEqual(service.view!.webContents.getURL(), current, 'remote navigation blocked');
    const pending = invoke('canvas:panel-show', { filePath: file, bounds, reload: true }); service.hide();
    assertEqual((await pending).ok,false,'stale presentation refused'); assertEqual(service.view!.getVisible(),false,'overlay still hides view');
  });
  h.test('a separately destroyed generated page is revoked and can be reopened', async () => {
    const contents = service.view!.webContents; const id = contents.id;
    contents.close({ waitForBeforeUnload: false });
    await waitFor(() => contents.isDestroyed(), 3000, 'generated renderer destroyed');
    assertEqual(roles.resolver()(id), undefined, 'externally closed role revoked');
    assertEqual(service.view, undefined, 'destroyed native view is not retained');
    assertEqual((await invoke('canvas:panel-show', { filePath: file, bounds })).ok, true, 'new generated page opened');
  });
  h.test('shutdown after the parent window closes destroys the generated page and revokes its role', async () => {
    const contents = service.view!.webContents; const id = contents.id;
    window.destroy();
    await service.dispose(); assert(contents.isDestroyed(), 'Canvas WebContents closed'); assertEqual(roles.resolver()(id),undefined,'IPC role revoked');
  });
  const result = await h.finish(join(__dirname, 'canvas-electron-result.json'), 'canvas-electron');
  await service.dispose(); window.destroy(); ipcMain.removeHandler(HOST_CHANNELS.coreInvoke); protocol.unhandle(APP_SCHEME);
  return result;
}
void main().then(code=>app.exit(code),error=>{process.stderr.write(`${String(error)}\n`);app.exit(1);});
