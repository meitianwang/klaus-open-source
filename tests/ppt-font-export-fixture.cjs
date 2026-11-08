const { app, BrowserWindow, ipcMain, net } = require('electron');
const { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } = require('node:fs');
const { join, resolve } = require('node:path');
const { tmpdir } = require('node:os');
const { PptService } = require('../dist/ppt-editor-logs/ppt-service.cjs');
const { registerAppScheme } = require('../dist/ppt-editor-logs/ppt-protocol.cjs');
const { officialPluginRoot } = require('../scripts/official-plugin-root.cjs');
registerAppScheme();
const base = process.env.PPT_QUALITY_LOGS;
const logs = join(base, process.env.PPT_FONT_CASE || 'font-before');
mkdirSync(logs, { recursive: true });
const profile = mkdtempSync(join(tmpdir(), 'klaus-ppt-font-'));
app.setPath('userData', profile);
const rows = [];
const log = (event, value) => { rows.push({ event, value }); writeFileSync(join(logs, 'events.json'), JSON.stringify(rows, null, 2)); };
let service, window;
async function run() {
  await app.whenReady();
  window = new BrowserWindow({ width: 1440, height: 1000, show: false });
  const roles = new Map();
  service = new PptService({ configRoot: profile, window, pluginRoot: () => officialPluginRoot('ppt'), readRoots: () => [profile], registerRenderer: (id, role) => roles.set(id, role), unregisterRenderer: id => roles.delete(id), emit: log, log });
  ipcMain.handle('klaus:core-invoke', async (event, payload) => {
    if (event.senderFrame !== event.sender.mainFrame || roles.get(event.sender.id) !== 'ppt') throw Error('Unowned presentation transport');
    return { ok: true, value: await service.invoke({ channel: payload.args.channel, args: payload.args.args || [], role: 'ppt', senderId: event.sender.id }) };
  });
  const opened = await service.call('fixture', 'ppt_open', { title: 'Font export quality' });
  if (opened.isError) throw Error(JSON.stringify(opened));
  const id = opened.structuredContent.id;
  await service.invoke({ channel: 'ppt:panel-show', args: [{ id, sessionId: 'fixture', bounds: { x: 0, y: 0, width: 1440, height: 1000 } }], role: 'main', senderId: window.webContents.id });
  const editor = [...service.editors.values()][0];
  editor.partition.protocol.handle('https', async request => {
    const url = new URL(request.url);
    if (url.hostname === 'fonts.googleapis.com') {
      log('font-css', request.url);
      return new Response(readFileSync(join(base, 'dm-sans.css')), { headers: { 'Content-Type': 'text/css', 'Access-Control-Allow-Origin': '*' } });
    }
    if (url.hostname === 'fonts.gstatic.com') {
      log('font-bytes', request.url);
      const bold = url.pathname.includes('RZthTg');
      return new Response(readFileSync(join(base, bold ? 'dm-sans-700.ttf' : 'dm-sans-400.ttf')), { headers: { 'Content-Type': 'font/ttf', 'Access-Control-Allow-Origin': '*' } });
    }
    return net.fetch(request, { bypassCustomProtocolHandlers: true });
  });
  const deck = join(profile, 'deck.json'), slide = join(profile, 's01.html');
  writeFileSync(deck, JSON.stringify({ v: 4, title: 'Font export quality', order: ['s01'], sections: {}, faces: { 'dm-sans': { family: 'DM Sans', href: 'https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;700&display=swap' } }, designSystems: [], attachments: {} }));
  writeFileSync(slide, '<section id="s01" style="width:1920px;height:1080px;background:#f7f5ef"><h1 style="position:absolute;left:120px;top:160px;width:1600px;font-family:DM Sans,Arial,sans-serif;font-size:88px;font-weight:700;color:#163a36">Quality needs original type</h1><p style="position:absolute;left:120px;top:360px;width:1600px;font-family:DM Sans,Arial,sans-serif;font-size:40px">Editable typography should travel with the file.</p><aside>Font quality notes.</aside></section>');
  const published = await service.call('fixture', 'ppt_publish', { id, base_version: opened.structuredContent.version, files: [{ path: deck, as: 'project/deck.json' }, { path: slide, as: 'project/slides/s01.html' }] });
  log('published', published);
  if (published.isError) throw Error(JSON.stringify(published));
  const deadline = Date.now() + 40000;
  let frame;
  while (Date.now() < deadline) {
    frame = editor.view.webContents.mainFrame.frames.find(f => f.url.includes('.ppt-content/_f/') && !f.url.includes('__frame_renew=1'));
    if (frame) {
      const ready = await frame.executeJavaScript('document.body.innerText.includes("Quality needs original type")').catch(() => false);
      if (ready) break;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (!frame) throw Error('No content frame');
  await frame.executeJavaScript('document.fonts.ready');
  log('font-state', await frame.executeJavaScript('({faces:[...document.fonts].map(f=>({family:f.family,status:f.status,weight:f.weight})),loaded:document.fonts.check("700 88px \\\"DM Sans\\\"")})'));
  log('flags', await frame.executeJavaScript('({flag:globalThis.__appifact_flags?globalThis.__appifact_flags.get("appifact_extra_export_formats",false):null,override:globalThis.__appifact_flags_override??null})'));
  log('metadata-fetch', await frame.executeJavaScript('(async()=>Promise.all(["families","reserved","notices"].map(async n=>{const r=await fetch("artifact-type/reference/google-fonts-"+n+".json");return {name:n,status:r.status}})))()'));
  for (const [format, variant] of [['pptx','current'], ['pptx','basic'], ['html'], ['pdf']]) {
    const result = await service.call('fixture', 'ppt_export', { id, format, ...(variant ? { variant } : {}) });
    log('export', { format, variant, result });
    if (result.isError) throw Error(JSON.stringify(result));
    writeFileSync(join(logs, `font-${variant || 'export'}.${format}`), readFileSync(result.structuredContent.path));
  }
  log('page-state', await frame.executeJavaScript('({text:document.body.innerText})'));
  console.log('Font export fixture finished: ' + logs);
}
let deadline;
Promise.race([run(), new Promise((_, reject) => { deadline = setTimeout(() => reject(Error('Font fixture timeout')), 180000); })]).catch(error => { console.error(error); log('failure', { message: String(error), stack: error.stack }); process.exitCode = 1; }).finally(async () => {
  clearTimeout(deadline);
  await service?.dispose(true);
  if (window && !window.isDestroyed()) window.destroy();
  rmSync(profile, { recursive: true, force: true });
  console.log('Temporary profile removed: ' + profile);
  app.exit(process.exitCode || 0);
});
