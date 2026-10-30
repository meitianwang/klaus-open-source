import { app, BrowserWindow, ipcMain, nativeImage, protocol, webContents, type WebContentsView } from 'electron';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PrototypeService } from '../main/prototype/service';
import { CanvasDocumentStore } from '../main/canvas/document-store';
import { registerPrototypeHandlers } from '../main/ipc/handlers/prototype';
import { ChannelRegistry } from '../main/ipc/registry';
import { RoleTable } from '../main/ipc/contract';
import { IpcRouter } from '../main/ipc/router';
import { handleCoreInvoke, WindowRoleRegistry } from '../main/ipc/binding';
import { HOST_CHANNELS } from '../main/ipc/host-channels';
import { appUrl, APP_SCHEME, registerAppScheme } from '../main/app/protocol';
import { record, type Data } from '../main/visuals/data';
import { assert, assertEqual, assertRejects, Harness, waitFor } from './harness';
const { officialPluginRoot } = require('../../scripts/official-plugin-root.cjs') as typeof import('../scripts/official-plugin-root.cjs');
const prototypePluginRoot = officialPluginRoot('prototype-studio');

const profile = process.env.KLAUS_PROTOTYPE_FIXTURE_PROFILE;
if (!profile) throw new Error('An isolated interface design fixture profile is required.');
const logs = resolve(__dirname, '../prototype-figcraft-logs');
mkdirSync(logs, { recursive: true });
app.setPath('userData', profile);
registerAppScheme();
app.on('window-all-closed', () => {});

