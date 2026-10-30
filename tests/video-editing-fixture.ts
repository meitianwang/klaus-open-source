import { app, BrowserWindow, ipcMain, protocol, webContents, type WebContentsView, type WebFrameMain } from 'electron';
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { VideoEditingService } from '../main/video-editing/service';
import { registerVideoEditingHandlers } from '../main/ipc/handlers/video-editing';
import { ChannelRegistry } from '../main/ipc/registry';
import { RoleTable } from '../main/ipc/contract';
import { IpcRouter } from '../main/ipc/router';
import { handleCoreInvoke, WindowRoleRegistry } from '../main/ipc/binding';
import { HOST_CHANNELS } from '../main/ipc/host-channels';
import { APP_SCHEME, appUrl, registerAppScheme } from '../main/app/protocol';
import { record, type Data } from '../main/visuals/data';
import { Harness, assert, assertEqual, waitFor } from './harness';
const { officialPluginRoot } = require('../../scripts/official-plugin-root.cjs') as typeof import('../scripts/official-plugin-root.cjs');

const logs = resolve(__dirname, '../video-editing-plugin-logs');
mkdirSync(logs, { recursive: true });
const profile = mkdtempSync(join(logs, 'native-profile-'));
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
registerAppScheme();
app.on('window-all-closed', () => {});

