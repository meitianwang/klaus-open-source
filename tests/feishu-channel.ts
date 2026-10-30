import { createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import { FeishuTransport, feishuAdapter } from '../main/services/channels/feishu';
import { FeishuApi } from '../main/services/channels/feishu-api';
import { feishuConfiguration } from '../main/services/channels/feishu-config';
import { feishuHeader, type FeishuFrame } from '../main/services/channels/feishu-codec';
import { ChannelService } from '../main/services/channels/service';
import type { ChannelInbound } from '../main/services/channels/types';
import { object, string, type JsonObject } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';
import { sealFeishu } from './feishu-contract';
import { createFeishuFixture, FEISHU_FIXTURE_ACCOUNT as account, feishuFixtureEvent as event } from './feishu-fixture';

const context = (configRoot: string) => ({ configRoot, signal: new AbortController().signal, inbound: async () => ({}) });
const options = { debounceMs: 5, maxBurstMs: 30, typingTimeoutMs: 100 };
const ackCode = (frame: FeishuFrame): number => Number(object(JSON.parse(frame.payload!.toString())).code);
export function registerFeishuChannelTests(h: Harness, freshRoot: () => string): void {
  h.test('Feishu actual gateway and uint64 ACK route one deduplicated turn through the host owner', async () => {
    const fixture = await createFeishuFixture(), turns: JsonObject[] = [];
    const service = new ChannelService({ configRoot: freshRoot(), factories: { feishu: feishuAdapter({ ...fixture, ...options }) }, runTurn: async input => { turns.push(input.channelContext); return { reply: 'actual owner answer' }; } });
    try {
      assertEqual((await service.connect({ id: 'feishu', config: account })).ok, true, 'actual socket open');
      assertDeepEqual(fixture.calls.find(call => call.path === '/callback/ws/endpoint')!.body, { AppID: account.app_id, AppSecret: account.app_secret }, 'actual gateway credentials shape');
      const url = new URL(fixture.upgradeUrls[0]!, fixture.apiBase); assertEqual(url.searchParams.get('device_id'), 'fixture+1', 'signed URL query retained exactly');
      fixture.send(event('om_owner'), 'wire-owner'); fixture.send(event('om_owner'), 'wire-replay');
      await waitFor(() => fixture.replies().length === 1 && fixture.acks().length === 2, 4000, 'actual reply and duplicate ACKs');
      assertEqual(turns.length, 1, 'one actual owner submission'); assertEqual(turns[0]!.targetId, 'oc_room', 'manual-send destination uses actual chat');
      assertEqual(fixture.replies()[0]!.body.content, '{"text":"actual owner answer"}', 'actual owner text transmitted');
      for (const { frame } of fixture.acks()) { assertEqual(ackCode(frame), 200, 'accepted ACK'); assertEqual(frame.seqId, 9007199254740993n, 'large sequence preserved'); assertEqual(frame.logId, 18446744073709551615n, 'large log id preserved'); assert(Number(feishuHeader(frame, 'biz_rt')) >= 0, 'nonnegative actual dispatch time'); }
      assertEqual(fixture.calls.filter(call => call.path.endsWith('/tenant_access_token/internal')).length, 1, 'one token shared only by this account');
    } finally { await service.close(); await fixture.close(); }
  });
  h.test('Feishu burst coalescing preserves each author and topic while continuing heartbeat control', async () => {
    const fixture = await createFeishuFixture(), inbound: ChannelInbound[] = [];
    const port = await FeishuTransport.start({ ...account, group_policy: 'open', require_mention: 'false', group_session_scope: 'group_topic_sender' }, { ...context(freshRoot()), inbound: async message => { inbound.push(message); return {}; } }, { ...fixture, ...options, debounceMs: 30, maxBurstMs: 150 });
    try {
      fixture.send(event('om_a', { chat_type: 'group', root_id: 'root-a', thread_id: 'thread-a', content: '{"text":"first"}' }), 'wire-a');
      fixture.send(event('om_b', { chat_type: 'group', root_id: 'root-a', thread_id: 'thread-a', content: '{"text":"second"}' }), 'wire-b');
      fixture.send(event('om_other_author', { chat_type: 'group', root_id: 'root-a', thread_id: 'thread-a' }, { open_id: 'ou_other' }), 'wire-c');
      fixture.send(event('om_other_topic', { chat_type: 'group', root_id: 'root-b', thread_id: 'thread-b' }), 'wire-d');
      await waitFor(() => inbound.length === 3 && port.status().pendingInbound === 0, 4000, 'three correctly scoped batches');
      assertEqual(inbound.find(message => message.messageId === 'om_b')!.text, 'first\n\nsecond', 'same author and topic coalesced');
      assertDeepEqual(inbound.map(message => message.sessionKey).sort(), ['feishu:oc_room:topic:root-a:sender:ou_other', 'feishu:oc_room:topic:root-a:sender:ou_sender', 'feishu:oc_room:topic:root-b:sender:ou_sender'], 'different authors and topics stay separate');
      assert(inbound.every(message => message.threadId === (message.messageId === 'om_other_topic' ? 'thread-b' : 'thread-a')), 'real thread routing preserved');
      assert(fixture.pings() > 0, 'protobuf heartbeat is live');
    } finally { await port.close(); await fixture.close(); }
  });
  h.test('Feishu real post assets, safe media paths, sender lookup and Typing cleanup reach the owner', async () => {
    const fixture = await createFeishuFixture(), root = freshRoot(), inbound: ChannelInbound[] = [];
    const port = await FeishuTransport.start({ ...account, typing_indicator: 'true', resolve_sender_names: 'true', group_policy: 'open' }, { ...context(root), inbound: async message => { inbound.push(message); return { reply: '**markdown reply**' }; } }, { ...fixture, ...options });
    try {
      const content = JSON.stringify({ zh_cn: { title: 'Fixture post', content: [[{ tag: 'at', user_id: 'ou_bot', user_name: 'Klaus' }, { tag: 'text', text: 'Question' }, { tag: 'img', image_key: 'img_fixture' }], [{ tag: 'media', file_key: 'file_fixture', file_name: '../../unsafe.bin' }]] } });
      fixture.send(event('om_media', { chat_type: 'group', message_type: 'post', content, mentions: [{ key: '@_user_1', id: { open_id: 'ou_bot' }, name: 'Klaus' }], root_id: 'root-media', thread_id: 'thread-media' }), 'wire-media');
      await waitFor(() => port.status().pendingInbound === 0 && inbound.length === 1, 4000, 'media owner and cleanup terminal');
      const media = (inbound[0]!.media as unknown[]).map(object); assertEqual(media.length, 2, 'post image and file preserved together');
      for (const item of media) { const path = string(item.path); assert(!relative(root, path).startsWith('..'), 'saved inside this profile'); assertEqual(readFileSync(path, 'utf8'), 'fixture-media-bytes', 'actual downloaded bytes'); }
      assertEqual(media[1]!.fileName, 'fixture.bin', 'vendor traversal path reduced to a filename');
      assertEqual(inbound[0]!.senderName, 'Fixture Sender', 'actual contact lookup');
      assert(fixture.calls.some(call => call.path.includes('/contact/v3/users/ou_sender?user_id_type=open_id')), 'identity type follows actual sender id');
      assertEqual(fixture.calls.filter(call => call.path.endsWith('/reactions') && call.method === 'POST').length, 1, 'actual Typing reaction created');
      assertEqual(fixture.calls.filter(call => call.path.includes('/reactions/') && call.method === 'DELETE').length, 1, 'actual Typing reaction removed');
      const reply = fixture.replies()[0]!; assertEqual(reply.body.msg_type, 'interactive', 'markdown rendered as a card'); assertEqual(reply.body.reply_in_thread, true, 'thread reply is explicit');
    } finally { await port.close(); await fixture.close(); }
  });
  h.test('Feishu failed media is explicit while forwarded message text and remaining content stay usable', async () => {
    const fixture = await createFeishuFixture({ http: (call, response) => { if (call.path.includes('/images/')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"code":999,"msg":"fixture-secret"}'); return true; } } }), inbound: ChannelInbound[] = [];
    const port = await FeishuTransport.start(account, { ...context(freshRoot()), inbound: async message => { inbound.push(message); return {}; } }, { ...fixture, ...options });
    try {
      fixture.send(event('om_forward', { message_type: 'merge_forward', content: '{}' }), 'wire-forward');
      await waitFor(() => inbound.length === 1 && port.status().pendingInbound === 0, 4000, 'forwarded content fetched');
      assert(inbound[0]!.text.includes('forwarded fixture'), 'actual get-message body parsed');
      fixture.send(event('om_failed_media', { message_type: 'image', content: '{"image_key":"img_denied"}' }), 'wire-failed');
      await waitFor(() => inbound.length === 2 && port.status().pendingInbound === 0, 4000, 'failed media still reaches text owner');
      assert(inbound[1]!.text.includes('could not be downloaded'), 'failure is explicit in input'); assertEqual(inbound[1]!.media, undefined, 'error JSON is never saved as an image');
      assert(!JSON.stringify(port.status()).includes('fixture-secret'), 'vendor diagnostic cannot leak credentials');
    } finally { await port.close(); await fixture.close(); }
  });
  h.test('Feishu withdrawn ordinary replies fall back once while thread and ambiguous sends never duplicate', async () => {
    let mode = 'withdrawn';
    const fixture = await createFeishuFixture({ http: (call, response) => {
      if (!call.path.endsWith('/reply')) return;
      if (mode === 'lost') response.destroy(); else { response.writeHead(200); response.end(JSON.stringify(mode === 'missing' ? { code: 0, data: {} } : { code: 230011, msg: 'fixture target withdrawn' })); } return true;
    } });
    const port = await FeishuTransport.start(account, context(freshRoot()), { ...fixture, ...options });
    try {
      assertEqual((await port.send({ targetId: 'feishu:oc_room', replyToMessageId: 'om_deleted', text: 'ordinary' })).ok, true, 'known withdrawn plain target falls back with actual receipt');
      assertEqual(fixture.replies().filter(call => !call.path.endsWith('/reply')).length, 1, 'one direct fallback');
      for (const request of [{ targetId: 'oc_room', replyToMessageId: 'om_deleted', threadId: 'thread', text: 'thread' }, { targetId: 'oc_room', threadId: 'thread', text: 'missing parent' }]) assertEqual((await port.send(request)).ok, false, 'thread cannot silently move to top level');
      for (mode of ['lost', 'missing']) assertEqual((await port.send({ targetId: 'oc_room', replyToMessageId: 'om_reply', text: 'unconfirmed' })).ok, false, 'unconfirmed receipt rejected');
      assertEqual(fixture.replies().filter(call => !call.path.endsWith('/reply')).length, 1, 'no retry after an ambiguous send');
      const before = fixture.calls.length; assertEqual((await port.send({ targetId: 'oc_room', text: 'unsupported', files: [{}] })).ok, false, 'unsupported attachment is explicit'); assertEqual(fixture.calls.length, before, 'unsupported action has no side effect');
    } finally { await port.close(); await fixture.close(); }
  });
  h.test('Feishu token singleflight isolates credentials and cancellation and refreshes before expiry', async () => {
    let calls = 0, now = 1000;
    const fixture = await createFeishuFixture({ http: async (call, response) => {
      if (!call.path.endsWith('/tenant_access_token/internal')) return;
      const id = ++calls; await new Promise(resolve => setTimeout(resolve, 30)); response.writeHead(200); response.end(JSON.stringify({ code: 0, tenant_access_token: 'isolated-' + id, expire: 7200 })); return true;
    } });
    const api = new FeishuApi(feishuConfiguration(account), freshRoot(), new AbortController().signal, { ...fixture, now: () => now });
    const other = new FeishuApi(feishuConfiguration({ ...account, app_secret: 'other-secret' }), freshRoot(), new AbortController().signal, fixture), cancel = new AbortController();
    try {
      const cancelled = api.accessToken(cancel.signal); void cancelled.catch(() => undefined); const pending = Array.from({ length: 8 }, () => api.accessToken()); cancel.abort();
      await assertRejects(() => cancelled, 'cancelled waiter does not own shared refresh'); assert((await Promise.all(pending)).every(token => token === 'isolated-1'), 'one shared actual token response');
      assertEqual(await other.accessToken(), 'isolated-2', 'different credential gets separate token'); now += 7_021_000; assertEqual(await api.accessToken(), 'isolated-3', 'three-minute early refresh'); assertEqual(calls, 3, 'bounded account refreshes');
    } finally { await api.close(); await other.close(); await fixture.close(); }
  });
  h.test('Feishu audio and video retain native media types and Unicode filenames respect real filesystem byte limits', async () => {
    const fixture = await createFeishuFixture({ http: (call, response) => {
      if (!call.path.includes('/resources/')) return;
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-disposition': "attachment; filename*=UTF-8''" + encodeURIComponent('报告'.repeat(100) + '.bin') }); response.end('actual-long-name-media'); return true;
    } }), inbound: ChannelInbound[] = [], root = freshRoot();
    const port = await FeishuTransport.start(account, { ...context(root), inbound: async message => { inbound.push(message); return {}; } }, { ...fixture, ...options });
    try {
      for (const [id, type] of [['om_audio', 'audio'], ['om_video', 'video'], ['om_file', 'file']]) {
        fixture.send(event(id!, { message_type: type!, content: '{"file_key":"file_audio_video"}' }), 'wire-' + id);
        await waitFor(() => inbound.some(message => message.messageId === id) && port.status().pendingInbound === 0, 4000, 'actual media type completed');
      }
      assertDeepEqual(inbound.map(message => message.messageType), ['voice', 'video', 'file'], 'existing input message types');
      assertDeepEqual(inbound.map(message => object((message.media as unknown[])[0]).type), ['audio', 'video', 'file'], 'actual attached media types');
      for (const message of inbound) { const item = object((message.media as unknown[])[0]); assertEqual(readFileSync(string(item.path), 'utf8'), 'actual-long-name-media', 'actual path exists'); if (item.fileName) assert(Buffer.byteLength(string(item.fileName)) <= 180, 'Unicode filename obeys byte budget'); }
    } finally { await port.close(); await fixture.close(); }
  });
  h.test('Feishu fragments reassemble out of order and heartbeat timeout reconnects through a fresh endpoint', async () => {
    const fixture = await createFeishuFixture({ pong: connection => connection === 0 ? false : { PingInterval: 0.03 } }), inbound: ChannelInbound[] = [];
    const port = await FeishuTransport.start(account, { ...context(freshRoot()), inbound: async message => { inbound.push(message); return {}; } }, { ...fixture, ...options });
    try {
      await waitFor(() => fixture.sockets.length === 2 && fixture.pings() >= 3, 4000, 'missing pong causes real fresh connection');
      assertEqual(fixture.endpoints(), 2, 'endpoint is fetched again'); assert(new URL(fixture.upgradeUrls[1]!, fixture.apiBase).searchParams.get('device_id') === 'fixture+2', 'new signed URL is used');
      const payload = Buffer.from(JSON.stringify(event('om_fragment'))), cut = Math.floor(payload.length / 2);
      const shard = (seq: number): FeishuFrame => ({ seqId: 11n, logId: 12n, service: 7, method: 1, headers: [['type', 'event'], ['message_id', 'sharded'], ['sum', '2'], ['seq', String(seq)]], payload: seq ? payload.subarray(cut) : payload.subarray(0, cut) });
      fixture.sendFrame(shard(1)); fixture.sendFrame(shard(1)); fixture.sendFrame(shard(0));
      await waitFor(() => inbound.length === 1 && fixture.acks().length === 1, 4000, 'complete fragment receives one actual ACK');
      assertEqual(inbound[0]!.messageId, 'om_fragment', 'reassembled event reaches owner'); assertEqual(ackCode(fixture.acks()[0]!.frame), 200, 'accepted complete event');
    } finally { await port.close(); await fixture.close(); }
  });
  h.test('Feishu persisted completion prevents replay across actual transport restarts', async () => {
    const fixture = await createFeishuFixture(), root = freshRoot(); let turns = 0;
    const ctx = { ...context(root), inbound: async () => { turns++; return {}; } };
    let port = await FeishuTransport.start(account, ctx, { ...fixture, ...options });
    try {
      fixture.send(event('om_durable'), 'wire-durable'); await waitFor(() => turns === 1 && port.status().pendingInbound === 0, 4000, 'first completion persisted'); await port.close();
      port = await FeishuTransport.start(account, ctx, { ...fixture, ...options });
      const before = fixture.acks().length; fixture.send(event('om_durable'), 'wire-after-restart'); fixture.send(event('om_new'), 'wire-new');
      await waitFor(() => fixture.acks().length === before + 2 && port.status().pendingInbound === 0 && turns === 2, 4000, 'replay ACK and only new owner turn');
      const ledger = JSON.parse(readFileSync(root + '/feishu/dedup/global.json', 'utf8')); assertDeepEqual(Object.keys(ledger).sort(), ['om_durable', 'om_new'], 'actual existing ledger format');
    } finally { await port.close(); await fixture.close(); }
  });
  h.test('Feishu bounded admission rejects overflow without poisoning dedup or starving heartbeat and close drains owner', async () => {
    const fixture = await createFeishuFixture(); let entered = 0, released = false;
    const port = await FeishuTransport.start(account, { ...context(freshRoot()), inbound: async (_message, signal) => {
      entered++; await new Promise<void>(resolve => signal.addEventListener('abort', () => setTimeout(() => { released = true; resolve(); }, 30), { once: true })); return {};
    } }, { ...fixture, ...options });
    try {
      fixture.send(event('om_first'), 'first'); await waitFor(() => entered === 1, 4000, 'actual owner is blocked');
      for (let id = 0; id < 80; id++) fixture.send(event('om_flood_' + id), 'flood-' + id);
      await waitFor(() => fixture.acks().length === 81 && fixture.pings() >= 3, 4000, 'all admission results while owner remains blocked');
      assertEqual(fixture.acks().filter(({ frame }) => ackCode(frame) === 200).length, 32, 'per-session capacity is 32'); assertEqual(port.status().pendingInbound, 32, 'pending count bounded');
      assertEqual(fixture.acks().filter(({ frame }) => ackCode(frame) === 500).length, 49, 'overflow is not success-ACKed');
      await port.close(); assert(released, 'close waits for actual owner cancellation'); assertEqual(port.status().pendingInbound, 0, 'queued work drained'); assertEqual(entered, 1, 'cancelled queued batches never start new turns');
    } finally { await port.close(); await fixture.close(); }
  });
  h.test('Feishu account rejection and cancelled token or websocket handshake never report connected', async () => {
    for (const mode of ['denied', 'token', 'handshake'] as const) {
      const fixture = await createFeishuFixture({ stallHandshake: mode === 'handshake', http: (call, response) => {
        if (!call.path.endsWith('/tenant_access_token/internal')) return;
        if (mode === 'denied') { response.writeHead(200); response.end('{"code":10003,"msg":"fixture-secret"}'); return true; }
        if (mode === 'token') return true;
      } }), cancel = new AbortController(), statuses: JsonObject[] = [];
      const start = FeishuTransport.start(account, { ...context(freshRoot()), signal: cancel.signal, onStatus: status => statuses.push(status) }, { ...fixture, ...options }); void start.catch(() => undefined);
      try {
        if (mode !== 'denied') { await waitFor(() => mode === 'token' ? fixture.calls.length > 0 : fixture.upgradeUrls.length > 0, 4000, 'actual pending I/O reached'); cancel.abort(); }
        await assertRejects(() => start, 'start failure is explicit'); assert(!statuses.some(status => status.connected), 'no fake connected state');
        if (mode === 'denied') assert(statuses.some(status => status.manualReconnectRequired === true), 'rejected credentials require explicit reconnect');
        assert(!JSON.stringify(statuses).includes('fixture-secret'), 'no secret in status');
      } finally { cancel.abort(); await fixture.close(); }
    }
  });
  h.test('Feishu disconnect cancels active work and removes actual Typing reaction before API close', async () => {
    const fixture = await createFeishuFixture(); let entered = false, cancelled = false;
    const port = await FeishuTransport.start({ ...account, typing_indicator: 'true' }, { ...context(freshRoot()), inbound: async (_message, signal) => {
      entered = true; await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true })); return {};
    } }, { ...fixture, ...options });
    try {
      fixture.send(event('om_typing_cancel'), 'typing-cancel'); await waitFor(() => entered, 4000, 'actual typing precedes owner turn');
      await port.close(); assert(cancelled, 'owner observes cancellation'); assertEqual(fixture.calls.filter(call => call.method === 'DELETE' && call.path.includes('/reactions/')).length, 1, 'typing cleanup still executes after owner abort'); assertEqual(port.status().running, false, 'only fully stopped reports stopped');
    } finally { await port.close(); await fixture.close(); }
  });
  h.test('Feishu bounds actual outstanding sends and aborts every unconfirmed HTTP receipt on close', async () => {
    const fixture = await createFeishuFixture({ http: call => call.path.startsWith('/open-apis/im/v1/messages?') ? true : undefined });
    const port = await FeishuTransport.start(account, context(freshRoot()), { ...fixture, ...options });
    try {
      const pending = Array.from({ length: 64 }, () => port.send({ targetId: 'oc_room', text: 'bounded pending reply' }));
      assertEqual((await port.send({ targetId: 'oc_room', text: 'overflow' })).ok, false, 'sixty-fifth send is refused at admission');
      await waitFor(() => fixture.replies().length === 64, 4000, 'all accepted requests reached actual HTTP');
      await port.close(); const results = await Promise.all(pending);
      assert(results.every(result => result.ok === false), 'aborted replies never become success'); assertEqual(port.status().lastOutboundAt, undefined, 'no fake successful delivery timestamp'); assertEqual(port.status().pendingSends, 0, 'all accepted sends drained');
    } finally { await port.close(); await fixture.close(); }
  });
  h.test('Feishu webhook performs actual encrypted verification and rejects unsigned requests before owner admission', async () => {
    const fixture = await createFeishuFixture(), incoming: ChannelInbound[] = [], encrypt = 'fixture-aes-key', token = 'fixture-verification';
    const port = await FeishuTransport.start({ ...account, connection_mode: 'webhook', webhook_port: '0', encrypt_key: encrypt, verification_token: token }, { ...context(freshRoot()), inbound: async message => { incoming.push(message); return { reply: 'webhook answer' }; } }, { ...fixture, ...options });
    const url = 'http://127.0.0.1:' + port.status().webhookPort + '/feishu/events';
    try {
      const post = (body: JsonObject, headers: Record<string, string> = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
      const challenge = await post({ encrypt: sealFeishu({ type: 'url_verification', token, challenge: 'actual-challenge' }, encrypt) }); assertEqual(challenge.status, 200, 'real verification response'); assertDeepEqual(await challenge.json(), { challenge: 'actual-challenge' }, 'decrypted challenge returned');
      const body = event('om_webhook'); object(body.header).token = token;
      const rejected = await post(body); assertEqual(rejected.status, 401, 'unsigned event rejected'); await rejected.arrayBuffer(); assertEqual(incoming.length, 0, 'unauthenticated event does not reach owner');
      const stamp = String(Math.floor(Date.now() / 1000)), nonce = 'nonce', signature = createHash('sha256').update(stamp + nonce + encrypt + JSON.stringify(body)).digest('hex');
      const accepted = await post(body, { 'x-lark-request-timestamp': stamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': signature }); assertEqual(accepted.status, 200, 'signed event accepted'); await accepted.arrayBuffer();
      await waitFor(() => incoming.length === 1 && port.status().pendingInbound === 0, 4000, 'actual webhook owner and HTTP reply'); assertEqual(fixture.replies().length, 1, 'webhook mode uses actual REST reply'); assertEqual(fixture.sockets.length, 0, 'webhook does not also open a socket transport');
      const closedPort = Number(port.status().webhookPort); await port.close(); await assertRejects(() => fetch('http://127.0.0.1:' + closedPort + '/feishu/events', { method: 'POST', body: '{}' }), 'close actually releases listener');
    } finally { await port.close(); await fixture.close(); }
  });
  h.test('Feishu webhook bounds bodies and request rates and closes incomplete uploads', async () => {
    const fixture = await createFeishuFixture();
    const port = await FeishuTransport.start({ ...account, connection_mode: 'webhook', webhook_port: '0', verification_token: 'fixture-token' }, context(freshRoot()), { ...fixture, ...options, webhookRequestTimeoutMs: 100 });
    const url = 'http://127.0.0.1:' + port.status().webhookPort + '/feishu/events';
    try {
      // Send the size declaration before any body: rejection must not depend on buffering the upload.
      const oversized = await new Promise<number>((resolve, reject) => {
        const request = httpRequest(url, { method: 'POST', headers: { 'content-length': String(1024 * 1024 + 1) } }, response => { response.resume(); response.once('end', () => resolve(response.statusCode!)); });
        request.on('error', reject); request.end();
      }); assertEqual(oversized, 413, 'oversized declaration rejected before accepting body bytes');
      let rateLimited = false;
      for (let id = 0; id < 101; id++) { const response = await fetch(url, { method: 'POST', body: '{"token":"wrong"}' }); rateLimited ||= response.status === 429; await response.arrayBuffer(); }
      assert(rateLimited, 'actual same-IP request flood is bounded');
    } finally { await port.close(); await fixture.close(); }
    const otherFixture = await createFeishuFixture(), other = await FeishuTransport.start({ ...account, connection_mode: 'webhook', webhook_port: '0', verification_token: 'fixture-token' }, context(freshRoot()), { ...otherFixture, ...options });
    const partial = httpRequest({ hostname: '127.0.0.1', port: Number(other.status().webhookPort), path: '/feishu/events', method: 'POST', headers: { 'content-length': '100' } });
    const closed = new Promise<void>(resolve => { partial.on('error', () => resolve()); partial.on('close', resolve); });
    try { partial.write('{'); await new Promise<void>(resolve => partial.once('socket', socket => socket.connecting ? socket.once('connect', resolve) : resolve())); await other.close(); await closed; assertEqual(other.status().running, false, 'incomplete upload is cancelled by close'); }
    finally { partial.destroy(); await other.close(); await otherFixture.close(); }
  });
}
