import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Json } from '../main/ipc/contract';
import { DynamicTools } from '../main/sessions/dynamic-tools';
import { object } from '../main/services/service-types';
import { registerWorkspaceDependencyTool, type WorkspaceDependencyProvider } from '../main/services/workspace-dependency-tools';

const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/workspace-dependencies.json'), 'utf8')) as {
  toolName: string; resolveMethod: string; readyState: string; requiredReadyPaths: string[]; unavailableStates: string[];
};
const ready = { state: 'ready', pythonPath: '/managed/python', binDir: '/managed/bin', version: 'fixture' };
const text = (value: Json) => String(object((object(value).contentItems as Json[])[0]).text);
type Handler = Parameters<DynamicTools['register']>[1];
function fixture(service: WorkspaceDependencyProvider, options: { local?: boolean; current?: () => void } = {}) {
  let handler!: Handler;
  registerWorkspaceDependencyTool({ register(spec, run) {
    assert.equal(object(spec).name, vector.toolName); handler = run;
  } }, service, '/bundled/skills', (_id, signal) => ({
    local: options.local !== false,
    assertCurrent: () => { signal.throwIfAborted(); options.current?.(); },
  }));
  return (args: Json = {}, signal = new AbortController().signal) => handler(args, 'engine-session', signal, 'call', 'turn');
}

test('a ready managed runtime returns usable paths through the named dynamic-tool facade', async () => {
  let resolve!: (value: Record<string, Json>) => void;
  const completed = new Promise<Record<string, Json>>(done => { resolve = done; });
  const tools = new DynamicTools({ knownSession: id => id === 'session', log: () => {}, request: async (method, params) => {
    assert.equal(method, vector.resolveMethod); resolve(params); return {};
  } });
  try {
    registerWorkspaceDependencyTool(tools, { ensure: async () => ready }, '/bundled/skills', () => ({ local: true, assertCurrent() {} }));
    tools.receive({ type: 'rawSessionEvent', params: { sessionId: 'session', event: { dynamicToolCall: { callId: 'call', turnId: 'turn', tool: vector.toolName, arguments: {} } } } });
    const params = await completed;
    assert.equal(object(params.response).success, true);
    const result = JSON.parse(text(params.response!));
    assert.equal(result.state, vector.readyState);
    for (const key of vector.requiredReadyPaths) assert.equal(typeof result[key], 'string');
    assert.equal(result.pythonPath, ready.pythonPath);
    assert.equal(result.pdfHelperPath, join('/bundled/skills', 'pdf', 'scripts', 'pdf.py'));
  } finally { await tools.close(); }
});

for (const state of vector.unavailableStates) test(`${state} runtime reports failure without advertising executable paths`, async () => {
  const execute = fixture({ ensure: async () => ({ ...ready, state, error: 'fixture unavailable', logPath: '/managed/log' }) });
  const result = await execute();
  assert.equal(object(result).success, false);
  const detail = JSON.parse(text(result));
  assert.equal(detail.state, state); assert.equal(detail.error, 'fixture unavailable');
  assert.equal(detail.pythonPath, undefined); assert.equal(detail.pdfHelperPath, undefined);
});

test('nonlocal calls and unexpected arguments cannot install a local environment', async () => {
  let installs = 0;
  const service = { ensure: async () => { installs++; return ready; } };
  assert.equal(object(await fixture(service, { local: false })()).success, false);
  const execute = fixture(service);
  for (const args of [null, [], { path: '/untrusted' }]) assert.equal(object(await execute(args)).success, false);
  assert.equal(installs, 0);
});

test('caller cancellation releases its wait without cancelling shared installation', async () => {
  let finish!: (value: typeof ready) => void;
  const installing = new Promise<typeof ready>(resolve => { finish = resolve; });
  const service = { ensure: () => installing }, execute = fixture(service);
  const controller = new AbortController(), cancelled = execute({}, controller.signal);
  controller.abort(new Error('caller cancelled'));
  await assert.rejects(Promise.resolve(cancelled), /caller cancelled/);
  const other = execute(); finish(ready);
  assert.equal(object(await other).success, true);
});

test('a session that closes during installation cannot receive runtime paths', async () => {
  let active = true;
  const execute = fixture({ ensure: async () => { active = false; return ready; } }, {
    current: () => { if (!active) throw new Error('session closed'); },
  });
  await assert.rejects(Promise.resolve(execute()), /session closed/);
});
