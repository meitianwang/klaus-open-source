import strict from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Harness, waitFor } from './harness';
import { ComputerUsePolicyService, type ComputerUsePolicyDependencies, type ComputerUseTaskScope } from '../main/services/computer-use/policy';
import { withSettingsDb } from '../main/services/settings';
import { ComputerUseConnector, COMPUTER_USE_TOOLS, ESCAPE_STOP_MESSAGES, desktopSnapshot, snapshot, validateAction, validateDesktopAction, type ComputerUseDependencies } from '../main/services/computer-use/connector';
import { ComputerUseEscapeWatcher } from '../main/services/computer-use/escape-watch';
import { COMPUTER_USE_OVERLAY_COPY, computerUseOverlayHtml } from '../main/app/computer-use-overlay';
import { appGuidanceFor, appGuidancePrefix, APP_GUIDANCE_BUNDLE_IDS } from '../main/services/computer-use/app-guides';
import type { AppSnapshot, ComputerUseBackend, ComputerUseContext, NativeRequest } from '../main/services/computer-use/types';
import { createComputerUseRuntime } from '../main/app/computer-use-runtime';
import { ChannelRegistry } from '../main/ipc/registry';
import { NativeComputerUse } from '../main/native/computer-use';
import { ComputerUseAudioRecorder } from '../main/services/computer-use/audio';
import { elementText, stateText } from '../main/services/computer-use/format';
import { storeBytes } from '../main/services/media';

const h = new Harness(), temporary = mkdtempSync(join(tmpdir(), 'klaus-computer-use-'));
const app = { input: 'Fixture', name: 'Fixture', path: '/Applications/Fixture.app', bundleId: 'test.fixture', pid: 123 };
const jpeg = '/9j/4AAQSkZJRgABAgAAAQABAAD/2wBDABALChAYKDM9DAwOExo6PDcODRAYKDlFOA4RFh0zV1A+EhYlOERtZ00YIzdAUWhxXDFATldneXhlSFxfYnBkZ2P/wAALCAABAAEBAREA/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/ACv/2Q==';
const state = (): AppSnapshot => ({ app, windowId: 55, bounds: { x: -200, y: 10, width: 800, height: 400 },
  elements: [{ index: '0', path: 'w0', depth: 0, role: 'AXWindow', title: 'Fixture', settable: false, actions: [] },
    { index: '1', path: 'w0.0', depth: 1, role: 'AXTextField', roleDescription: 'text field', title: 'Input', value: 'first', settable: true,
      actions: [{ raw: 'AXConfirm', description: 'Confirm' }], bounds: { x: 10, y: 20, width: 100, height: 50 } }],
  screenshot: { data: jpeg, mimeType: 'image/jpeg', width: 1, height: 1 } });
