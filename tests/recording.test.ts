import { strict as assert } from 'node:assert';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrowserWindow } from 'electron';
import { RecordingHelper, recordingCapabilities, type RecordingRow } from '../main/services/recording/helper';
import { RecordingService, type RecordingDependencies, type RecordingEnded } from '../main/services/recording/service';
import { RecordingConnector, RECORDING_TOOLS } from '../main/services/recording/connector';
import { RecorderPanel } from '../main/app/recorder-panel';
import { RecordingStore, type RecordingState } from '../main/services/recording/store';
import { Harness, sleep, waitFor } from './harness';

const h = new Harness(), root = mkdtempSync(join(tmpdir(), 'klaus-recording-unit-'));
const services = new Set<RecordingService>(), helpers = new Set<RecordingHelper>();
let count = 0;
function gate<T = void>() { let release!: (value: T) => void; const promise = new Promise<T>(resolve => { release = resolve; }); return { promise, release }; }
function command(mode = 'normal') { return { executable: process.execPath, args: [resolve('tests/fixtures/recording-helper.cjs')], env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KLAUS_RECORDING_FIXTURE_MODE: mode } }; }
function helper(mode = 'normal', onEvent: (value: RecordingRow) => Promise<void> = async () => {}) {
  const capture = new RecordingHelper({ command: command(mode), recordingId: `fixture-${++count}`, generation: 1, blockedApps: [], onReady: async () => {}, onEvent });
  helpers.add(capture); return capture;
}
const context = (sessionId = 'session-a', elicit: () => Promise<unknown> = async () => ({ action: 'accept' })) => ({ sessionId, signal: new AbortController().signal, elicit });
function service(overrides: Partial<RecordingDependencies> = {}, mode = 'normal') {
  const ended: RecordingEnded[] = [], displayed: RecordingState[] = [], closed: string[] = [], logs: string[] = [];
  const recorder = new RecordingService({ recordingsRoot: join(root, `store-${++count}`), command: command(mode), platform: 'darwin', policy: () => ({ blockedApps: [] }),
    showPanel: async state => { displayed.push(state); }, closePanel: id => { closed.push(id); }, ended: async value => { ended.push(value); }, log: value => logs.push(value), ...overrides });
  services.add(recorder); return { recorder, ended, displayed, closed, logs };
}
h.test('recording tools preserve order and effect annotations from the released client', () => {
  assert.deepEqual(RECORDING_TOOLS.map(tool => tool.name), ['event_stream_start','event_stream_status','event_stream_stop']);
  assert.deepEqual(RECORDING_TOOLS.map(tool => tool.annotations.readOnlyHint), [false,true,false]);
  assert.deepEqual(RECORDING_TOOLS.map(tool => tool.annotations.idempotentHint), [false,true,false]);
  assert.ok(RECORDING_TOOLS.every(tool => tool.annotations.destructiveHint === false && tool.annotations.openWorldHint === false));
});
h.test('capability checks refuse unsupported platforms and denied permission without calling consent', async () => {
  assert.equal((await recordingCapabilities(command(), 'win32')).supported, false);
  const f = service({}, 'permission-denied'); let consent = 0;
  await assert.rejects(f.recorder.start(context('denied', async () => { consent++; return { action: 'accept' }; })), /permission-required/);
  assert.equal(consent, 0); assert.equal(f.displayed.length, 0); assert.equal((await f.recorder.close()).complete, true);
});
h.test('event acknowledgement waits for actual asynchronous storage and stop drains its final events', async () => {
  const pending = gate(), events: string[] = []; let entered = false;
  const capture = helper('normal', async value => { if (value.type === 'session.started') { entered = true; await pending.promise; } events.push(String(value.type)); });
  await capture.ready; await waitFor(() => entered, 1000, 'storage entered');
  let stopped = false; const stop = capture.stop('stop', 'test-stop').then(value => { stopped = true; return value; });
  await sleep(30); assert.equal(stopped, false); assert.deepEqual(events, []);
  pending.release(); assert.equal((await stop).mode, 'stop');
  assert.deepEqual(events, ['session.started', 'keyboard.text_input', 'session.ended']);
  await sleep(20); assert.equal(events.length, 3);
});
h.test('deadline close stays incomplete until an entered callback really settles, then never calls it again', async () => {
  const pending = gate(); let entered = false, events = 0;
  const capture = helper('normal', async () => { entered = true; await pending.promise; events++; });
  await capture.ready; await waitFor(() => entered, 1000, 'callback entered');
  assert.deepEqual(await capture.close(10), { complete: false }); pending.release();
  assert.deepEqual(await capture.close(2000), { complete: true }); const finished = events;
  await sleep(25); assert.equal(events, finished); await assert.rejects(capture.done, /cancelled/);
});
h.test('native readiness refusal, sequence corruption and abnormal exit cannot become successful captures', async () => {
  const denied = helper('native-denied'); await assert.rejects(denied.ready, /tap-refused/); assert.equal((await denied.completed).mode, 'error'); await denied.done;
  const sequence = helper('bad-sequence'); await sequence.ready; await assert.rejects(sequence.done, /sequence-invalid/);
  const badExit = helper('bad-exit'); await badExit.ready; await assert.rejects(badExit.stop('stop', 'test-stop'), /exit-failed/);
  const early = helper('early-exit'); await assert.rejects(early.ready, /fixture-early-exit|exited-before-end/); await assert.rejects(early.done);
});
h.test('stderr is drained and ordered policy operations settle through the same event stream', async () => {
  const capture = helper('stderr'); await capture.ready;
  await capture.updatePolicy({ blockedApps: ['Sensitive App'], allowedProcessIds: [process.pid] });
  assert.equal((await capture.stop('stop', 'test-stop')).mode, 'stop');
});
h.test('policy data cannot replace the trusted executable, resource identity or command kind', async () => {
  const extra = { blockedApps: [], command: { executable: 'must-not-execute' }, recordingId: 'spoofed', generation: -1, type: 'stop', mode: 'discard' };
  const f = service({ policy: () => extra }), state = await f.recorder.start(context());
  assert.notEqual(state.id, 'spoofed'); await f.recorder.updatePolicy(); assert.equal(f.recorder.status().recording, true);
  assert.equal((await f.recorder.stop(state.id, 'stop', 'tool')).ok, true);
});
h.test('late consent after session closure is revoked, and shutdown reports the unresolved consent accurately', async () => {
  const pending = gate<unknown>(); let entered = false;
  const f = service(), started = f.recorder.start(context('old-session', () => { entered = true; return pending.promise; }));
  await waitFor(() => entered, 2000, 'consent entered');
  assert.deepEqual(await f.recorder.stopSession('old-session', 10), { complete: false });
  assert.deepEqual(await f.recorder.close(10), { complete: false });
  pending.release({ action: 'accept' }); await assert.rejects(started, /cancelled/);
  assert.equal(f.displayed.length, 0); assert.equal(f.ended.length, 0); assert.deepEqual(await f.recorder.close(), { complete: true });
});
h.test('two simultaneous starts cannot reserve one profile and a declined approval leaves no recording files', async () => {
  const pending = gate<unknown>(), location = join(root, `shared-${++count}`), f = service({ recordingsRoot: location }), other = service({ recordingsRoot: location });
  let entered = false; const started = f.recorder.start(context('a', () => { entered = true; return pending.promise; }));
  await waitFor(() => entered, 2000, 'first consent'); await assert.rejects(other.recorder.start(context('b')), /already-active/);
  pending.release({ action: 'decline' }); await assert.rejects(started, /approval was not granted/); assert.equal(existsSync(location), false);
});
h.test('panel stop preserves ordered files and notifies exactly the creating session, including repeated stop', async () => {
  const f = service(), state = await f.recorder.start(context('creator'));
  assert.equal(state.state, 'recording'); assert.equal(f.displayed[0]!.sessionId, 'creator');
  const [first, second] = await Promise.all([f.recorder.stop(state.id, 'stop'), f.recorder.stop(state.id, 'discard')]);
  assert.equal(first.ok, true); assert.deepEqual(second, first);
  assert.equal(f.ended.length, 1); assert.equal(f.ended[0]!.sessionId, 'creator'); assert.equal(f.ended[0]!.mode, 'stop');
  assert.deepEqual(readFileSync(state.eventsPath, 'utf8').trim().split('\n').map(line => JSON.parse(line).type), ['session.started', 'keyboard.text_input', 'session.ended']);
  assert.equal(JSON.parse(readFileSync(join(state.eventsPath, '..', 'metadata.json'), 'utf8')).state, 'ended');
});
h.test('discard deletes only the drained recording and preserves sibling files', async () => {
  const f = service(), state = await f.recorder.start(context()), sibling = join(state.eventsPath, '..', '..', 'keep.txt'); writeFileSync(sibling, 'keep');
  assert.equal((await f.recorder.stop(state.id, 'discard')).ok, true); assert.equal(existsSync(state.eventsPath), false);
  assert.equal(readFileSync(sibling, 'utf8'), 'keep'); assert.equal(f.ended[0]!.mode, 'discard');
});
h.test('agent stop returns evidence without submitting another turn and retains each session result when another starts', async () => {
  const f = service(), connector = new RecordingConnector(f.recorder);
  await connector.call('event_stream_start', {}, context('session-a'));
  const first = await connector.call('event_stream_stop', {}, context('session-a'));
  assert.match(first.content[0]!.text, /state=ended/); assert.equal(f.ended.length, 0);
  const b = await f.recorder.start(context('session-b'));
  const retained = await connector.call('event_stream_stop', {}, context('session-a'));
  assert.deepEqual(retained, first); assert.equal(f.recorder.status().recording, true);
  const foreign = await connector.call('event_stream_stop', {}, context('foreign')); assert.match(foreign.content[0]!.text, /No recording/);
  await f.recorder.stop(b.id, 'stop', 'tool');
});
h.test('native auto-stop and transport failures publish distinct terminal states and preserve failed prefixes', async () => {
  const automatic = service({}, 'auto-stop'); await automatic.recorder.start(context());
  await waitFor(() => automatic.ended.length === 1, 2000, 'automatic end'); assert.equal(automatic.ended[0]!.mode, 'stop');
  const failed = service({}, 'bad-exit'), state = await failed.recorder.start(context());
  const result = await failed.recorder.stop(state.id, 'stop'); assert.equal(result.ok, false); assert.equal(result.state!.state, 'failed');
  assert.equal(failed.ended[0]!.mode, 'error'); assert.ok(existsSync(state.eventsPath));
});
h.test('a pending end delivery keeps shutdown incomplete and is never retried after ambiguous failure', async () => {
  const pending = gate(); let entered = 0;
  const f = service({ ended: async () => { entered++; await pending.promise; throw new Error('ack-lost'); } }), state = await f.recorder.start(context());
  const stopped = f.recorder.stop(state.id, 'stop'); await waitFor(() => entered === 1, 2000, 'delivery entered');
  assert.deepEqual(await f.recorder.close(10), { complete: false }); pending.release();
  assert.equal((await stopped).ok, false); assert.equal((await f.recorder.stop(state.id, 'stop')).ok, false); assert.equal(entered, 1);
  assert.deepEqual(await f.recorder.close(), { complete: true });
});
h.test('control files stop their exact recording and symlink controls fail without following or deleting the target', async () => {
  const f = service(), state = await f.recorder.start(context()); writeFileSync(join(state.eventsPath, '..', 'control.json'), JSON.stringify({ action: 'stop' }));
  await waitFor(() => f.ended.length === 1, 2000, 'control stop'); assert.equal(f.ended[0]!.recordingId, state.id);
  if (process.platform === 'win32') return;
  const next = await f.recorder.start(context()), outside = join(root, 'outside.json'); writeFileSync(outside, '{"action":"discard"}');
  symlinkSync(outside, join(next.eventsPath, '..', 'control.json'));
  await waitFor(() => f.ended.length === 2, 2000, 'invalid control ends safely');
  assert.equal(f.ended[1]!.mode, 'error'); assert.ok(existsSync(next.eventsPath)); assert.equal(readFileSync(outside, 'utf8'), '{"action":"discard"}');
});
h.test('a live previous owner blocks recording instead of overwriting its active metadata', async () => {
  const location = join(root, `live-${++count}`); mkdirSync(location);
  const active = { id: 'old', eventsPath: join(location, 'old', 'events.jsonl'), state: 'recording', pid: process.pid };
  writeFileSync(join(location, 'active.json'), JSON.stringify(active));
  const f = service({ recordingsRoot: location }); await assert.rejects(f.recorder.start(context()), /live-process/);
  assert.deepEqual(JSON.parse(readFileSync(join(location, 'active.json'), 'utf8')), active);
});
h.test('disk metadata failure cannot resolve stop as success', async () => {
  const f = service(), state = await f.recorder.start(context()), metadata = join(state.eventsPath, '..', 'metadata.json');
  rmSync(metadata); mkdirSync(metadata);
  const result = await f.recorder.stop(state.id, 'stop'); assert.equal(result.ok, false); assert.equal(result.state!.state, 'failed'); assert.equal(f.ended[0]!.mode, 'error');
});
h.test('a restarted service reads only the persisted owner session and reports a crashed prefix as incomplete', async () => {
  const location = join(root, `restart-${++count}`), first = service({ recordingsRoot: location });
  const state = await first.recorder.start(context('persisted')); await first.recorder.stop(state.id, 'stop', 'tool'); await first.recorder.close();
  const restarted = service({ recordingsRoot: location }), connector = new RecordingConnector(restarted.recorder);
  assert.match((await connector.call('event_stream_status', {}, context('persisted'))).content[0]!.text, /state=ended/);
  assert.match((await connector.call('event_stream_status', {}, context('other'))).content[0]!.text, /No recording/);
  const activePath = join(location, 'active.json'), old = JSON.parse(readFileSync(activePath, 'utf8'));
  writeFileSync(activePath, JSON.stringify({ ...old, state: 'recording', hostPid: 0, pid: 0 }));
  await assert.rejects(connector.call('event_stream_stop', {}, context('persisted')), /recording-interrupted/);
  assert.ok(existsSync(state.eventsPath));
});
h.test('store refuses an active path outside its configured recording root', async () => {
  const location = join(root, `invalid-${++count}`); mkdirSync(location); writeFileSync(join(location, 'active.json'), JSON.stringify({ id: 'owned', state: 'recording', eventsPath: '/tmp/foreign/events.jsonl' }));
  await assert.rejects(new RecordingStore(location).previous(), /active-path-invalid/);
});