async function main(): Promise<number> {
  await app.whenReady();
  const deadline = setTimeout(() => { appendFileSync(join(logs, 'native-fixture-progress.log'), 'Fixture deadline exceeded\n'); app.exit(1); }, 240_000);
  const h = new Harness();
  const test = (name: string, work: () => Promise<void>) => h.test(name, async () => {
    appendFileSync(join(logs, 'native-fixture-progress.log'), `${new Date().toISOString()} START ${name}\n`);
    try { await work(); } finally { appendFileSync(join(logs, 'native-fixture-progress.log'), `${new Date().toISOString()} END ${name}\n`); }
  });
  protocol.handle(APP_SCHEME, () => new Response('<!doctype html><h1>Video editor fixture</h1>', { headers: { 'Content-Type': 'text/html' } }));
  const window = new BrowserWindow({ width: 1480, height: 1000, show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await window.loadURL(appUrl('index.html'));
  const registry = new ChannelRegistry(), roles = new WindowRoleRegistry();
  const plugin = officialPluginRoot('video-editing');
  const service = new VideoEditingService({ configRoot: profile, window, pluginRoot: () => plugin,
    registerRenderer: (id, role) => {
      roles.register(id, role);
      const contents = webContents.fromId(id)!;
      contents.on('console-message', event => appendFileSync(join(logs, 'native-editor-console.jsonl'), JSON.stringify({ level: event.level, message: event.message, source: event.sourceId, line: event.lineNumber }) + '\n'));
      setTimeout(() => {
        if (contents.isDestroyed()) return;
        void Promise.all(contents.mainFrame.framesInSubtree.map(async frame => ({
          path: (() => { try { return new URL(frame.url).pathname; } catch { return frame.url; } })(),
          state: await frame.executeJavaScript('({text:document.body.innerText.slice(0,2000),scripts:Array.from(document.scripts).map(s=>s.src),bridge:typeof window.klausVideoHost,request:typeof window.klausVideo?.request,origin:location.origin})').catch(error => String(error)),
        }))).then(state => writeFileSync(join(logs, 'native-startup-state.json'), JSON.stringify(state, null, 2)));
      }, 5000);
    },
    unregisterRenderer: id => roles.unregister(id),
    emit: (channel, data) => { appendFileSync(join(logs, 'native-events.jsonl'), JSON.stringify({ channel, data }) + '\n'); },
    log: (event, data) => { appendFileSync(join(logs, 'native-events.jsonl'), JSON.stringify({ event, data }) + '\n'); },
  });
  registerVideoEditingHandlers(registry, { service });
  const router = new IpcRouter({ registry, roles: RoleTable.load() });
  ipcMain.handle(HOST_CHANNELS.coreInvoke, async (event, payload: unknown) => {
    const fields = record(payload);
    appendFileSync(join(logs, 'native-ipc.jsonl'), JSON.stringify({ command: fields.command, channel: record(fields.args).channel, type: record((record(fields.args).args as unknown[])?.[0]).action }) + '\n');
    const result = await handleCoreInvoke({ roleOf: id => roles.resolver()(id), route: (caller, channel, args) => router.route(caller, channel, args), windowOp: () => { throw new Error('No window capability'); } }, event, String(fields.command), fields.args);
    appendFileSync(join(logs, 'native-ipc.jsonl'), JSON.stringify({ reply: result.ok, ...(result.ok ? { keys: Object.keys(record(result.value)) } : { error: result.error }) }) + '\n');
    return result;
  });
  const invoke = async (channel: string, fields: Data = {}) => record(await registry.lookup(channel)!({ role: 'main', senderId: window.webContents.id, channel, args: [fields] }));
  const owner = 'native-video-fixture';
  let id = '', view: WebContentsView, ui: WebFrameMain;
  const call = async (name: string, fields: Data = {}): Promise<Data> => {
    const result = await service.call(owner, name, { ...(id ? { id } : {}), ...fields });
    assert(result.isError !== true, JSON.stringify(result));
    return record(result.structuredContent);
  };
  const inspect = () => call('video_editing_inspect');
  const api = async (path: string, body?: Data, method = body ? 'POST' : 'GET'): Promise<Data> => {
    const reply = await call('video_editing_request', { path, method, ...(body ? { body } : {}),
      ...(!['GET', 'HEAD'].includes(method) ? { expected_revision: (await inspect()).revision! } : {}) });
    const result = record(reply.result);
    assertEqual(result.ok, true, JSON.stringify(result));
    return record(result.body);
  };
  const native = async (method: string, params: Data = {}) => record(await view.webContents.executeJavaScript(`window.klausVideo.request(${JSON.stringify({ method, params })})`));
  const child = (workspace: string) => {
    const found = window.contentView.children.find(candidate => 'webContents' in candidate && new URL((candidate as WebContentsView).webContents.getURL()).searchParams.get('id') === workspace) as WebContentsView;
    assert(found, 'owned native view exists'); return found;
  };
  const stage = (w: number, height: number) => [{ op: 'stage', w, h: height }];
  const source = join(profile, 'source-film');
  mkdirSync(source, { recursive: true });
  mkdirSync(join(source, 'assets'));
  execFileSync('/opt/homebrew/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x385a70:s=640x360:r=10:d=3',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(source, 'assets/source.mp4')]);
  writeFileSync(join(source, 'assets/source.vtt'), 'WEBVTT\n\n00:00:00.000 --> 00:00:03.000\nNative shared editor acceptance.\n');
  writeFileSync(join(source, 'scene.html'), '<!doctype html><html><body style="margin:0;background:#385a70;color:white;font:40px Arial"><div id="title">Native video editor</div><script>window.film={duration:3,frame(t){document.querySelector("div").style.transform=`translateX(${t*10}px)`}}</script></body></html>');
  writeFileSync(join(source, 'film.html'), '<!doctype html><html><head><meta name="viewport" content="width=640, height=360"></head><body><section><iframe id="title" src="scene.html#t=0,3"></iframe></section><section><video id="media" src="assets/source.mp4#t=0,3"></video></section></body></html>');
  test('the complete Studio boots in an owned native view with only a narrow trusted bridge', async () => {
    const opened = await call('video_editing_open', { title: 'Native video acceptance', path: source });
    id = String(opened.id);
    assertEqual(record(opened.artifact).kind, 'video-editing', 'native artifact');
    assertEqual(JSON.stringify(opened).includes('key='), false, 'launch capability is private');
    window.show(); window.focus();
    assertEqual((await invoke('video-editing:panel-show', { id, sessionId: owner, bounds: { x: 0, y: 0, width: 1460, height: 960 } })).ok, true, 'native view shows');
    view = child(id); view.webContents.focus();
    ui = view.webContents.mainFrame.frames.find(frame => frame.url.startsWith('http://127.0.0.1:'))!;
    assert(ui, 'original Studio frame exists');
    const globals = record(await view.webContents.executeJavaScript('({require:typeof require,klaus:typeof window.klaus,bridge:typeof window.klausVideoHost.action})'));
    assertEqual(globals.require, 'undefined', 'no Node'); assertEqual(globals.klaus, 'undefined', 'no main bridge');
    assertEqual(globals.bridge, 'function', 'trusted wrapper bridge');
    const inner = record(await ui.executeJavaScript('({bridge:typeof window.klausVideoHost,klaus:typeof window.klaus,require:typeof require,buttons:document.querySelectorAll("button").length,text:document.body.innerText})'));
    assertEqual(inner.bridge, 'undefined', 'original Studio has no preload capability');
    assertEqual(inner.klaus, 'undefined', 'no host object in native iframe');
    assert(Number(inner.buttons) > 10, 'full original controls are rendered');
    writeFileSync(join(logs, 'native-ui-inspection.json'), JSON.stringify(inner, null, 2));
    const geometry = {
      host: { visible: window.isVisible(), minimized: window.isMinimized(), focused: window.isFocused(), view: view.getVisible(), bounds: view.getBounds() },
      wrapper: await view.webContents.executeJavaScript('({viewport:[innerWidth,innerHeight],visibility:document.visibilityState,frame:document.getElementById("studio").getBoundingClientRect().toJSON(),style:getComputedStyle(document.getElementById("studio")).cssText,messageHidden:document.getElementById("message").hidden})'),
      ui: await ui.executeJavaScript('({viewport:[innerWidth,innerHeight],visibility:document.visibilityState,root:document.getElementById("root")?.getBoundingClientRect().toJSON(),first:document.querySelector("button")?.getBoundingClientRect().toJSON()})'),
    };
    writeFileSync(join(logs, 'native-geometry.json'), JSON.stringify(geometry, null, 2));
    await waitFor(async () => {
      try {
        const image = await view.webContents.capturePage(undefined, { stayHidden: true });
        if (image.isEmpty()) return false;
        const bitmap = image.toBitmap(), colors = new Set<number>();
        for (let at = 0; at + 4 < bitmap.length; at += 508) colors.add(bitmap.readUInt32LE(at));
        if (colors.size < 20) return false;
        writeFileSync(join(logs, 'native-studio.png'), image.toPNG());
        return true;
      } catch { return false; }
    }, 10_000, 'native compositor rendered Studio');
    const browsers = join(logs, 'profile', 'browsers');
    if (existsSync(browsers)) cpSync(browsers, join(service.store.directory(id), 'runtime', 'browsers'), { recursive: true });
  });
  test('agent edits share the visible original undo history and reject a stale revision', async () => {
    const before = await inspect();
    const after = await call('video_editing_execute', { expected_revision: before.revision!, ops: stage(800, 450), label: 'Fixture resize' });
    assert(after.revision !== before.revision, 'saved revision advances');
    assert(readFileSync(join(source, 'film.html'), 'utf8').includes('800'), 'original film saved');
    assert((record(after.history).done as unknown[]).length >= 1, 'native undo step recorded');
    const stale = await service.call(owner, 'video_editing_execute', { id, expected_revision: before.revision!, ops: stage(900, 500) });
    assertEqual(stale.isError, true, 'stale film cannot overwrite manual state');
    const controls = await ui.executeJavaScript('Array.from(document.querySelectorAll("button")).map(b=>({text:b.innerText,label:b.getAttribute("aria-label"),title:b.title}))');
    writeFileSync(join(logs, 'native-controls.json'), JSON.stringify(controls, null, 2));
    const target = record(await ui.executeJavaScript(`(() => { const b=Array.from(document.querySelectorAll('button')).find(b=>/undo|撤销/i.test([b.getAttribute('aria-label'),b.title,b.innerText].join(' '))&&!b.disabled); if(!b)throw Error('Original Undo control not found');const r=b.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`));
    await ui.executeJavaScript('window.__fixtureClicks=[];for(const type of ["pointerdown","mousedown","mouseup","click"])document.addEventListener(type,e=>window.__fixtureClicks.push({type,target:e.target.getAttribute("aria-label"),x:e.clientX,y:e.clientY,trusted:e.isTrusted}),true);true');
    view.webContents.focus();
    view.webContents.debugger.attach('1.3');
    await view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: Number(target.x), y: Number(target.y) });
    await new Promise(resolve => setTimeout(resolve, 100));
    await view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x: Number(target.x), y: Number(target.y), button: 'left', clickCount: 1 });
    await view.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x: Number(target.x), y: Number(target.y), button: 'left', clickCount: 1 });
    view.webContents.debugger.detach();
    await new Promise(resolve => setTimeout(resolve, 100));
    writeFileSync(join(logs, 'native-pointer.json'), JSON.stringify({ target, events: await ui.executeJavaScript('window.__fixtureClicks') }, null, 2));
    await waitFor(async () => Number(record(record((await inspect()).film).stage).w) === 640, 10_000, 'original UI Undo reverses agent batch');
    assertEqual((record((await inspect()).history).undone as unknown[]).length, 1, 'native Undo moves the agent step to redo');
  });
  test('source writes use both shared revision and file hash while preserving native project files', async () => {
    const before = await inspect();
    const read = await call('video_editing_project_file', { action: 'read', path: 'scene.html' });
    const file = record(read.result);
    await call('video_editing_project_file', { action: 'write', path: 'scene.html', expected_revision: before.revision!, expectedSha256: file.sha256!, text: String(file.text).replace('Native video editor', 'Shared source edit') });
    assert(readFileSync(join(source, 'scene.html'), 'utf8').includes('Shared source edit'), 'native source written');
    const current = await inspect();
    const conflict = await service.call(owner, 'video_editing_project_file', { id, action: 'write', path: 'scene.html', expected_revision: current.revision!, expectedSha256: file.sha256!, text: 'stale' });
    assertEqual(conflict.isError, true, 'stale source hash is refused');
    assert(readFileSync(join(source, 'scene.html'), 'utf8').includes('Shared source edit'), 'conflict preserves latest file');
  });
  test('panel hiding and resizing retain the same live instance and ownership', async () => {
    const contentsId = view.webContents.id, before = await inspect();
    await invoke('video-editing:panel-hide'); assertEqual(view.getVisible(), false, 'overlay hides native view');
    assertEqual((await invoke('video-editing:panel-show', { id, sessionId: owner, bounds: { x: 20, y: 30, width: 1000, height: 700 } })).ok, true, 'native view resumes');
    assertEqual(view.webContents.id, contentsId, 'same instance');
    assertEqual(view.getBounds().width, 1000, 'bounds applied');
    assertEqual((await inspect()).revision, before.revision, 'document retained');
    const foreign = await service.call('other-owner', 'video_editing_inspect', { id });
    assertEqual(foreign.isError, true, 'foreign chat cannot inspect');
    const stolen = await service.call('other-owner', 'video_editing_open', { path: source });
    assertEqual(stolen.isError, true, 'foreign chat cannot claim folder');
  });
  test('a failed flush refuses panel close and preserves the visible editor', async () => {
    await view.webContents.executeJavaScript('window.__nativeOriginalFlush=window.klausVideo.flush;window.klausVideo={...window.klausVideo,flush:async()=>{throw Error("Fixture unsaved state")}};true');
    try {
      const reply = await invoke('video-editing:panel-close');
      assertEqual(reply.ok, false, 'close refuses save failure');
      assertEqual(view.getVisible(), true, 'failed close keeps native view');
      assertEqual((await inspect()).id, id, 'same workspace stays reachable');
    } finally { await view.webContents.executeJavaScript('window.klausVideo={...window.klausVideo,flush:window.__nativeOriginalFlush};true'); }
  });
  test('CLI uses this same managed runtime and waits for a terminal acknowledgement', async () => {
    const result = await call('video_editing_command', { args: ['--version'], cwd: source });
    const job = record(result.result);
    assertEqual(job.status, 'completed', 'CLI terminal');
    assert(JSON.stringify(job).includes('0.2.6'), 'pinned CLI version');
    assertEqual(JSON.stringify(result).includes('key='), false, 'no private launch URL');
    assertEqual((await inspect()).id, id, 'same live workspace after CLI');
  });
  test('native player and stage operations use the original frame', async () => {
    const player = await call('video_editing_editor', { target: 'player', command: { type: 'seek', time: 1 } });
    assert(player.playback !== undefined, 'native playback state');
    const stageState = await call('video_editing_editor', { target: 'stage', command: { op: 'tree' } });
    assert(stageState.result !== undefined, 'native stage tree');
  });
  test('all nine original export families run in the owned worker and produce real media', async () => {
    const current = await inspect(), project = record(current.project), P = `/api/projects/${project.id}`;
    const started = await api(`${P}/exports`, { folder: join(logs, 'native-exports'), jobs: [
      { kind: 'video', name: 'native-video', shortEdge: 360, fps: 10, codec: 'h264', hardware: false, burnSubtitles: true },
      { kind: 'gif', name: 'native-gif', width: 320, fps: 5 },
      { kind: 'audio', name: 'native-audio', format: 'wav', mix: true, stems: true },
      { kind: 'stills', name: 'native-stills', as: 'zip', shortEdge: 360, at: [0.5, 2] },
      { kind: 'poster', name: 'native-poster', shortEdge: 360, at: 1 },
      { kind: 'subtitles', name: 'native-subtitles', format: 'srt' },
      { kind: 'slides', name: 'native-slides', format: 'pptx', shortEdge: 360, at: [0.5, 2] },
      { kind: 'nle', name: 'native-timeline', format: 'fcpxml', fps: 10, audio: 'clips', media: 'copy', subtitles: true },
      { kind: 'project', name: 'native-project', as: 'zip', parts: ['history'] },
    ] });
    const ids = (started.exports as Data[]).map(job => job.id);
    writeFileSync(join(logs, 'native-exports-start.json'), JSON.stringify(started, null, 2));
    let exports: Data[] = [];
    await waitFor(async () => {
      const status = await api(`${P}/exports`);
      exports = ((status.jobs ?? status.exports) as Data[]).filter(job => ids.includes(job.id));
      writeFileSync(join(logs, 'native-exports.json'), JSON.stringify(exports, null, 2));
      await new Promise(resolve => setTimeout(resolve, 250));
      return exports.length === 9 && exports.every(job => ['done', 'failed', 'cancelled'].includes(String(job.status)));
    }, 150_000, 'all native exports reach terminal state');
    for (const job of exports) assertEqual(job.status, 'done', JSON.stringify(job));
    const video = exports.find(job => job.kind === 'video')!;
    const movie = (video.outputs as string[]).find(file => file.endsWith('.mp4')) ?? String(video.out);
    const probe = JSON.parse(execFileSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', movie], { encoding: 'utf8' }));
    writeFileSync(join(logs, 'native-ffprobe.json'), JSON.stringify(probe, null, 2));
    assert(probe.streams.some((stream: { codec_type: string; width: number }) => stream.codec_type === 'video' && stream.width === 640), 'actual video stream');
    assert(probe.streams.some((stream: { codec_type: string }) => stream.codec_type === 'audio'), 'actual audio stream');
    execFileSync('/opt/homebrew/bin/ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', movie, '-frames:v', '1', join(logs, 'native-decoded-frame.png')]);
  });
  test('successful close flushes, and reopening preserves native film state', async () => {
    await waitFor(async () => Boolean(await ui.executeJavaScript('Array.from(document.querySelectorAll(".stage iframe")).some(frame=>getComputedStyle(frame).opacity==="1")')), 15_000, 'the original preview displays a completed film frame');
    writeFileSync(join(logs, 'native-studio-ready.png'), (await view.webContents.capturePage(undefined, { stayHidden: true })).toPNG());
    const before = await inspect();
    assertEqual((await invoke('video-editing:panel-close')).ok, true, 'clean close acknowledged');
    assertEqual(view.getVisible(), false, 'view hidden');
    await call('video_editing_open');
    assertEqual((await inspect()).revision, before.revision, 'saved revision remains');
  });
  const result = await h.finish(join(logs, 'native-fixture-result.json'), 'video-editing-fixture');
  try { await service.dispose(); } finally { clearTimeout(deadline); window.destroy(); ipcMain.removeHandler(HOST_CHANNELS.coreInvoke); protocol.unhandle(APP_SCHEME); }
  writeFileSync(join(logs, 'native-profile.json'), JSON.stringify({ profile, source, id }, null, 2));
  return result;
}
void main().then(code => app.exit(code), error => { appendFileSync(join(logs, 'native-fixture-fatal.log'), String(error?.stack ?? error) + '\n'); app.exit(1); });