function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const closing: Array<() => Promise<unknown>> = [];
function fixture(override?: ComputerUseBackend['request'], hooks: Partial<Pick<ComputerUseDependencies, 'beginOperation' | 'approvedWindow' | 'guardInteraction' | 'saveScreenshot' | 'audio' | 'desktopAvailable' | 'escapeStopMessage'>> = {}, policyOverrides: Partial<ComputerUsePolicyDependencies> = {}) {
  const requests: NativeRequest[] = [], approvals: unknown[] = [], currentState = state();
  const backend: ComputerUseBackend = { availability: () => ({ available: true }), close: async () => ({ complete: true }),
    request: async (request, signal) => {
      requests.push(request); if (override) return override(request, signal);
      if (request.method === 'resolve' || request.method === 'activate') return app;
      if (request.method === 'state') return structuredClone(currentState);
      if (request.method === 'listApps') return { apps: [{ ...app, running: true }] };
      return { applied: true };
    } };
  const configRoot = join(temporary, randomUUID());
  withSettingsDb(configRoot, db => db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('computer_use.allowed_apps', '[]'));
  const policy = new ComputerUsePolicyService({ configRoot, availability: backend.availability, enabledChanged: async () => {}, ...policyOverrides });
  const connector = new ComputerUseConnector({ policy, backend,
    saveScreenshot: (data, mime) => storeBytes(Buffer.from(data, 'base64'), mime, configRoot), ...hooks }); connector.attachSession('a'); connector.attachSession('b');
  closing.push(() => connector.close());
  const context = (sessionId = 'a', turnId = 'turn1', elicit?: ComputerUseContext['elicit']): ComputerUseContext => ({
    sessionId, turnId, signal: new AbortController().signal,
    elicit: elicit ?? (async request => { approvals.push(request); return { action: 'accept' }; }),
  });
  return { connector, policy, requests, approvals, currentState, context, configRoot,
    read: (ctx = context()) => connector.call('get_app_state', { app: app.input }, ctx) };
}
h.test('twenty-four named tools preserve explicit read and write effect annotations', () => {
  strict.equal(COMPUTER_USE_TOOLS.length, 24); strict.equal(new Set(COMPUTER_USE_TOOLS.map(tool => tool.name)).size, 24);
  for (const tool of COMPUTER_USE_TOOLS) {
    strict.equal(tool.inputSchema.additionalProperties, false);
    strict.equal(tool.annotations.readOnlyHint, ['list_apps', 'get_app_state', 'get_computer_use_policy', 'get_desktop_screenshot'].includes(tool.name));
  }
});
h.test('app discovery retains the exact path, bundle identifier and running process for recovery', async () => {
  const f = fixture(); const result = await f.connector.call('list_apps', {}, f.context());
  strict.match(String(result.content[0]?.text), /Fixture \(\/Applications\/Fixture.app\).*bundle ID test.fixture, pid 123/);
});
h.test('documented keysym names and punctuation retain their platform-independent meaning', () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/computer-use-observation-vectors.json'), 'utf8'));
  for (const item of vector.keyCases) strict.equal(validateAction('press_key', { key: item.input }).key, item.normalized, item.input);
  for (const key of vector.invalidKeys) strict.throws(() => validateAction('press_key', { key }), /Unsupported|Invalid/);
  strict.deepEqual(validateAction('click', { element_index: '', x: 2, y: 3 }), { name: 'click', click_count: 1, mouse_button: 'left', x: 2, y: 3 });
  strict.deepEqual(validateAction('scroll', { direction: 'down', x: 2, y: 3 }), { name: 'scroll', direction: 'down', pages: 1, x: 2, y: 3 });
  strict.throws(() => validateAction('scroll', { element_index: '', pages: 1 }), /Invalid Computer Use x/);
  strict.deepEqual(validateAction('paste', { text: 'hi' }), { name: 'paste', text: 'hi', format: 'text' });
  strict.throws(() => validateAction('paste', { text: 'hi', format: 'rtf' }), /format/);
  strict.deepEqual(validateAction('click', { x: 2, y: 3, key: 'Control_L+a', duration: 0.2, mouse_button: 'L' }), { name: 'click', click_count: 1, mouse_button: 'left', key: 'control_l+a', x: 2, y: 3, duration: 0.2 });
  strict.equal(validateAction('scroll', { element_index: '1', direction: ' D ' }).direction, 'down');
  strict.throws(() => validateAction('press_key', { key: 'a', duration: 31 }), /duration/);
});
h.test('paste, audio and observation vectors pin the shipped schemas', () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/computer-use-observation-vectors.json'), 'utf8'));
  const schema = (name: string) => COMPUTER_USE_TOOLS.find(tool => tool.name === name)!.inputSchema as
    { properties: Record<string, { type?: string; enum?: readonly string[] }>; required?: readonly string[] };
  strict.deepEqual(vector.paste.formats, ['text', 'md', 'html']);
  strict.deepEqual(schema('paste').properties.format!.enum, vector.paste.formats);
  strict.deepEqual(schema('scroll').required, ['app', 'direction']);
  strict.deepEqual(vector.scrollTarget.targets, ['element_index', 'screenshot point']);
  strict.equal(schema('get_app_state').properties.disable_diff!.type, 'boolean');
  strict.equal(vector.appStateDiff.default, 'diff from the state the model was last shown');
  strict.equal(vector.audioRecording.sampleRate, 24000); strict.equal(vector.audioRecording.channels, 2);
  strict.deepEqual(vector.audioRecording.durationRangeMs, [100, 300000]); strict.equal(vector.audioRecording.defaultDurationMs, 60000);
  strict.equal(schema('start_audio_recording').properties.max_duration_ms!.type, 'integer');
  strict.equal(vector.screenshotImage.mimeType, 'image/jpeg');
  strict.equal(vector.screenshotImage.dimensionCrossCheck, 'start-of-frame segment');
  strict.equal(vector.screenshotImage.maxPixels, 8_000_000);
  for (const name of ['paste', 'start_audio_recording', 'stop_audio_recording']) {
    strict.equal(COMPUTER_USE_TOOLS.find(tool => tool.name === name)!.annotations.readOnlyHint, false);
  }
});
h.test('app guidance ships per-app know-how for the pinned bundle identifiers', () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/computer-use-observation-vectors.json'), 'utf8')).appGuidance;
  strict.deepEqual(vector.apps, [...APP_GUIDANCE_BUNDLE_IDS]);
  strict.equal(vector.wireTag, 'app_specific_instructions');
  strict.equal(vector.match, 'exact bundle identifier');
  for (const bundleId of vector.apps as string[]) {
    const guide = appGuidanceFor({ bundleId });
    strict.equal(typeof guide, 'string', bundleId);
    strict.ok((guide as string).length > 100, bundleId);
  }
  strict.equal(appGuidanceFor({ bundleId: 'com.apple.iWork.Numbers' }), undefined);
  strict.equal(appGuidanceFor({}), undefined);
  strict.equal(appGuidancePrefix('X'), `<${vector.wireTag}>\nX\n</${vector.wireTag}>\n`);
});
h.test('the first observation of a guided app carries its instructions once per session', async () => {
  const guided = { ...app, input: 'Spotify', name: 'Spotify', path: '/Applications/Spotify.app', bundleId: 'com.spotify.client' };
  const f = fixture(async request => {
    if (request.method === 'resolve' || request.method === 'activate') return guided;
    if (request.method === 'state') return { ...state(), app: guided };
    return { applied: true };
  });
  const first = await f.connector.call('get_app_state', { app: 'Spotify' }, f.context());
  strict.match(String(first.content[0]?.text), /^<app_specific_instructions>\n## Spotify\n/);
  strict.match(String(first.content[0]?.text), /call get_app_state once more/);
  const second = await f.connector.call('get_app_state', { app: 'Spotify' }, f.context());
  strict.doesNotMatch(String(second.content[0]?.text), /app_specific_instructions/);
  const acted = await f.connector.call('press_key', { app: 'Spotify', key: 'a' }, f.context());
  strict.doesNotMatch(String(acted.content[0]?.text), /app_specific_instructions/);
  // a different session observes the same app for the first time again
  const other = await f.connector.call('get_app_state', { app: 'Spotify' }, f.context('b'));
  strict.match(String(other.content[0]?.text), /^<app_specific_instructions>/);
  const plain = fixture();
  const result = await plain.read();
  strict.doesNotMatch(String(result.content[0]?.text), /app_specific_instructions/);
});
h.test('observation text distinguishes accessibility changes, visible results and incomplete trees', () => {
  const before = state(), after = state(); after.elements[1]!.focused = true;
  const delta = stateText(after, before); strict.match(delta, /~\s+1 text field/); strict.match(delta, /focused UI element is 1/);
  strict.doesNotMatch(delta, /action did not alter/);
  const unchanged = stateText(after, after); strict.match(unchanged, /Check the screenshot/); strict.match(unchanged, /focused UI element is 1/);
  strict.match(unchanged, /Screenshot: 1 x 1 pixels/);
  const captured = snapshot({ ...after, treeTruncated: true, loading: true }, app);
  strict.match(stateText(captured), /output limit/); strict.match(stateText(captured), /still reports loading/);
  strict.doesNotMatch(stateText(captured), /CUA App Version/);
});
h.test('native pre-input refusals differ from failures after a successful action', async () => {
  let acted = false;
  const f = fixture(async request => {
    if (request.method === 'resolve' || request.method === 'activate') return app;
    if (request.method === 'action') {
      if (!acted) throw Object.assign(new Error('Approved window changed'), { computerUseActionStarted: false });
      return { applied: true };
    }
    if (acted) throw Object.assign(new Error('fixture capture failed'), { computerUseActionStarted: false });
    return state();
  });
  await f.read(); await strict.rejects(f.connector.call('click', { app: app.input, x: 0, y: 0 }, f.context()), /No input was sent/);
  await strict.rejects(f.connector.call('click', { app: app.input, x: 0, y: 0 }, f.context()), /get_app_state/);
  await f.read(); acted = true;
  await strict.rejects(f.connector.call('click', { app: app.input, x: 0, y: 0 }, f.context()), /may have executed/);
  strict.equal(f.requests.filter(request => request.method === 'action').length, 2);
});
h.test('recording guards prevent read operations from activating another app', async () => {
  const f = fixture(undefined, { guardInteraction: async () => { throw new Error('fixture recording is active'); } });
  await strict.rejects(f.read(), /fixture recording is active/);
  strict.deepEqual(f.requests.map(request => request.method), ['resolve']);
});
h.test('metadata is resolved without activation and a refused elicitation sends no OS action', async () => {
  const f = fixture(); await strict.rejects(f.read(f.context('a', 'turn1', async () => ({ action: 'decline' }))), /decline/);
  strict.deepEqual(f.requests.map(request => request.method), ['resolve']);
  await f.policy.setAppPolicy({ blocked_apps: ['Fixture'] }); await strict.rejects(f.read(), /blocked/); strict.equal(f.requests.length, 1);
});
h.test('resolved identity is checked against policy before activation', async () => {
  const f = fixture(async request => request.method === 'resolve' ? { ...app, path: '/Applications/Mail.app', bundleId: 'com.apple.mail' } : app);
  await f.policy.setAppPolicy({ blocked_apps: ['mail'] }); await strict.rejects(f.read(), /blocked/); strict.equal(f.approvals.length, 0);
});
h.test('the returned image has the MCP image shape and exact screenshot coordinate mapping', async () => {
  const f = fixture(), result = await f.read();
  strict.deepEqual(result.content[1], { type: 'image', data: jpeg, mimeType: 'image/jpeg' });
  strict.match(String(result.content[0]?.text), /<app_state>/);
  await f.connector.call('click', { app: app.input, x: 0.5, y: 0.25 }, f.context());
  strict.deepEqual(f.requests.find(request => request.method === 'action')?.args.point, { x: 200, y: 110 });
  strict.equal(f.approvals.length, 1);
});
h.test('a valid capture crop maps its pixels independently while actions retain the exact window bounds', async () => {
  const f = fixture(), crop = { x: -180, y: 20, width: 780, height: 380 }; f.currentState.screenshot.bounds = crop;
  const result = await f.read();
  strict.deepEqual((result._meta?.klaus as { computerUse: { mapping: unknown } }).computerUse.mapping,
    { screenshotPixelWidth: 1, screenshotPixelHeight: 1, screenshotScreenX: -180, screenshotScreenY: 20, screenshotScreenWidth: 780, screenshotScreenHeight: 380 });
  await f.connector.call('click', { app: app.input, x: 0.5, y: 0.25 }, f.context());
  const action = f.requests.find(request => request.method === 'action')!;
  strict.deepEqual(action.args.point, { x: 210, y: 115 }); strict.deepEqual(action.args.windowBounds, f.currentState.bounds);
  for (const outside of [{ ...crop, x: -201 }, { ...crop, width: 781 }, { ...crop, height: 400 }]) {
    const invalid = state(); invalid.screenshot.bounds = outside; strict.throws(() => snapshot(invalid, app), /outside the approved window/);
  }
});
h.test('new sessions and new turns cannot use another stored element or screenshot', async () => {
  const f = fixture(); await f.read();
  for (const context of [f.context('b'), f.context('a', 'turn2')]) await strict.rejects(f.connector.call('click', { app: app.input, element_index: '1' }, context), /this assistant turn/);
  strict.equal(f.requests.filter(request => request.method === 'action').length, 0);
});
h.test('validation rejects invalid keys, oversized input and out-of-screenshot coordinates', async () => {
  const f = fixture();
  await strict.rejects(f.connector.call('press_key', { app: app.input, key: 'arbitrary+action' }, f.context()), /Unsupported/);
  strict.equal(f.requests.length, 0);
  strict.throws(() => validateAction('type_text', { text: 'x'.repeat(50001) }), /Invalid/);
  await f.read(); await strict.rejects(f.connector.call('click', { app: app.input, x: 1, y: 0.5 }, f.context()), /screenshot x/);
  strict.equal(f.requests.filter(request => request.method === 'action').length, 0);
});
h.test('key aliases preserve capital-letter shift, navigation and cross-platform modifiers', () => {
  strict.equal(validateAction('press_key', { key: 'C' }).key, 'shift+c');
  strict.equal(validateAction('press_key', { key: 'ControlOrMeta+ArrowLeft' }).key, 'controlormeta+left');
  strict.equal(validateAction('press_key', { key: 'KP8' }).key, 'kp_8');
});
h.test('editable UIA labels remain visible with values and a renamed label appears in state diffs', () => {
  const before = state(), field = before.elements[1]!;
  field.role = 'Edit'; field.roleDescription = 'edit'; field.actions = [];
  strict.equal(elementText(field), '1 edit (settable, string) Input Value: first');
  strict.equal(elementText({ ...field, description: 'Input' }), '1 edit (settable, string) Description: Input, Value: first');
  const after = structuredClone(before); after.elements[1]!.title = 'Renamed input';
  strict.match(stateText(after, before), /~\s+1 edit \(settable, string\) Renamed input Value: first/);
});
h.test('an element action carries exact cached identity and rejects a fabricated action name', async () => {
  const f = fixture(); await f.read();
  await strict.rejects(f.connector.call('perform_secondary_action', { app: app.input, element_index: '1', action: 'Delete everything' }, f.context()), /does not expose/);
  await f.connector.call('perform_secondary_action', { app: app.input, element_index: '1', action: 'Confirm' }, f.context());
  const action = f.requests.find(request => request.method === 'action')!;
  strict.equal(action.args.action, 'AXConfirm'); strict.deepEqual(action.args.element, state().elements[1]); strict.equal(action.args.windowId, 55);
});
h.test('a failed final capture never retries an already entered input operation', async () => {
  let acted = false;
  const f = fixture(async request => {
    if (request.method === 'resolve' || request.method === 'activate') return app;
    if (request.method === 'action') { acted = true; return {}; }
    if (acted) throw new Error('fixture-capture-failed'); return state();
  });
  await f.read(); await strict.rejects(f.connector.call('type_text', { app: app.input, text: 'hello' }, f.context()), /may have executed/);
  await strict.rejects(f.connector.call('type_text', { app: app.input, text: 'hello' }, f.context()), /get_app_state/);
  strict.equal(f.requests.filter(request => request.method === 'action').length, 1);
});
h.test('policy cancellation between native steps prevents the next input side effect', async () => {
  const gate = deferred(); let activated = false;
  const f = fixture(async request => {
    if (request.method === 'resolve') return app;
    if (request.method === 'activate') { activated = true; await gate.promise; return app; } return state();
  });
  const read = f.read(), rejected = strict.rejects(read, /cancelled|unavailable|policy|abort/i);
  await waitFor(() => activated, 1000, 'native activation entered'); await f.policy.setAppPolicy({ blocked_apps: ['Fixture'] }); gate.resolve(); await rejected;
  strict.equal(f.requests.filter(request => request.method === 'state').length, 0);
});
h.test('close waits for entered native work and a late result cannot revive an owner', async () => {
  const gate = deferred(); let entered = false;
  const f = fixture(async request => {
    if (request.method === 'resolve') { entered = true; await gate.promise; return app; } return state();
  });
  const read = f.read(), rejected = strict.rejects(read, /closed|unavailable/);
  await waitFor(() => entered, 1000, 'native lookup entered'); strict.deepEqual(await f.connector.closeSession('a', 1), { complete: false });
  strict.throws(() => f.connector.attachSession('a'), /finish closing/); gate.resolve(); await rejected;
  strict.deepEqual(await f.connector.closeSession('a'), { complete: true }); f.connector.attachSession('a');
  strict.equal(f.requests.length, 1);
});
h.test('desktop transactions remain serial even when sessions approve concurrently', async () => {
  const gate = deferred(); let firstState = true, blocked = false;
  const f = fixture(async request => {
    if (request.method === 'resolve' || request.method === 'activate') return app;
    if (firstState) { firstState = false; blocked = true; await gate.promise; } return state();
  });
  const first = f.read(); await waitFor(() => blocked, 1000, 'first capture entered'); const second = f.read(f.context('b'));
  await waitFor(() => f.requests.filter(request => request.method === 'resolve').length === 2, 1000, 'second approval metadata');
  strict.equal(f.requests.filter(request => request.method === 'activate').length, 1); gate.resolve(); await Promise.all([first, second]);
  strict.equal(f.requests.filter(request => request.method === 'activate').length, 2);
});
h.test('close drains an entered presentation callback before the same owner may be attached again', async () => {
  const gate = deferred(); let entered = false, finished = false;
  const f = fixture(undefined, { beginOperation: () => 42, approvedWindow: async (session, epoch, surface, signal) => {
    strict.equal(session, 'a'); strict.equal(epoch, 42); strict.equal((surface.app as typeof app).pid, app.pid);
    entered = true; await gate.promise; strict.equal(signal.aborted, true); finished = true;
  } });
  const read = f.read(), rejected = strict.rejects(read, /closed|unavailable/);
  await waitFor(() => entered, 1000, 'presentation callback entered');
  strict.deepEqual(await f.connector.closeSession('a', 1), { complete: false }); strict.equal(finished, false);
  strict.throws(() => f.connector.attachSession('a'), /finish closing/);
  gate.resolve(); await rejected; strict.equal(finished, true);
  strict.deepEqual(await f.connector.closeSession('a'), { complete: true }); f.connector.attachSession('a');
});
h.test('unreadable state and ambiguous indices fail before exposing a usable cached handle', () => {
  const changed = state(); changed.elements.push(changed.elements[0]!); strict.throws(() => snapshot(changed, app), /ambiguous/);
  strict.throws(() => snapshot({ ...state(), app: { ...app, pid: 124 } }, app), /identity changed/);
  strict.throws(() => snapshot({ ...state(), screenshot: { ...state().screenshot, data: 'not-an-image' } }, app), /screenshot is invalid/);
  strict.throws(() => snapshot({ ...state(), screenshot: { ...state().screenshot, width: 2 } }, app), /screenshot is invalid/);
  // The observation wire format switched to lossy frames; a lossless payload must not slip through.
  strict.throws(() => snapshot({ ...state(), screenshot: { ...state().screenshot, mimeType: 'image/png' } }, app), /screenshot is invalid/);
});
h.test('state deltas retain no-change, changed-element and full-tree fallback semantics', () => {
  const before = state(), after = state(); strict.match(stateText(after, before), /no change/);
  after.elements[1]!.value = 'updated'; strict.match(stateText(after, before), /~\s+1 text field/);
  after.elements[0]!.path = 'w1'; strict.match(stateText(after, before), /Most of the tree changed/);
});
h.test('repeated observations diff from the last shown state unless the full tree is requested', async () => {
  const f = fixture();
  const first = await f.read();
  strict.match(String(first.content[0]?.text), /<app_state>/);
  f.currentState.elements[1]!.value = 'updated';
  const second = await f.read();
  strict.match(String(second.content[0]?.text), /diff from the accessibility tree/);
  strict.match(String(second.content[0]?.text), /~\s+1 text field/);
  f.currentState.elements[1]!.value = 'third';
  const full = await f.connector.call('get_app_state', { app: app.input, disable_diff: true }, f.context());
  strict.match(String(full.content[0]?.text), /<app_state>/);
  strict.match(String(full.content[0]?.text), /third/);
  await strict.rejects(f.connector.call('get_app_state', { app: app.input, disable_diff: 'yes' }, f.context()), /disable_diff/);
});
h.test('scroll targets an element or exact screenshot coordinates', async () => {
  const f = fixture();
  await f.read();
  await f.connector.call('scroll', { app: app.input, direction: 'down', x: 0, y: 0 }, f.context());
  const atPoint = f.requests.filter(request => request.method === 'action').pop();
  strict.equal(atPoint?.args.name, 'scroll');
  strict.deepEqual(atPoint?.args.point, { x: -200, y: 10 });
  strict.equal(atPoint?.args.element_index, undefined);
  await f.connector.call('scroll', { app: app.input, direction: 'up', element_index: '1' }, f.context());
  const atElement = f.requests.filter(request => request.method === 'action').pop();
  strict.ok(atElement?.args.element); strict.equal(atElement?.args.point, undefined);
});
h.test('paste requires an observed state and reaches the native action with its format', async () => {
  const f = fixture();
  await strict.rejects(f.connector.call('paste', { app: app.input, text: 'hello' }, f.context()), /Call get_app_state/);
  await f.read();
  const result = await f.connector.call('paste', { app: app.input, text: 'hello', format: 'html' }, f.context());
  const action = f.requests.filter(request => request.method === 'action').pop();
  strict.equal(action?.args.name, 'paste'); strict.equal(action?.args.text, 'hello'); strict.equal(action?.args.format, 'html');
  strict.ok(result.content.some(item => item.type === 'image'));
  await strict.rejects(f.connector.call('paste', { app: app.input, text: 'x', format: 'rtf' }, f.context()), /format/);
  await strict.rejects(f.connector.call('paste', { app: app.input }, f.context()), /text/);
});
h.test('system audio tools are session-scoped and never reach friend tasks', async () => {
  const calls: Array<{ kind: string; sessionId: string; ms?: number }> = [];
  const f = fixture(undefined, { audio: {
    start: async (sessionId, ms) => { calls.push({ kind: 'start', sessionId, ms }); },
    stop: async sessionId => { calls.push({ kind: 'stop', sessionId });
      return { recording: { path: '/tmp/fixture.wav', durationMs: 1500, sampleRate: 24000, channels: 2, bytes: 60044, limitReached: false }, data: Buffer.from('riff-fixture') }; } } });
  const started = await f.connector.call('start_audio_recording', {}, f.context());
  strict.match(String(started.content[0]?.text), /Recording system audio/);
  strict.deepEqual(calls[0], { kind: 'start', sessionId: 'a', ms: 60000 });
  await strict.rejects(f.connector.call('start_audio_recording', { max_duration_ms: 50 }, f.context()), /max_duration_ms/);
  await strict.rejects(f.connector.call('start_audio_recording', { max_duration_ms: 100.5 }, f.context()), /max_duration_ms/);
  const stopped = await f.connector.call('stop_audio_recording', {}, f.context());
  const block = stopped.content.find(item => item.type === 'audio');
  strict.equal(block?.mimeType, 'audio/wav');
  strict.equal(Buffer.from(String(block?.data), 'base64').toString(), 'riff-fixture');
  strict.match(String(stopped.content[0]?.text), /1\.5 s at 24000 Hz, 2 channels/);
  const plain = fixture();
  await strict.rejects(plain.connector.call('start_audio_recording', {}, plain.context()), /unavailable on this computer/);
  const friend = fixture(undefined, { audio: { start: async () => {}, stop: async () => { throw new Error('unreachable'); } } },
    { taskScope: () => ({ active: true, apps: ['bundle:test.fixture'] }) });
  await strict.rejects(friend.connector.call('start_audio_recording', {}, friend.context()), /Friend tasks cannot record system audio/);
  await strict.rejects(friend.connector.call('stop_audio_recording', {}, friend.context()), /Friend tasks cannot record system audio/);
});

const desktopVector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/computer-use-observation-vectors.json'), 'utf8')).desktopSurface;
const pinned = (text: string) => new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
/** One stitched 2x2 virtual desktop observation scaled to a 1x1 screenshot frame. */
const desktopValue = (overrides: Record<string, unknown> = {}) => ({ app, screenshot: { data: jpeg, mimeType: 'image/jpeg', width: 1, height: 1 },
  virtualBounds: { x: -100, y: 0, width: 2, height: 2 }, displays: [{ bounds: { x: -100, y: 0, width: 2, height: 2 }, width: 2, height: 2 }],
  sourceWidth: 2, sourceHeight: 2, ...overrides });
function desktopFixture(override?: ComputerUseBackend['request'], hooks: Partial<ComputerUseDependencies> = {}, policyOverrides: Partial<ComputerUsePolicyDependencies> = {}) {
  return fixture(async (request, signal) => override ? override(request, signal)
    : request.method === 'desktopState' ? desktopValue() : { applied: true }, { desktopAvailable: true, ...hooks }, policyOverrides);
}
h.test('desktop observation caches turn geometry, approves the foreground identity and maps input onto the virtual desktop', async () => {
  const f = desktopFixture();
  const result = await f.connector.call('get_desktop_screenshot', {}, f.context());
  strict.deepEqual(result.content[1], { type: 'image', data: jpeg, mimeType: 'image/jpeg' });
  strict.match(String(result.content[0]?.text), /Saved: /); strict.match(String(result.content[0]?.text), /Full desktop across 1 display\(s\): 2x2 physical pixels, screenshot 1x1/);
  const meta = (result._meta?.klaus as { computerUse: { mapping: unknown; screenshotMode: string; app: unknown } }).computerUse;
  strict.equal(meta.screenshotMode, desktopVector.screenshotMode); strict.deepEqual(meta.app, app);
  strict.deepEqual(meta.mapping, { screenshotPixelWidth: 1, screenshotPixelHeight: 1, screenshotScreenX: -100, screenshotScreenY: 0, screenshotScreenWidth: 2, screenshotScreenHeight: 2 });
  strict.equal(f.approvals.length, 1);
  await f.connector.call('desktop_click', { x: 0.5, y: 0.25 }, f.context());
  const action = f.requests.find(request => request.method === 'desktopAction')!;
  strict.deepEqual({ name: action.args.name, x: action.args.x, y: action.args.y, click_count: action.args.click_count, mouse_button: action.args.mouse_button },
    { name: 'click', x: -99, y: 0.5, click_count: 1, mouse_button: 'left' });
  strict.deepEqual(action.args.app, app);
  strict.match(String((await f.connector.call('desktop_move', { x: 0, y: 0 }, f.context())).content[0]?.text), /Applied desktop_move/);
});
h.test('desktop input needs a same-turn observation carrying a foreground identity', async () => {
  const f = desktopFixture();
  await strict.rejects(f.connector.call('desktop_click', { x: 0, y: 0 }, f.context()), pinned(desktopVector.errors.turnGate));
  await f.connector.call('get_desktop_screenshot', {}, f.context());
  await strict.rejects(f.connector.call('desktop_click', { x: 0, y: 0 }, f.context('b')), pinned(desktopVector.errors.turnGate));
  await strict.rejects(f.connector.call('desktop_click', { x: 0, y: 0 }, f.context('a', 'turn2')), pinned(desktopVector.errors.turnGate));
  strict.equal(f.requests.some(request => request.method === 'desktopAction'), false);
  const g = desktopFixture(async request => request.method === 'desktopState' ? desktopValue({ app: null }) : { applied: true });
  const observed = await g.connector.call('get_desktop_screenshot', {}, g.context());
  strict.equal((observed._meta?.klaus as { computerUse: { app: unknown } }).computerUse.app, null);
  strict.match(String(observed.content[0]?.text), /no foreground application identity/);
  strict.equal(g.approvals.length, 0);
  await strict.rejects(g.connector.call('desktop_type_text', { text: 'hi' }, g.context()), pinned(desktopVector.errors.identityRequired));
  strict.equal(g.requests.some(request => request.method === 'desktopAction'), false);
});
h.test('the desktop surface is Windows-only and closed to friend tasks', async () => {
  const f = fixture();
  const platformArgs: Record<string, Record<string, unknown>> = { get_desktop_screenshot: {}, desktop_click: { x: 0, y: 0 },
    desktop_drag: { path: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }] }, desktop_drag_handle: { op: 'end' }, desktop_move: { x: 0, y: 0 },
    desktop_scroll: { x: 0, y: 0, delta_y: 120 }, desktop_type_text: { text: 'x' }, desktop_press_key: { key: 'a' }, desktop_paste: { text: 'x' } };
  for (const name of desktopVector.tools as string[]) await strict.rejects(f.connector.call(name, platformArgs[name], f.context()), pinned(desktopVector.platform), name);
  const friend = desktopFixture(undefined, {}, { taskScope: () => ({ active: true, apps: ['bundle:test.fixture'] }) });
  await strict.rejects(friend.connector.call('get_desktop_screenshot', {}, friend.context()), pinned(desktopVector.errors.friendTask));
  await strict.rejects(friend.connector.call('desktop_click', { x: 0, y: 0 }, friend.context()), pinned(desktopVector.errors.friendTask));
  strict.equal(friend.requests.length, 0);
});
h.test('the desktop drag handle holds the left button across calls with the pinned guard wording', async () => {
  const f = desktopFixture();
  await f.connector.call('get_desktop_screenshot', {}, f.context());
  await strict.rejects(f.connector.call('desktop_drag_handle', { op: 'move_to', x: 0.5, y: 0.5 }, f.context()), pinned(desktopVector.errors.moveWithoutStart));
  await strict.rejects(f.connector.call('desktop_drag_handle', { op: 'end' }, f.context()), pinned(desktopVector.errors.endWithoutStart));
  await f.connector.call('desktop_drag_handle', { op: 'start', x: 0.25, y: 0.25 }, f.context());
  await strict.rejects(f.connector.call('desktop_drag_handle', { op: 'start', x: 0.5, y: 0.5 }, f.context()), pinned(desktopVector.errors.startTwice));
  // observing mid-drag is allowed and keeps the button held
  await f.connector.call('get_desktop_screenshot', {}, f.context());
  await f.connector.call('desktop_drag_handle', { op: 'move_to', x: 0.75, y: 0.5 }, f.context());
  await f.connector.call('desktop_drag_handle', { op: 'end' }, f.context());
  const actions = f.requests.filter(request => request.method === 'desktopAction').map(request => request.args);
  strict.deepEqual(actions.map(args => [args.name, args.x, args.y]), [['mouse_down', -99.5, 0.5], ['mouse_move', -98.5, 1], ['mouse_up', -98.5, 1]]);
  // held-move and release do not re-verify the pinned identity; the press does
  strict.deepEqual(actions[0]!.app, app);
  strict.equal('app' in actions[1]!, false); strict.equal('app' in actions[2]!, false);
});
h.test('a failed desktop input releases a held drag and a failed release closes the desktop surface', async () => {
  let failMove = false, failRelease = false;
  const f = desktopFixture(async request => {
    if (request.method === 'desktopState') return desktopValue();
    if (request.method === 'desktopAction') {
      if (request.args.name === 'mouse_move' && failMove) throw new Error('fixture-move-failed');
      if (request.args.name === 'mouse_up' && failRelease) throw new Error('fixture-release-failed');
    }
    return { applied: true };
  });
  await f.connector.call('get_desktop_screenshot', {}, f.context());
  await f.connector.call('desktop_drag_handle', { op: 'start', x: 0.25, y: 0.25 }, f.context());
  failMove = true;
  await strict.rejects(f.connector.call('desktop_drag_handle', { op: 'move_to', x: 0.5, y: 0.5 }, f.context()), /may have executed/);
  const releases = f.requests.filter(request => request.args.name === 'mouse_up');
  strict.equal(releases.length, 1);
  strict.deepEqual({ x: releases[0]!.args.x, y: releases[0]!.args.y }, { x: -99.5, y: 0.5 });
  // the released handle starts again after a fresh observation in the same turn
  await f.connector.call('get_desktop_screenshot', {}, f.context());
  await f.connector.call('desktop_drag_handle', { op: 'start', x: 0.25, y: 0.25 }, f.context());
  failRelease = true;
  await strict.rejects(f.connector.call('desktop_drag_handle', { op: 'move_to', x: 0.5, y: 0.5 }, f.context()), /may have executed/);
  await strict.rejects(f.connector.call('get_desktop_screenshot', {}, f.context()), pinned(desktopVector.errors.closed));
  await strict.rejects(f.connector.call('desktop_click', { x: 0, y: 0 }, f.context()), pinned(desktopVector.errors.closed));
});
h.test('desktop drag maps the whole path into one native operation', async () => {
  const f = desktopFixture();
  await f.connector.call('get_desktop_screenshot', {}, f.context());
  await f.connector.call('desktop_drag', { path: [{ x: 0, y: 0 }, { x: 0.5, y: 0.5 }, { x: 0.75, y: 0.75 }] }, f.context());
  const drags = f.requests.filter(request => request.method === 'desktopAction');
  strict.equal(drags.length, 1); strict.equal(drags[0]!.args.name, 'drag'); strict.deepEqual(drags[0]!.args.app, app);
  strict.deepEqual(drags[0]!.args.path, [{ x: -100, y: 0 }, { x: -99, y: 1 }, { x: -98.5, y: 1.5 }]);
  await strict.rejects(f.connector.call('desktop_drag', { path: [{ x: 0, y: 0 }] }, f.context()), /between 2 and 16/);
});
h.test('desktop schemas and validators pin the shipped surface', () => {
  const schema = (name: string) => COMPUTER_USE_TOOLS.find(tool => tool.name === name)!.inputSchema as
    { properties: Record<string, { type?: string; enum?: readonly string[] }>; required?: readonly string[] };
  for (const name of desktopVector.tools as string[]) strict.equal(COMPUTER_USE_TOOLS.some(tool => tool.name === name), true, name);
  strict.equal(COMPUTER_USE_TOOLS.filter(tool => (desktopVector.tools as string[]).includes(tool.name)).length, (desktopVector.tools as string[]).length);
  strict.equal(COMPUTER_USE_TOOLS.find(tool => tool.name === 'get_desktop_screenshot')!.annotations.readOnlyHint, true);
  strict.deepEqual(schema('desktop_drag_handle').properties.op!.enum, desktopVector.dragHandleOps);
  strict.deepEqual(schema('desktop_click').properties.mouse_button!.enum, ['left', 'right', 'middle', 'l', 'r', 'm']);
  strict.deepEqual(validateDesktopAction('desktop_click', { x: 1, y: 2 }), { x: 1, y: 2, click_count: desktopVector.clickCount[0], mouse_button: 'left' });
  strict.deepEqual(validateDesktopAction('desktop_click', { x: 1, y: 2, mouse_button: 'R', click_count: desktopVector.clickCount[1] }), { x: 1, y: 2, click_count: 3, mouse_button: 'right' });
  strict.throws(() => validateDesktopAction('desktop_click', { x: 1, y: 2, click_count: desktopVector.clickCount[1] + 1 }), /click_count/);
  strict.throws(() => validateDesktopAction('desktop_drag', { path: [{ x: 0, y: 0 }] }), /between 2 and 16/);
  strict.deepEqual(validateDesktopAction('desktop_scroll', { x: 0, y: 0, delta_y: 2 * desktopVector.scroll.notch }), { x: 0, y: 0, delta_y: 240 });
  strict.throws(() => validateDesktopAction('desktop_scroll', { x: 0, y: 0 }), /non-zero delta/);
  strict.throws(() => validateDesktopAction('desktop_scroll', { x: 0, y: 0, delta_x: 0, delta_y: 0 }), /non-zero delta/);
  strict.throws(() => validateDesktopAction('desktop_scroll', { x: 0, y: 0, delta_y: desktopVector.scroll.deltaRange[1] + 1 }), /delta_y/);
  strict.deepEqual(validateDesktopAction('desktop_press_key', { key: 'ArrowDown' }), { key: 'down' });
  strict.deepEqual(validateDesktopAction('desktop_paste', { text: 'hi' }), { text: 'hi', format: 'text' });
  strict.deepEqual(validateDesktopAction('desktop_drag_handle', { op: 'end' }), { op: 'end' });
  strict.throws(() => validateDesktopAction('desktop_drag_handle', { op: 'start' }), /Invalid Computer Use x/);
  strict.throws(() => desktopSnapshot({ ...desktopValue(), screenshot: { data: jpeg, mimeType: 'image/png', width: 1, height: 1 } }), /desktop screenshot is invalid/);
  strict.throws(() => desktopSnapshot({ ...desktopValue(), sourceWidth: 6000, sourceHeight: 6000 }), /exceeds its limit/);
  strict.throws(() => desktopSnapshot({ ...desktopValue(), displays: [] }), /display list/);
  strict.deepEqual(desktopVector.nativeMethods, ['desktopState', 'desktopAction']);
});