let windowId = 200;
class FakeWindow extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), { id: ++windowId }); destroyed = false;
  isDestroyed() { return this.destroyed; } isVisible() { return !this.destroyed; }
  destroy() { if (this.destroyed) return; this.destroyed = true; this.emit('closed'); }
}
h.test('panel owner isolation survives reload; the old id cannot stop a new recording', async () => {
  const windows: FakeWindow[] = [], owners = new Set<number>();
  const panel = new RecorderPanel({ createWindow: () => { const window = new FakeWindow(); windows.push(window); setImmediate(() => window.webContents.emit('did-finish-load')); return window as unknown as BrowserWindow; }, registerOwner: window => { owners.add(window.webContents.id); }, unregisterOwner: id => { owners.delete(id); }, log: () => {} });
  const f = service({ showPanel: state => panel.show(state), closePanel: id => panel.close(id) }); panel.bind(f.recorder);
  await f.recorder.start(context()); const first = windows[0]!;
  assert.throws(() => panel.status(first.webContents.id + 1), /does not own/);
  first.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  await waitFor(() => f.ended.length === 1, 2000, 'reload stopped capture'); assert.equal(owners.size, 0);
  const second = await f.recorder.start(context()); assert.throws(() => panel.stop(first.webContents.id, 'discard'), /does not own/);
  assert.equal(f.recorder.status().recording, true); await f.recorder.stop(second.id, 'discard'); panel.shutdown();
});

void h.finish(join(root, 'result.json'), 'recording').then(async code => {
  for (const recorder of services) await recorder.close(1000);
  for (const capture of helpers) await capture.close(1000);
  if (code === 0) rmSync(root, { recursive: true, force: true }); else console.error(`recording evidence: ${root}`);
  process.exitCode = code;
});
