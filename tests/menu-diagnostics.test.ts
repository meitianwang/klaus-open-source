import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopMenuDiagnostics, type MenuDiagnosticsServices, type MenuTraceState } from '../main/app/menu-diagnostics';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'klaus-menu-diagnostics-'));
  const states: MenuTraceState[] = [], messages: unknown[] = [], revealed: string[] = [], opened: string[] = [], logs: string[] = [];
  let startError = false, stopError = false, starts = 0, stops = 0, saves = 0, startGate: Promise<void> | undefined;
  let chinese = false;
  const services: MenuDiagnosticsServices = {
    createWindow: () => { throw new Error('A native window was not expected in this test'); },
    tracing: {
      startRecording: async () => { starts++; await startGate; if (startError) throw new Error('capture busy'); },
      stopRecording: async path => { stops++; if (stopError) throw new Error('capture write failed'); assert.ok(path); await writeFile(path, '{"traceEvents":[]}'); return path; },
      getTraceBufferUsage: async () => ({ percentage: 0.2, value: 20 }),
    },
    dialog: {
      showSaveDialog: async () => { saves++; return { canceled: true, filePath: undefined }; },
      showMessageBox: async (...args: unknown[]) => { messages.push(args.at(-1)); return { response: 0, checkboxChecked: false }; },
    } as unknown as MenuDiagnosticsServices['dialog'],
    shell: { openPath: async path => { opened.push(path); return ''; }, showItemInFolder: path => { revealed.push(path); } },
  };
  const diagnostics = new DesktopMenuDiagnostics({ app: { getAppMetrics: () => [], getName: () => 'Klaus', getVersion: () => '1.0.0' },
    configRoot: root, parent: () => null, chinese: () => chinese, status: () => ({ engine: 'ready' }),
    onChanged: () => { states.push(diagnostics.traceState); }, log: (kind, value) => logs.push(`${kind}: ${value}`) }, services);
  return { diagnostics, services, root, states, messages, revealed, opened, logs,
    counts: () => ({ starts, stops, saves }), setStartGate: (gate: Promise<void>) => { startGate = gate; },
    setErrors: (start: boolean, stop: boolean) => { startError = start; stopError = stop; },
    setChinese: () => { chinese = true; }, cleanup: async () => { await diagnostics.close(); await rm(root, { recursive: true, force: true }); } };
}

test('trace transitions disable duplicate actions and retain private output when save is canceled', async t => {
  const f = await fixture(); t.after(f.cleanup);
  let release!: () => void;
  f.setStartGate(new Promise<void>(resolve => { release = resolve; }));
  const start = f.diagnostics.toggleTrace();
  assert.equal(f.diagnostics.traceState, 'starting');
  assert.equal(f.diagnostics.traceEnabled, false);
  await Promise.resolve();
  const duplicate = f.diagnostics.toggleTrace();
  assert.equal(start, duplicate);
  assert.equal(f.counts().starts, 1);
  release(); await start;
  assert.equal(f.diagnostics.traceState, 'recording');
  f.setChinese(); assert.equal(f.diagnostics.traceLabel, '停止性能跟踪');
  await f.diagnostics.toggleTrace();
  assert.deepEqual(f.states, ['starting', 'recording', 'stopping', 'saving', 'idle']);
  assert.deepEqual(f.counts(), { starts: 1, stops: 1, saves: 1 });
  const files = await readdir(join(f.root, 'diagnostics'));
  assert.equal(files.length, 1);
  const path = join(f.root, 'diagnostics', files[0]!);
  assert.equal(await readFile(path, 'utf8'), '{"traceEvents":[]}');
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(f.messages.length, 1);
  assert.match(JSON.stringify(f.messages), /性能跟踪文件位于/);
});

test('start and stop failures preserve recoverable capture state and allow retry', async t => {
  const f = await fixture(); t.after(f.cleanup);
  f.setErrors(true, false);
  await f.diagnostics.toggleTrace();
  assert.equal(f.diagnostics.traceState, 'idle');
  f.setErrors(false, false);
  await f.diagnostics.toggleTrace();
  f.setErrors(false, true);
  await f.diagnostics.toggleTrace();
  assert.equal(f.diagnostics.traceState, 'recording');
  assert.equal(f.diagnostics.traceEnabled, true);
  f.setErrors(false, false);
  await f.diagnostics.toggleTrace();
  assert.equal(f.diagnostics.traceState, 'idle');
  assert.ok(f.logs.some(line => line.includes('capture busy')));
  assert.ok(f.logs.some(line => line.includes('capture write failed')));
  assert.deepEqual(f.counts(), { starts: 2, stops: 2, saves: 1 });
});

test('selected trace destinations receive private output while save failures retain the original', async t => {
  const f = await fixture(); t.after(f.cleanup);
  const destination = join(f.root, 'selected-trace.json');
  f.services.dialog.showSaveDialog = (async () => ({ canceled: false, filePath: destination })) as MenuDiagnosticsServices['dialog']['showSaveDialog'];
  await f.diagnostics.toggleTrace();
  await f.diagnostics.toggleTrace();
  assert.equal(await readFile(destination, 'utf8'), '{"traceEvents":[]}');
  assert.deepEqual(f.revealed, [destination]);
  if (process.platform !== 'win32') assert.equal((await stat(destination)).mode & 0o777, 0o600);
  f.services.dialog.showSaveDialog = (async () => ({ canceled: false, filePath: join(f.root, 'missing-directory', 'trace.json') })) as MenuDiagnosticsServices['dialog']['showSaveDialog'];
  await f.diagnostics.toggleTrace();
  await f.diagnostics.toggleTrace();
  assert.equal(f.diagnostics.traceState, 'idle');
  assert.ok(f.logs.some(line => line.startsWith('menu-trace-retained: ')));
  assert.equal((await readdir(join(f.root, 'diagnostics'))).length, 2);
});

test('shutdown waits for a pending start and saves owned capture without a dialog', async t => {
  const f = await fixture(); t.after(f.cleanup);
  let release!: () => void;
  f.setStartGate(new Promise<void>(resolve => { release = resolve; }));
  const starting = f.diagnostics.toggleTrace();
  const closing = f.diagnostics.close();
  assert.equal(f.diagnostics.close(), closing);
  release(); await starting; await closing;
  assert.deepEqual(f.counts(), { starts: 1, stops: 1, saves: 0 });
  assert.equal(f.diagnostics.traceState, 'idle');
  assert.equal(f.diagnostics.traceEnabled, false);
  await f.diagnostics.toggleTrace();
  assert.equal(f.counts().starts, 1);
  assert.equal(f.messages.length, 0);
});

test('troubleshooting opens the local log root and reports shell failures', async t => {
  const f = await fixture(); t.after(f.cleanup);
  await f.diagnostics.openTroubleshooting();
  assert.deepEqual(f.opened, [f.root]);
  f.services.shell.openPath = async () => 'no file manager';
  await f.diagnostics.openTroubleshooting();
  assert.equal(f.messages.length, 1);
  assert.ok(f.logs.some(line => line.includes('no file manager')));
});