const script = join(temporary, 'native-fixture.cjs');
writeFileSync(script, `let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{
 const r=JSON.parse(input);const out=(result,sequence=r.sequence)=>process.stdout.write(JSON.stringify({resourceId:r.resourceId,operationId:r.operationId,generation:r.generation,sequence,ok:true,postedAt:r.args.postedAt??0,result}));
 if(r.method==='capabilities'){out({version:1,supported:true});return;}
 if(r.args.mode==='delay'){process.on('SIGTERM',()=>{});setTimeout(()=>out({late:true}),10000);return;}
 if(r.args.mode==='wrong'){out({},r.sequence+1);return;}
 if(r.args.mode==='overflow'){for(let i=0;i<30;i++)process.stdout.write('x'.repeat(1024*1024));return;}
 if(r.args.mode==='timestamp'){out({lastOwnInputAt:r.args.lastOwnInputAt});return;}
 if(r.args.mode==='not-started'){process.stdout.write(JSON.stringify({...r,ok:false,error:'fixture refusal',actionStarted:false}));return;}
 out({method:r.method});
});`);
function native() {
  const backend = new NativeComputerUse({ platform: 'darwin', command: { executable: process.execPath, args: [script], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } });
  closing.push(() => backend.close()); return backend;
}
h.test('native execution metadata describes only the action request that produced it', async () => {
  const backend = native(); await backend.initialize();
  const action = request('not-started'); action.method = 'action';
  await strict.rejects(backend.request(action, new AbortController().signal), error => error instanceof Error && 'computerUseActionStarted' in error && error.computerUseActionStarted === false);
  const observation = request('not-started'); observation.method = 'state';
  await strict.rejects(backend.request(observation, new AbortController().signal), error => error instanceof Error && !('computerUseActionStarted' in error));
});
const request = (mode = ''): NativeRequest => ({ resourceId: randomUUID(), operationId: randomUUID(), generation: 1, sequence: 1, method: 'resolve', args: { mode } });
h.test('native protocol identity mismatch rejects after actual child exit and permits a fresh request', async () => {
  const backend = native(); await backend.initialize(); strict.equal(backend.availability().available, true);
  await strict.rejects(backend.request(request('wrong'), new AbortController().signal), /identity mismatch/);
  strict.deepEqual(await backend.request(request(), new AbortController().signal), { method: 'resolve' });
});
h.test('native output is bounded and overflow drains the killed child instead of allocating forever', async () => {
  const backend = native(); await backend.initialize(); await strict.rejects(backend.request(request('overflow'), new AbortController().signal), /output exceeds/);
  strict.deepEqual(await backend.close(), { complete: true });
});
h.test('non-input replies cannot erase the last owned input timestamp used by presence checks', async () => {
  const backend = native(); await backend.initialize(); const postedAt = Date.now() - 500, first = request('timestamp'); first.args.postedAt = postedAt;
  strict.deepEqual(await backend.request(first, new AbortController().signal), { lastOwnInputAt: 0 });
  for (let index = 0; index < 2; index++) strict.deepEqual(await backend.request(request('timestamp'), new AbortController().signal), { lastOwnInputAt: postedAt });
  await backend.close();
});
h.test('queued native cancellation settles immediately while close still waits for an entered child', async () => {
  const backend = native(); await backend.initialize(); const controller = new AbortController();
  const first = backend.request(request('delay'), new AbortController().signal), firstRejected = strict.rejects(first, /closed/);
  await new Promise(resolve => setTimeout(resolve, 100));
  const second = backend.request(request(), controller.signal), secondRejected = strict.rejects(second, /queued operation was cancelled/);
  controller.abort(); await secondRejected; const early = await backend.close(1);
  // Windows terminates a child immediately; POSIX lets this fixture delay SIGTERM.
  if (process.platform !== 'win32') strict.deepEqual(early, { complete: false });
  await firstRejected; strict.deepEqual(await backend.close(), { complete: true });
});
h.test('unsupported platforms and a missing Windows helper report explicit unavailability', async () => {
  const backend = new NativeComputerUse({ platform: 'linux' }); await backend.initialize(); strict.equal(backend.availability().available, false);
  await strict.rejects(backend.request(request(), new AbortController().signal), /not installed for linux/); await backend.close();
  const windows = new NativeComputerUse({ platform: 'win32' }); await windows.initialize(); strict.equal(windows.availability().available, false);
  await strict.rejects(windows.request(request(), new AbortController().signal), /helper is missing/); await windows.close();
});
const audioScript = join(temporary, 'audio-fixture.cjs');
writeFileSync(audioScript, `const fs=require('node:fs');let text='',rec=null;
const finish=()=>{if(!rec||rec.done)return;rec.done=true;const path=rec.frame.args.path;
 const out={resourceId:rec.frame.resourceId,operationId:rec.frame.operationId,generation:1,sequence:1,ok:true,postedAt:0,actionStarted:false,
 result:{path,durationMs:10,sampleRate:24000,channels:2,bytes:fs.statSync(path).size,limitReached:rec.frame.args.maxDurationMs<=200}};
 process.stdout.write(JSON.stringify(out),()=>process.exit(0));};
process.stdin.on('data',chunk=>{text+=chunk;let end;while((end=text.indexOf('\\n'))>=0){const line=text.slice(0,end);text=text.slice(end+1);if(!line.trim())continue;const frame=JSON.parse(line);
 if(frame.method==='recordAudio'){fs.writeFileSync(frame.args.path,Buffer.alloc(44+960));rec={frame};process.stderr.write('klaus-audio-recording-started\\n');if(frame.args.maxDurationMs<=200)setTimeout(finish,120);}
 else if(frame.stop===true)finish();}});
process.stdin.on('end',()=>finish());
`);
function audioRecorder(available = true) {
  const recorder = new ComputerUseAudioRecorder({ root: join(temporary, `audio-${randomUUID()}`), available: () => available, log: () => {},
    command: { executable: process.execPath, args: [audioScript], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } });
  closing.push(() => recorder.close()); return recorder;
}
h.test('audio recording starts on the native ack, stays single-active and returns the captured file once', async () => {
  const recorder = audioRecorder();
  await recorder.start('a', 60000, new AbortController().signal);
  await strict.rejects(recorder.start('b', 1000, new AbortController().signal), /already active/);
  const captured = await recorder.stop('a', new AbortController().signal);
  strict.equal(captured.recording.durationMs, 10); strict.equal(captured.recording.sampleRate, 24000);
  strict.equal(captured.recording.limitReached, false);
  strict.equal(captured.data.length, 44 + 960); strict.equal(captured.recording.bytes, captured.data.length);
  strict.equal(existsSync(captured.recording.path), false);
  await strict.rejects(recorder.stop('a', new AbortController().signal), /No audio recording is active/);
});
h.test('audio recording finalizes at its duration limit and only its session retrieves it', async () => {
  const recorder = audioRecorder();
  await recorder.start('a', 200, new AbortController().signal);
  await strict.rejects(recorder.stop('b', new AbortController().signal), /another session/);
  const captured = await recorder.stop('a', new AbortController().signal);
  strict.equal(captured.recording.limitReached, true);
});
h.test('audio recording refuses unavailable platforms and drains on release and close', async () => {
  const off = audioRecorder(false);
  await strict.rejects(off.start('a', 1000, new AbortController().signal), /requires the current native helper/);
  strict.deepEqual(await off.close(2000), { complete: true });
  const recorder = audioRecorder();
  await recorder.start('a', 60000, new AbortController().signal);
  await recorder.release('a');
  strict.deepEqual(await recorder.close(2000), { complete: true });
  await strict.rejects(recorder.start('a', 1000, new AbortController().signal), /shutting down/);
});
h.test('native audio capability is explicit and never assumed', async () => {
  const capScript = join(temporary, 'audio-cap.cjs');
  writeFileSync(capScript, `let input='';process.stdin.on('data',b=>input+=b);process.stdin.on('end',()=>{const r=JSON.parse(input);
 process.stdout.write(JSON.stringify({resourceId:r.resourceId,operationId:r.operationId,generation:r.generation,sequence:r.sequence,ok:true,postedAt:0,
 result:{version:1,supported:true,audio:process.env.AUDIO_CAP==='1'}}));});`);
  const on = new NativeComputerUse({ platform: 'darwin', command: { executable: process.execPath, args: [capScript], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', AUDIO_CAP: '1' } } });
  closing.push(() => on.close()); await on.initialize(); strict.equal(on.audioAvailable(), true);
  const off = new NativeComputerUse({ platform: 'darwin', command: { executable: process.execPath, args: [capScript], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } });
  closing.push(() => off.close()); await off.initialize(); strict.equal(off.audioAvailable(), false);
});
h.test('Windows framing requests graceful cancellation and waits for the actual cleanup and child exit', async () => {
  const worker = join(temporary, 'windows-framing.cjs'), marker = join(temporary, 'windows-entered'), cleanup = join(temporary, 'windows-cleanup');
  writeFileSync(worker, `const fs=require('node:fs');let text='',request;const out=result=>process.stdout.write(JSON.stringify({...request,ok:true,result}),()=>process.exit(0));
    process.stdin.on('data',chunk=>{text+=chunk;let end;while((end=text.indexOf('\\n'))>=0){const frame=JSON.parse(text.slice(0,end));text=text.slice(end+1);
      if(!request){request=frame;if(request.method==='capabilities')out({version:1,supported:true});else fs.writeFileSync(request.args.marker,'entered');}
      else if(frame.cancel===true)setTimeout(()=>{fs.writeFileSync(request.args.cleanup,'released');out({cancelled:true});},125);
    }});`);
  const backend = new NativeComputerUse({ platform: 'win32', command: { executable: process.execPath, args: [worker], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } });
  closing.push(() => backend.close()); await backend.initialize(); strict.equal(backend.availability().available, true);
  const value = request(); value.args = { marker, cleanup }; const pending = backend.request(value, new AbortController().signal), rejected = strict.rejects(pending, /closed/);
  await waitFor(() => existsSync(marker), 2000, 'framed worker entered');
  strict.deepEqual(await backend.close(1), { complete: false }); strict.equal(existsSync(cleanup), false);
  await rejected; strict.equal(readFileSync(cleanup, 'utf8'), 'released'); strict.deepEqual(await backend.close(), { complete: true });
});
h.test('cancelled native cleanup retains its own input timestamp without accepting cancelled results', async () => {
  const worker = join(temporary, 'cancelled-input.cjs'), marker = join(temporary, 'cancelled-input-entered');
  writeFileSync(worker, `const fs=require('node:fs');let text='',request;const out=(result,extra={})=>process.stdout.write(JSON.stringify({...request,ok:true,result,...extra}),()=>process.exit(0));
    process.stdin.on('data',chunk=>{text+=chunk;let end;while((end=text.indexOf('\\n'))>=0){const frame=JSON.parse(text.slice(0,end));text=text.slice(end+1);
      if(!request){request=frame;if(request.method==='capabilities')out({version:1,supported:true});else if(request.method==='action')fs.writeFileSync(request.args.marker,'entered');else out({lastOwnInputAt:request.args.lastOwnInputAt});}
      else if(frame.cancel===true)out({}, {ok:false,error:'cancelled after mouse release',postedAt:Date.now()});
    }});`);
  const backend = new NativeComputerUse({ platform: 'win32', command: { executable: process.execPath, args: [worker], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } });
  closing.push(() => backend.close()); await backend.initialize();
  const value = request(); value.method = 'action'; value.args = { marker }; const controller = new AbortController();
  const pending = backend.request(value, controller.signal), rejected = strict.rejects(pending, /operation was cancelled/);
  await waitFor(() => existsSync(marker), 2000, 'cancellable input entered'); controller.abort(); await rejected;
  const next = request(); next.method = 'state';
  const response = await backend.request(next, new AbortController().signal) as { lastOwnInputAt: number };
  strict.ok(response.lastOwnInputAt > 0 && response.lastOwnInputAt <= Date.now());
});

function passwordBackend() {
  const root = join(temporary, randomUUID()); mkdirSync(root);
  const worker = join(root, 'worker.cjs'), marker = join(root, 'entered'), credential = join(root, 'credential'), calls = join(root, 'calls.jsonl');
  writeFileSync(worker, `const fs=require('node:fs'),path=require('node:path'),root=__dirname;
    let text='';process.stdin.on('data',b=>text+=b);process.stdin.on('end',()=>{
      const r=JSON.parse(text),file=path.join(root,'credential');
      fs.appendFileSync(path.join(root,'calls.jsonl'),JSON.stringify({method:r.method,args:r.args})+'\\n');
      const out=(result,extra={})=>process.stdout.write(JSON.stringify({resourceId:r.resourceId,operationId:r.operationId,generation:r.generation,sequence:r.sequence,ok:true,result,...extra}));
      if(r.method==='capabilities')return out({version:1,supported:true,autoUnlock:true});
      if(r.method==='loginPasswordPresence')return out({hasLoginPassword:fs.existsSync(file)});
      if(r.method==='promptLoginPassword'){
        process.on('SIGTERM',()=>{});fs.writeFileSync(path.join(root,'entered'),'entered');
        return setTimeout(()=>{const created=!fs.existsSync(file);if(created)fs.writeFileSync(file,r.operationId);out({cancelled:false,stored:created,hasLoginPassword:true});},150);
      }
      if(r.method==='discardLoginPassword'||r.method==='deleteLoginPassword'){
        if(fs.existsSync(file)&&(r.method==='deleteLoginPassword'||fs.readFileSync(file,'utf8')===r.args.owner))fs.unlinkSync(file);
        return out({deleted:true});
      }
      if(r.args.mode==='physical')return out({}, {ok:false,error:'physical input detected',cooldownUntil:Date.now()+2000});
      out({autoUnlock:r.args.autoUnlock,lastOwnInputAt:r.args.lastOwnInputAt});
    });`);
  let enabled = true;
  const backend = new NativeComputerUse({ platform: 'darwin', autoUnlockEnabled: () => enabled,
    command: { executable: process.execPath, args: [worker], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } } });
  closing.push(() => backend.close());
  return { backend, marker, credential, calls, setEnabled: (value: boolean) => { enabled = value; } };
}
h.test('native password capability reports only presence and ownership receipts without secret transport', async () => {
  const f = passwordBackend(), signal = new AbortController().signal; await f.backend.initialize();
  strict.equal(f.backend.loginPassword.available(), true); strict.equal(await f.backend.loginPassword.hasPassword(signal), false);
  const first = await f.backend.loginPassword.prompt(signal); strict.equal(first.created, true); strict.equal(first.cancelled, false);
  strict.equal(await f.backend.loginPassword.hasPassword(signal), true);
  const existing = await f.backend.loginPassword.prompt(signal); strict.equal(existing.created, false);
  await existing.discard(); strict.equal(existsSync(f.credential), true);
  await first.discard(); strict.equal(await f.backend.loginPassword.hasPassword(signal), false);
  writeFileSync(f.credential, 'preexisting-fixture-owner'); await f.backend.loginPassword.remove(signal); strict.equal(existsSync(f.credential), false);
  for (const line of readFileSync(f.calls, 'utf8').trim().split('\n')) {
    const call = JSON.parse(line); strict.equal('password' in call.args, false); strict.equal('value' in call.args, false);
  }
});
h.test('cancelled native password work drains owned cleanup and preserves any preexisting credential', async () => {
  for (const existing of [false, true]) {
    const f = passwordBackend(); if (existing) writeFileSync(f.credential, 'preexisting-fixture-owner');
    await f.backend.initialize(); const controller = new AbortController();
    const task = f.backend.loginPassword.prompt(controller.signal), rejected = strict.rejects(task, /operation was cancelled/);
    await waitFor(() => existsSync(f.marker), 2000, 'native password operation entered'); controller.abort();
    await rejected;
    strict.equal(existsSync(f.credential), existing); if (existing) strict.equal(readFileSync(f.credential, 'utf8'), 'preexisting-fixture-owner');
    strict.equal(readFileSync(f.calls, 'utf8').includes('discardLoginPassword'), true);
    strict.deepEqual(await f.backend.close(), { complete: true });
  }
});
h.test('native shutdown remains incomplete until an entered password save has finished owned cleanup', async () => {
  const f = passwordBackend(); await f.backend.initialize();
  const task = f.backend.loginPassword.prompt(new AbortController().signal), rejected = strict.rejects(task, /closed/);
  await waitFor(() => existsSync(f.marker), 2000, 'native password operation entered');
  strict.deepEqual(await f.backend.close(1), { complete: false });
  await rejected; strict.equal(existsSync(f.credential), false); strict.deepEqual(await f.backend.close(), { complete: true });
});
h.test('physical-input refusal holds the committed cooldown without another native input probe and refreshes unlock intent', async () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/computer-use-lockscreen-vectors.json'), 'utf8'));
  strict.equal(vector.presence.cooldownMs, 2000);
  const f = passwordBackend(); await f.backend.initialize(); const signal = new AbortController().signal;
  const input = request('physical'); input.method = 'activate'; input.args.app = app; input.args.inputAction = true;
  await strict.rejects(f.backend.request(input, signal), /physical input/);
  const before = readFileSync(f.calls, 'utf8'); input.args.mode = '';
  await strict.rejects(f.backend.request(input, signal), /Wait 2 seconds/); strict.equal(readFileSync(f.calls, 'utf8'), before);
  const read = request(); read.method = 'state'; await f.backend.request(read, signal);
  await new Promise(resolve => setTimeout(resolve, vector.presence.cooldownMs + 50));
  strict.equal((await f.backend.request(input, signal) as { autoUnlock: boolean }).autoUnlock, true);
  f.setEnabled(false); strict.equal((await f.backend.request(input, signal) as { autoUnlock: boolean }).autoUnlock, false);
});


h.test('failed screenshot persistence cannot authorize later native input', async () => {
  const f = fixture(undefined, { saveScreenshot: () => { throw new Error('capture persistence failed'); } });
  await strict.rejects(f.read(), /capture persistence failed/);
  await strict.rejects(f.connector.call('click', { app: app.input, x: 0, y: 0 }, f.context()), /get_app_state/);
  strict.equal(f.requests.filter(request => request.method === 'action').length, 0);
});

h.test('native screenshot saves exact bytes and gives the same quoted path to the model and replay', async () => {
  const f = fixture(), first = await f.read(), second = await f.read();
  const path = String(first.structuredContent?.path || '');
  strict.equal(first.structuredContent?.saved, true);
  strict.equal(path, second.structuredContent?.path);
  strict.deepEqual(readFileSync(path), Buffer.from(jpeg, 'base64'));
  strict.equal(first.content[1]?.type, 'image');
  strict.equal(first.content[1]?.data, jpeg);
  strict.equal(first.content[1]?.mimeType, 'image/jpeg');
  strict.ok(String(first.content[0]?.text).startsWith('Saved: ' + JSON.stringify(path) + '\n'));
  strict.ok(String(first.content[0]?.text).includes('<app_state>'));
});


h.test('friend app metadata cannot inherit global bypass and only selected identities may activate or capture', async () => {
  const f = fixture(undefined, {}, { taskScope: () => ({ active: true, apps: ['bundle:test.fixture'] }) });
  await f.policy.setEnabled({ enabled: false });
  await f.read(); strict.equal(f.approvals.length, 0);
  strict.equal(f.requests.every(request => request.args.friendTaskRestricted === true), true);
  const denied = fixture(async request => request.method === 'resolve' ? { ...app, name: 'Mail', bundleId: 'test.fixture.impostor', path: '/Applications/Impostor.app' } : state(), {},
    { taskScope: () => ({ active: true, apps: ['bundle:test.fixture'] }) });
  await strict.rejects(denied.read(), /only allowed/);
  strict.deepEqual(denied.requests.map(request => request.method), ['resolve']);
});
h.test('inactive and empty friend scopes reject every metadata or action tool before native work', async () => {
  let scope: ComputerUseTaskScope = { active: false, apps: ['bundle:test.fixture'] };
  const f = fixture(undefined, {}, { taskScope: () => scope });
  for (const name of ['list_apps', 'get_computer_use_policy', 'get_app_state', 'type_text']) {
    const args = name === 'get_app_state' ? { app: app.input } : name === 'type_text' ? { app: app.input, text: 'forbidden' } : {};
    await strict.rejects(f.connector.call(name, args, f.context()), /inactive|no approved/);
  }
  scope = { active: true, apps: [] };
  await strict.rejects(f.read(), /inactive|no approved/); strict.equal(f.requests.length, 0);
});
h.test('friend list and policy tools expose only approved metadata and cannot modify global settings', async () => {
  const f = fixture(undefined, {}, { taskScope: () => ({ active: true, apps: ['bundle:test.fixture'] }) });
  await f.policy.setEnabled({ enabled: false });
  const listed = await f.connector.call('list_apps', {}, f.context());
  strict.match(String(listed.content[0]?.text), /Fixture/);
  strict.deepEqual(f.requests.map(request => request.method), ['resolve']);
  const policy = await f.connector.call('get_computer_use_policy', {}, f.context());
  strict.match(String(policy.content[0]?.text), /Task-authorized applications/);
  await strict.rejects(f.connector.call('set_computer_use_policy', { always_allowed_apps: ['Mail'], auto_unlock: true }, f.context()), /cannot change global/);
  await strict.rejects(f.connector.call('set_computer_use_policy', { restricted_to_apps: ['Mail'] }, f.context()), /cannot change global/);
  strict.equal(f.policy.get().enabled, false); strict.deepEqual(f.policy.get().allowedApps, []);
});
h.test('scope revocation during resolution or capture blocks the next operation and discards captured output', async () => {
  for (const method of ['resolve', 'state']) {
    let scope: ComputerUseTaskScope = { active: true, apps: ['bundle:test.fixture'] }, entered = false;
    const gate = deferred(); let saved = 0;
    const f = fixture(async request => {
      if (request.method === method) { entered = true; await gate.promise; }
      return request.method === 'resolve' || request.method === 'activate' ? app : state();
    }, { saveScreenshot: () => { saved++; return '/capture.jpg'; } }, { taskScope: () => scope });
    const read = f.read(), rejected = strict.rejects(read, /authorization changed|inactive/);
    await waitFor(() => entered, 1000, 'scoped native operation entered');
    scope = { active: false, apps: [] }; gate.resolve(); await rejected;
    strict.equal(saved, 0);
    if (method === 'resolve') strict.equal(f.requests.some(request => request.method === 'activate'), false);
  }
});
h.test('revocation clears old input state even if an owner later grants the same app again', async () => {
  let scope: ComputerUseTaskScope = { active: true, apps: ['bundle:test.fixture'] };
  const f = fixture(undefined, {}, { taskScope: () => scope }); await f.read();
  scope = { active: false, apps: [] };
  await strict.rejects(f.connector.call('type_text', { app: app.input, text: 'blocked' }, f.context()), /inactive|authorization changed/);
  scope = { active: true, apps: ['bundle:test.fixture'] };
  await strict.rejects(f.connector.call('type_text', { app: app.input, text: 'no cached state' }, f.context()), /get_app_state/);
  strict.equal(f.requests.some(request => request.method === 'action'), false);
  await f.read(); await f.connector.call('type_text', { app: app.input, text: 'fresh state' }, f.context());
  strict.equal(f.requests.filter(request => request.method === 'action').length, 1);
});
h.test('an adversarial capture identity outside the selected app cannot be saved or returned', async () => {
  let saved = 0;
  const f = fixture(async request => request.method === 'resolve' || request.method === 'activate' ? app
    : { ...state(), app: { ...app, bundleId: 'private.other', path: '/Applications/Other.app' } },
    { saveScreenshot: () => { saved++; return '/capture.jpg'; } }, { taskScope: () => ({ active: true, apps: ['bundle:test.fixture'] }) });
  await strict.rejects(f.read(), /identity/); strict.equal(saved, 0);
});


h.test('real host capability routing enables only scoped sessions while global access is off and native unlock stays false', async () => {
  const root = join(temporary, 'scoped-runtime'), helper = join(temporary, 'scoped-native.cjs'), log = join(temporary, 'scoped-native-requests.jsonl');
  mkdirSync(root, { recursive: true });
  writeFileSync(helper, `const fs=require('node:fs');let input='',handled=false;const app=${JSON.stringify(app)},state=${JSON.stringify(state())};
    function run(){if(handled)return;let r;try{r=JSON.parse(input.trim().split('\\n')[0]);}catch{return;}handled=true;
    fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(r)+'\\n');let result;
    if(r.method==='capabilities')result={version:1,supported:true,autoUnlock:true};
    else if(r.method==='resolve'||r.method==='activate')result=app;else if(r.method==='state')result=state;else if(r.method==='action')result={applied:true};
    else result={unexpected:r.method};process.stdout.write(JSON.stringify({...r,ok:true,result})+'\\n',()=>process.exit(0));}
    process.stdin.on('data',b=>{input+=b;if(input.includes('\\n'))run();});process.stdin.on('end',run);`);
  withSettingsDb(root, db => {
    for (const [key,value] of [['computer_use.enabled','0'],['computer_use.allowed_apps','["app:self"]'],['computer_use.auto_unlock','1']] as const) db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run(key,value);
  });
  let scope: ComputerUseTaskScope = { active: true, apps: ['bundle:test.fixture'] };
  const runtime = await createComputerUseRuntime(new ChannelRegistry(), { configRoot: root,
    command: { executable: process.execPath, args: [helper], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } },
    currentTurn: () => 'turn1', taskScope: id => id === 'friend' ? scope : undefined, pip: () => undefined,
    enabledChanged: async () => {}, createRecorderWindow: () => { throw new Error('No GUI may be created by this fixture'); },
    registerRecorderOwner: () => {}, unregisterRecorderOwner: () => {}, recordingEnded: async () => {}, log: () => {},
  });
  closing.push(() => runtime.shutdown());
  strict.equal(runtime.ownerAppsAvailable().available, process.platform === 'darwin' || process.platform === 'win32');
  strict.deepEqual(await runtime.hostCapabilities('ordinary'), { mcpServers: [], runtimeCapabilityRoots: [] });
  if (!runtime.ownerAppsAvailable().available) {
    await strict.rejects(runtime.hostCapabilities('friend'), /unavailable|not installed/); return;
  }
  const capabilities = await runtime.hostCapabilities('friend'), servers = capabilities.mcpServers as Array<{ url: string }>;
  strict.equal(servers.length, 1); const url = servers[0]!.url;
  let sessionHeader = '', id = 0;
  const rpc = async (method: string, params: Record<string, unknown>) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream',
      ...(sessionHeader ? { 'mcp-session-id': sessionHeader, 'mcp-protocol-version': '2025-06-18' } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', ...(method.startsWith('notifications/') ? {} : { id: ++id }), method, params }) });
    if (response.headers.get('mcp-session-id')) sessionHeader = response.headers.get('mcp-session-id')!;
    const text = await response.text(); strict.equal(response.status, method.startsWith('notifications/') ? 202 : 200, `${method}: ${text}`);
    if (!text) return {};
    const value = text.startsWith('event:') ? JSON.parse(text.split('\n').find(row => row.startsWith('data:'))!.slice(5)) : JSON.parse(text);
    strict.equal(response.status, 200, text); return value;
  };
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'scoped-regression', version: '1' } });
  await rpc('notifications/initialized', {});
  const describe = await rpc('tools/call', { name: 'get_computer_use_policy', arguments: {} });
  strict.match(String(describe.result.content[0].text), /auto-unlock: disabled/);
  await rpc('tools/call', { name: 'get_app_state', arguments: { app: app.input } });
  await rpc('tools/call', { name: 'type_text', arguments: { app: app.input, text: 'scoped input' } });
  const requests = readFileSync(log, 'utf8').trim().split('\n').map(row => JSON.parse(row));
  strict.equal(requests.some(row => row.method === 'action'), true);
  strict.equal(requests.some(row => row.method.includes('Password')), false);
  strict.equal(requests.some(row => row.args.autoUnlock === true), false);
  strict.equal(requests.some(row => 'friendTaskRestricted' in row.args), false);
  strict.equal(runtime.policy.get().enabled, false); strict.equal(runtime.policy.autoUnlockEnabled(), true);
  scope = { active: false, apps: [] };
  strict.deepEqual(await runtime.hostCapabilities('friend'), { mcpServers: [], runtimeCapabilityRoots: [] });
});


