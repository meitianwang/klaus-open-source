import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { MCP_DEVICE_CHANNELS } from '../main/ipc/handlers/mcp-device';
import { McpDeviceService, resolveMcpDeviceClientId } from '../main/services/mcp/device';
import { object, type JsonObject } from '../main/services/service-types';
import { kvGet, withSettingsDb } from '../main/services/settings';
import { Harness, waitFor } from './harness';
import { deferred, deviceFixture, reply, type DeviceRequest } from './mcp-device-fixture';

const h = new Harness();
const deadline = setTimeout(() => { process.stderr.write('MCP device fixture exceeded its 90 second deadline\n'); process.exit(1); }, 90_000);
const failure = (error: string): JsonObject => ({ ok: false, error });

void (async () => {
  await h.test('four channels keep the SQLite key and environment, user, catalog client-id precedence', async () => {
    const env = { KLAUS_GITHUB_CLIENT_ID: '  fixture-env-client  ' }, f = await deviceFixture({ env });
    try {
      assert.deepEqual(f.registry.channels(), [...MCP_DEVICE_CHANNELS].sort());
      assert.deepEqual(await f.invoke('mcp:device:client-id', { id: 'github', clientId: ' fixture-stored-client ' }), { ok: true, clientId: 'fixture-env-client' });
      assert.equal(kvGet('mcp-device-client-id:github', f.root), 'fixture-stored-client');
      env.KLAUS_GITHUB_CLIENT_ID = ' ';
      assert.deepEqual(await f.service.clientId({ id: 'github' }), { ok: true, clientId: 'fixture-stored-client' });
      await f.service.clientId({ id: 'github', clientId: ' ' });
      assert.equal(object(await f.service.clientId({ id: 'github' })).clientId, 'fixture-public-client');
      await f.service.clientId({ id: 'github', clientId: 'persistent-client' });
      const reopened = new McpDeviceService({ configRoot: f.root, env: {}, catalog: async () => [], install: async () => { throw new Error('Not called'); } });
      try { assert.equal(object(await reopened.clientId({ id: 'github' })).clientId, 'persistent-client'); } finally { await reopened.close(); }
      assert.equal(resolveMcpDeviceClientId(f.root, 'github', [], {}), 'persistent-client');
      assert.deepEqual(withSettingsDb(f.root, db => db.prepare('SELECT key,value FROM settings').all()).map(row => ({ ...row })), [{ key: 'mcp-device-client-id:github', value: 'persistent-client' }]);
      assert.equal(f.requests.length, 0); assert.equal(f.installs.length, 0);
    } finally { await f.close(); }
  });
  await h.test('unsupported providers and absent public clients fail without requesting a grant', async () => {
    const f = await deviceFixture(); try {
      assert.deepEqual(await f.service.start({ id: 'missing' }), failure('unsupported'));
      f.catalog([{ id: 'github', deviceAuth: { provider: 'other', defaultClientId: 'fixture' } }]);
      assert.deepEqual(await f.service.start({ id: 'github' }), failure('unsupported_provider'));
      f.catalog([{ id: 'github', deviceAuth: { provider: 'github', tokenEnvKey: 'GITHUB_PAT' } }]);
      assert.deepEqual(await f.service.start({ id: 'github' }), failure('no_client_id'));
      assert.equal(f.requests.length, 0); assert.deepEqual(await f.service.wait({ id: 'github' }), failure('no_pending'));
      assert.throws(() => f.service.start({ id: '../escape' }), /valid MCP server id/);
      await assert.rejects(f.service.clientId({ id: 'github', clientId: '\r\nsecret' }), /Invalid public/);
      assert.throws(() => new McpDeviceService({ configRoot: 'relative', catalog: async () => [], install: async () => null }), /absolute/);
    } finally { await f.close(); }
  });
  await h.test('GitHub client registration failures and HTTP statuses keep the current UI branches', async () => {
    const f = await deviceFixture(); try {
      for (const error of ['Not Found', 'incorrect_client_credentials', 'device_flow_disabled']) {
        f.code(request => reply(request, { error })); assert.deepEqual(await f.service.start({ id: 'github' }), failure('no_client_id'));
      }
      f.code(request => reply(request, { error: 'fixture-private-response' }, 403));
      assert.deepEqual(await f.service.start({ id: 'github' }), failure('http_403'));
      f.code(request => reply(request, {})); assert.deepEqual(await f.service.start({ id: 'github' }), failure('invalid_response'));
      assert.equal(f.installs.length, 0);
    } finally { await f.close(); }
  });
  await h.test('malformed grants, unsafe verification links and oversized responses never reach installation', async () => {
    const f = await deviceFixture(); try {
      for (const fields of [{ expires_in: -1 }, { interval: 1.5 }, { expires_in: 1e20 }, { verification_uri: 'https://foreign.invalid/login/device' }, { verification_uri: f.origin + '/fixture-device-1' }, { verification_uri: 'javascript:alert(1)' }, { user_code: 'fixture-device-1' }] as JsonObject[]) {
        f.code(request => reply(request, f.grant(1, fields)));
        assert.deepEqual(await f.service.start({ id: 'github' }), failure('invalid_response'));
      }
      f.code(request => { request.response.writeHead(200); request.response.end('x'.repeat(64 * 1024 + 1)); });
      assert.deepEqual(await f.service.start({ id: 'github' }), failure('invalid_response')); assert.equal(f.installs.length, 0);
    } finally { await f.close(); }
  });
  await h.test('a closed dialog needs no waiter: background success is consumed later without tokens in IPC', async () => {
    const f = await deviceFixture(); try {
      const start = await f.invoke('mcp:device:start');
      assert.deepEqual(start, { ok: true, userCode: 'CODE-0001', verificationUri: f.origin + '/login/device', expiresIn: 30 });
      await waitFor(() => f.installs.length === 1, 3000, 'background install without renderer wait');
      assert.deepEqual(f.requests[0]!.data, { client_id: 'fixture-public-client', scope: 'repo read:org read:user' });
      assert.deepEqual(f.requests[1]!.data, { client_id: 'fixture-public-client', device_code: 'fixture-device-1', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' });
      assert.equal(f.requests[1]!.request.headers.accept, 'application/json');
      assert.deepEqual(f.installs[0]!.payload, { id: 'github', env: { GITHUB_PAT: 'fixture-access-fixture-device-1' } });
      assert.equal(f.installs[0]!.signal.aborted, false);
      assert.deepEqual(await f.invoke('mcp:device:wait', { id: 'github' }, 2), { ok: true });
      assert.deepEqual(await f.service.wait({ id: 'github' }), failure('no_pending'));
      assert((await readdir(f.root)).every(file => /^settings\.db(?:-wal|-shm)?$/.test(file)), 'only the public client-id SQLite store is created');
    } finally { await f.close(); }
  });
  await h.test('pending and slow_down follow real HTTP timing and respect a longer server interval', async () => {
    const f = await deviceFixture(); try {
      f.token((request, index) => reply(request, index === 1 ? { error: 'authorization_pending' } : index === 2 ? { error: 'slow_down', interval: 7 } : { access_token: 'fixture-timing-token' }));
      await f.service.start({ id: 'github' }); const first = f.service.wait({ id: 'github' }), second = f.service.wait({ id: 'github' });
      assert.deepEqual(await first, { ok: true }); assert.deepEqual(await second, { ok: true });
      const polls = f.requests.filter(row => row.path.endsWith('/access_token'));
      assert.equal(polls.length, 3); assert(polls[1]!.at - polls[0]!.at >= 990); assert(polls[2]!.at - polls[1]!.at >= 6990);
      assert.equal(f.installs.length, 1);
    } finally { await f.close(); }
  });
  await h.test('a network blip and malformed poll response retry on later rounds', async () => {
    const f = await deviceFixture(); try {
      f.token((request, index) => { if (index === 1) request.response.destroy(); else if (index === 2) request.response.end('{'); else reply(request, { access_token: 'fixture-recovered-token' }); });
      await f.service.start({ id: 'github' }); assert.deepEqual(await f.service.wait({ id: 'github' }), { ok: true });
      assert.equal(f.requests.filter(row => row.path.endsWith('/access_token')).length, 3); assert.equal(f.installs.length, 1);
    } finally { await f.close(); }
  });
  await h.test('denial, server expiry and local expiry are distinct terminal failures', async () => {
    for (const [serverError, wanted] of [['access_denied', 'denied'], ['expired_token', 'expired'], ['unknown-fixture-secret', 'unknown']]) {
      const f = await deviceFixture(); try {
        f.token(request => reply(request, { error: serverError! }));
        await f.service.start({ id: 'github' }); assert.deepEqual(await f.service.wait({ id: 'github' }), failure(wanted!)); assert.equal(f.installs.length, 0);
      } finally { await f.close(); }
    }
    const f = await deviceFixture(); try {
      f.code(request => reply(request, f.grant(1, { expires_in: 1, interval: 5 })));
      await f.service.start({ id: 'github' }); assert.deepEqual(await f.service.wait({ id: 'github' }), failure('expired'));
      assert.equal(f.requests.length, 1, 'expiry prevents even one late poll');
    } finally { await f.close(); }
  });
  await h.test('expiry aborts an in-flight token response before any credential can land', async () => {
    const f = await deviceFixture({ requestTimeoutMs: 10_000 }); let closed = false;
    try {
      f.code(request => reply(request, f.grant(1, { expires_in: 2 })));
      f.token(request => { request.response.on('close', () => { closed = true; }); });
      await f.service.start({ id: 'github' }); assert.deepEqual(await f.service.wait({ id: 'github' }), failure('expired'));
      await waitFor(() => closed, 1000, 'expired response socket aborted'); assert.equal(f.installs.length, 0);
    } finally { await f.close(); }
  });
  await h.test('explicit cancel aborts grant retrieval and an in-flight token response', async () => {
    const f = await deviceFixture(); let grantClosed = false, tokenClosed = false;
    try {
      f.code(request => { request.response.on('close', () => { grantClosed = true; }); });
      const starting = f.service.start({ id: 'github' }), grantWait = f.service.wait({ id: 'github' });
      await waitFor(() => f.requests.length === 1, 1000, 'grant request pending');
      assert.deepEqual(await f.invoke('mcp:device:cancel'), { ok: true });
      assert.deepEqual(await starting, failure('cancelled')); assert.deepEqual(await grantWait, failure('cancelled'));
      await waitFor(() => grantClosed, 1000, 'cancelled grant response closed');
      f.code(request => reply(request, f.grant(2))); f.token(request => { request.response.on('close', () => { tokenClosed = true; }); });
      await f.service.start({ id: 'github' }); const tokenWait = f.service.wait({ id: 'github' });
      await waitFor(() => f.requests.some(row => row.path.endsWith('/access_token')), 3000, 'token request pending');
      f.service.cancel({ id: 'github' }); assert.deepEqual(await tokenWait, failure('cancelled'));
      await waitFor(() => tokenClosed, 1000, 'cancelled token response closed'); assert.equal(f.installs.length, 0);
      assert.deepEqual(f.service.cancel({ id: 'github' }), { ok: true });
    } finally { await f.close(); }
  });
  await h.test('replacement rejects the old grant and its waiter cannot delete the new attempt', async () => {
    const f = await deviceFixture(); let oldRequest: DeviceRequest | undefined;
    try {
      f.code((request, index) => { if (index === 1) oldRequest = request; else reply(request, f.grant(index)); });
      const oldStart = f.service.start({ id: 'github' }), oldWait = f.service.wait({ id: 'github' });
      await waitFor(() => Boolean(oldRequest), 1000, 'old grant reached server');
      const started = await f.service.start({ id: 'github' }); assert.equal(object(started).ok, true);
      assert.deepEqual(await oldStart, failure('cancelled')); assert.deepEqual(await oldWait, failure('cancelled'));
      reply(oldRequest!, f.grant(1));
      assert.deepEqual(await f.service.wait({ id: 'github' }), { ok: true });
      assert.equal(f.installs.length, 1); assert.equal(object(f.installs[0]!.payload.env).GITHUB_PAT, 'fixture-access-fixture-device-2');
    } finally { await f.close(); }
  });
  await h.test('replacement during catalog loading cannot resurrect its earlier authorization', async () => {
    const held = deferred<JsonObject[]>(); let calls = 0;
    const catalog = [{ id: 'github', deviceAuth: { provider: 'github', tokenEnvKey: 'GITHUB_PAT', defaultClientId: 'fixture' } }];
    const f = await deviceFixture({ catalog: async () => ++calls === 1 ? held.promise : catalog });
    try {
      const old = f.service.start({ id: 'github' });
      assert.equal(object(await f.service.start({ id: 'github' })).ok, true); assert.deepEqual(await old, failure('cancelled'));
      held.resolve(catalog); assert.deepEqual(await f.service.wait({ id: 'github' }), { ok: true }); assert.equal(f.requests.length, 2);
    } finally { held.resolve(catalog); await f.close(); }
  });
  await h.test('re-auth sends the new credential through the same installer and aborts a queued old install', async () => {
    let installed = 0;
    const f = await deviceFixture({ install: async (_payload, signal) => {
      if (++installed === 1) await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('fixture rejected old install')), { once: true }));
      signal.throwIfAborted(); return { ok: true };
    } });
    try {
      await f.service.start({ id: 'github' }); const firstWait = f.service.wait({ id: 'github' });
      await waitFor(() => f.installs.length === 1, 3000, 'first credential reached owner queue');
      await f.service.start({ id: 'github' }); assert.deepEqual(await firstWait, failure('cancelled'));
      assert.deepEqual(await f.service.wait({ id: 'github' }), { ok: true });
      assert.equal(f.installs[0]!.signal.aborted, true); assert.equal(f.installs[1]!.signal.aborted, false);
      assert.notDeepEqual(f.installs[0]!.payload.env, f.installs[1]!.payload.env);
      assert.equal(f.installs[1]!.payload.id, f.installs[0]!.payload.id);
    } finally { await f.close(); }
  });
  await h.test('installer refusal and exceptions never expose token-bearing errors or claim success', async () => {
    for (const mode of ['throws', 'saved', 'empty']) {
      const f = await deviceFixture({ install: async () => { if (mode === 'throws') throw new Error('fixture-access-token and fixture-device-code'); return mode === 'saved' ? { ok: false, error: 'fixture-access-token', saved: true } : null; } });
      try {
        await f.service.start({ id: 'github' });
        assert.deepEqual(await f.service.wait({ id: 'github' }), { ...failure('install_failed'), ...(mode === 'saved' ? { saved: true, reloadRequired: true } : {}) });
      } finally { await f.close(); }
    }
  });
  await h.test('redirects never forward the device request and unsafe host overrides fail locally', async () => {
    const f = await deviceFixture(); try {
      f.code(request => { request.response.writeHead(307, { location: f.origin + '/unexpected' }); request.response.end(); });
      assert.deepEqual(await f.service.start({ id: 'github' }), failure('http_307')); assert.equal(f.requests.length, 1);
      f.code(request => reply(request, f.grant())); f.token(request => { request.response.writeHead(302, { location: f.origin + '/unexpected' }); request.response.end(); });
      await f.service.start({ id: 'github' }); assert.deepEqual(await f.service.wait({ id: 'github' }), failure('http_302'));
      assert(!f.requests.some(row => row.path === '/unexpected'));
    } finally { await f.close(); }
    const unsafe = await deviceFixture({ baseURL: 'http://remote.invalid', env: {} });
    try { assert.deepEqual(await unsafe.service.start({ id: 'github' }), failure('invalid_endpoint')); assert.equal(unsafe.requests.length, 0); } finally { await unsafe.close(); }
  });
  await h.test('shutdown drains the installer cancellation and settles existing waiters exactly once', async () => {
    const release = deferred(), entered = deferred(); let aborted = false, closingDone = false;
    const f = await deviceFixture({ install: async (_payload, signal) => { signal.addEventListener('abort', () => { aborted = true; }, { once: true }); entered.resolve(); await release.promise; signal.throwIfAborted(); return { ok: true }; } });
    try {
      await f.service.start({ id: 'github' }); const waiting = f.service.wait({ id: 'github' }); await entered.promise;
      const closing = f.service.close(); void closing.then(() => { closingDone = true; });
      assert.equal(f.service.close(), closing); assert.deepEqual(await waiting, failure('cancelled')); assert.equal(aborted, true); assert.equal(closingDone, false);
      release.resolve(); await closing; assert.equal(closingDone, true);
      assert.throws(() => f.service.start({ id: 'github' }), /closed/); await assert.rejects(f.service.wait({ id: 'github' }), /closed/);
    } finally { release.resolve(); await f.close(); }
  });
  clearTimeout(deadline);
  process.exitCode = await h.finish(join(__dirname, 'mcp-device-result.json'), 'mcp-device');
})();
