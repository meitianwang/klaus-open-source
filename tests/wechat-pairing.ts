import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerWechatPairingHandlers, WECHAT_PAIRING_CHANNELS } from '../main/ipc/handlers/wechat-pairing';
import { ChannelCredentialCodec } from '../main/services/channels/credentials';
import { ChannelSettingsStore } from '../main/services/channels/settings-store';
import { WechatPairingService } from '../main/services/channels/wechat-pairing';
import { kvSet, withSettingsDb } from '../main/services/settings';
import { object, string, type JsonObject } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

const vector = JSON.parse(readFileSync(join(__dirname, '../../tests/vectors/wechat-pairing.json'), 'utf8')) as {
  credential: { home: string; hostname: string; plaintext: string; envelope: string };
  start: JsonObject; confirmed: JsonObject; keys: string[]; channels: string[];
};
interface FixtureOptions { startBody?: unknown; startStatus?: number; pollBody?: unknown; pollStatus?: number; holdPoll?: boolean; holdFirstStart?: boolean; hangBody?: boolean }
async function fixture(options: FixtureOptions = {}) {
  const requests: Array<{ path: string; query: string; header?: string }> = [], held: ServerResponse[] = [];
  let starts = 0, polls = 0, closedResponses = 0;
  const json = (response: ServerResponse, body: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  const server = createServer((request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    requests.push({ path: url.pathname, query: url.searchParams.toString(), header: typeof request.headers['ilink-app-clientversion'] === 'string' ? request.headers['ilink-app-clientversion'] : undefined });
    response.once('close', () => { closedResponses++; });
    if (url.pathname === '/gateway/ilink/bot/get_bot_qrcode') {
      starts++;
      if (options.holdFirstStart && starts === 1) { held.push(response); return; }
      json(response, options.startBody ?? vector.start, options.startStatus); return;
    }
    if (url.pathname === '/gateway/ilink/bot/get_qrcode_status') {
      polls++;
      if (options.holdPoll) { held.push(response); return; }
      if (options.hangBody) { response.writeHead(200, { 'content-type': 'application/json' }); response.write('{"status":'); return; }
      json(response, options.pollBody ?? { status: 'wait' }, options.pollStatus); return;
    }
    json(response, {}, 404);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/gateway';
  return {
    base, requests, options, held, starts: () => starts, polls: () => polls, closed: () => closedResponses,
    answer: (body: unknown, index = 0) => json(held[index]!, body),
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
function setup(root: string, base: string) {
  assertEqual(kvSet('channel.wechat.base_url', base, root), true, 'fixture gateway persisted');
  return new ChannelSettingsStore(root, new ChannelCredentialCodec(vector.credential));
}
function rows(root: string): Record<string, unknown> {
  return withSettingsDb(root, db => Object.fromEntries(db.prepare("SELECT key, value FROM settings WHERE key LIKE 'channel.wechat.%' ORDER BY key").all().map(row => [String(row.key), row.value])));
}

export function registerWechatPairingTests(h: Harness, freshRoot: () => string): void {
  h.test('channel credential compatibility uses the fixed AES envelope without a plaintext write fallback', async () => {
    const codec = new ChannelCredentialCodec(vector.credential);
    assertEqual(codec.decrypt(vector.credential.envelope), vector.credential.plaintext, 'independent OpenSSL vector');
    const a = codec.encrypt(vector.credential.plaintext), b = codec.encrypt(vector.credential.plaintext);
    assert(/^[a-f0-9]{32}:[a-f0-9]+$/u.test(a), 'legacy envelope shape'); assert(a !== b, 'fresh random IV');
    assert(!a.includes(vector.credential.plaintext), 'no plaintext duplication'); assertEqual(codec.decrypt(a), vector.credential.plaintext, 'UTF-8 token survives');
    for (const raw of ['', 'legacy-token', 'zz:zz', '00ff:00ff', '0'.repeat(32) + ':01']) assertEqual(codec.decrypt(raw), raw, 'legacy undecodable values remain intact');
  });
  h.test('WeChat QR handlers execute real local HTTP and atomically persist the four legacy settings rows', async () => {
    const root = freshRoot(), f = await fixture({ pollBody: vector.confirmed }), store = setup(root, f.base), registry = new ChannelRegistry();
    let starts = 0;
    const service = registerWechatPairingHandlers(registry, { configRoot: root, store, onPaired: async id => { assertEqual(id, 'fixture-account', 'adapter account'); assertEqual(store.wechatCredential()?.token, 'fixture-bot-token', 'adapter reads committed encrypted credential'); starts++; } });
    try {
      assertDeepEqual([...WECHAT_PAIRING_CHANNELS], vector.channels, 'actual registered scope');
      assertDeepEqual(registry.channels(), [...vector.channels].sort(), 'real registry contains only the two implemented channels');
      const start = registry.lookup('channels:wechat:qrStart')!, poll = registry.lookup('channels:wechat:qrPoll')!;
      const result = object(await start({ args: [], role: 'main', senderId: 1, channel: 'channels:wechat:qrStart' }));
      assertEqual(result.ok, true, 'real start HTTP');
      const png = Buffer.from(string(result.qrcodeDataUrl).split(',')[1]!, 'base64');
      assertEqual(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'actual PNG encoder');
      assertEqual(png.readUInt32BE(16), 280, 'PNG width');
      assertDeepEqual(await poll({ args: [], role: 'main', senderId: 1, channel: 'channels:wechat:qrPoll' }), { ok: true, status: 'confirmed', accountId: 'fixture-account' }, 'renderer reply');
      assertEqual(starts, 1, 'one real runtime hook');
      assertDeepEqual(Object.keys(rows(root)), vector.keys, 'same four settings keys');
      assert(/^[a-f0-9]{32}:/u.test(String(rows(root)['channel.wechat.token'])), 'encrypted durable token');
      assertEqual(new ChannelSettingsStore(root, new ChannelCredentialCodec(vector.credential)).wechatCredential()?.token, 'fixture-bot-token', 'reopen profile');
      assertDeepEqual(f.requests.map(row => ({ path: row.path, header: row.header })), [
        { path: '/gateway/ilink/bot/get_bot_qrcode', header: undefined }, { path: '/gateway/ilink/bot/get_qrcode_status', header: '1' },
      ], 'relative base path and poll header');
      assertEqual(new URLSearchParams(f.requests[1]!.query).get('qrcode'), vector.start.qrcode, 'QR query is encoded once');
      assertEqual(object(await service.poll()).ok, false, 'consumed flow cannot replay');
    } finally { await service.close(); await f.close(); }
  });
  h.test('WeChat pairing database failures roll back every credential row and remain retryable', async () => {
    const root = freshRoot(), f = await fixture({ pollBody: vector.confirmed }), store = setup(root, f.base);
    let started = 0;
    const service = new WechatPairingService({ configRoot: root, store, onPaired: async () => { started++; } });
    try {
      store.saveWechatPairing({ token: 'old-fixture-token', accountId: 'old-fixture-account', baseUrl: f.base });
      const before = rows(root);
      withSettingsDb(root, db => db.exec("CREATE TRIGGER refuse_pairing BEFORE INSERT ON settings WHEN NEW.key='channel.wechat.account_id' BEGIN SELECT RAISE(ABORT, 'fixture refused write'); END"));
      assertEqual(object(await service.start()).ok, true, 'QR acquired');
      assertEqual(object(await service.poll()).ok, false, 'write failure visible'); assertDeepEqual(rows(root), before, 'all four original values intact'); assertEqual(started, 0, 'no runtime start after failed write');
      withSettingsDb(root, db => db.exec('DROP TRIGGER refuse_pairing'));
      assertEqual(object(await service.poll()).status, 'confirmed', 'same flow can retry failed transaction'); assertEqual(started, 1, 'one start after actual commit');
    } finally { await service.close(); await f.close(); }
  });
  h.test('overlapping WeChat polls are one HTTP request and body timeouts keep the flow waiting', async () => {
    for (const hangBody of [false, true]) {
      const root = freshRoot(), f = await fixture({ holdPoll: !hangBody, hangBody }), store = setup(root, f.base);
      const service = new WechatPairingService({ configRoot: root, store, pollTimeoutMs: 120, onPaired: async () => { throw new Error('must not start'); } });
      try {
        await service.start(); const first = service.poll(), second = service.poll(); assertEqual(first, second, 'single flight promise');
        assertDeepEqual(await first, { ok: true, status: 'wait' }, 'own request or body timeout is waiting'); assertEqual(f.polls(), 1, 'one network poll');
        await waitFor(() => f.closed() >= 2, 2000, 'timed-out HTTP response actually closes');
        assertEqual(store.wechatCredential(), undefined, 'no credential from a stalled response');
      } finally { await service.close(); await f.close(); }
    }
  });
  h.test('a replacement WeChat QR cancels its predecessor without allowing a late credential write', async () => {
    const root = freshRoot(), f = await fixture({ holdPoll: true }), store = setup(root, f.base);
    let started = 0;
    const service = new WechatPairingService({ configRoot: root, store, onPaired: async () => { started++; } });
    try {
      await service.start(); const oldPoll = service.poll(); await waitFor(() => f.polls() === 1, 2000, 'old poll reached server');
      assertEqual(object(await service.start()).ok, true, 'replacement ready');
      assertEqual(object(await oldPoll).ok, false, 'previous request cancelled'); f.answer(vector.confirmed);
      assertEqual(store.wechatCredential(), undefined, 'late grant does not reach disk'); assertEqual(started, 0, 'late grant does not start adapter');
      f.options.holdPoll = false; f.options.pollBody = vector.confirmed;
      assertEqual(object(await service.poll()).status, 'confirmed', 'replacement remains usable'); assertEqual(started, 1, 'only current grant starts');
    } finally { await service.close(); await f.close(); }
  });
  h.test('a superseded WeChat start cannot replace the current QR key after late HTTP completion', async () => {
    const root = freshRoot(), f = await fixture({ holdFirstStart: true }), store = setup(root, f.base);
    const service = new WechatPairingService({ configRoot: root, store, onPaired: async () => {} });
    try {
      const oldStart = service.start(); await waitFor(() => f.starts() === 1, 2000, 'first request held');
      f.options.startBody = { ...vector.start, qrcode: 'replacement-key' };
      assertEqual(object(await service.start()).ok, true, 'replacement starts'); assertEqual(object(await oldStart).ok, false, 'old start cancelled'); f.answer(vector.start);
      await service.poll(); assertEqual(new URLSearchParams(f.requests.at(-1)!.query).get('qrcode'), 'replacement-key', 'only replacement key is polled');
    } finally { await service.close(); await f.close(); }
  });
  h.test('WeChat malformed HTTP and incomplete confirmations never report a successful account', async () => {
    for (const options of [{ startStatus: 503 }, { startBody: {} }, { pollStatus: 502 }, { pollBody: { status: 'confirmed' } }, { pollBody: { status: 'confirmed', bot_token: 'fixture', ilink_bot_id: 'fixture', baseurl: 'file:///bad' } }, { pollBody: [] }]) {
      const root = freshRoot(), f = await fixture(options), store = setup(root, f.base);
      let starts = 0;
      const service = new WechatPairingService({ configRoot: root, store, onPaired: async () => { starts++; } });
      try {
        const started = object(await service.start());
        const result = started.ok ? object(await service.poll()) : started;
        assertEqual(result.ok, false, 'malformed or failed endpoint stays failed'); assertEqual(store.wechatCredential(), undefined, 'no durable grant'); assertEqual(starts, 0, 'no adapter start');
      } finally { await service.close(); await f.close(); }
    }
  });
  h.test('WeChat startup failures disclose committed credentials and never replay the one-time grant', async () => {
    const root = freshRoot(), f = await fixture({ pollBody: vector.confirmed }), store = setup(root, f.base);
    let starts = 0;
    const service = new WechatPairingService({ configRoot: root, store, onPaired: async () => { starts++; throw new Error('fixture start rejected'); } });
    try {
      await service.start(); const result = object(await service.poll()); assertEqual(result.ok, false, 'not connected'); assertEqual(result.saved, true, 'credential commit is disclosed');
      assertEqual(store.wechatCredential()?.accountId, 'fixture-account', 'credentials remain usable for retry'); assertEqual(object(await service.poll()).ok, false, 'grant consumed'); assertEqual(starts, 1, 'one failed start');
    } finally { await service.close(); await f.close(); }
  });
  h.test('closing WeChat pairing cancels active HTTP and accepted hot-start before settling', async () => {
    for (const hotStart of [false, true]) {
      const root = freshRoot(), f = await fixture({ holdPoll: !hotStart, pollBody: vector.confirmed }), store = setup(root, f.base);
      let starting = false, observedAbort = false;
      const service = new WechatPairingService({ configRoot: root, store, onPaired: async (_id, signal) => { starting = true; await new Promise<void>(resolve => { signal.addEventListener('abort', () => { observedAbort = true; resolve(); }, { once: true }); }); } });
      try {
        await service.start(); const pending = service.poll(); await waitFor(() => hotStart ? starting : f.polls() === 1, 2000, 'active request reached');
        await service.close(); assertEqual(object(await pending).ok, false, 'closing flow cannot claim connected');
        if (hotStart) { assertEqual(observedAbort, true, 'accepted startup receives cancellation'); assertEqual(object(await pending).saved, true, 'already committed account stays explicit'); }
        else assertEqual(store.wechatCredential(), undefined, 'no late write after close');
        assertEqual(object(await service.start()).ok, false, 'closed service refuses new start');
      } finally { await service.close(); await f.close(); }
    }
  });
  h.test('WeChat refuses a missing runtime hook and a settings read failure before network activity', async () => {
    await assertRejects(async () => new WechatPairingService({ configRoot: freshRoot() } as never), 'missing actual runtime hook');
    const root = freshRoot(), f = await fixture(), store = setup(root, f.base);
    store.get = () => { throw new Error('fixture settings read denied'); };
    const service = new WechatPairingService({ configRoot: root, store, onPaired: async () => {} });
    try { assertEqual(object(await service.start()).ok, false, 'read error visible'); assertEqual(f.starts(), 0, 'no guessed default gateway on error'); }
    finally { await service.close(); await f.close(); }
  });
}