h.test('mistaken self-app grants cannot activate Klaus, capture other conversations or press its permission controls', async () => {
  const self = { ...app, input: 'Alias', name: 'Alias', bundleId: 'ai.klaus.desktop' };
  const f = fixture(async request => request.method === 'resolve' ? self : { ...state(), app: self }, {},
    { taskScope: () => ({ active: true, apps: ['bundle:ai.klaus.desktop'] }) });
  await strict.rejects(f.connector.call('get_app_state', { app: 'Alias' }, f.context()), /cannot operate Klaus/);
  strict.deepEqual(f.requests.map(request => request.method), ['resolve']);
  strict.equal(f.approvals.length, 0);
});


h.test('invalid selectors invalidate cached state and never restore ordinary access on a scoped owner', async () => {
  let scope: ComputerUseTaskScope | undefined = { active: true, apps: ['bundle:test.fixture'] };
  const f = fixture(undefined, {}, { taskScope: () => scope }); await f.read();
  scope = { active: true, apps: ['Fixture'] };
  await strict.rejects(f.read(), /exact bundle or path/);
  scope = undefined;
  await strict.rejects(f.read(), /inactive/);
  scope = { active: true, apps: ['bundle:test.fixture'] };
  await strict.rejects(f.connector.call('type_text', { app: app.input, text: 'old state' }, f.context()), /get_app_state/);
  strict.equal(f.requests.some(request => request.method === 'action'), false);
});

