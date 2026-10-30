import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { ChannelService } from '../main/services/channels/service';
import { WeComTransport, wecomAdapter } from '../main/services/channels/wecom';
import { WECOM, wecomInbound } from '../main/services/channels/wecom-wire';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

interface Options { respond?: (frame: JsonObject, connection: number) => JsonObject | null | undefined }
export async function createWeComFixture(options: Options = {}) {
  const frames: Array<{ value: JsonObject; connection: number }> = [], sockets: WebSocket[] = [];
  let closed = 0;
  const server = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const ws = new WebSocketServer({ server, perMessageDeflate: false, maxPayload: 256 * 1024 });
  ws.on('connection', socket => {
    const connection = sockets.length; sockets.push(socket); socket.on('error', () => undefined); socket.on('close', () => { closed++; });
    socket.on('message', data => {
      const value = object(JSON.parse(data.toString())); frames.push({ value, connection });
      const reply = options.respond?.(value, connection);
      if (reply === null) return;
      socket.send(JSON.stringify(reply ?? { headers: value.headers, errcode: 0, errmsg: 'ok' }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    wsUrl: 'ws://127.0.0.1:' + (server.address() as AddressInfo).port, frames, sockets, closed: () => closed,
    send: (frame: JsonObject, connection = sockets.length - 1) => sockets[connection]!.send(JSON.stringify(frame)),
    count: (command: string) => frames.filter(row => row.value.cmd === command).length,
    close: async () => { for (const socket of sockets) socket.terminate(); await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
const message = (id: number, group = false): JsonObject => ({ cmd: WECOM.callback, headers: { req_id: 'inbound-' + id },
  body: { msgid: 'message-' + id, chattype: group ? 'group' : 'single', chatid: 'fixture-group', from: { userid: 'fixture-user' }, msgtype: 'text', text: { content: 'fixture ' + id } } });
const account = { bot_id: 'fixture-bot', secret: 'fixture-only-secret' };

export function registerWeComChannelTests(h: Harness, freshRoot: () => string): void {
  h.test('WeCom preserves callback, DM and group identities without fabricating missing sender ids', () => {
    assertDeepEqual(wecomInbound(message(1, true), 1700000000000), { requestId: 'inbound-1', message: {
      sessionKey: 'wecom:fixture-group', text: 'fixture 1', messageType: 'text', chatType: 'group', senderId: 'fixture-user', targetId: 'fixture-group',
      timestamp: 1700000000000, groupId: 'fixture-group', messageId: 'message-1', dedupKey: 'wecom:message-1',
    } }, 'group mapping');
    assertEqual(wecomInbound({ ...message(2), body: { ...object(message(2).body), msgtype: 'stream' } }), undefined, 'stream callback never becomes a user turn');
    let rejected = false; try { wecomInbound({ ...message(2), body: { ...object(message(2).body), from: {} } }); } catch { rejected = true; }
    assert(rejected, 'missing sender does not share an unknown session');
    assertEqual(wecomInbound({ ...message(3), body: { ...object(message(3).body), msgtype: 'voice', voice: { content: 'transcribed' } } })!.message.text, 'transcribed', 'voice transcription');
  });
  h.test('WeCom actual authentication and same-request stream receipts route through the unique injected owner', async () => {
    const fixture = await createWeComFixture(), turns: JsonObject[] = [];
    const service = new ChannelService({ configRoot: freshRoot(), factories: { wecom: wecomAdapter({ wsUrl: fixture.wsUrl, heartbeatIntervalMs: 50 }) },
      runTurn: async input => { turns.push(input.channelContext); return { reply: 'real owner reply' }; } });
    try {
      assertEqual(object(await service.connect({ id: 'wecom', config: account })).ok, true, 'authentication completed');
      assertDeepEqual(object(fixture.frames[0]!.value.body), account, 'actual subscription fields');
      fixture.send(message(1)); fixture.send(message(1)); fixture.send(message(2, true));
      await waitFor(() => fixture.count(WECOM.response) === 2, 8000, 'two actual stream replies');
      const replies = fixture.frames.filter(row => row.value.cmd === WECOM.response).map(row => row.value);
      assertDeepEqual(replies.map(row => object(row.headers).req_id).sort(), ['inbound-1', 'inbound-2'], 'original req_id preserved across independent chats');
      for (const reply of replies) { const stream = object(object(reply.body).stream); assertEqual(stream.finish, true, 'stream is terminal'); assertEqual(stream.content, 'real owner reply', 'actual owner text'); assert(/^[a-f0-9]{32}$/u.test(String(stream.id)), 'stream identity'); }
      assertEqual(turns.length, 2, 'replay suppressed before owner'); assert(turns.some(row => row.targetId === 'fixture-group'), 'group target retained');
      await waitFor(() => fixture.count(WECOM.ping) > 0, 8000, 'actual heartbeat');
      assert(!('body' in fixture.frames.find(row => row.value.cmd === WECOM.ping)!.value), 'heartbeat has no body');
    } finally { await service.close(); await fixture.close(); }
  });
  h.test('WeCom manual send suppresses automatic reply only after an actual successful receipt', async () => {
    const fixture = await createWeComFixture(); let turns = 0;
    const service = new ChannelService({ configRoot: freshRoot(), factories: { wecom: wecomAdapter({ wsUrl: fixture.wsUrl }) }, runTurn: async input => {
      turns++; await service.send('wecom', { targetId: 'fixture-user', text: 'manual fixture', sessionId: input.sessionKey }); return { reply: 'automatic should be suppressed' };
    } });
    try {
      await service.connect({ id: 'wecom', config: account }); fixture.send(message(1));
      await waitFor(() => turns === 1 && fixture.count(WECOM.send) === 1, 8000, 'actual manual send');
      await new Promise(resolve => setTimeout(resolve, 30));
      assertEqual(fixture.count(WECOM.response), 0, 'no duplicate automatic reply');
    } finally { await service.close(); await fixture.close(); }
  });
  h.test('WeCom send only succeeds on the matching receipt; rejection, timeout and unsupported actions stay visible', async () => {
    const fixture = await createWeComFixture({ respond: frame => frame.cmd === WECOM.send ? null : undefined });
    const port = await WeComTransport.start(account, { configRoot: freshRoot(), signal: new AbortController().signal, inbound: async () => ({}) }, { wsUrl: fixture.wsUrl, replyAckTimeoutMs: 100 });
    try {
      let complete = false; const sending = port.send({ targetId: 'fixture-user', text: 'first' }).then(value => { complete = true; return value; });
      await waitFor(() => fixture.count(WECOM.send) === 1, 8000, 'actual outbound frame');
      fixture.send({ headers: { req_id: 'not-the-receipt' }, errcode: 0 }); await new Promise(resolve => setTimeout(resolve, 10)); assertEqual(complete, false, 'foreign receipt cannot settle send');
      fixture.send({ headers: object(fixture.frames.find(row => row.value.cmd === WECOM.send)!.value.headers), errcode: 0 }); assertEqual((await sending).ok, true, 'matching success');
      const rejected = port.send({ targetId: 'fixture-user', text: 'rejected' }); await waitFor(() => fixture.count(WECOM.send) === 2, 8000, 'second actual frame');
      fixture.send({ headers: object(fixture.frames.filter(row => row.value.cmd === WECOM.send)[1]!.value.headers), errcode: 400, errmsg: account.secret });
      const failure = await rejected; assertEqual(failure.ok, false, 'server rejection'); assert(!JSON.stringify(failure).includes(account.secret), 'server text cannot leak credentials');
      const timeout = await port.send({ targetId: 'fixture-user', text: 'timeout' }); assertEqual(timeout.ok, false, 'missing receipt is failure'); assert(String(timeout.error).includes('ACK timed out'), 'explicit timeout');
      const count = fixture.count(WECOM.send);
      for (const params of [{ targetId: 'fixture-user', text: 'attachments', files: [{ path: '/never/read' }] }, { targetId: 'fixture-user', action: 'react', text: 'emoji' }, { targetId: 'fixture-user', text: '😀'.repeat(6000) }]) assertEqual((await port.send(params)).ok, false, 'unsupported payload refused');
      assertEqual(fixture.count(WECOM.send), count, 'refused actions write no frame');
    } finally { await port.close(); await fixture.close(); }
  });
  h.test('WeCom failed stream receipt uses the existing proactive fallback and retains its actual receipt', async () => {
    const fixture = await createWeComFixture({ respond: frame => frame.cmd === WECOM.response ? { headers: object(frame.headers), errcode: 45001 } : undefined });
    const port = await WeComTransport.start(account, { configRoot: freshRoot(), signal: new AbortController().signal, inbound: async () => ({ reply: 'fallback fixture' }) }, { wsUrl: fixture.wsUrl });
    try {
      fixture.send(message(1)); await waitFor(() => fixture.count(WECOM.send) === 1, 8000, 'proactive fallback');
      assertDeepEqual(object(fixture.frames.find(row => row.value.cmd === WECOM.send)!.value.body), { chatid: 'fixture-user', msgtype: 'markdown', markdown: { content: 'fallback fixture' } }, 'fallback wire');
      await waitFor(() => typeof port.status().lastOutboundAt === 'number', 8000, 'fallback acknowledged');
    } finally { await port.close(); await fixture.close(); }
  });
  h.test('WeCom server takeover stops the manager until an explicit reconnect instead of fighting the new connection', async () => {
    const fixture = await createWeComFixture();
    const service = new ChannelService({ configRoot: freshRoot(), factories: { wecom: wecomAdapter({ wsUrl: fixture.wsUrl, backoffMs: [1] }) }, runTurn: async () => ({}), backoffMs: [1] });
    try {
      await service.connect({ id: 'wecom', config: account });
      fixture.send({ cmd: WECOM.event, headers: { req_id: 'takeover' }, body: { event: { eventtype: 'disconnected_event' } } });
      await waitFor(() => object(service.list().find(row => row.id === 'wecom')!.status).state === 'stopped', 8000, 'manager terminal state');
      await new Promise(resolve => setTimeout(resolve, 30));
      assertEqual(fixture.sockets.length, 1, 'no autonomous replacement'); const stopped = object(service.list().find(row => row.id === 'wecom')!.status);
      assertEqual(stopped.manualReconnectRequired, true, 'actionable reconnect requirement'); assertEqual(stopped.restartPending, false, 'no hidden restart queued');
      await service.restart('wecom'); assertEqual(fixture.sockets.length, 2, 'explicit reconnect creates exactly one new socket');
      assertEqual(service.list().find(row => row.id === 'wecom')!.connected, true, 'new socket authenticated');
    } finally { await service.close(); await fixture.close(); }
  });
  h.test('WeCom lost heartbeat replaces the socket and close cancels a silent authentication handshake', async () => {
    const fixture = await createWeComFixture({ respond: frame => frame.cmd === WECOM.ping ? null : undefined });
    const controller = new AbortController();
    const port = await WeComTransport.start(account, { configRoot: freshRoot(), signal: controller.signal, inbound: async () => ({}) }, { wsUrl: fixture.wsUrl, heartbeatIntervalMs: 20, backoffMs: [1] });
    try { await waitFor(() => fixture.sockets.length >= 2, 8000, 'actual missing heartbeat caused reconnect'); assert(fixture.closed() > 0, 'old socket closed'); }
    finally { await port.close(); await fixture.close(); }
    const silent = await createWeComFixture({ respond: () => null }), cancel = new AbortController();
    try {
      const pending = WeComTransport.start(account, { configRoot: freshRoot(), signal: cancel.signal, inbound: async () => ({}) }, { wsUrl: silent.wsUrl, handshakeTimeoutMs: 10_000 });
      void pending.catch(() => undefined); await waitFor(() => silent.count(WECOM.subscribe) === 1, 8000, 'silent auth actually sent'); const before = Date.now(); cancel.abort();
      await assertRejects(() => pending, 'cancelled start rejects'); assert(Date.now() - before < 2000, 'does not wait for auth timeout');
    } finally { await silent.close(); }
  });
  h.test('WeCom rejects invalid auth and keeps callback work bounded while heartbeat receipts remain responsive', async () => {
    const bad = await createWeComFixture({ respond: frame => ({ headers: object(frame.headers), errcode: account.secret, errmsg: account.secret }) });
    try {
      const error = await WeComTransport.start(account, { configRoot: freshRoot(), signal: new AbortController().signal, inbound: async () => ({}) }, { wsUrl: bad.wsUrl }).then(() => '', error => String(error));
      assert(error.includes('authentication failed') && !error.includes(account.secret), 'invalid auth code fails without echoing server-controlled credentials');
      assertEqual(bad.sockets.length, 1, 'failed start does not leave a reconnect worker');
    }
    finally { await bad.close(); }
    const fixture = await createWeComFixture(); let turns = 0, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const port = await WeComTransport.start(account, { configRoot: freshRoot(), signal: new AbortController().signal,
      inbound: async () => { turns++; await gate; return {}; } }, { wsUrl: fixture.wsUrl, heartbeatIntervalMs: 20 });
    try {
      for (let id = 1; id <= 100; id++) fixture.send(message(id));
      await waitFor(() => port.status().lastError === 'WeCom inbound queue capacity exceeded' && fixture.count(WECOM.ping) >= 2, 8000, 'bounded queue and responsive heartbeat');
      assertEqual(turns, 1, 'same chat turns serialize'); assertEqual(fixture.sockets.length, 1, 'slow engine does not kill heartbeat');
      release(); await waitFor(() => turns === 32, 8000, 'only bounded accepted turns drain'); await port.close(); assertEqual(turns, 32, 'overflow did not queue silently');
    } finally { release(); await port.close(); await fixture.close(); }
  });
  h.test('WeCom shutdown cancels pending receipts and waits for accepted owner cancellation before completing', async () => {
    const fixture = await createWeComFixture({ respond: frame => frame.cmd === WECOM.send ? null : undefined }); let entered = false, cancelled = false;
    const service = new ChannelService({ configRoot: freshRoot(), factories: { wecom: wecomAdapter({ wsUrl: fixture.wsUrl }) }, runTurn: async (_input, signal) => {
      entered = true; await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true })); return { reply: 'late reply' };
    } });
    try {
      await service.connect({ id: 'wecom', config: account }); fixture.send(message(1)); await waitFor(() => entered, 8000, 'owner active');
      const sending = service.send('wecom', { targetId: 'fixture-user', text: 'pending send' }); await waitFor(() => fixture.count(WECOM.send) === 1, 8000, 'actual pending receipt');
      await service.close(); assertEqual((await sending).ok, false, 'pending send cancelled'); assertEqual(cancelled, true, 'owner cancellation settled');
      assertEqual(fixture.count(WECOM.response), 0, 'no reply after shutdown'); assertEqual(service.contextFor('wecom:fixture-user'), undefined, 'context retired');
    } finally { await service.close(); await fixture.close(); }
  });
}
