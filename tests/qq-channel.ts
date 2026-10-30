import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { ChannelService } from '../main/services/channels/service';
import { QQApi } from '../main/services/channels/qq-api';
import { QQTransport, qqAdapter } from '../main/services/channels/qq';
import { QQ, QQ_INTENTS, qqInbound, qqSendTarget } from '../main/services/channels/qq-wire';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

interface Call { path: string; body: JsonObject; authorization?: string }
interface Options {
  heartbeatInterval?: number;
  http?: (call: Call, response: ServerResponse) => boolean | void | Promise<boolean | void>;
  frame?: (frame: JsonObject, socket: WebSocket, connection: number) => boolean | void;
}
export async function createQQFixture(options: Options = {}) {
  const calls: Call[] = [], frames: Array<{ value: JsonObject; connection: number }> = [], sockets: WebSocket[] = []; let tokens = 0, closed = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const call = { path: request.url ?? '', body: chunks.length ? object(JSON.parse(Buffer.concat(chunks).toString())) : {}, authorization: request.headers.authorization }; calls.push(call);
      if (await options.http?.(call, response)) return;
      let value: JsonObject;
      if (call.path === '/token') value = { access_token: 'fixture-token-' + ++tokens, expires_in: '7200' };
      else if (call.path === '/gateway') value = { url: 'ws://127.0.0.1:' + (server.address() as AddressInfo).port + '/socket' };
      else if (/^\/v2\/(?:users|groups)\/[a-f0-9-]+\/messages$/u.test(call.path)) value = { id: 'receipt-' + calls.length };
      else { response.writeHead(404); response.end('{}'); return; }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end('{}'); });
  });
  const ws = new WebSocketServer({ server, path: '/socket', perMessageDeflate: false, maxPayload: 1024 * 1024 });
  ws.on('connection', socket => {
    const connection = sockets.length; sockets.push(socket); socket.on('error', () => undefined); socket.on('close', () => { closed++; });
    socket.on('message', data => {
      const value = object(JSON.parse(data.toString())); frames.push({ value, connection }); if (options.frame?.(value, socket, connection)) return;
      if (value.op === QQ.identify) socket.send(JSON.stringify({ op: QQ.dispatch, s: 1, t: 'READY', d: { session_id: 'fixture-session-' + connection } }));
      else if (value.op === QQ.resume) socket.send(JSON.stringify({ op: QQ.dispatch, s: object(value.d).seq, t: 'RESUMED', d: {} }));
      else if (value.op === QQ.heartbeat) socket.send(JSON.stringify({ op: QQ.heartbeatAck, d: null }));
    });
    socket.send(JSON.stringify({ op: QQ.hello, d: { heartbeat_interval: options.heartbeatInterval ?? 50 } }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const apiBase = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  return { apiBase, tokenUrl: apiBase + '/token', calls, frames, sockets, closed: () => closed,
    messages: () => calls.filter(call => call.path.startsWith('/v2/')),
    send: (value: JsonObject, connection = sockets.length - 1) => sockets[connection]!.send(JSON.stringify(value)),
    close: async () => { for (const socket of sockets) socket.terminate(); server.closeAllConnections(); await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
const account = { app_id: '123456789', client_secret: 'fixture-only-qq-secret' }, user = 'a'.repeat(32), group = 'b'.repeat(32);
const message = (id: number, grouped = false): JsonObject => ({ op: QQ.dispatch, s: id + 1, t: grouped ? 'GROUP_AT_MESSAGE_CREATE' : 'C2C_MESSAGE_CREATE', d: {
  id: 'message-' + id, content: '<@!bot> question ' + id, timestamp: '2023-11-14T22:13:20Z',
  author: grouped ? { member_openid: user, username: 'Fixture sender' } : { user_openid: user }, ...(grouped ? { group_openid: group } : {}),
} });

export function registerQQChannelTests(h: Harness, freshRoot: () => string): void {
  h.test('QQ group and private wire identities preserve mention and timestamp semantics', () => {
    assertDeepEqual(qqInbound(message(4, true), 1), { sessionKey: 'qq:group:' + group, senderId: user, targetId: group, text: 'question 4', messageId: 'message-4', messageType: 'text', chatType: 'group', timestamp: 1_700_000_000_000, dedupKey: 'qq:group:message-4', groupId: group, mentioned: true, senderName: 'Fixture sender' }, 'committed group projection');
    assertEqual(qqInbound(message(1))!.text, '<@!bot> question 1', 'private literal mentions retained'); assertEqual(qqInbound(message(1))!.sessionKey, 'qq:' + user, 'existing private session identity');
    assertDeepEqual(qqSendTarget({ targetId: 'qq:group:' + group }), { id: group, group: true }, 'group delivery prefix'); assertDeepEqual(qqSendTarget({ targetId: 'qq:c2c:' + user }), { id: user, group: false }, 'legacy c2c delivery prefix');
    assertEqual(qqInbound({ ...message(1), t: 'INTERACTION_CREATE' }), undefined, 'unhandled event cannot become a turn');
    let rejected = false; try { qqInbound({ ...message(1), d: { ...object(message(1).d), author: {} } }); } catch { rejected = true; } assert(rejected, 'missing sender cannot merge unrelated conversations');
  });
  h.test('QQ actual HTTP token and gateway handshake route group and DM replies through the injected owner', async () => {
    const fixture = await createQQFixture(), turns: JsonObject[] = [];
    const service = new ChannelService({ configRoot: freshRoot(), factories: { qq: qqAdapter(fixture) }, runTurn: async input => { turns.push(input.channelContext); return { reply: 'actual owner reply' }; } });
    try {
      assertEqual(object(await service.connect({ id: 'qq', config: account })).ok, true, 'READY received before connect succeeds');
      assertDeepEqual(fixture.calls.find(call => call.path === '/token')!.body, { appId: account.app_id, clientSecret: account.client_secret }, 'vendor token request schema');
      assertEqual(fixture.calls.find(call => call.path === '/gateway')!.authorization, 'QQBot fixture-token-1', 'gateway request authorization');
      assertDeepEqual(fixture.frames[0]!.value, { op: QQ.identify, d: { token: 'QQBot fixture-token-1', intents: QQ_INTENTS, shard: [0, 1] } }, 'actual gateway identify');
      fixture.send(message(1)); fixture.send(message(1)); fixture.send(message(2, true));
      await waitFor(() => fixture.messages().length === 2, 8000, 'two actual reply receipts');
      assertEqual(turns.length, 2, 'gateway replay deduplicated');
      const direct = fixture.messages().find(call => call.path.includes('/users/'))!, grouped = fixture.messages().find(call => call.path.includes('/groups/'))!;
      assertEqual(direct.path, '/v2/users/' + user + '/messages', 'private endpoint'); assertEqual(grouped.path, '/v2/groups/' + group + '/messages', 'group endpoint');
      assertEqual(direct.body.msg_id, 'message-1', 'private passive reply id'); assertEqual(grouped.body.msg_id, 'message-2', 'group passive reply id');
      assertEqual(direct.body.content, 'actual owner reply', 'owner text'); assertEqual(grouped.body.msg_type, 0, 'text wire type'); assert(direct.body.msg_seq !== grouped.body.msg_seq, 'reply sequence does not collide');
      assertEqual(fixture.calls.filter(call => call.path === '/token').length, 1, 'one account token reused');
    } finally { await service.close(); await fixture.close(); }
  });
  h.test('QQ start stays pending until actual READY rather than treating socket open as authentication', async () => {
    const fixture = await createQQFixture({ frame: frame => frame.op === QQ.identify }); let complete = false;
    const starting = QQTransport.start(account, { configRoot: freshRoot(), signal: new AbortController().signal, inbound: async () => ({}) }, fixture).then(value => { complete = true; return value; });
    void starting.catch(() => undefined);
    try {
      await waitFor(() => fixture.frames.some(frame => frame.value.op === QQ.identify), 8000, 'actual identify sent'); assertEqual(complete, false, 'no false ready');
      fixture.send({ op: QQ.dispatch, s: 1, t: 'READY', d: { session_id: 'delayed-real-ready' } }); const port = await starting; assertEqual(port.status().connected, true, 'actual ready'); await port.close();
    } finally { await fixture.close(); await starting.then(port => port.close(), () => undefined); }
  });
  h.test('QQ failed token authentication is explicit and never leaves an autonomous socket or exposes response secrets', async () => {
    const fixture = await createQQFixture({ http: (call, response) => {
      if (call.path !== '/token') return; response.writeHead(200); response.end(JSON.stringify({ code: account.client_secret, message: 'fixture-token-1' })); return true;
    } }), statuses: JsonObject[] = [];
    try {
      const error = await assertRejects(() => QQTransport.start(account, { configRoot: freshRoot(), signal: new AbortController().signal, inbound: async () => ({}), onStatus: row => statuses.push(row) }, fixture), 'actual token refusal');
      assert(!String(error).includes(account.client_secret) && !JSON.stringify(statuses).includes('fixture-token-1'), 'untrusted server fields are not included in diagnostic');
      assertEqual(fixture.sockets.length, 0, 'token failure never creates a gateway'); assertEqual(fixture.calls.length, 1, 'no hidden authentication retry'); assertEqual(statuses.at(-1)!.manualReconnectRequired, true, 'account failure requires user intervention');
    } finally { await fixture.close(); }
  });
  h.test('QQ manual delivery suppresses an automatic response only after a real successful HTTP receipt', async () => {
    for (const failManual of [false, true]) {
      let sends = 0;
      const fixture = await createQQFixture({ http: (call, response) => { if (call.path.startsWith('/v2/') && ++sends === 1 && failManual) { response.writeHead(500); response.end('{"code":999}'); return true; } } });
      const service = new ChannelService({ configRoot: freshRoot(), factories: { qq: qqAdapter(fixture) }, runTurn: async input => {
        await service.send('qq', { targetId: user, text: 'manual fixture', sessionId: input.sessionKey }); return { reply: 'automatic fixture' };
      } });
      try {
        await service.connect({ id: 'qq', config: account }); fixture.send(message(1));
        await waitFor(() => fixture.messages().length === (failManual ? 2 : 1) && service.contextFor('qq:' + user) === undefined, 8000, 'actual owner and delivery settled');
        assertEqual(fixture.messages().at(-1)!.body.content, failManual ? 'automatic fixture' : 'manual fixture', 'only a confirmed manual delivery suppresses automatic text');
      } finally { await service.close(); await fixture.close(); }
    }
  });
  h.test('QQ token refresh is account scoped and a cancelled waiter does not cancel another caller', async () => {
    let tokenCalls = 0;
    const fixture = await createQQFixture({ http: async (call, response) => {
      if (call.path !== '/token') return; const count = ++tokenCalls; await new Promise(resolve => setTimeout(resolve, 30)); response.writeHead(200); response.end(JSON.stringify({ access_token: 'shared-fixture-' + count, expires_in: '7200' })); return true;
    } });
    const api = new QQApi(account.app_id, account.client_secret, new AbortController().signal, fixture), other = new QQApi(account.app_id, 'different-fixture-secret', new AbortController().signal, fixture), cancel = new AbortController();
    try {
      const cancelled = api.accessToken(cancel.signal); void cancelled.catch(() => undefined); const waiting = Array.from({ length: 8 }, () => api.accessToken()); cancel.abort();
      await assertRejects(() => cancelled, 'cancelled waiter rejects'); assert((await Promise.all(waiting)).every(token => token === 'shared-fixture-1'), 'remaining callers share actual reply'); assertEqual(tokenCalls, 1, 'singleflight HTTP call');
      assertEqual(await other.accessToken(), 'shared-fixture-2', 'same app id with different credentials has an independent token slot');
    } finally { await api.close(); await other.close(); await fixture.close(); }
  });
  h.test('QQ refreshes expiring tokens and retries an explicit HTTP 401 once with the same reply identity', async () => {
    let now = 1000, denyOnce = true;
    const fixture = await createQQFixture({ http: (call, response) => { if (call.path.startsWith('/v2/') && denyOnce) { denyOnce = false; response.writeHead(401); response.end('{"code":11244}'); return true; } } });
    const api = new QQApi(account.app_id, account.client_secret, new AbortController().signal, { ...fixture, now: () => now });
    try {
      await api.accessToken(); now += 6_901_000; assertEqual(await api.accessToken(), 'fixture-token-2', 'five-minute refresh window');
      const sent = await api.send({ targetId: user, text: 'retry fixture', replyToMessageId: 'inbound-retry' }); assertEqual(sent.ok, true, 'actual retry receipt');
      assertEqual(fixture.messages().length, 2, 'one rejected call and one retry'); assertDeepEqual(fixture.messages()[0]!.body, fixture.messages()[1]!.body, '401 retry preserves msg_id and msg_seq');
      assertEqual(fixture.messages()[0]!.authorization, 'QQBot fixture-token-2', 'expired credential actually attempted'); assertEqual(fixture.messages()[1]!.authorization, 'QQBot fixture-token-3', 'refreshed credential on retry');
    } finally { await api.close(); await fixture.close(); }
  });
  h.test('QQ gateway reconnect resumes sequence and invalid-session recovery refreshes credentials and identifies anew', async () => {
    const fixture = await createQQFixture(); let turns = 0;
    const port = await QQTransport.start(account, { configRoot: freshRoot(), signal: new AbortController().signal, inbound: async () => { turns++; return {}; } }, { ...fixture, backoffMs: [1] });
    try {
      fixture.send(message(8)); await waitFor(() => turns === 1, 8000, 'first message delivered'); fixture.send({ op: QQ.reconnect });
      await waitFor(() => fixture.frames.some(frame => frame.connection === 1 && frame.value.op === QQ.resume) && port.status().connected === true, 8000, 'actual gateway resume');
      const resumed = fixture.frames.find(frame => frame.connection === 1 && frame.value.op === QQ.resume)!;
      assertDeepEqual(resumed.value.d, { token: 'QQBot fixture-token-1', session_id: 'fixture-session-0', seq: 9 }, 'session state survives socket replacement');
      fixture.send(message(8)); fixture.send(message(9)); await waitFor(() => turns === 2, 8000, 'replayed old message suppressed');
      fixture.send({ op: QQ.invalidSession, d: false });
      await waitFor(() => fixture.frames.some(frame => frame.connection === 2 && frame.value.op === QQ.identify), 8000, 'invalid session uses fresh identify');
      assertEqual(object(fixture.frames.find(frame => frame.connection === 2 && frame.value.op === QQ.identify)!.value.d).token, 'QQBot fixture-token-2', 'invalid session invalidates token cache');
    } finally { await port.close(); await fixture.close(); }
  });
  h.test('QQ missing heartbeat ACK reconnects while a slow owner cannot block healthy heartbeats or grow the queue', async () => {
    const lost = await createQQFixture({ heartbeatInterval: 20, frame: (frame, _socket, connection) => connection === 0 && frame.op === QQ.heartbeat });
    const recovering = await QQTransport.start(account, { configRoot: freshRoot(), signal: new AbortController().signal, inbound: async () => ({}) }, { ...lost, backoffMs: [1] });
    try { await waitFor(() => lost.sockets.length >= 2, 8000, 'missed heartbeat replaced socket'); assert(lost.closed() >= 1, 'old socket reaped'); }
    finally { await recovering.close(); await lost.close(); }
    const fixture = await createQQFixture({ heartbeatInterval: 20 }); let turns = 0, release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const port = await QQTransport.start(account, { configRoot: freshRoot(), signal: new AbortController().signal, inbound: async () => { turns++; await barrier; return {}; } }, fixture);
    try {
      for (let id = 1; id <= 100; id++) fixture.send(message(id));
      await waitFor(() => port.status().lastError === 'QQ inbound queue capacity exceeded' && fixture.frames.filter(frame => frame.value.op === QQ.heartbeat).length >= 2, 8000, 'queue bound does not block heartbeat');
      assertEqual(turns, 1, 'same conversation serialized'); assertEqual(fixture.sockets.length, 1, 'busy owner did not disconnect a healthy socket');
      release(); await waitFor(() => turns === 32, 8000, 'accepted bounded turns drain'); await port.close(); assertEqual(turns, 32, 'overflow not accepted silently');
    } finally { release(); await port.close(); await fixture.close(); }
  });
  h.test('QQ rejected or malformed HTTP receipts do not report successful delivery or echo credentials', async () => {
    let mode: 'server-error' | 'malformed' | 'missing-id' = 'server-error';
    const fixture = await createQQFixture({ http: (call, response) => {
      if (!call.path.startsWith('/v2/')) return;
      response.writeHead(mode === 'server-error' ? 500 : 200); response.end(mode === 'malformed' ? account.client_secret : JSON.stringify(mode === 'server-error' ? { code: account.client_secret, message: 'fixture-token-1' } : {})); return true;
    } });
    const port = await QQTransport.start(account, { configRoot: freshRoot(), signal: new AbortController().signal, inbound: async () => ({}) }, fixture);
    try {
      for (const value of ['server-error', 'malformed', 'missing-id'] as const) {
        mode = value; const before = fixture.messages().length, result = await port.send({ targetId: user, text: 'failure fixture' }); assertEqual(result.ok, false, 'failure remains visible: ' + value);
        assert(!JSON.stringify(result).includes(account.client_secret) && !JSON.stringify(result).includes('fixture-token-1'), 'diagnostic omits secret/token'); assertEqual(fixture.messages().length, before + 1, 'ambiguous failure is not retried');
      }
      const before = fixture.messages().length;
      for (const params of [{ targetId: '../outside', text: 'invalid' }, { targetId: user, action: 'react', text: 'invalid' }, { targetId: user, text: 'file', files: ['/never/read'] }]) assertEqual((await port.send(params)).ok, false, 'unsupported input rejected');
      assertEqual(fixture.messages().length, before, 'rejected local inputs produce no HTTP request');
    } finally { await port.close(); await fixture.close(); }
  });
  h.test('QQ close cancels actual pending HTTP writes, bounds outbound work, and waits for owner cancellation', async () => {
    let aborted = 0, entered = false, ownerCancelled = false;
    const fixture = await createQQFixture({ http: (call, response) => { if (!call.path.startsWith('/v2/')) return; response.on('close', () => { aborted++; }); return true; } });
    const port = await QQTransport.start(account, { configRoot: freshRoot(), signal: new AbortController().signal, inbound: async (_message, signal) => {
      entered = true; await new Promise<void>(resolve => signal.addEventListener('abort', () => { ownerCancelled = true; resolve(); }, { once: true })); return { reply: 'late reply' };
    } }, fixture);
    try {
      fixture.send(message(1)); await waitFor(() => entered, 8000, 'actual owner request entered');
      const pending = Array.from({ length: 64 }, () => port.send({ targetId: user, text: 'pending fixture' }));
      await waitFor(() => fixture.messages().length === 64, 8000, 'bounded actual pending HTTP requests');
      assertEqual((await port.send({ targetId: user, text: 'overflow' })).error, 'QQ outbound queue capacity exceeded', 'overflow explicitly refused');
      await port.close(); assert((await Promise.all(pending)).every(result => result.ok === false), 'close rejects unacknowledged sends'); assertEqual(ownerCancelled, true, 'owner cancellation settled');
      await waitFor(() => aborted === 64, 8000, 'HTTP resources actually disconnected'); assertEqual(fixture.messages().length, 64, 'cancelled owner did not send a late reply');
    } finally { await port.close(); await fixture.close(); }
  });
  h.test('QQ cancelling token or authentication startup reaps the actual request instead of waiting for its timeout', async () => {
    for (const stage of ['token', 'gateway'] as const) {
      let tokenEntered = false, tokenClosed = false; const controller = new AbortController();
      const fixture = await createQQFixture({ http: (call, response) => { if (stage === 'token' && call.path === '/token') { tokenEntered = true; response.on('close', () => { tokenClosed = true; }); return true; } }, frame: frame => stage === 'gateway' && frame.op === QQ.identify });
      const starting = QQTransport.start(account, { configRoot: freshRoot(), signal: controller.signal, inbound: async () => ({}) }, { ...fixture, requestTimeoutMs: 10_000, handshakeTimeoutMs: 10_000 }); void starting.catch(() => undefined);
      try {
        await waitFor(() => stage === 'token' ? tokenEntered : fixture.frames.some(frame => frame.value.op === QQ.identify), 8000, 'actual startup request entered');
        const before = Date.now(); controller.abort(); await assertRejects(() => starting, 'cancelled startup rejects'); assert(Date.now() - before < 2000, 'cancel does not wait for timeout');
        await waitFor(() => stage === 'token' ? tokenClosed : fixture.closed() === 1, 8000, 'actual startup resource closed');
      } finally { controller.abort(); await starting.then(port => port.close(), () => undefined); await fixture.close(); }
    }
  });
}
