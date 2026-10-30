import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserMcpServer } from '../main/browser/mcp';
import type { BrowserManager } from '../main/browser/manager';
import { object, type BrowserObject } from '../main/browser/types';
import { assert, assertEqual, assertRejects, Harness, waitFor } from './harness';

const h = new Harness();

async function fixture(run: (context: {
  server: BrowserMcpServer;
  endpoint(owner: string): Promise<string>;
  signals: Map<string, AbortSignal>;
  finish: Map<string, () => void>;
  observed: string[];
}) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'klaus-browser-cancellation-'));
  const signals = new Map<string, AbortSignal>(), finish = new Map<string, () => void>(), observed: string[] = [];
  const server = new BrowserMcpServer({
    configRoot: root, isEnabled: () => true, releaseConversation: () => {},
  } as unknown as BrowserManager, { chromeDiscoveryDirectory: join(root, 'chrome'), observeResult: (_owner, _lease, result) => { observed.push(String(object(result).label)); } });
  // Keep operations pending while exercising the real authenticated HTTP server.
  server.operations.execute = async (_owner, _name, input, signal) => {
    assert(signal, 'each HTTP operation has a request signal');
    const label = String(object(input).label);
    signals.set(label, signal);
    return new Promise<BrowserObject>(resolve => {
      const aborted = (): void => resolve({ isError: true, label });
      finish.set(label, () => { signal.removeEventListener('abort', aborted); resolve({ label }); });
      signal.addEventListener('abort', aborted, { once: true });
      if (signal.aborted) aborted();
    });
  };
  const endpoint = async (owner: string): Promise<string> => {
    const capabilities = await server.hostCapabilities(owner);
    return String(object((capabilities.mcpServers as BrowserObject[])[0]).url);
  };
  try { await run({ server, endpoint, signals, finish, observed }); }
  finally { await server.shutdown(); rmSync(root, { recursive: true, force: true }); }
}

async function rpc(url: string, session: string | undefined, method: string, params: BrowserObject, id?: string | number, signal?: AbortSignal): Promise<{ response: Response; body: BrowserObject }> {
  const response = await fetch(url, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...(session ? { 'Mcp-Session-Id': session } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return { response, body: response.status === 202 ? {} : object(await response.json()) };
}

async function initialize(url: string): Promise<string> {
  const { response } = await rpc(url, undefined, 'initialize', {}, 1);
  const session = response.headers.get('mcp-session-id');
  assert(session, 'initialize returns a connection identity');
  return session;
}

h.test('cancellation preserves request-id types and isolates capability tokens and MCP sessions', () => fixture(async ({ endpoint, signals, finish, observed }) => {
  const url = await endpoint('owner'), foreign = await endpoint('foreign');
  const first = await initialize(url), second = await initialize(url);
  const a = rpc(url, first, 'tools/call', { name: 'read_urls', arguments: { label: 'A' } }, 7);
  const b = rpc(url, second, 'tools/call', { name: 'read_urls', arguments: { label: 'B' } }, 7);
  await waitFor(() => signals.size === 2, 1000, 'both connections have active calls');
  await rpc(url, first, 'notifications/cancelled', { requestId: '7' });
  assertEqual(signals.get('A')!.aborted, false, 'string id cannot cancel numeric id');
  const forbidden = await rpc(foreign, first, 'notifications/cancelled', { requestId: 7 });
  assertEqual(forbidden.response.status, 404, 'foreign capability cannot use another session');
  await rpc(url, second, 'notifications/cancelled', { requestId: 7 });
  assertEqual(signals.get('B')!.aborted, true, 'matching MCP connection cancelled');
  assertEqual(signals.get('A')!.aborted, false, 'other MCP connection remains active');
  await b;
  assertEqual(observed.length, 0, 'cancelled result does not reach presentation');
  finish.get('A')!(); await a;
  assertEqual(signals.get('A')!.aborted, false, 'normal response close does not cancel');
  assertEqual(observed.join(','), 'A', 'normal result is presented once');
}));

h.test('dropping a pending HTTP response cancels only its browser operation', () => fixture(async ({ endpoint, signals, finish }) => {
  const url = await endpoint('owner'), session = await initialize(url), controller = new AbortController();
  const pending = rpc(url, session, 'tools/call', { name: 'read_urls', arguments: { label: 'dropped' } }, 2, controller.signal);
  await waitFor(() => signals.has('dropped'), 1000, 'dropped request reached the operation');
  controller.abort();
  await assertRejects(() => pending, 'HTTP caller abandoned the response');
  await waitFor(() => signals.get('dropped')!.aborted, 1000, 'response close propagates cancellation');
  const next = rpc(url, session, 'tools/call', { name: 'read_urls', arguments: { label: 'next' } }, 3);
  await waitFor(() => signals.has('next'), 1000, 'same browser connection remains usable');
  finish.get('next')!(); await next;
  assertEqual(signals.get('next')!.aborted, false, 'later request is unaffected');
}));

h.test('DELETE, task release and shutdown cancel exactly their owned browser calls', () => fixture(async ({ server, endpoint, signals }) => {
  const url = await endpoint('owner'), other = await endpoint('other');
  const first = await initialize(url), second = await initialize(url), third = await initialize(other);
  const calls = [
    rpc(url, first, 'tools/call', { name: 'read_urls', arguments: { label: 'A' } }, 7),
    rpc(url, second, 'tools/call', { name: 'read_urls', arguments: { label: 'B' } }, 7),
    rpc(other, third, 'tools/call', { name: 'read_urls', arguments: { label: 'C' } }, 7),
  ];
  await waitFor(() => signals.size === 3, 1000, 'three independently owned calls');
  await fetch(url, { method: 'DELETE', headers: { 'Mcp-Session-Id': first } });
  assertEqual(signals.get('A')!.aborted, true, 'deleted MCP session cancelled');
  assertEqual(signals.get('B')!.aborted, false, 'other MCP session preserved');
  server.releaseSession('owner');
  assertEqual(signals.get('B')!.aborted, true, 'released task cancelled');
  assertEqual(signals.get('C')!.aborted, false, 'another task preserved');
  const settled = Promise.allSettled(calls);
  await server.shutdown();
  assertEqual(signals.get('C')!.aborted, true, 'shutdown cancels remaining owner');
  await settled;
}));

void h.finish(join(__dirname, 'browser-mcp-cancellation-result.json'), 'browser-mcp-cancellation').then(code => process.exit(code));
