import strict from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from './harness';
import { MacOsConnectors } from '../main/services/macos-connectors/service';
import { MACOS_TOOL_CONTRACTS } from '../main/services/macos-connectors/tool-contracts';
import { keyAction, resolvePoint } from '../main/services/macos-connectors/app-ui-model';
import { SCREEN_SCRIPT } from '../main/services/macos-connectors/app-ui-script';
import type { MacOsCommand, MacOsCommands } from '../main/native/macos-command';
import type { MacOsCallContext, Row } from '../main/services/macos-connectors/types';

const h = new Harness(), directory = mkdtempSync(join(tmpdir(), 'klaus-macos-app-ui-'));
const cleanups: Array<() => Promise<unknown>> = [];
const uiNode = { path: '1.1', role: 'AXButton', subrole: null, name: 'Own\nButton', value: null, description: 'Own description', identifier: 'own-button', enabled: true, focused: false, bounds: { x: 100, y: 100, width: 80, height: 24 } };
const tree = { appName: 'Own Fixture', pid: 42, nodes: [uiNode], truncated: false };
const screen = { left: -1000, top: -500, width: 2000, height: 1500, right: 1000, bottom: 1000, screens: [{ left: 0, top: 0, width: 1000, height: 1000, scale: 2 }, { left: -1000, top: -500, width: 1000, height: 1000, scale: 1 }] };
const isActivation = (request: MacOsCommand) => (request.args[1] ?? '').includes('Application activation timed out');
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(run?: MacOsCommands['run']) {
  const requests: MacOsCommand[] = []; let reply = '{"ok":true}', screens = screen, probe = 'true';
  const service = new MacOsConnectors({ configRoot: directory, userHome: directory, platform: 'darwin', commands: {
    available: async () => true, close: async () => ({ complete: true }), run: async (request, signal) => {
      requests.push(request); if (run) return run(request, signal);
      if (request.executable === '/usr/bin/open') return ''; if (isActivation(request)) return 'ok';
      if (request.args.includes(SCREEN_SCRIPT)) return JSON.stringify(screens);
      if (request.args[1] === 'tell application "System Events" to return UI elements enabled') return probe;
      if (request.executable === '/usr/sbin/screencapture') { const bytes = Buffer.alloc(24); Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes); bytes.writeUInt32BE(200, 16); bytes.writeUInt32BE(100, 20); writeFileSync(request.args.at(-1)!, bytes); return ''; }
      return reply;
    },
  } });
  service.attachSession('fixture'); cleanups.push(() => service.close());
  const context: MacOsCallContext = { sessionId: 'fixture', turnId: 'turn', signal: new AbortController().signal, assertCurrent() {}, elicit: async () => ({ action: 'accept' }) };
  const call = async (tool: string, args: Row = {}, ctx = context) => JSON.parse((await service.call('macos-app-ui', tool, args, ctx)).content[0]!.text);
  return { service, requests, context, call, setReply(value: unknown) { reply = JSON.stringify(value); }, setScreen(value: typeof screen) { screens = value; }, setProbe(value: string) { probe = value; } };
}
h.test('sixteen App UI contracts declare actual dispatch and per-session snapshot semantics', async () => {
  strict.equal(createHash('sha256').update(JSON.stringify(MACOS_TOOL_CONTRACTS['macos-app-ui'])).digest('hex'), '058c612355d18a80438696cab7a8dc5e5659dc5a08a590cb3e7e3e24dd2bf365');
  const { service, requests } = fixture(); strict.equal((await service.capability('macos-app-ui'))?.tools.length, 16); strict.equal(requests.length, 0);
});
h.test('permission probe distinguishes UI reads from input status and no-window results from permission errors', async () => {
  const { call, setReply } = fixture(); setReply({ applicationProcessCount: 1, frontmostApp: 'Own Fixture', frontmostWindowCount: 0, frontmostUiElementCount: 0, uiEventsEnabled: false });
  const capability = await call('app_ui_check_permission'); strict.equal(capability.capabilities.readUiTree, true); strict.equal(capability.capabilities.clickCoordinates, false);
  setReply({ appName: 'Own Fixture', windows: [] }); const windows = await call('app_ui_list_windows'); strict.equal(windows.permissionEvidence, 'no_ax_window_not_permission_denied'); strict.equal(windows.count, 0);
  const denied = fixture(async () => { throw new Error('System Events access denied'); }); const failure = await denied.call('app_ui_check_permission'); strict.equal(failure.ok, false); strict.equal(failure.capabilities.readUiTree, false);
});
h.test('paths require a current app process snapshot, do not cross owners, and expire after turn or detach', async () => {
  const { call, setReply, service, context, requests } = fixture(); setReply(tree); await call('app_ui_get_tree', { appName: tree.appName });
  setReply({ ok: true, dryRun: true, target: uiNode }); strict.equal((await call('app_ui_click_element', { elementPath: '1.1', dryRun: true })).ok, true);
  strict.match(requests.at(-1)!.args[1]!, /unix id of p is not 42/); strict.match(requests.at(-1)!.args[1]!, /snapshot element changed/);
  const count = requests.length; service.attachSession('other'); strict.equal((await call('app_ui_click_element', { elementPath: '1.1', dryRun: true }, { ...context, sessionId: 'other' })).ok, false);
  strict.equal((await call('app_ui_click_element', { appName: 'Different', elementPath: '1.1', dryRun: true })).ok, false);
  context.turnId = 'next'; strict.equal((await call('app_ui_click_element', { elementPath: '1.1', dryRun: true })).ok, false); strict.equal(requests.length, count);
  await service.detachSession('fixture'); service.attachSession('fixture'); context.turnId = 'turn'; strict.equal((await call('app_ui_click_element', { elementPath: '1.1', dryRun: true })).ok, false);
});
h.test('failed snapshot refresh clears old paths and malformed metadata never becomes a usable tree', async () => {
  const { call, setReply, requests } = fixture(); setReply(tree); await call('app_ui_get_tree'); setReply({ ...tree, nodes: [uiNode, uiNode] });
  strict.equal((await call('app_ui_get_tree')).ok, false); const before = requests.length; strict.equal((await call('app_ui_click_element', { elementPath: '1.1' })).ok, false); strict.equal(requests.length, before);
  setReply({ ...tree, nodes: [{ ...uiNode, enabled: 'true' }] }); strict.equal((await call('app_ui_get_tree')).ok, false);
});
h.test('action inputs are validated before activation and typing fallback is chosen before any value mutation', async () => {
  const { call, requests } = fixture();
  for (const [tool, args] of [['app_ui_set_value', { query: 'Own', value: 'x'.repeat(50_001) }], ['app_ui_select_menu_item', { appName: 'Own', menuPath: ['File'] }], ['app_ui_press_key', { key: 'return', modifiers: ['unknown'] }]] as const) strict.equal((await call(tool, args)).ok, false);
  strict.equal(requests.length, 0); await call('app_ui_set_value', { query: 'Own', value: 'Owned text', fallbackTyping: true });
  const script = requests.at(-1)!.args[1]!; strict.match(script, /if settable_ then/); strict.match(script, /else if true then/); strict.doesNotMatch(script.slice(script.lastIndexOf('set settable_ to false')), /on error/); strict.match(script, /requested value was not confirmed/);
  strict.match(script, /Select All was not confirmed; no replacement text was inserted/); strict.match(script, /field changed before replacement/);
});
h.test('uncertain clicks are not retried through click or return and owner cancellation is not converted to a soft success', async () => {
  let actions = 0;
  const uncertain = fixture(async request => { if (request.executable === '/usr/bin/open') return ''; if (isActivation(request)) return 'ok'; actions++; throw new Error('Uncertain AXPress result'); });
  strict.equal((await uncertain.call('app_ui_click_element', { query: 'Own', appName: 'Own Fixture' })).ok, false); strict.equal(actions, 1);
  const entered = deferred(), gate = deferred(); const closing = fixture(async () => { entered.resolve(); await gate.promise; return '{"found":false}'; });
  const pending = closing.call('app_ui_wait_for', { query: 'Own', timeoutMs: 5000 }), rejected = strict.rejects(pending); await entered.promise;
  strict.deepEqual(await closing.service.close(0), { complete: false }); gate.resolve(); await rejected; strict.deepEqual(await closing.service.close(), { complete: true }); strict.equal(closing.requests.length, 1);
});
h.test('typed input and key actions report dispatch with the focused element rather than an inferred visible outcome', async () => {
  const { call, setReply, requests } = fixture(); setReply({ ok: true, focusedRole: 'AXTextField', focusedLabel: 'Own\nField' });
  const typed = await call('app_ui_type_text', { text: '你好😀' }); strict.equal(typed.charCount, 4); strict.equal(typed.focusedRole, 'AXTextField'); strict.equal(typed.requested, true);
  strict.match(requests.at(-1)!.args[1]!, /Focus changed during typing/);
  const before = requests.length, dry = await call('app_ui_press_key', { key: 'return', modifiers: ['cmd', 'shift'], dryRun: true }); strict.equal(dry.dryRun, true); strict.equal(requests.length, before);
  strict.equal(keyAction('return', ['cmd', 'shift']), 'key code 36 using {command down, shift down}'); strict.throws(() => keyAction('unknown', []), /Unsupported/);
});
h.test('pixel mappings support negative displays, require complete explicit geometry and reject out-of-image coordinates', () => {
  const mapping = { path: 'own.png', screenshotPixelWidth: 200, screenshotPixelHeight: 100, screenshotScreenX: -1000, screenshotScreenY: -500, screenshotScreenWidth: 100, screenshotScreenHeight: 50 };
  strict.deepEqual(resolvePoint({ x: 100, y: 50, coordinateSpace: 'screenshotPixels' }, mapping).x, -950);
  strict.equal(resolvePoint({ x: 100, y: 50, coordinateSpace: 'screenshotPixels', ...mapping }).y, -475);
  strict.throws(() => resolvePoint({ x: 1, y: 1, coordinateSpace: 'screenshotPixels' }), /missing_screenshot_mapping/);
  strict.throws(() => resolvePoint({ x: 1, y: 1, coordinateSpace: 'screenshotPixels', screenshotPixelWidth: 20 }, mapping), /all six/);
  strict.throws(() => resolvePoint({ x: 200, y: 1, coordinateSpace: 'screenshotPixels' }, mapping), /outside/);
});
h.test('capture mappings stay in their session and turn, reject display changes, and dry-run respects actual event status', async () => {
  const { call, service, context, setScreen, setProbe, requests } = fixture();
  const capture = await call('app_ui_capture_screen', { path: join(directory, 'owned-capture.png'), region: '100,100,100,50' }); strict.equal(capture.ok, true);
  strict.equal(capture.clickMapping.screenshotPixelWidth, 200); strict.equal(capture.clickMapping.screenshotScreenWidth, 100);
  const dry = await call('app_ui_click_at', { x: 100, y: 50, coordinateSpace: 'screenshotPixels', dryRun: true }); strict.equal(dry.ok, true); strict.equal(dry.resolved.x, 150);
  service.attachSession('other'); strict.equal((await call('app_ui_click_at', { x: 100, y: 50, coordinateSpace: 'screenshotPixels', dryRun: true }, { ...context, sessionId: 'other' })).ok, false);
  context.turnId = 'next'; strict.equal((await call('app_ui_click_at', { x: 100, y: 50, coordinateSpace: 'screenshotPixels', dryRun: true })).ok, false); context.turnId = 'turn';
  setScreen({ ...screen, screens: [{ ...screen.screens[0]!, scale: 1 }] }); strict.match((await call('app_ui_click_at', { x: 100, y: 50, coordinateSpace: 'screenshotPixels', dryRun: true })).error, /geometry changed/);
  setScreen(screen); setProbe('false'); strict.equal((await call('app_ui_click_at', { x: 100, y: 100, dryRun: true })).ok, false);
  strict.equal(requests.some(row => (row.args[1] ?? '').includes('click p at')), false);
});
h.test('invalid capture inputs cause no activation and invalidate the previous screenshot mapping', async () => {
  const { call, requests } = fixture();
  await call('app_ui_capture_screen', { path: join(directory, 'before-invalid-capture.png') });
  const before = requests.length;
  strict.equal((await call('app_ui_capture_screen', { appName: 'Own', path: 'relative.png' })).ok, false);
  strict.equal((await call('app_ui_click_at', { x: 1, y: 1, coordinateSpace: 'screenshotPixels', dryRun: true })).ok, false);
  for (const region of ['1,2,0,5', '1,,10,5', '1,2,Infinity,5']) strict.equal((await call('app_ui_capture_screen', { appName: 'Own', region })).ok, false);
  strict.equal(requests.length, before);
});
if (process.platform === 'darwin') h.test('every generated App UI script compiles against System Events without executing private UI actions', async () => {
  const { call, setReply, requests } = fixture();
  const cases: Array<[string, Row, unknown]> = [
    ['app_ui_check_permission', {}, { uiEventsEnabled: true }], ['app_ui_list_apps', {}, []], ['app_ui_get_front_app', {}, { name: 'Own' }],
    ['app_ui_list_windows', { appName: tree.appName }, { windows: [] }], ['app_ui_get_tree', { appName: tree.appName, allowProcessFallback: true }, tree],
    ['app_ui_find_element', { query: 'Own' }, { found: true }], ['app_ui_wait_for', {}, { found: true }],
    ['app_ui_click_element', { elementPath: '1.1', dryRun: true }, { ok: true, dryRun: true }], ['app_ui_click_element', { query: 'Own' }, { ok: true }],
    ['app_ui_set_value', { query: 'Own', value: 'Own "text"\nline' }, { ok: true, method: 'set-value' }], ['app_ui_type_text', { text: 'Own' }, { ok: true }],
    ['app_ui_press_key', { key: 'return' }, { ok: true }], ['app_ui_select_menu_item', { appName: tree.appName, menuPath: ['File', 'Owned', 'Child'] }, { ok: true }],
    ['app_ui_activate_app', { appName: tree.appName }, { ok: true }], ['app_ui_handoff', { appName: tree.appName, instructions: 'Own' }, { ok: true }],
    ['app_ui_click_at', { x: 100, y: 100, appName: tree.appName }, { ok: true }], ['app_ui_capture_screen', { path: join(directory, 'compile-capture.png') }, { ok: true }],
  ];
  for (const [tool, args, reply] of cases) { setReply(reply); const result = await call(tool, args); strict.notEqual(result.ok, false, tool + ': ' + JSON.stringify(result)); }
  for (const [i, request] of requests.filter(row => row.executable === '/usr/bin/osascript').entries()) {
    const js = request.args[0] === '-l', source = request.args[js ? 3 : 1];
    const result = spawnSync('/usr/bin/osacompile', [...(js ? ['-l', 'JavaScript'] : []), '-o', join(directory, 'ui-' + i + '.scpt')], { input: source, encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
    if (result.error) throw result.error; strict.equal(result.status, 0, result.stderr.trim() + '\n' + source);
  }
}); else h.info('native App UI script compilation', 'Requires macOS; no user application windows or input targets were operated.');
void h.finish(join(directory, 'result.json'), 'macos-app-ui').then(async code => {
  await Promise.all(cleanups.map(close => close())); rmSync(directory, { recursive: true, force: true }); process.exitCode = code;
}).catch(error => { console.error(error); process.exitCode = 1; });
