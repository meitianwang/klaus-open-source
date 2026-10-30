import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import WebSocket, { WebSocketServer } from 'ws';
import { ChannelService } from '../main/services/channels/service';
import { DingTalkApi } from '../main/services/channels/dingtalk-api';
import { DingTalkTransport, dingtalkAdapter } from '../main/services/channels/dingtalk';
import { DINGTALK_ROBOT_TOPIC, dingtalkAck, dingtalkContent, dingtalkInbound, dingtalkTarget, dingtalkTitle } from '../main/services/channels/dingtalk-wire';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

interface Call { path: string; method: string; body: JsonObject; token?: string }
interface Options {
  http?: (call: Call, response: ServerResponse) => boolean | void | Promise<boolean | void>;
  pong?: (connection: number) => boolean;
  stallHandshake?: boolean;
}
export async function createDingTalkFixture(options: Options = {}) {
  const calls: Call[] = [], frames: Array<{ value: JsonObject; connection: number }> = [], sockets: WebSocket[] = [], upgradeUrls: string[] = [], tcp = new Set<Socket>();
  let tokenCount = 0, gatewayCount = 0, pingCount = 0;
  const server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const call = { path: request.url ?? '', method: request.method ?? '', body: chunks.length ? object(JSON.parse(Buffer.concat(chunks).toString())) : {}, token: request.headers['x-acs-dingtalk-access-token'] as string | undefined }; calls.push(call);
      if (await options.http?.(call, response)) return;
      let value: JsonObject;
      if (call.path === '/v1.0/gateway/connections/open') value = { endpoint: 'ws://127.0.0.1:' + (server.address() as AddressInfo).port + '/gateway/path?retained=yes', ticket: 'fixture ticket/+' + ++gatewayCount };
      else if (call.path === '/v1.0/oauth2/accessToken') value = { accessToken: 'fixture-token-' + ++tokenCount, expireIn: 7200 };
      else if (call.path.startsWith('/v1.0/card/')) value = { success: true };
      else if (call.path.startsWith('/v1.0/robot/')) value = { processQueryKey: 'receipt-' + calls.length };
      else { response.writeHead(404); response.end('{}'); return; }
      response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value));
    })().catch(() => { if (!response.headersSent) response.writeHead(500); response.end('{}'); });
  });
  server.on('connection', socket => { tcp.add(socket); socket.on('close', () => tcp.delete(socket)); });
  const ws = new WebSocketServer({ noServer: true, autoPong: false, perMessageDeflate: false, maxPayload: 1024 * 1024 });
  server.on('upgrade', (request, socket, head) => { upgradeUrls.push(request.url ?? ''); if (!options.stallHandshake) ws.handleUpgrade(request, socket, head, connection => ws.emit('connection', connection, request)); });
  ws.on('connection', socket => {
    const connection = sockets.length; sockets.push(socket); socket.on('error', () => undefined);
    socket.on('ping', data => { pingCount++; if (options.pong?.(connection) !== false) socket.pong(data); });
    socket.on('message', data => { frames.push({ value: object(JSON.parse(data.toString())), connection }); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const apiBase = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
  return { apiBase, calls, frames, sockets, upgradeUrls, pings: () => pingCount,
    messages: () => calls.filter(call => call.path.startsWith('/v1.0/robot/')),
    cards: () => calls.filter(call => call.path.startsWith('/v1.0/card/')),
    send: (value: JsonObject, connection = sockets.length - 1) => sockets[connection]!.send(JSON.stringify(value)),
    close: async () => { for (const socket of sockets) socket.terminate(); for (const socket of tcp) socket.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => ws.close(() => resolve())); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
const account = { client_id: 'fixture-app-key', client_secret: 'fixture-dingtalk-secret' };
const raw = (group = false): JsonObject => ({ msgtype: 'text', text: { content: group ? '@Klaus question' : 'literal @friend' }, conversationType: group ? '2' : '1',
  senderId: 'sender-1', senderNick: 'Fixture Sender', conversationId: 'cidROOM', robotCode: account.client_id, createAt: 1_700_000_000_000, ...(group ? { atUsers: [{ dingtalkId: account.client_id }] } : {}) });
const message = (id: string, group = false): JsonObject => ({ type: 'CALLBACK', headers: { topic: DINGTALK_ROBOT_TOPIC, messageId: id }, data: JSON.stringify(raw(group)) });
const context = (configRoot: string) => ({ configRoot, signal: new AbortController().signal, inbound: async () => ({}) });

export function registerDingTalkChannelTests(h: Harness, freshRoot: () => string): void {
  h.test('DingTalk committed content and routing vectors preserve group policy and strict identities', () => {
    const contents: Array<[JsonObject, string, string]> = [
      [{ msgtype: 'text', text: { content: ' hi ' } }, 'hi', 'text'], [{ msgtype: 'audio', content: '{"recognition":" spoken "}' }, 'spoken', 'text'],
      [{ msgtype: 'richText', content: { richText: [{ type: 'text', text: 'a' }, { type: 'picture' }, { type: 'text', text: 'b' }] } }, 'ab', 'text'],
      [{ msgtype: 'file', content: { fileName: 'report.pdf' } }, '[文件: report.pdf]', 'file'], [{ msgtype: 'picture', content: {} }, '[图片]', 'image'],
      [{ msgtype: 'video', content: {} }, '[视频]', 'video'], [{ msgtype: 'audio', content: 'bad json' }, '[audio]', 'text'],
    ];
    for (const [input, text, messageType] of contents) assertDeepEqual(dingtalkContent(input), { text, messageType }, 'pinned content shape');
    assertDeepEqual(dingtalkInbound(raw(true), 'mid-1', account.client_id, 1), { sessionKey: 'dingtalk:cidROOM', senderId: 'sender-1', targetId: 'cidROOM', text: 'question', messageId: 'mid-1', messageType: 'text', chatType: 'group', timestamp: 1_700_000_000_000, dedupKey: 'dingtalk:mid-1', groupId: 'cidROOM', mentioned: true, senderName: 'Fixture Sender' }, 'group projection');
    assertEqual(dingtalkInbound(raw(), 'mid-2', account.client_id)!.text, 'literal @friend', 'private mentions retained');
    assertEqual(dingtalkInbound({ ...raw(true), atUsers: [{ dingtalkId: 'other-bot' }] }, 'mid-3', account.client_id), undefined, 'only this configured bot is addressed');
    const missingRobot: JsonObject = { ...raw(true), atUsers: [{}] }; delete missingRobot.robotCode;
    assertEqual(dingtalkInbound(missingRobot, 'mid-4', account.client_id), undefined, 'missing identifiers cannot compare equal and mention the bot');
    assertDeepEqual(dingtalkAck('mid-1', true), { code: 200, headers: { contentType: 'application/json', messageId: 'mid-1' }, message: 'OK', data: '{"response":{"success":true}}' }, 'double-encoded callback response');
    assertDeepEqual(dingtalkTarget({ targetId: 'dingtalk:cidROOM' }), { id: 'cidROOM', group: true }, 'legacy delivery identity');
    assertEqual(dingtalkTitle('# ' + '😀'.repeat(11)), '😀'.repeat(10), 'title retains complete UTF-16 characters');
    let rejected = false; try { dingtalkInbound({ ...raw(), senderId: '' }, 'mid-5', account.client_id); } catch { rejected = true; } assert(rejected, 'empty sender cannot merge conversations');
  });
  h.test('DingTalk actual gateway ticket and callback ACK deliver group and private AI cards through the host owner', async () => {
    const fixture = await createDingTalkFixture(), turns: JsonObject[] = [];
    const service = new ChannelService({ configRoot: freshRoot(), factories: { dingtalk: dingtalkAdapter(fixture) }, runTurn: async input => { turns.push(input.channelContext); return { reply: 'owner answer' }; } });
    try {
      assertEqual((await service.connect({ id: 'dingtalk', config: account })).ok, true, 'real socket opened');
      assertDeepEqual(fixture.calls[0]!.body, { clientId: account.client_id, clientSecret: account.client_secret, ua: 'klaus-dingtalk', subscriptions: [{ type: 'EVENT', topic: '*' }, { type: 'CALLBACK', topic: DINGTALK_ROBOT_TOPIC }] }, 'gateway schema');
      const url = new URL(fixture.upgradeUrls[0]!, fixture.apiBase); assertEqual(url.pathname, '/gateway/path', 'ticket endpoint path retained'); assertEqual(url.searchParams.get('retained'), 'yes', 'existing query retained'); assertEqual(url.searchParams.get('ticket'), 'fixture ticket/+1', 'ticket encoded exactly once');
      fixture.send(message('mid-1', true)); fixture.send(message('mid-1', true)); fixture.send(message('mid-2'));
      await waitFor(() => fixture.cards().filter(call => object(object(call.body.cardData).cardParamMap).flowStatus === '3').length === 2, 8000, 'two actual terminal card updates');
      assertEqual(turns.length, 2, 'deduplicated actual engine-owner submissions'); assertEqual(fixture.frames.length, 3, 'duplicate is also acknowledged');
      for (const frame of fixture.frames) assertEqual(JSON.parse(String(frame.value.data)).response.success, true, 'callback confirmation is nested JSON');
      const delivered = fixture.cards().filter(call => call.path.endsWith('/deliver')); assertDeepEqual(delivered.map(call => call.body.openSpaceId).sort(), ['dtv1.card//IM_GROUP.cidROOM', 'dtv1.card//IM_ROBOT.sender-1'], 'correct card destinations');
      for (const call of fixture.cards().filter(call => call.path.endsWith('/streaming'))) { assertEqual(call.body.content, 'owner answer', 'actual owner text'); assertEqual(call.body.isFinalize, true, 'terminal stream payload'); }
      assertEqual(fixture.messages().length, 0, 'no additional markdown after confirmed card'); assertEqual(fixture.calls.filter(call => call.path.endsWith('/accessToken')).length, 1, 'account token singleflight');
    } finally { await service.close(); await fixture.close(); }
  });
  h.test('DingTalk vendor staff IDs and actual bot mention fields keep conversation identity separate from delivery', async () => {
    const fixture = await createDingTalkFixture(), turns: Array<{ key: string; context: JsonObject }> = [];
    const service = new ChannelService({ configRoot: freshRoot(), factories: { dingtalk: dingtalkAdapter(fixture) }, runTurn: async input => { turns.push({ key: input.sessionKey, context: input.channelContext }); return { reply: 'staff-directed reply' }; } });
    try {
      await service.connect({ id: 'dingtalk', config: account });
      fixture.send({ ...message('staff'), data: JSON.stringify({ ...raw(), senderId: '$:LWCP_v1:$fixture-encrypted', senderStaffId: 'staff-1' }) });
      fixture.send({ ...message('at-bot', true), data: JSON.stringify({ ...raw(true), chatbotUserId: '$:fixture-bot', atUsers: [{ dingtalkId: '$:fixture-bot' }], isInAtList: true }) });
      await waitFor(() => fixture.cards().filter(call => object(object(call.body.cardData).cardParamMap).flowStatus === '3').length === 2, 8000, 'actual DM and group field shapes produce replies');
      const direct = turns.find(turn => turn.key.startsWith('dingtalk:$:'))!;
      assertEqual(direct.key, 'dingtalk:$:LWCP_v1:$fixture-encrypted', 'existing session identity is preserved');
      assertEqual(dingtalkInbound({ ...raw(), senderId: '$:LWCP_v1:$fixture-encrypted', senderStaffId: 'staff-1' }, 'staff', account.client_id)!.senderId, '$:LWCP_v1:$fixture-encrypted', 'access policy identity remains the sender id');
      assertEqual(direct.context.targetId, 'staff-1', 'host manual-send context uses actual OpenAPI staff id');
      assert(fixture.cards().some(call => call.body.openSpaceId === 'dtv1.card//IM_ROBOT.staff-1'), 'card recipient uses staff ID');
      assertEqual(dingtalkInbound({ ...raw(true), isInAtList: false }, 'not-at-bot', account.client_id), undefined, 'explicit server mention flag is authoritative');
      assertEqual(dingtalkInbound({ ...raw(true), chatbotUserId: '$:fixture-bot', atUsers: [{ dingtalkId: '$:fixture-bot' }] }, 'fallback-at-bot', account.client_id)!.mentioned, true, 'bot user ID is used when older callback omits isInAtList');
      const before = fixture.calls.length;
      assertEqual((await service.send('dingtalk', { targetId: '$:LWCP_v1:$fixture-encrypted', text: 'unaddressable' })).ok, false, 'encrypted identity is not accepted as an OpenAPI recipient');
      assertEqual(fixture.calls.length, before, 'invalid private address never crosses HTTP');
    } finally { await service.close(); await fixture.close(); }
  });
  h.test('DingTalk card rejection before content falls back to an actual markdown receipt', async () => {
    for (const failure of ['create', 'input', 'stream'] as const) {
      const fixture = await createDingTalkFixture({ http: (call, response) => {
        if ((failure === 'create' && call.path === '/v1.0/card/instances' && call.method === 'POST') || (failure === 'input' && call.path === '/v1.0/card/instances' && call.method === 'PUT') || (failure === 'stream' && call.path.endsWith('/streaming'))) { response.writeHead(403); response.end('{"message":"fixture-secret-do-not-display"}'); return true; }
      } });
      const port = await DingTalkTransport.start(account, { ...context(freshRoot()), inbound: async () => ({ reply: '# Answer\nactual fallback' }) }, fixture);
      try {
        fixture.send(message('fallback', true)); await waitFor(() => fixture.messages().length === 1 && port.status().lastOutboundAt !== undefined, 8000, 'actual fallback completes');
        const sent = fixture.messages()[0]!; assertEqual(sent.path, '/v1.0/robot/groupMessages/send', 'group markdown endpoint');
        assertDeepEqual(sent.body, { robotCode: account.client_id, openConversationId: 'cidROOM', msgKey: 'sampleMarkdown', msgParam: '{"title":"Answer","text":"# Answer\\nactual fallback"}' }, 'markdown body');
        assertEqual(port.status().connected, true, 'card permission does not invalidate stream account');
      } finally { await port.close(); await fixture.close(); }
    }
  });
  h.test('DingTalk lost streaming response and rejected final status never claim completion or duplicate an answer', async () => {
    for (const ambiguous of [true, false]) {
      const fixture = await createDingTalkFixture({ http: (call, response) => {
        if (ambiguous && call.path.endsWith('/streaming')) { response.destroy(); return true; }
        if (!ambiguous && object(object(call.body.cardData).cardParamMap).flowStatus === '3') { response.writeHead(500); response.end('{}'); return true; }
      } });
      const port = await DingTalkTransport.start(account, { ...context(freshRoot()), inbound: async () => ({ reply: 'answer that may already be visible' }) }, fixture);
      try {
        fixture.send(message('ambiguous')); await waitFor(() => String(port.status().lastError).includes('delivery may be partial'), 8000, 'unconfirmed terminal result is visible');
        assertEqual(fixture.messages().length, 0, 'no potentially duplicate message'); assertEqual(port.status().lastOutboundAt, undefined, 'no fake successful timestamp');
        assertEqual(fixture.cards().filter(call => call.path.endsWith('/streaming')).length, 1, 'ambiguous send is not retried');
      } finally { await port.close(); await fixture.close(); }
    }
  });
  h.test('DingTalk private manual delivery suppresses automatic cards only after the actual REST receipt', async () => {
    for (const failed of [false, true]) {
      const fixture = await createDingTalkFixture({ http: (call, response) => { if (failed && call.path.startsWith('/v1.0/robot/')) { response.writeHead(500); response.end('{}'); return true; } } });
      const service = new ChannelService({ configRoot: freshRoot(), factories: { dingtalk: dingtalkAdapter(fixture) }, runTurn: async input => {
        await service.send('dingtalk', { targetId: 'sender-1', text: 'manual delivery', sessionId: input.sessionKey }); return { reply: 'automatic fallback' };
      } });
      try {
        await service.connect({ id: 'dingtalk', config: account }); fixture.send(message('manual'));
        await waitFor(() => fixture.messages().length === 1 && service.contextFor('dingtalk:sender-1') === undefined, 8000, 'owner and manual receipt settled');
        if (failed) await waitFor(() => fixture.cards().length === 5, 8000, 'failed manual send permits automatic answer');
        assertEqual(fixture.cards().length, failed ? 5 : 0, 'only actual success suppresses automatic delivery');
        assertEqual(fixture.messages()[0]!.path, '/v1.0/robot/oToMessages/batchSend', 'private endpoint'); assertDeepEqual(fixture.messages()[0]!.body.userIds, ['sender-1'], 'recipient list');
      } finally { await service.close(); await fixture.close(); }
    }
  });
  h.test('DingTalk token singleflight isolates credentials and cancelled callers while refreshing before expiry', async () => {
    let tokenCalls = 0, now = 1000;
    const fixture = await createDingTalkFixture({ http: async (call, response) => {
      if (!call.path.endsWith('/accessToken')) return; const id = ++tokenCalls; await new Promise(resolve => setTimeout(resolve, 30)); response.writeHead(200); response.end(JSON.stringify({ accessToken: 'isolated-' + id, expireIn: 7200 })); return true;
    } });
    const api = new DingTalkApi(account.client_id, account.client_secret, new AbortController().signal, { ...fixture, now: () => now });
    const other = new DingTalkApi(account.client_id, 'another-fixture-secret', new AbortController().signal, fixture), cancel = new AbortController();
    try {
      const cancelled = api.accessToken(cancel.signal); void cancelled.catch(() => undefined); const pending = Array.from({ length: 8 }, () => api.accessToken()); cancel.abort();
      await assertRejects(() => cancelled, 'cancelled token waiter'); assert((await Promise.all(pending)).every(value => value === 'isolated-1'), 'one actual shared response'); assertEqual(tokenCalls, 1, 'bounded singleflight');
      assertEqual(await other.accessToken(), 'isolated-2', 'same client id does not share a different credential'); now += 6_901_000; assertEqual(await api.accessToken(), 'isolated-3', 'early expiry refresh');
    } finally { await api.close(); await other.close(); await fixture.close(); }
  });
  h.test('DingTalk malformed and rejected receipts cannot manufacture delivery IDs or leak secrets', async () => {
    let mode = 'missing';
    const fixture = await createDingTalkFixture({ http: (call, response) => {
      if (!call.path.startsWith('/v1.0/robot/')) return;
      response.writeHead(mode === 'rejected' ? 500 : 200);
      response.end(mode === 'malformed' ? account.client_secret : JSON.stringify(mode === 'logical' ? { success: false, processQueryKey: 'not-a-receipt' } : mode === 'recipient' ? { processQueryKey: 'partial-receipt', invalidStaffIdList: ['sender-1'] } : { message: account.client_secret })); return true;
    } });
    const port = await DingTalkTransport.start(account, context(freshRoot()), fixture);
    try {
      for (mode of ['missing', 'malformed', 'rejected', 'logical', 'recipient']) {
        const result = await port.send({ targetId: 'sender-1', text: 'receipt validation' }); assertEqual(result.ok, false, 'failure remains visible: ' + mode); assert(!JSON.stringify(result).includes(account.client_secret), 'no untrusted diagnostic text');
      }
      assertEqual(fixture.messages().length, 5, 'no automatic resend on an unconfirmed response'); assertEqual(port.status().lastOutboundAt, undefined, 'no fabricated success');
      const before = fixture.calls.length;
      for (const params of [{ targetId: '', text: 'invalid' }, { targetId: 'sender-1', text: '', action: 'sendText' }, { targetId: 'sender-1', action: 'react', text: 'invalid' }, { targetId: 'sender-1', text: 'file', files: ['/never/read'] }]) assertEqual((await port.send(params)).ok, false, 'unsupported input remains an error');
      assertEqual(fixture.calls.length, before, 'rejected inputs never call the vendor');
    } finally { await port.close(); await fixture.close(); }
  });
  h.test('DingTalk gateway credential rejection and insecure endpoint are explicit before any socket starts', async () => {
    for (const insecure of [false, true]) {
      const fixture = await createDingTalkFixture({ http: (call, response) => {
        if (!call.path.endsWith('/connections/open')) return; response.writeHead(insecure ? 200 : 401); response.end(JSON.stringify(insecure ? { endpoint: 'ws://external.example/never-connect', ticket: account.client_secret } : { message: account.client_secret })); return true;
      } }), statuses: JsonObject[] = [];
      try {
        const error = await assertRejects(() => DingTalkTransport.start(account, { ...context(freshRoot()), onStatus: value => statuses.push(value) }, fixture), 'actual gateway failure');
        assert(!String(error).includes(account.client_secret) && !JSON.stringify(statuses).includes(account.client_secret), 'credential never enters diagnostics');
        assertEqual(fixture.sockets.length, 0, 'no unauthorized or insecure socket'); if (!insecure) assertEqual(statuses.at(-1)!.manualReconnectRequired, true, 'invalid account requires manual action');
      } finally { await fixture.close(); }
    }
  });
  h.test('DingTalk system control ACKs and fresh-ticket reconnect keep replay deduplication', async () => {
    const fixture = await createDingTalkFixture(); let turns = 0;
    const port = await DingTalkTransport.start(account, { ...context(freshRoot()), inbound: async () => { turns++; return {}; } }, { ...fixture, backoffMs: [1] });
    try {
      fixture.send(message('replay')); await waitFor(() => turns === 1, 8000, 'original callback');
      const control = { headers: { topic: 'ping', messageId: 'control', custom: 'retained' }, data: 'opaque-data' }; fixture.send({ type: 'SYSTEM', ...control });
      fixture.send({ type: 'EVENT', headers: { messageId: 'event', topic: 'unused' }, data: '{}' });
      await waitFor(() => fixture.frames.some(frame => object(frame.value.headers).messageId === 'event'), 8000, 'default event ACK');
      assertDeepEqual(fixture.frames.find(frame => object(frame.value.headers).messageId === 'control')!.value, { code: 200, ...control, message: 'OK' }, 'system ping echoes headers and data verbatim');
      assertDeepEqual(fixture.frames.find(frame => object(frame.value.headers).messageId === 'event')!.value, dingtalkAck('event', false), 'event SUCCESS envelope');
      fixture.send({ type: 'SYSTEM', headers: { topic: 'disconnect', messageId: 'bye' }, data: 'reconnect-ticket' });
      await waitFor(() => fixture.sockets.length === 2 && port.status().connected === true, 8000, 'fresh endpoint opened after control disconnect');
      assert(fixture.frames.some(frame => object(frame.value.headers).messageId === 'bye'), 'disconnect acknowledged on the original socket');
      assertEqual(new URL(fixture.upgradeUrls[1]!, fixture.apiBase).searchParams.get('ticket'), 'fixture ticket/+2', 'ticket is not reused');
      fixture.send(message('replay')); fixture.send(message('new')); await waitFor(() => turns === 2, 8000, 'replay skipped but new callback accepted');
    } finally { await port.close(); await fixture.close(); }
  });
  h.test('DingTalk slow owners cannot block heartbeat or cause overflow callbacks to be falsely acknowledged', async () => {
    let turns = 0, release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const fixture = await createDingTalkFixture(), port = await DingTalkTransport.start(account, { ...context(freshRoot()), inbound: async () => { turns++; await barrier; return {}; } }, { ...fixture, heartbeatIntervalMs: 20 });
    try {
      for (let id = 0; id < 60; id++) fixture.send(message('flood-' + id));
      await waitFor(() => port.status().lastError === 'DingTalk inbound queue capacity exceeded' && fixture.pings() >= 2, 8000, 'capacity enforced while pings continue');
      assertEqual(turns, 1, 'per-conversation owner serialized'); assertEqual(fixture.frames.length, 32, 'only accepted callbacks were acknowledged'); assertEqual(fixture.sockets.length, 1, 'healthy socket remains connected');
      release(); await waitFor(() => turns === 32, 8000, 'accepted work drains'); fixture.send(message('flood-59')); await waitFor(() => turns === 33, 8000, 'unacknowledged callback can be redelivered');
      assertEqual(fixture.frames.filter(frame => object(frame.value.headers).messageId === 'flood-59').length, 1, 'overflow did not poison deduplication');
    } finally { release(); await port.close(); await fixture.close(); }
  });
  h.test('DingTalk lost pong reconnects and cancelling gateway HTTP or socket handshake closes the actual resource', async () => {
    const lost = await createDingTalkFixture({ pong: connection => connection !== 0 });
    const port = await DingTalkTransport.start(account, context(freshRoot()), { ...lost, heartbeatIntervalMs: 20, backoffMs: [1] });
    try { await waitFor(() => lost.sockets.length >= 2, 8000, 'missing heartbeat response reconnects'); }
    finally { await port.close(); await lost.close(); }
    for (const handshake of [false, true]) {
      let httpClosed = false;
      const fixture = await createDingTalkFixture({ stallHandshake: handshake, http: (call, response) => {
        if (!handshake && call.path.endsWith('/connections/open')) { response.on('close', () => { httpClosed = true; }); return true; }
      } }), cancel = new AbortController();
      const starting = DingTalkTransport.start(account, { ...context(freshRoot()), signal: cancel.signal }, fixture); void starting.catch(() => undefined);
      try {
        await waitFor(() => handshake ? fixture.upgradeUrls.length === 1 : fixture.calls.length === 1, 8000, 'actual start I/O began'); cancel.abort();
        await assertRejects(() => starting, 'cancelled start settles'); if (!handshake) await waitFor(() => httpClosed, 8000, 'actual gateway request closed');
        assertEqual(fixture.sockets.length, 0, 'start never reported connected');
      } finally { cancel.abort(); await starting.catch(() => undefined); await fixture.close(); }
    }
  });
  h.test('DingTalk close cancels bounded HTTP sends and drains the accepted host operation', async () => {
    let ownerStarted = false, ownerStopped = false, httpClosed = 0;
    const fixture = await createDingTalkFixture({ http: (call, response) => { if (call.path.startsWith('/v1.0/robot/')) { response.on('close', () => { httpClosed++; }); return true; } } });
    const port = await DingTalkTransport.start(account, { ...context(freshRoot()), inbound: async (_message, signal) => {
      ownerStarted = true; await new Promise<void>(resolve => signal.addEventListener('abort', () => { ownerStopped = true; resolve(); }, { once: true })); return {};
    } }, fixture);
    try {
      fixture.send(message('cancel-owner')); await waitFor(() => ownerStarted, 8000, 'host operation accepted');
      // Warm the token through an independent private send, then retain exactly the bounded 64 sends.
      const first = port.send({ targetId: 'sender-1', text: 'first' });
      await waitFor(() => fixture.messages().length === 1, 8000, 'first pending HTTP delivery');
      const pending = [first, ...Array.from({ length: 63 }, () => port.send({ targetId: 'sender-1', text: 'pending' }))];
      await waitFor(() => fixture.messages().length === 64, 8000, 'bounded actual HTTP operations');
      assertEqual((await port.send({ targetId: 'sender-1', text: 'overflow' })).ok, false, 'outbound capacity rejects immediately');
      await port.close(); assert((await Promise.all(pending)).every(result => result.ok === false), 'all pending delivery receipts are cancelled');
      await waitFor(() => httpClosed === 64, 8000, 'actual HTTP connections closed'); assert(ownerStopped, 'accepted host operation stopped before close resolved');
      assertEqual(port.status().running, false, 'transport stopped'); assertEqual(fixture.sockets[0]!.readyState, WebSocket.CLOSED, 'socket closed');
    } finally { await port.close(); await fixture.close(); }
  });
}
