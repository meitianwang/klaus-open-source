const { app, BrowserWindow, ipcMain } = require('electron');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { PptService } = require('../dist/ppt-editor-logs/ppt-service.cjs');
const { registerAppScheme } = require('../dist/ppt-editor-logs/ppt-protocol.cjs');
const { officialPluginRoot } = require('../scripts/official-plugin-root.cjs');
const pptPluginRoot = officialPluginRoot('ppt');
registerAppScheme();
const logs = resolve(__dirname, '../dist/ppt-editor-logs');
const profile = mkdtempSync(join(tmpdir(), 'klaus-ppt-ui-'));
app.setPath('userData', profile);
let service, window;
const evidence = [];
const log = (event, value) => { evidence.push({ event, value }); writeFileSync(join(logs, 'ui-events.json'), JSON.stringify(evidence, null, 2)); };
async function run() {
  await app.whenReady();
  window = new BrowserWindow({ width: 1440, height: 1000, show: false });
  const roles = new Map();
  service = new PptService({ configRoot: profile, window, pluginRoot: () => pptPluginRoot, readRoots: () => [profile], registerRenderer: (id, role) => roles.set(id, role), unregisterRenderer: id => roles.delete(id), emit: log, log });
  ipcMain.handle('klaus:core-invoke', async (event, payload) => {
    if (event.senderFrame !== event.sender.mainFrame || roles.get(event.sender.id) !== 'ppt') throw Error('Unowned presentation transport');
    const value = await service.invoke({ channel: payload.args.channel, args: payload.args.args || [], role: 'ppt', senderId: event.sender.id });
    return { ok: true, value };
  });
  const opened = await service.call('fixture', 'ppt_open', { title: 'Klaus PPT validation' }); log('opened', opened);
  if (opened.isError) throw Error(JSON.stringify(opened));
  const id = opened.structuredContent.id;
  await service.invoke({ channel: 'ppt:panel-show', args: [{ id, sessionId: 'fixture', bounds: { x: 0, y: 0, width: 1440, height: 1000 } }], role: 'main', senderId: window.webContents.id });
  const emptyEditor = [...service.editors.values()][0];
  const emptyDeadline = Date.now() + 15000;
  let emptyLoaded = false;
  while (Date.now() < emptyDeadline) {
    const frame = emptyEditor.view.webContents.mainFrame.frames.find(frame => frame.url.includes('.ppt-content/_f/') && !frame.url.includes('__frame_renew=1'));
    if (frame) {
      const emptyState = await frame.executeJavaScript('({text:document.body.innerText, root:document.getElementById("root")?.childElementCount ?? 0, loading:!!document.querySelector(".mc-loadgate")})');
      log('empty-state', emptyState);
      emptyLoaded = emptyState.root > 0 && emptyState.text.includes('This presentation has no slides yet.') && !emptyState.loading;
      if (emptyLoaded) break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  log('empty-document', { loaded: emptyLoaded, version: service.store.get('fixture', id).version, files: service.store.files('fixture', id).length });
  if (!emptyLoaded) throw Error('The empty presentation failed before its first publish.');
  await require('./ppt-service-assertions.cjs').assertLocalShell(emptyEditor, log, 'empty');
  const deck = join(profile, 'deck.json'), first = join(profile, 'slide-a.html'), second = join(profile, 'slide-b.html');
  writeFileSync(deck, JSON.stringify({ v: 4, title: 'Presentation fixture', order: ['slide-a', 'slide-b'], sections: {}, faces: {}, designSystems: [], attachments: {} }));
  writeFileSync(first, '<section id="slide-a" style="width:1280px;height:720px;background:#f4efe5"><h1 style="position:absolute;left:80px;top:120px;width:1100px;font-size:64px;color:#192b28">Presentation fixture</h1><p style="position:absolute;left:80px;top:260px;width:1000px;font-size:30px;color:#192b28">Editable text and original export rendering.</p><aside>Speaker notes fixture.</aside></section>');
  writeFileSync(second, '<section id="slide-b" style="width:1280px;height:720px;background:#173a35"><h1 style="position:absolute;left:80px;top:120px;width:1100px;font-size:64px;color:#ffffff">Second slide</h1></section>');
  const published = await service.call('fixture', 'ppt_publish', { id, base_version: opened.structuredContent.version, files: [{ path: deck, as: 'project/deck.json' }, { path: first, as: 'project/slides/slide-a.html' }, { path: second, as: 'project/slides/slide-b.html' }] });
  log('published', published); if (published.isError) throw Error(JSON.stringify(published));
  const shown = await service.invoke({ channel: 'ppt:panel-show', args: [{ id, sessionId: 'fixture', bounds: { x: 0, y: 0, width: 1440, height: 1000 } }], role: 'main', senderId: window.webContents.id }); log('shown', shown);
  const editor = [...service.editors.values()][0];
  const deadline = Date.now() + 40000;
  let state;
  while (Date.now() < deadline) {
    state = await editor.view.webContents.executeJavaScript('({text:document.body.innerText,frames:[...document.querySelectorAll("iframe")].map(f=>({src:f.src,hidden:f.hidden})),html:document.documentElement.outerHTML.slice(0,1500)})');
    const frame = editor.view.webContents.mainFrame.frames.find(f => f.url.includes('.ppt-content/_f/'));
    if (frame) { try { const inner = await frame.executeJavaScript('({text:document.body.innerText,root:document.getElementById("root")?.childElementCount,html:document.body.innerHTML.slice(0,2500)})'); state.inner = inner; if (inner.text.includes('Presentation fixture') && inner.text.includes('2')) break; } catch {} }
    await new Promise(resolveWait => setTimeout(resolveWait, 250));
  }
  log('state', state);
  if (process.env.KLAUS_PPT_TRACE === '1') {
    writeFileSync(join(logs, 'served-shell.html'), await editor.view.webContents.executeJavaScript('fetch(location.href).then(r=>r.text())'));
    const contentFrame = editor.view.webContents.mainFrame.frames.find(frame => frame.url.includes('.ppt-content/_f/'));
    writeFileSync(join(logs, 'served-content.html'), await contentFrame.executeJavaScript('fetch(location.href).then(r=>r.text())'));
  }
  if (!state.inner?.text.includes('Presentation fixture')) throw Error('The presentation content did not render.');
  if (/can.t be edited|saved content has a problem|outside any/.test(state.inner.text)) throw Error('The presentation contains a document parsing error.');
  app.focus({ steal: true }); window.show(); window.focus();
  const interactiveDeadline = Date.now() + 15000;
  while (Date.now() < interactiveDeadline && await editor.view.webContents.executeJavaScript('document.getElementById("frame-content")?.inert !== false')) await new Promise(resolveWait => setTimeout(resolveWait, 100));
  await require('./ppt-service-assertions.cjs').assertLocalShell(editor, log, 'initial');
  log('report', await editor.view.webContents.executeJavaScript('window.__klausPresentationReport ?? null'));
  const headerMenu = await editor.view.webContents.executeJavaScript('(async()=>{const button=document.querySelector("[data-title-menu]");button?.click();await new Promise(resolve=>requestAnimationFrame(resolve));const text=document.body.innerText;const disabled=document.querySelector("[data-delete-item]")?.getAttribute("aria-disabled");button?.click();return {text,deleteDisabled:disabled,favorite:/Favorite|Favourite/.test(text)}})()');
  log('header-menu', headerMenu);
  if (!headerMenu.text.includes('Delete artifact') || headerMenu.deleteDisabled !== 'true' || headerMenu.favorite) throw Error('The presentation header actions changed unexpectedly.');
  const capabilities = await editor.view.webContents.executeJavaScript(`fetch('/api/frame/${id}').then(r=>r.json()).then(boot=>Object.keys(boot.capabilities??{}))`);
  if (capabilities.includes('comments') || capabilities.includes('mcp')) throw Error('An excluded presentation capability was declared.');
  log('local-capabilities', capabilities);
  await require('./ppt-service-assertions.cjs').assertServiceBoundaries(service, window, id, log);
  const exported = await service.call('fixture', 'ppt_export', { id, format: 'pptx', variant: 'basic' }); log('exported', exported);
  if (exported.isError) throw Error(JSON.stringify(exported));
  const bytes = require('node:fs').readFileSync(exported.structuredContent.path);
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) throw Error('The presentation export is not an OOXML archive.');
  writeFileSync(join(logs, 'fixture.pptx'), bytes);
  if (process.env.PPT_EXTENDED === '1') {
    const actions = require('./ppt-ui-actions.cjs');
    if (process.env.PPT_EDIT_ONLY !== '1') await actions.exportFormats(service, id, logs, log);
    await require('./ppt-service-assertions.cjs').assertConcurrentExport(service, id, log);
    await actions.editAndReopen(service, window, id, profile, log);
  }
  if (process.env.PPT_CAPTURE === '1') {
    const active = [...service.editors.values()].find(entry => entry.id === id);
    const image = await active.view.webContents.capturePage(); writeFileSync(join(logs, 'editor.png'), image.toPNG());
  }
  console.log(process.env.PPT_EXTENDED === '1' ? `PPT native editor: ${process.env.PPT_EDIT_ONLY === '1' ? 'PPTX' : 'all formats'}, ownership, concurrent exports, editing, undo/redo, automatic save, live updates and reopening passed.` : 'PPT native editor rendered two slides and exported an OOXML presentation.');
}
writeFileSync(join(logs, 'ui-profile.json'), JSON.stringify({ profile }));
let deadline;
Promise.race([run(), new Promise((_resolve, reject) => { deadline = setTimeout(() => reject(new Error('The presentation UI fixture timed out.')), process.env.PPT_EXTENDED === '1' ? 240000 : 75000); })]).catch(error => { console.error(error); log('failure', { message: error?.message ?? String(error), code: error?.code, stack: error?.stack, details: JSON.stringify(error) }); process.exitCode = 1; }).finally(async () => {
  clearTimeout(deadline);
  await service?.dispose(true); if (window && !window.isDestroyed()) window.destroy();
  rmSync(profile, { recursive: true, force: true }); app.exit(process.exitCode || 0);
});