async function main(): Promise<number> {
  await app.whenReady();
  const h = new Harness();
  const deadline = setTimeout(() => { appendFileSync(join(logs, 'fixture-progress.log'), 'Fixture deadline exceeded.\n'); app.exit(1); }, 90_000);
  const test = (name: string, body: () => Promise<void>): Promise<void> => h.test(name, async () => {
    appendFileSync(join(logs, 'fixture-progress.log'), `${new Date().toISOString()} START ${name}\n`);
    try { await body(); }
    finally { appendFileSync(join(logs, 'fixture-progress.log'), `${new Date().toISOString()} END ${name}\n`); }
  });
  protocol.handle(APP_SCHEME, () => new Response('<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><h1>Interface design fixture</h1>', { headers: { 'Content-Type': 'text/html' } }));
  const window = new BrowserWindow({ width: 1520, height: 1060, show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  await window.loadURL(appUrl('index.html'));
  const roles = new WindowRoleRegistry(), registry = new ChannelRegistry();
  const documents = new CanvasDocumentStore(profile!, input => String(input));
  const service = new PrototypeService({ configRoot: profile!, window,
    language: () => fixtureLanguage,
    readLegacy: path => documents.get(path),
    pluginRoot: () => prototypePluginRoot,
    registerRenderer: (id, role) => {
      roles.register(id, role);
      webContents.fromId(id)?.on('console-message', (_event, details) => appendFileSync(join(logs, 'editor-console.txt'), JSON.stringify(details) + '\n'));
    },
    unregisterRenderer: id => roles.unregister(id),
    emit: (channel, data) => appendFileSync(join(logs, 'editor-events.txt'), JSON.stringify({ channel, data }) + '\n'),
    log: (event, data) => appendFileSync(join(logs, 'editor-events.txt'), JSON.stringify({ event, data }) + '\n'),
    chooseExportPath: async name => join(profile!, name),
  });
  registerPrototypeHandlers(registry, { service });
  const router = new IpcRouter({ registry, roles: RoleTable.load() });
  ipcMain.handle(HOST_CHANNELS.coreInvoke, (event, payload: unknown) => {
    const fields = record(payload);
    return handleCoreInvoke({ roleOf: id => roles.resolver()(id), route: (caller, channel, args) => router.route(caller, channel, args), windowOp: () => { throw new Error('The editor has no window actions.'); } }, event, String(fields.command), fields.args);
  });
  const invoke = async (channel: string, fields: Data = {}): Promise<Data> => {
    const handler = registry.lookup(channel); assert(handler, `${channel} registered`);
    return record(await handler({ role: 'main', senderId: window.webContents.id, channel, args: [fields] }));
  };
  let id = '';
  const owner = 'prototype-fixture-owner';
  let fixtureLanguage = 'zh-CN';
  let view: WebContentsView;
  const call = async (name: string, fields: Data = {}): Promise<Data> => {
    const response = await service.call(owner, name, { id, ...fields });
    assert(response.isError !== true, JSON.stringify(response));
    return record(response.structuredContent);
  };
  const inspect = () => call('prototype_inspect', { depth: 8, all_pages: true });
  const edit = async (commands: Data[], fields: Data = {}): Promise<Data> => {
    const current = await inspect();
    return call('prototype_execute', { expected_revision: Number(current.revision), commands, ...fields });
  };
  const child = (projectId: string): WebContentsView => {
    const result = window.contentView.children.find(candidate => 'webContents' in candidate && new URL((candidate as WebContentsView).webContents.getURL()).searchParams.get('id') === projectId) as WebContentsView;
    assert(result, `editor view for ${projectId}`);
    return result;
  };
  const frames = async () => view.webContents.executeJavaScript('new Promise(resolve => { requestAnimationFrame(() => requestAnimationFrame(resolve)); setTimeout(resolve, 250); })');
  const native = async (method: string, params: Data = {}): Promise<Data> => record(await view.webContents.executeJavaScript(`window.klausPrototype.request(${JSON.stringify({ method, params })})`));
  const contains = (value: unknown, name: string): boolean => JSON.stringify(value).includes(JSON.stringify(name));
  test('the complete offline editor boots through its isolated preload and authoritative host store', async () => {
    const opened = await service.call('prototype-fixture-owner', 'prototype_open', { title: 'Fixture interface design' });
    writeFileSync(join(logs, 'initial-open.json'), JSON.stringify(opened, null, 2));
    assert(opened.isError !== true, JSON.stringify(opened));
    id = String(record(opened.structuredContent).id);
    assertEqual((await invoke('prototype:panel-show', { id, sessionId: 'prototype-fixture-owner', bounds: { x: 0, y: 0, width: 1500, height: 1000 } })).ok, true, 'editor shown');
    window.showInactive();
    view = child(id);
    assert(view, 'native child editor exists');
    await waitFor(async () => await view.webContents.executeJavaScript('document.getElementById("startup").hidden && document.querySelector("canvas").width > 0'), 15_000, 'editor paints after its first saved snapshot');
    await view.webContents.executeJavaScript('new Promise(resolve => { requestAnimationFrame(() => requestAnimationFrame(resolve)); setTimeout(resolve, 250); })');
    writeFileSync(join(logs, 'initial-ui.json'), JSON.stringify(await view.webContents.executeJavaScript('window.klausPrototype.request({method:"ui.inspect",params:{}})'), null, 2));
    await waitFor(async () => {
      try {
        const image = await view.webContents.capturePage(undefined, { stayHidden: true });
        if (image.isEmpty()) return false;
        writeFileSync(join(logs, 'prototype-editor.png'), image.toPNG());
        return true;
      } catch { return false; }
    }, 6000, 'the editor compositor produces a captured frame');
    const globals = await view.webContents.executeJavaScript('({require:typeof require,process:typeof process,klaus:typeof window.klaus,bridge:typeof window.klausPrototypeHost.action})');
    assertEqual(JSON.stringify(globals), JSON.stringify({ require: 'undefined', process: 'undefined', klaus: 'undefined', bridge: 'function' }), 'only the narrow lifecycle bridge is exposed');
    assert(service.store.load(id, 'prototype-fixture-owner').version >= 1, 'initial native workspace saved');
  });
  test('manual pointer editing and agent inspection use the same live document', async () => {
    view.webContents.focus();
    await view.webContents.executeJavaScript('document.querySelector("canvas").focus()');
    view.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'R' });
    view.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'R' });
    await frames();
    view.webContents.sendInputEvent({ type: 'mouseMove', x: 600, y: 350 });
    view.webContents.sendInputEvent({ type: 'mouseDown', x: 600, y: 350, button: 'left', clickCount: 1 });
    await frames();
    view.webContents.sendInputEvent({ type: 'mouseMove', x: 760, y: 450, button: 'left' });
    await frames();
    view.webContents.sendInputEvent({ type: 'mouseUp', x: 760, y: 450, button: 'left', clickCount: 1 });
    await frames();
    const state = await inspect();
    writeFileSync(join(logs, 'manual-edit.json'), JSON.stringify(state, null, 2));
    assert(contains(state.result, 'Rectangle'), 'manual rectangle is visible in agent inspection');
    const response = await edit([{ command: 'node.create', params: { type: 'rectangle', name: 'Agent rectangle', x: 80, y: 80, width: 160, height: 100, props: { fills: ['#635bff'] } } }], { label: 'Agent rectangle' });
    assert(typeof response.revision === 'number', 'agent edit returns a revision');
    await frames();
    assert(contains((await inspect()).result, 'Agent rectangle'), 'agent edit is present in the shared design');
    const image = await view.webContents.capturePage(undefined, { stayHidden: true });
    writeFileSync(join(logs, 'prototype-shared-edit.png'), image.toPNG());
  });
  test('stale edits and failed atomic batches preserve the design and history', async () => {
    const before = await inspect();
    await edit([{ command: 'node.create', params: { type: 'rectangle', name: 'Current edit', width: 80, height: 60 } }]);
    const stale = await service.call(owner, 'prototype_execute', { id, expected_revision: Number(before.revision), commands: [{ command: 'node.create', params: { type: 'rectangle', name: 'Stale edit' } }] });
    assertEqual(stale.isError, true, 'stale revision refused');
    const stable = await inspect();
    const failed = await service.call(owner, 'prototype_execute', { id, expected_revision: Number(stable.revision), commands: [
      { command: 'node.create', params: { type: 'rectangle', name: 'Rolled back edit', width: 30, height: 40 } },
      { command: 'node.create', params: { type: 'unknown-fixture-shape' } },
    ] });
    assertEqual(failed.isError, true, 'invalid atomic step refused');
    const after = await inspect();
    assert(!contains(after.result, 'Rolled back edit') && !contains(after.result, 'Stale edit'), 'no partial or stale layers');
    assertEqual(JSON.stringify(record(after.result).history), JSON.stringify(record(stable.result).history), 'failed batch retains undo history');
    const commands = await call('prototype_commands', { query: 'doc.switch' });
    assert(Number(commands.total) > 0, 'native document switching is discoverable');
  });
  test('native and rendered exports contain the expected file formats', async () => {
    const signatures: Record<string, (bytes: Buffer) => boolean> = {
      figcraft: bytes => bytes.subarray(0, 2).toString() === 'PK',
      png: bytes => bytes.subarray(1, 4).toString() === 'PNG',
      jpg: bytes => bytes[0] === 0xff && bytes[1] === 0xd8,
      webp: bytes => bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP',
      svg: bytes => bytes.toString().includes('<svg'),
      pdf: bytes => bytes.subarray(0, 5).toString() === '%PDF-',
      fig: bytes => bytes.subarray(0, 2).toString() === 'PK' && bytes.includes(Buffer.from('canvas.fig')),
    };
    const exports: Data[] = [];
    for (const [format, check] of Object.entries(signatures)) {
      const result = await call('prototype_export', { format });
      const bytes = readFileSync(String(result.path));
      assert(check(bytes), `${format} signature`);
      exports.push({ format, bytes: bytes.length, path: result.path! });
    }
    writeFileSync(join(logs, 'exports.json'), JSON.stringify(exports, null, 2));
  });
  test('hidden editors retain identity and reject another chat owner', async () => {
    const identity = view.webContents.id;
    await invoke('prototype:panel-hide');
    assert(!view.getVisible(), 'view hidden');
    await invoke('prototype:panel-show', { id, sessionId: owner, bounds: { x: 0, y: 0, width: 1500, height: 1000 } });
    assertEqual(child(id).webContents.id, identity, 'same editor shown');
    const rejected = await service.call('another-fixture-owner', 'prototype_inspect', { id });
    assertEqual(rejected.isError, true, 'other owner denied');
    const denied = await view.webContents.executeJavaScript('window.klausPrototypeHost.action({type:"settings",key:"secret"}).then(value => value?.ok === false, () => true)');
    assertEqual(denied, true, 'narrow host action rejects unrelated operations');
  });
  test('workspace eviction restores native tabs, branches and undo history', async () => {
    await edit([{ command: 'file.new', params: { name: 'Second document' } }]);
    await edit([{ command: 'branch.create', params: { name: 'Alternative' } }]);
    const before = await inspect();
    assertEqual((record(before.workspace).files as unknown[]).length, 3, 'all native tabs exposed');
    const oldContents = view.webContents.id;
    await invoke('prototype:panel-close');
    for (let index = 0; index < 3; index++) {
      const opened = await service.call(owner, 'prototype_open', { title: `Eviction fixture ${index}` });
      assert(opened.isError !== true, JSON.stringify(opened));
    }
    const reopened = await call('prototype_open');
    assertEqual((record(reopened.workspace).files as unknown[]).length, 3, 'native tabs restored');
    view = child(id);
    assert(view.webContents.id !== oldContents, 'a new editor was loaded from persisted native files');
    await edit([{ command: 'doc.switch', params: { index: 0 } }]);
    const restored = await inspect();
    assert(contains(restored.result, 'Agent rectangle'), 'main file restored');
    await edit([{ command: 'edit.undo', params: {} }]);
    assert(!contains((await inspect()).result, 'Current edit'), 'undo history remains functional');
    await edit([{ command: 'edit.redo', params: {} }]);
    assert(contains((await inspect()).result, 'Current edit'), 'redo history remains functional');
  });
  test('static legacy snapshots import through the native engine without rewriting their source or history', async () => {
    const file = join(profile!, 'saved.canvas.tsx');
    writeFileSync(file, 'throw new Error("The legacy source must never execute");\n');
    const document = { schema: 1, name: 'Legacy fixture', palette: { brand: '#635bff', surface: '#ffffff', ink: '#17243a' }, components: [],
      pages: [{ id: 'home', name: 'Home', device: 'mobile', width: 390, height: 844, layers: [
        { id: 'title', kind: 'text', name: 'Legacy headline', x: 28, y: 80, w: 325, h: 110, text: 'Saved design', fill: '#ffffff', color: '#17243a', stroke: '#d8e0ec', radius: 12, fontSize: 36, image: '', action: null, componentId: null, layout: 'scale' },
      ] }] };
    documents.apply(file, 0, document);
    documents.apply(file, 1, document);
    const source = readFileSync(file), archive = readFileSync(file.replace('.tsx', '.document.json'));
    const imported = await service.call(owner, 'prototype_open', { legacy_canvas: file });
    assert(imported.isError !== true, JSON.stringify(imported));
    const data = record(imported.structuredContent);
    assert(contains(data.result, 'Legacy headline'), 'native editable layers imported');
    assert(readFileSync(file).equals(source), 'source preserved');
    assert(readFileSync(file.replace('.tsx', '.document.json')).equals(archive), 'archive and history preserved');
    assertEqual(record(JSON.parse(readFileSync(String(data.legacyBackup), 'utf8'))).version, 2, 'snapshot backup retained');
    const count = service.store.list(owner).length;
    documents.apply(file, 2, { ...document, components: [{ id: 'unsupported' }] });
    const unsupported = await service.call(owner, 'prototype_open', { legacy_canvas: file });
    assertEqual(unsupported.isError, true, 'unsupported structure refused');
    assertEqual(service.store.list(owner).length, count, 'no phantom project created');
  });
  test('save failures preserve dirty edits, permit exports and block closure until recovery', async () => {
    view = child(id);
    const original = service.store.save.bind(service.store);
    let fail = true;
    service.store.save = (...args) => { if (fail) throw new Error('Fixture storage unavailable'); return original(...args); };
    try {
      const current = await inspect();
      const result = await service.call(owner, 'prototype_execute', { id, expected_revision: Number(current.revision), commands: [{ command: 'node.create', params: { type: 'rectangle', name: 'Unsaved recoverable edit', width: 40, height: 50 } }] });
      assertEqual(result.isError, true, 'save error returned');
      assert(contains((await inspect()).result, 'Unsaved recoverable edit'), 'in-memory edit retained');
      await call('prototype_export', { format: 'png' });
      await assertRejects(() => service.prepareToClose(), 'closure rejected during save failure');
      assert(!view.webContents.isDestroyed(), 'editor retained after failed close');
      fail = false;
      await view.webContents.executeJavaScript('window.klausPrototype.flush()');
      assert(contains((await inspect()).result, 'Unsaved recoverable edit'), 'recovered save keeps edits');
    } finally { fail = false; service.store.save = original; }
  });
  // These two cases run after the eviction test on purpose: they append undo
  // steps to the main document, and the eviction case asserts that a single
  // undo on it removes a specific earlier layer.
  test('a Chinese text layer exports with glyph outlines from the embedded fonts', async () => {
    // A wasm target cannot scan system fonts, so the editor ships its own font
    // set. Without it, text layout produced no glyph runs and exports silently
    // dropped every text layer; the pixel count below is the regression gate.
    await edit([{ command: 'text.create', params: { text: '植物大战僵尸', x: 40, y: 1240, props: { fill: '#111111', fontSize: 48 } } }]);
    assert(contains((await inspect()).result, '植物大战僵尸'), 'the Chinese text layer is in the shared design');
    const result = await call('prototype_export', { format: 'png' });
    const image = nativeImage.createFromPath(String(result.path));
    assert(!image.isEmpty(), 'exported png decodes');
    const bytes = image.toBitmap();
    let ink = 0;
    for (let offset = 0; offset + 3 < bytes.length; offset += 4) {
      if (bytes[offset] === 0x11 && bytes[offset + 1] === 0x11 && bytes[offset + 2] === 0x11) ink += 1;
    }
    writeFileSync(join(logs, 'cjk-export.png'), image.toPNG());
    assert(ink > 500, `Chinese glyphs rendered into the export (${ink} ink pixels)`);
    // The eviction and save-failure cases leave the panel hidden; a capture
    // needs the editor view attached and visible again.
    assertEqual((await invoke('prototype:panel-show', { id, sessionId: owner, bounds: { x: 0, y: 0, width: 1500, height: 1000 } })).ok, true, 'editor shown for the capture');
    await frames();
    const shot = await view.webContents.capturePage(undefined, { stayHidden: true });
    writeFileSync(join(logs, 'cjk-editor.png'), shot.toPNG());
  });
  test('the editor UI follows the application language choice and live language changes', async () => {
    // The isolated editor used to read the system locale; it must follow the
    // application's language setting instead, including while a panel is open.
    assertEqual(String((await native('ui.language')).result), 'zh-Hans', 'the editor starts in the application language');
    assertEqual(await view.webContents.executeJavaScript('document.documentElement.lang'), 'zh-CN', 'the document language follows the application language');
    fixtureLanguage = 'en-US';
    service.refreshLanguage();
    await frames();
    assertEqual(String((await native('ui.language')).result), 'en', 'an open editor follows a live language change');
    assertEqual(await view.webContents.executeJavaScript('document.documentElement.lang'), 'en', 'the document language follows the live change');
    fixtureLanguage = 'zh-CN';
    service.refreshLanguage();
    await frames();
  });
  test('the path firewall names file commands and lets geometry path data through', async () => {
    // SVG path data in vector.create is geometry, not a filesystem path; only
    // file.* commands read or write bytes and may carry one. The refusal names
    // the offending command and its batch index so a caller fixes it in one pass.
    const vec = await edit([
      { command: 'frame.create', params: { x: 0, y: 1500, width: 400, height: 300, name: 'Guard frame' } },
      { command: 'vector.create', params: { parent: { $step: 0 }, path: 'M0 110 L145 0 L290 110 Z', x: 52, y: 1690, width: 290, height: 110, props: { fill: '#C0563E' } } },
    ]);
    assert(typeof vec.revision === 'number', `geometry path data passes the file firewall: ${JSON.stringify(vec)}`);
    const refused = await service.call(owner, 'prototype_execute', { id, expected_revision: Number(vec.revision), commands: [{ command: 'file.open', params: { path: '/tmp/missing-interface-design.fig' } }] });
    assertEqual(refused.isError, true, 'a file command carrying a filesystem path is refused');
    const message = JSON.stringify(refused.content);
    assert(message.includes('command[0]') && message.includes('file.open'), `the refusal names the offending command and index: ${message}`);
  });
  test('an empty native workspace reopens successfully', async () => {
    let current = await inspect();
    while ((record(current.workspace).files as unknown[]).length) {
      await edit([{ command: 'file.close', params: { index: 0, force: true } }]);
      current = await inspect();
    }
    assertEqual(record(current.result).empty, true, 'empty workspace inspect succeeds');
    await call('prototype_open');
    assertEqual(record((await inspect()).result).empty, true, 'empty workspace remains empty');
  });
  test('concurrent close and dispose wait for the same flush barrier', async () => {
    const original = service.flush.bind(service);
    let release!: () => void, entered = false;
    const barrier = new Promise<void>(resolve => { release = resolve; });
    service.flush = async () => { entered = true; await barrier; await original(); };
    const preparing = service.prepareToClose();
    await waitFor(() => entered, 1000, 'flush entered');
    let disposed = false;
    const closing = service.dispose().then(() => { disposed = true; });
    await Promise.resolve(); await Promise.resolve();
    assertEqual(disposed, false, 'dispose still awaits the shared barrier');
    release();
    await Promise.all([preparing, closing]);
    assertEqual(disposed, true, 'dispose completes after flush');
  });
  const result = await h.finish(join(logs, 'prototype-fixture-result.json'), 'prototype-fixture');
  await service.dispose();
  clearTimeout(deadline);
  window.destroy();
  ipcMain.removeHandler(HOST_CHANNELS.coreInvoke);
  protocol.unhandle(APP_SCHEME);
  return result;
}
void main().then(code => app.exit(code), error => {
  appendFileSync(join(logs, 'fixture-fatal.txt'), String(error?.stack ?? error) + '\n');
  app.exit(1);
});
