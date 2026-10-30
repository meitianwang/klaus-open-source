import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ReadableStream } from 'node:stream/web';
import type { Json } from '../main/ipc/contract';
import type { MobileAccount } from '../main/services/mobile/protocol';
import { mobileDeviceId } from '../main/services/mobile/settings';
import { RemoteThreadClient, type RemoteThreadClientDeps, type RemoteThreadOperation } from '../main/services/remote-thread-client';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness, waitFor } from './harness';

const h = new Harness();
const deadline = setTimeout(() => { process.stderr.write('remote-thread-client deadline exceeded\n'); process.exit(1); }, 30_000);
const signal = (): AbortSignal => new AbortController().signal;
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
const json = (body: Json, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const peer = (extra: JsonObject = {}): JsonObject => ({ id: 'other-computer', name: 'Other computer', status: 'online', relayId: 'fixture-relay-123456', features: { threadCommunication: 1 }, ...extra });
interface Request { url: string; init: RequestInit; headers: Headers; body: JsonObject }

async function fixture(overrides: Partial<RemoteThreadClientDeps> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'klaus-remote-thread-client-'));
  let account: MobileAccount | undefined = { token: 'fixture-account-token', userId: 'fixture-user' }, enabled = true, expired = 0;
  const requests: Request[] = [];
  const localHostId = await mobileDeviceId(root, account.userId, 'linux', async () => undefined);
  const state = {
    devices: [peer()] as JsonObject[],
    handler: undefined as undefined | ((request: Request) => Response | Promise<Response>),
  };
  const client = new RemoteThreadClient({ configRoot: root, serverURL: 'https://trusted.invalid', account: () => account, enabled: () => enabled,
    platform: 'linux', machineIdentifier: async () => undefined, authorizationExpired: () => { expired += 1; },
    fetch: async (input, init = {}) => {
      const request = { url: String(input), init, headers: new Headers(init.headers), body: init.body ? object(JSON.parse(String(init.body))) : {} };
      requests.push(request);
      return state.handler?.(request) ?? (request.url.endsWith('/api/mobile/devices') ? json({ devices: state.devices }) : json({ ok: true }));
    }, ...overrides });
  return { client, root, state, requests, localHostId, expired: () => expired,
    account: (value: MobileAccount | undefined) => { account = value; }, enabled: (value: boolean) => { enabled = value; },
    close: async () => { await client.close(); rmSync(root, { recursive: true, force: true }); } };
}

h.test('discovery excludes the machine identity and retains offline and unsupported account peers', async () => {
  const f = await fixture(); try {
    f.state.devices = [peer({ id: f.localHostId, isCurrent: false }), peer({ isCurrent: true, relayBaseUrl: 'https://hostile.invalid', name: '\u0000\n Other \u202ecomputer\u200f ' }),
      peer({ id: 'offline-computer', status: 'offline', features: {} }), peer({ id: 'older-computer', features: { threadCommunication: true } }),
      peer({ id: 'reconnecting-computer', status: 'reconnecting', name: 'x'.repeat(500) })];
    const result = await f.client.discover(signal());
    assert.equal(result.localHostId, f.localHostId);
    assert.deepEqual(result.hosts.map(row => [row.id, row.status, row.features]), [
      ['other-computer', 'online', { threadCommunication: 1 }], ['offline-computer', 'offline', {}],
      ['older-computer', 'online', { threadCommunication: true }], ['reconnecting-computer', 'reconnecting', { threadCommunication: 1 }],
    ]);
    assert.equal(result.hosts[0]!.name, 'Other computer'); assert.equal(result.hosts[3]!.name.length, 120);
    assert(!JSON.stringify(result).includes('hostile')); assert(!JSON.stringify(result).includes('relayId'));
    assert.equal(f.requests[0]!.headers.get('authorization'), 'Bearer fixture-account-token');
    assert.equal(f.requests[0]!.headers.get('x-klaus-device-id'), f.localHostId);
  } finally { await f.close(); }
});