const fakeWatcherScript = (name: string, body: string): string => {
  const script = join(temporary, `${name}-${randomUUID()}.cjs`);
  writeFileSync(script, body);
  return script;
};
const watcherCommand = (script: string) => ({ executable: process.execPath, args: [script], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });

h.test('a physical stop surfaces its own wording for entered input and refuses the rest of the turn', async () => {
  const gate = deferred();
  let entered = false;
  const f = fixture(async (request, signal) => {
    if (request.method === 'resolve' || request.method === 'activate') return app;
    if (request.method === 'state') return structuredClone(state());
    if (request.method === 'action') {
      entered = true;
      await new Promise<void>((resolve, reject) => {
        const abort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('aborted'));
        signal.addEventListener('abort', abort, { once: true });
        gate.promise.then(() => { signal.removeEventListener('abort', abort); resolve(); });
      });
      return { applied: true };
    }
    return { applied: true };
  });
  await f.read();
  const pending = f.connector.call('click', { app: app.input, x: 0, y: 0 }, f.context());
  await waitFor(() => entered, 2000, 'native action entered');
  f.connector.stopTurn('a', 'turn1');
  gate.resolve();
  // The stop wording is delivered verbatim; it is never the uncertain-action wrapper.
  await strict.rejects(pending, (error: unknown) => error instanceof Error && error.message === ESCAPE_STOP_MESSAGES.macos);
  const before = f.requests.length;
  await strict.rejects(f.read(f.context()), (error: unknown) => error instanceof Error && error.message === ESCAPE_STOP_MESSAGES.macos);
  strict.equal(f.requests.length, before);
  strict.equal(f.connector.turnStopped('a', 'turn1'), true);
  strict.equal(f.connector.turnStopped('b', 'turn1'), false);
  strict.equal(f.connector.turnStopped('a', 'turn2'), false);
  const next = await f.read(f.context('a', 'turn2'));
  strict.match(String(next.content[0]?.text), /<app_state>|diff from the accessibility tree|no change/);
});
h.test('the configured platform stop wording is delivered verbatim before any native work', async () => {
  const f = fixture(undefined, { escapeStopMessage: ESCAPE_STOP_MESSAGES.windows });
  f.connector.stopTurn('a', 'turn1');
  await strict.rejects(f.read(f.context()), (error: unknown) => error instanceof Error && error.message === ESCAPE_STOP_MESSAGES.windows);
  strict.equal(f.requests.length, 0);
  // A stop for an unknown or closing owner is a no-op.
  f.connector.stopTurn('missing', 'turn1');
  const next = await f.read(f.context('a', 'turn2'));
  strict.ok(next.content[0]?.text);
});
h.test('the escape watcher reports a physical escape for the attributed turn and settles on stop', async () => {
  const script = fakeWatcherScript('escape-watcher', `
process.stderr.write('klaus-escape-watch-started\\n');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  if (buffer.includes('"stop":true')) { process.stdout.write('{"event":"stopped"}\\n'); process.exit(0); }
});
setTimeout(() => process.stdout.write('{"event":"escape"}\\n'), 50);
`);
  const escapes: Array<[string, string]> = [];
  const watcher = new ComputerUseEscapeWatcher({ command: watcherCommand(script), available: () => true, log: () => {},
    onEscape: (sessionId, turnId) => escapes.push([sessionId, turnId]) });
  watcher.ensure('a', 'turn1');
  strict.equal(watcher.watching, true);
  // Attribution is read at delivery time: a re-activation before the frame arrives wins.
  watcher.ensure('b', 'turn2');
  await waitFor(() => escapes.length === 1, 10000, 'escape frame delivered');
  strict.deepEqual(escapes[0], ['b', 'turn2']);
  await watcher.stop();
  strict.equal(watcher.watching, false);
  await watcher.close(1000);
});
h.test('an unavailable escape watch degrades to a logged no-watch and never stops a turn', async () => {
  const script = fakeWatcherScript('escape-unavailable', `
process.stdout.write('{"event":"unavailable","reason":"fixture-permission"}\\n');
process.stdout.write('not json\\n');
`);
  const logs: string[] = [];
  let escapes = 0;
  const watcher = new ComputerUseEscapeWatcher({ command: watcherCommand(script), available: () => true,
    log: message => logs.push(message), onEscape: () => { escapes++; } });
  watcher.ensure('a', 'turn1');
  await waitFor(() => !watcher.watching, 10000, 'unavailable watch settles');
  strict.equal(escapes, 0);
  strict.ok(logs.some(line => line.includes('unavailable') && line.includes('fixture-permission')));
  strict.ok(logs.some(line => line.includes('malformed frame')));
  strict.deepEqual(await watcher.close(1000), { complete: true });
});
h.test('the emergency stop vector pins the shipped wording, watch protocol and banner copy', () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/computer-use-observation-vectors.json'), 'utf8')).emergencyStop;
  strict.deepEqual(vector.stopMessages, { macos: ESCAPE_STOP_MESSAGES.macos, windows: ESCAPE_STOP_MESSAGES.windows });
  strict.equal(vector.watchMethod, 'watchEscape');
  strict.equal(vector.startedMarker, 'klaus-escape-watch-started');
  strict.deepEqual(vector.watchFrames, ['escape', 'unavailable', 'tapDisabled', 'stopped']);
  strict.deepEqual(vector.overlay.en, [COMPUTER_USE_OVERLAY_COPY.en.title, COMPUTER_USE_OVERLAY_COPY.en.hint]);
  strict.deepEqual(vector.overlay.zh, [COMPUTER_USE_OVERLAY_COPY.zh.title, COMPUTER_USE_OVERLAY_COPY.zh.hint]);
  const objc = readFileSync(join(__dirname, '../../native/computer-use/klaus-computer-use-helper.m'), 'utf8');
  const cpp = readFileSync(join(__dirname, '../../native/computer-use/windows-helper.cpp'), 'utf8');
  strict.deepEqual(vector.ownInputMarks, { macos: '0x4b4c4155', windows: '0x4b435541' });
  for (const [source, mark] of [[objc, vector.ownInputMarks.macos], [cpp, vector.ownInputMarks.windows]] as const) {
    strict.ok(source.includes(mark) && source.includes(vector.startedMarker) && source.includes('watchEscape'));
  }
  const zh = computerUseOverlayHtml('zh');
  strict.ok(zh.includes(COMPUTER_USE_OVERLAY_COPY.zh.title) && zh.includes(COMPUTER_USE_OVERLAY_COPY.zh.hint) && zh.includes('prefers-color-scheme'));
  const en = computerUseOverlayHtml('en');
  strict.ok(en.includes(COMPUTER_USE_OVERLAY_COPY.en.title) && en.includes(COMPUTER_USE_OVERLAY_COPY.en.hint));
});

void h.finish(join(temporary, 'result.json'), 'computer-use').then(async code => {
  for (const close of closing) await close(); rmSync(temporary, { recursive: true, force: true }); process.exit(code);
});