h.test('every operation uses a fresh account lookup and a trusted POST with caller identity', async () => {
  const f = await fixture(); try {
    f.state.devices = [peer({ relayBaseUrl: 'https://hostile.invalid/steal', relayUrl: 'https://hostile.invalid', origin: 'https://hostile.invalid' })];
    const operations: RemoteThreadOperation[] = ['list_threads', 'list_archived_threads', 'read_thread', 'send_message_to_thread'];
    for (const [index, operation] of operations.entries()) {
      f.state.devices[0]!.relayId = 'fresh-relay-' + index;
      assert.deepEqual(await f.client.request('other-computer', operation, { threadId: 'target' }, 'caller', signal(), 'logical-request-' + index), { ok: true });
      const request = f.requests.at(-1)!;
      assert.equal(request.url, 'https://trusted.invalid/api/mobile/relay/fresh-relay-' + index + '/thread-tools/' + operation);
      assert.equal(request.init.method, 'POST'); assert.equal(request.init.redirect, 'error');
      assert.equal(request.headers.get('authorization'), 'Bearer fixture-account-token');
      assert.equal(request.headers.get('x-klaus-device-id'), f.localHostId);
      assert.deepEqual(request.body, { caller: { hostId: f.localHostId, threadId: 'caller' }, requestId: 'logical-request-' + index, arguments: { threadId: 'target' } });
    }
    assert.equal(f.requests.filter(request => request.init.method === 'GET').length, 4);
    assert(f.requests.every(request => request.url.startsWith('https://trusted.invalid/')));
  } finally { await f.close(); }
});

h.test('goal owner operations are refused before remote discovery or relay traffic', async () => {
  const f = await fixture();
  try {
    for (const operation of ['goal:get', 'goal:prepare-objective', 'goal:read-objective', 'goal:discard-prepared-objective', 'goal:set', 'goal:clear', 'session/setGoal']) {
      await assert.rejects(() => f.client.request('other-computer', operation as RemoteThreadOperation,
        { sessionId: 'same-conversation', objective: 'Use local owned files' }, 'same-conversation', signal()),
      { code: 'invalid_remote_request' });
    }
    assert.equal(f.requests.length, 0, 'unsupported owner operations never discover a peer or post a relay request');
  } finally { await f.close(); }
});

h.test('delivery observations survive the HTTP client without becoming transport errors', async () => {
  const f = await fixture(); try {
    for (const state of ['unconfirmed', 'removed']) {
      const observed: JsonObject = { ok: false, threadId: 'target', delivered: state, messageId: 'b216eea4-4673-442e-b0d7-5d8501a0c309',
        [state]: true, deliveryError: 'Delivery was not applied', notice: 'Check queued input before resending' };
      f.state.handler = request => request.url.endsWith('/api/mobile/devices') ? json({ devices: f.state.devices }) : json(observed);
      assert.deepEqual(await f.client.request('other-computer', 'send_message_to_thread', { threadId: 'target', prompt: 'Already issued' }, 'caller', signal()), observed,
        'observation is data, not the relay error envelope');
    }
  } finally { await f.close(); }
});

h.test('requests mint an id by default and preserve a supplied bounded retry identity', async () => {
  const f = await fixture(); try {
    await f.client.request('other-computer', 'send_message_to_thread', { prompt: 'Hello' }, 'caller', signal());
    assert.match(String(f.requests.at(-1)!.body.requestId), /^[0-9a-f-]{36}$/u);
    const explicit = 'r'.repeat(256);
    await f.client.request('other-computer', 'send_message_to_thread', { prompt: 'Hello' }, 'caller', signal(), explicit);
    assert.equal(f.requests.at(-1)!.body.requestId, explicit);
    await assert.rejects(f.client.request('other-computer', 'send_message_to_thread', {}, 'caller', signal(), explicit + 'r'), { code: 'invalid_remote_request' });
    assert.equal(f.requests.length, 4);
  } finally { await f.close(); }
});

h.test('unknown, local, offline, reconnecting and older hosts fail before a relay request', async () => {
  const f = await fixture(); try {
    f.state.devices = [peer({ id: f.localHostId }), peer({ id: 'offline', status: 'offline' }), peer({ id: 'reconnecting', status: 'reconnecting' }),
      peer({ id: 'old', features: {} }), peer({ id: 'boolean-version', features: { threadCommunication: true } }),
      peer({ id: 'unknown-status', status: 'future' })];
    for (const [id, code] of [['unknown', 'remote_host_not_found'], [f.localHostId, 'local_host'], ['offline', 'remote_host_offline'],
      ['reconnecting', 'remote_host_offline'], ['old', 'remote_threads_unsupported'], ['boolean-version', 'remote_threads_unsupported'], ['unknown-status', 'remote_host_offline']]) {
      await assert.rejects(f.client.request(id!, 'read_thread', {}, 'caller', signal()), { code });
    }
    assert(f.requests.every(request => request.init.method === 'GET'));
  } finally { await f.close(); }
});

h.test('signed out and disabled discovery is empty while explicit requests reject', async () => {
  const f = await fixture(); try {
    f.account(undefined);
    assert.deepEqual(await f.client.discover(signal()), { localHostId: null, hosts: [] });
    await assert.rejects(f.client.request('other-computer', 'read_thread', {}, 'caller', signal()), { code: 'account_required' });
    f.account({ token: 'new-token', userId: 'new-user' }); f.enabled(false);
    assert.deepEqual(await f.client.discover(signal()), { localHostId: null, hosts: [] });
    await assert.rejects(f.client.request('other-computer', 'read_thread', {}, 'caller', signal()), { code: 'remote_threads_disabled' });
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

h.test('malformed, duplicate and excessive device lists cannot produce routing candidates', async () => {
  const f = await fixture(); try {
    for (const body of [{}, { devices: {} }, { devices: [peer({ id: '' })] }, { devices: [peer({ features: [] })] },
      { devices: [peer(), peer()] }, { devices: Array.from({ length: 65 }, (_, index) => peer({ id: 'peer-' + index })) }] as Json[]) {
      f.state.handler = () => json(body);
      await assert.rejects(f.client.discover(signal()), { code: 'invalid_remote_response' });
    }
    f.state.handler = undefined; f.state.devices = [peer({ relayId: '../hostile?token=leak' })];
    await assert.rejects(f.client.request('other-computer', 'read_thread', {}, 'caller', signal()), { code: 'invalid_remote_response' });
    assert(f.requests.every(request => request.init.method === 'GET'));
  } finally { await f.close(); }
});

h.test('invalid operation, caller identity and cyclic arguments fail without network traffic', async () => {
  const f = await fixture(); try {
    const cyclic: JsonObject = {}; cyclic.self = cyclic;
    const cases: Array<[string, RemoteThreadOperation, JsonObject, string]> = [
      ['other-computer', 'delete_thread' as RemoteThreadOperation, {}, 'caller'], ['../other', 'read_thread', {}, 'bad\ncaller'],
      ['other-computer', 'read_thread', [] as unknown as JsonObject, 'caller'], ['other-computer', 'read_thread', cyclic, 'caller'],
    ];
    for (const args of cases) await assert.rejects(f.client.request(...args, signal()), { code: 'invalid_remote_request' });
    assert.equal(f.requests.length, 0);
  } finally { await f.close(); }
});

h.test('oversized request bodies are rejected without sending a message', async () => {
  const f = await fixture(); try {
    await assert.rejects(f.client.request('other-computer', 'send_message_to_thread', { prompt: 'x'.repeat(256 * 1024) }, 'caller', signal()), { code: 'remote_request_too_large' });
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0]!.init.method, 'GET');
  } finally { await f.close(); }
});

h.test('malformed result objects and invalid response statuses fail explicitly', async () => {
  const f = await fixture(); try {
    const bad = [() => new Response('not json'), () => json([]), () => json(null), () => json({ error: {} }),
      () => json({ error: { type: 'failed', message: '' } }), () => json({ ok: true }, 302), () => new Response(null, { status: 204 }),
      () => new Response('{"infinite":1e400}'), () => json({ error: { type: 'failed', message: 'm'.repeat(4097) } })];
    for (const response of bad) {
      f.state.handler = request => request.init.method === 'GET' ? json({ devices: f.state.devices }) : response();
      await assert.rejects(f.client.request('other-computer', 'read_thread', {}, 'caller', signal()), { code: 'invalid_remote_response' });
    }
  } finally { await f.close(); }
});

h.test('remote errors are surfaced and failed writes are never automatically retried', async () => {
  const f = await fixture(); try {
    f.state.handler = request => request.init.method === 'GET' ? json({ devices: f.state.devices }) : json({ error: { type: 'thread_not_found', message: 'Thread is gone' } }, 404);
    await assert.rejects(f.client.request('other-computer', 'send_message_to_thread', { prompt: 'Hello' }, 'caller', signal()), { status: 404, code: 'thread_not_found', message: 'Thread is gone' });
    assert.equal(f.requests.filter(request => request.init.method === 'POST').length, 1);
    f.state.handler = request => request.init.method === 'GET' ? json({ devices: f.state.devices }) : json({ error: { type: 'thread_busy', message: 'Thread is busy' } });
    await assert.rejects(f.client.request('other-computer', 'send_message_to_thread', { prompt: 'Hello' }, 'caller', signal()), { status: 502, code: 'thread_busy' });
    assert.equal(f.requests.filter(request => request.init.method === 'POST').length, 2);
  } finally { await f.close(); }
});

h.test('declared and streamed oversized responses are bounded', async () => {
  const f = await fixture(); try {
    f.state.handler = () => new Response('{}', { headers: { 'content-length': String(512 * 1024 + 1) } });
    await assert.rejects(f.client.discover(signal()), { code: 'remote_response_too_large' });
    f.state.handler = () => json({ devices: [], padding: 'x'.repeat(512 * 1024) });
    await assert.rejects(f.client.discover(signal()), /Response is too large/u);
    f.state.handler = request => request.init.method === 'GET' ? json({ devices: f.state.devices }) : json({ padding: 'x'.repeat(1024 * 1024) });
    await assert.rejects(f.client.request('other-computer', 'read_thread', {}, 'caller', signal()), /Response is too large/u);
  } finally { await f.close(); }
});

h.test('deep and overly wide JSON responses are refused within the byte budget', async () => {
  const f = await fixture(); try {
    let deep: Json = null; for (let index = 0; index < 70; index += 1) deep = { nested: deep };
    for (const body of [{ deep }, { wide: Array.from({ length: 50_001 }, () => null) }] as Json[]) {
      f.state.handler = request => request.init.method === 'GET' ? json({ devices: f.state.devices }) : json(body);
      await assert.rejects(f.client.request('other-computer', 'read_thread', {}, 'caller', signal()), { code: 'invalid_remote_response' });
    }
  } finally { await f.close(); }
});

h.test('401 invalidates only the captured current account without retrying', async () => {
  const f = await fixture(); try {
    f.state.handler = () => new Response('unauthorized', { status: 401 });
    await assert.rejects(f.client.discover(signal()), { code: 'account_unauthorized' });
    assert.equal(f.expired(), 1); assert.equal(f.requests.length, 1);
    const held = deferred<Response>(); f.state.handler = () => held.promise;
    const pending = f.client.discover(signal());
    await waitFor(() => f.requests.length === 2, 1000, 'Second discovery started');
    f.account({ token: 'next-token', userId: 'next-user' }); held.resolve(json({}, 401));
    await assert.rejects(pending, { code: 'account_changed' }); assert.equal(f.expired(), 1);
  } finally { await f.close(); }
});

h.test('account changes before discovery returns cannot dispatch a stale-account message', async () => {
  const f = await fixture(); try {
    f.state.handler = () => { f.account({ token: 'other-account-token', userId: 'other-user' }); return json({ devices: [peer()] }); };
    await assert.rejects(f.client.request('other-computer', 'send_message_to_thread', { prompt: 'Hello' }, 'caller', signal()), { code: 'account_changed' });
    assert.equal(f.requests.length, 1);
  } finally { await f.close(); }
});

h.test('token mutation and logout cancel pending requests even when fetch has not settled', async () => {
  const f = await fixture(); try {
    const account = { token: 'current-token', userId: 'current-user' }; f.account(account);
    const held = deferred<Response>(); f.state.handler = () => held.promise;
    const pending = f.client.discover(signal());
    await waitFor(() => f.requests.length === 1, 1000, 'Pending account request started');
    account.token = 'refreshed-token';
    await assert.rejects(pending, { code: 'account_changed' });
    assert.equal(f.requests[0]!.init.signal!.aborted, true);
    held.resolve(json({ devices: [] }));
    const loggedOut = deferred<Response>(); f.state.handler = () => loggedOut.promise;
    const next = f.client.discover(signal());
    await waitFor(() => f.requests.length === 2, 1000, 'Pending logout request started');
    f.account(undefined); await assert.rejects(next, { code: 'account_changed' });
    assert.equal(f.requests[1]!.init.signal!.aborted, true); loggedOut.resolve(json({ devices: [] }));
  } finally { await f.close(); }
});

h.test('new requests use the new account identity and token after switching accounts', async () => {
  const f = await fixture(); try {
    await f.client.discover(signal()); f.account({ token: 'second-token', userId: 'second-user' });
    const discovered = await f.client.discover(signal()); assert.notEqual(discovered.localHostId, f.localHostId);
    await f.client.request('other-computer', 'read_thread', {}, 'caller', signal());
    assert.equal(f.requests.at(-1)!.headers.get('authorization'), 'Bearer second-token');
    assert.equal(object(f.requests.at(-1)!.body.caller).hostId, discovered.localHostId);
  } finally { await f.close(); }
});

h.test('caller abort and timeout cancel pending requests without retries', async () => {
  const f = await fixture({ requestTimeoutMs: 75 }); try {
    const held = deferred<Response>(); f.state.handler = () => held.promise;
    const controller = new AbortController(), pending = f.client.discover(controller.signal);
    await waitFor(() => f.requests.length === 1, 1000, 'Pending cancellable discovery'); controller.abort();
    await assert.rejects(pending, { name: 'AbortError' }); assert(f.requests[0]!.init.signal!.aborted);
    await assert.rejects(f.client.discover(signal()), { name: 'TimeoutError' });
    assert.equal(f.requests.length, 2); assert(f.requests[1]!.init.signal!.aborted); held.resolve(json({ devices: [] }));
  } finally { await f.close(); }
});

h.test('shutdown cancels response streaming, drains pending work and rejects subsequent calls', async () => {
  const f = await fixture(); try {
    let cancelled = false;
    f.state.handler = () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(Buffer.from('{"devices":[')); }, cancel() { cancelled = true; } }));
    const pending = f.client.discover(signal());
    const rejected = assert.rejects(pending, { code: 'remote_client_closed' });
    await waitFor(() => f.requests.length === 1, 1000, 'Streaming discovery started');
    await f.client.close(); await rejected;
    await waitFor(() => cancelled, 1000, 'Response stream cancelled');
    await assert.rejects(f.client.discover(signal()), { code: 'remote_client_closed' });
    await assert.rejects(f.client.request('other-computer', 'read_thread', {}, 'caller', signal()), { code: 'remote_client_closed' });
    await f.client.close();
  } finally { await f.close(); }
});

h.test('disabling communication aborts a pending remote response without accepting its result', async () => {
  const f = await fixture(); try {
    const held = deferred<Response>();
    f.state.handler = request => request.init.method === 'GET' ? json({ devices: [peer()] }) : held.promise;
    const pending = f.client.request('other-computer', 'read_thread', {}, 'caller', signal());
    await waitFor(() => f.requests.length === 2, 1000, 'Remote read started'); f.enabled(false);
    await assert.rejects(pending, { code: 'account_changed' });
    assert.equal(f.requests[1]!.init.signal!.aborted, true); held.resolve(json({ ok: true }));
  } finally { await f.close(); }
});

void h.finish(join(__dirname, 'remote-thread-client-result.json'), 'remote-thread-client').then(code => { clearTimeout(deadline); process.exitCode = code; }, error => {
  clearTimeout(deadline); process.stderr.write(String(error) + '\n'); process.exitCode = 1;
});
