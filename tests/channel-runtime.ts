import { readFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerChannelHandlers } from '../main/ipc/handlers/channels';
import { ChannelService } from '../main/services/channels/service';
import { ChannelSettingsStore } from '../main/services/channels/settings-store';
import { type ChannelAdapter, type ChannelAdapterFactory, type ChannelInbound } from '../main/services/channels/types';
import { wechatAdapter, wechatInbound, wechatMessageText, wechatUin } from '../main/services/channels/wechat';
import { kvGet, withSettingsDb } from '../main/services/settings';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

const vector = JSON.parse(readFileSync(join(__dirname, '../../tests/vectors/channel-runtime.json'), 'utf8')) as {
  ids: string[]; channels: string[]; message: JsonObject; inbound: ChannelInbound; baseInfo: JsonObject; mixedMessage: JsonObject; mixedText: string;
};
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
async function fixture(batches: JsonObject[] = []) {
  let pollCount = 0, closeCount = 0, sendBody: unknown = { errcode: 0 }, sendStatus = 200;
  const requests: Array<{ path: string; body: JsonObject; headers: Record<string, string | string[] | undefined> }> = [], held: ServerResponse[] = [];
  const json = (response: ServerResponse, value: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  const server = createServer(async (request, response) => {
    response.once('close', () => { closeCount++; });
    if (request.method === 'GET' && request.url?.startsWith('/gateway/ilink/bot/get_bot_qrcode?')) {
      json(response, { qrcode: 'fixture-qr-session', qrcode_img_content: 'https://fixture.invalid/pairing' }); return;
    }
    if (request.method === 'GET' && request.url?.startsWith('/gateway/ilink/bot/get_qrcode_status?')) {
      json(response, { status: 'confirmed', bot_token: 'fixture-bot-token', ilink_bot_id: 'fixture-bot-id', baseurl: base }); return;
    }
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    let body: JsonObject; try { body = object(JSON.parse(raw)); } catch { json(response, {}, 400); return; }
    requests.push({ path: request.url!, body, headers: request.headers });
    if (request.url === '/gateway/ilink/bot/getupdates') {
      pollCount++; const batch = batches.shift();
      if (batch) json(response, batch); else held.push(response);
      return;
    }
    if (request.url === '/gateway/ilink/bot/sendmessage') { json(response, sendBody, sendStatus); return; }
    json(response, {}, 404);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const base = 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/gateway';
  return {
    base, requests, polls: () => pollCount, closed: () => closeCount,
    sends: () => requests.filter(row => row.path.endsWith('/sendmessage')),
    answer: (value: JsonObject) => json(held.shift()!, value),
    sendResult: (value: unknown, status = 200) => { sendBody = value; sendStatus = status; },
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}
export { fixture as createWechatTransportFixture };
function setup(root: string, baseUrl: string): ChannelSettingsStore {
  const store = new ChannelSettingsStore(root);
  store.saveWechatPairing({ token: 'fixture-bot-token', baseUrl, accountId: 'fixture-bot-id' });
  return store;
}
function stoppedPort(status: JsonObject = { running: true, connected: true }): ChannelAdapter {
  const stopped = deferred(); let closed = false;
  return { done: stopped.promise, status: () => closed ? { running: false, connected: false } : status,
    send: async () => ({ ok: false, error: 'fixture send rejected' }), close: async () => { closed = true; stopped.resolve(); } };
}

export function registerChannelRuntimeTests(h: Harness, freshRoot: () => string): void {
  h.test('WeChat inbound message and UIN vectors preserve the current platform vocabulary', async () => {
    assertDeepEqual(wechatInbound(vector.message, 1), vector.inbound, 'wire to host message');
    assertEqual(wechatMessageText(vector.mixedMessage), vector.mixedText, 'existing media placeholders');
    assertEqual(wechatUin(Buffer.from([1, 2, 3, 4])), 'MTY5MDkwNjA=', 'big endian decimal then base64');
  });
  h.test('channel registry exposes real manager operations and never invents an available transport', async () => {
    const root = freshRoot(), f = await fixture([{ ret: 0, msgs: [], get_updates_buf: 'cursor-ready' }]), store = setup(root, f.base), registry = new ChannelRegistry();
    const service = registerChannelHandlers(registry, { configRoot: root, store, factories: { wechat: wechatAdapter() }, runTurn: async () => { throw new Error('unexpected turn'); } });
    try {
      assertDeepEqual(registry.channels(), [...vector.channels].sort(), 'actual three handlers');
      const list = () => registry.lookup('channels:list')!({ role: 'main', senderId: 1, channel: 'channels:list', args: [] });
      const before = await list() as JsonObject[]; assertDeepEqual(before.map(row => row.id), vector.ids, 'full roster'); assertEqual(before.find(row => row.id === 'wechat')!.connected, false, 'enabled config is not a connected socket');
      const result = await registry.lookup('channels:connect')!({ role: 'main', senderId: 1, channel: 'channels:connect', args: [{ id: 'wechat', config: {} }] });
      assertEqual(object(result).ok, true, 'real transport starts');
      await waitFor(() => service.list().find(row => row.id === 'wechat')!.connected === true, 2000, 'actual HTTP update makes connected');
      assertDeepEqual(await service.connect({ id: 'discord', config: { bot_token: 'not-a-real-token' } }), { ok: false, error: 'Discord transport is not available in this build' }, 'missing adapter is a failure');
      assertEqual(kvGet('channel.discord.bot_token', root), null, 'unavailable operation does not persist a fake connection');
      assertEqual(await service.disconnect({ id: 'wechat' }), true, 'disconnect closes actual transport');
      assertEqual(service.list().find(row => row.id === 'wechat')!.connected, false, 'disconnected snapshot'); assertEqual(kvGet('channel.wechat.enabled', root), '0', 'disabled on disk');
      assertEqual(await service.disconnect({ id: 'unknown' }), false, 'unknown channel remains false');
    } finally { await service.close(); await f.close(); }
  });
  h.test('channel registry forwards a cancelled caller before credentials or transports change', async () => {
    const root = freshRoot(), registry = new ChannelRegistry(); let starts = 0;
    const service = registerChannelHandlers(registry, {
      configRoot: root,
      factories: { discord: async () => { starts++; return stoppedPort(); } },
      runTurn: async () => ({ reply: null }),
    });
    const controller = new AbortController(); controller.abort();
    try {
      const result = await registry.lookup('channels:connect')!({
        role: 'main', senderId: 1, channel: 'channels:connect',
        args: [{ id: 'discord', config: { bot_token: 'cancelled-secret' } }], signal: controller.signal,
      });
      assertEqual(object(result).ok, false, 'cancelled call is rejected');
      assert(String(object(result).error).includes('cancelled'), 'cancelled call stays diagnosable');
      assertEqual(starts, 0, 'cancelled call starts no transport');
      assertEqual(kvGet('channel.discord.bot_token', root), null, 'cancelled call stores no credential');
    } finally { await service.close(); }
  });
  h.test('real WeChat polling reaches the host bridge once and sends a correctly authorized contextual reply', async () => {
    const messages = [vector.message, vector.message, { ...vector.message, message_type: 2 }];
    const root = freshRoot(), f = await fixture([{ ret: 0, msgs: messages, get_updates_buf: 'cursor-1' }]), store = setup(root, f.base);
    const turns: string[] = [];
    const service = new ChannelService({ configRoot: root, store, factories: { wechat: wechatAdapter() }, runTurn: async (input, signal) => {
      assertEqual(signal.aborted, false, 'live turn signal'); turns.push(input.text);
      assertEqual(JSON.parse(readFileSync(join(root, 'wechat/sync.json'), 'utf8')).buf, 'cursor-1', 'cursor persisted before batch handling');
      assertDeepEqual(service.contextFor(input.sessionKey), input.channelContext, 'current context exposed only during turn');
      return { reply: 'fixture reply' };
    } });
    try {
      await service.restart('wechat'); await waitFor(() => f.sends().length === 1, 3000, 'actual outbound HTTP');
      assertDeepEqual(turns, ['hello fixture'], 'duplicate and bot echo do not invoke engine twice');
      const send = f.sends()[0]!, msg = object(send.body.msg);
      assertDeepEqual(send.body.base_info, vector.baseInfo, 'vendor version'); assertEqual(send.headers.authorization, 'Bearer fixture-bot-token', 'decrypted credential reaches transport only');
      assertEqual(send.headers.authorizationtype, 'ilink_bot_token', 'auth kind');
      assertEqual(msg.to_user_id, 'fixture-sender', 'reply target'); assertEqual(msg.context_token, 'fixture-context', 'reply echoes incoming context token');
      assertDeepEqual(msg.item_list, [{ type: 1, text_item: { text: 'fixture reply' } }], 'outbound text item'); assertEqual(msg.message_type, 2, 'bot message'); assertEqual(msg.message_state, 2, 'finished message');
      assert(/^klaus-wechat-[0-9a-f-]{36}$/u.test(String(msg.client_id)), 'new outbound id');
      assertEqual(kvGet('channel.wechat.owner_id', root), 'fixture-sender', 'first private sender stored once');
      assertEqual(service.contextFor('wechat:fixture-sender'), undefined, 'context cleared after completion');
      await service.restart('wechat'); await waitFor(() => f.polls() >= 3, 2000, 'replacement poll starts');
      const poll = f.requests.filter(row => row.path.endsWith('/getupdates')).at(-1)!;
      assertEqual(poll.body.get_updates_buf, 'cursor-1', 'same cursor schema resumes');
    } finally { await service.close(); await f.close(); }
  });
  h.test('WeChat same-chat turns serialize and automatic replies keep each original context token', async () => {
    const root = freshRoot(), first = deferred(), f = await fixture([{ msgs: [vector.message, { ...vector.message, message_id: 43, context_token: 'second-context', item_list: [{ type: 1, text_item: { text: 'second fixture' } }] }], get_updates_buf: 'cursor-two' }]), store = setup(root, f.base);
    const turns: string[] = [];
    const service = new ChannelService({ configRoot: root, store, factories: { wechat: wechatAdapter() }, runTurn: async input => { turns.push(input.text); if (turns.length === 1) await first.promise; return { reply: input.text }; } });
    try {
      await service.restart('wechat'); await waitFor(() => turns.length === 1, 2000, 'first turn entered'); assertEqual(turns.length, 1, 'second waits shared chat queue');
      first.resolve(); await waitFor(() => f.sends().length === 2, 3000, 'two real replies');
      const byText = new Map(f.sends().map(row => {
        const message = object(row.body.msg), firstItem = object((message.item_list as JsonObject[])[0]);
        return [String(object(firstItem.text_item).text), message.context_token] as const;
      }));
      assertEqual(byText.get('hello fixture'), 'fixture-context', 'first reply keeps first token'); assertEqual(byText.get('second fixture'), 'second-context', 'second reply keeps second token');
    } finally { first.resolve(); await service.close(); await f.close(); }
  });
  h.test('channel manual send suppression applies only after an actual successful send and current target', async () => {
    const root = freshRoot(), f = await fixture([{ msgs: [vector.message] }]), store = setup(root, f.base);
    const service = new ChannelService({ configRoot: root, store, factories: { wechat: wechatAdapter() }, runTurn: async input => {
      const reply = await service.send('wechat', { targetId: 'fixture-sender', text: 'manual fixture', sessionId: input.sessionKey });
      assertEqual(reply.ok, true, 'actual manual send acknowledged'); return { reply: 'must not auto-send' };
    } });
    try {
      await service.restart('wechat'); await waitFor(() => service.contextFor('wechat:fixture-sender') === undefined && f.sends().length > 0, 3000, 'completed manual turn');
      assertEqual(f.sends().length, 1, 'only the manual message was delivered');
      f.sendResult({ errcode: 9, errmsg: 'fixture declined' });
      assertEqual(await service.deliverToBinding({ channelId: 'wechat', targetId: 'fixture-sender' }, 'cron fixture'), false, 'HTTP 200 vendor failure is not cron success');
      const noContext = await service.send('wechat', { targetId: 'no-context', text: 'fixture' });
      assertEqual(noContext.ok, false, 'missing-token vendor refusal visible'); assert(String(noContext.error).includes('no context_token'), 'actionable context diagnostic');
      const before = f.sends().length;
      assertEqual(object(await service.send('wechat', { targetId: 'x', text: 'fixture', files: [{}] })).ok, false, 'attachments rejected explicitly');
      assertEqual(object(await service.send('wechat', { targetId: 'x', text: 'fixture', action: 'react' })).ok, false, 'unimplemented action rejected explicitly');
      assertEqual(f.sends().length, before, 'unsupported actions send no HTTP');
    } finally { await service.close(); await f.close(); }
  });
  h.test('closing the channel manager aborts real HTTP and running or queued engine callbacks without a late reply', async () => {
    const root = freshRoot(), f = await fixture([{ msgs: [vector.message, { ...vector.message, message_id: 43 }] }]), store = setup(root, f.base);
    let entered = 0, cancelled = false;
    const service = new ChannelService({ configRoot: root, store, factories: { wechat: wechatAdapter() }, runTurn: async (_input, signal) => {
      entered++; await new Promise<void>(resolve => { signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true }); }); return { reply: 'late fixture' };
    } });
    try {
      await service.restart('wechat'); await waitFor(() => entered === 1 && f.polls() >= 2, 2000, 'actual waiting engine and HTTP'); await service.close();
      assertEqual(cancelled, true, 'running turn signal cancelled'); assertEqual(entered, 1, 'queued turn never starts'); assertEqual(f.sends().length, 0, 'no send after shutdown');
      assertEqual(service.contextFor('wechat:fixture-sender'), undefined, 'context cleared on cancellation');
      await waitFor(() => f.closed() >= 2, 2000, 'actual poll connection closed');
      await assertRejects(() => service.restart('wechat'), 'closed manager does not restart');
      const activity = readFileSync(join(root, 'logs/channel-activity.jsonl'), 'utf8');
      assertEqual(await service.deliverToBinding({ channelId: 'wechat', targetId: 'fixture-sender' }, 'after-close'), false, 'closed cron delivery is rejected');
      await assertRejects(() => service.startConfigured(), 'closed startup is rejected before reading config');
      assertEqual(readFileSync(join(root, 'logs/channel-activity.jsonl'), 'utf8'), activity, 'no diagnostic writes after close');
    } finally { await service.close(); await f.close(); }
  });
  h.test('an expired WeChat session stays disconnected and its long retry sleep is cancellable', async () => {
    const root = freshRoot(), f = await fixture([{ errcode: -14 }]), store = setup(root, f.base);
    const service = new ChannelService({ configRoot: root, store, factories: { wechat: wechatAdapter() }, runTurn: async () => { throw new Error('unexpected turn'); } });
    try {
      await service.restart('wechat'); await waitFor(() => object(service.list().find(row => row.id === 'wechat')!.status).tokenStatus === 'expired', 2000, 'expired state');
      assertEqual(service.list().find(row => row.id === 'wechat')!.connected, false, 'expired token never marks connected');
      const before = Date.now(); await service.close(); assert(Date.now() - before < 2000, 'one-hour backoff ends on cancellation');
    } finally { await service.close(); await f.close(); }
  });
  h.test('channel connection requests cannot resurrect a start queued before disconnect or overlap account owners', async () => {
    const root = freshRoot(), starts: string[] = []; let owners = 0, peak = 0;
    const factory: ChannelAdapterFactory = async (account, context) => {
      starts.push(account.bot_token!);
      if (account.bot_token === 'first-fixture') await new Promise<void>(resolve => { context.signal.addEventListener('abort', () => resolve(), { once: true }); });
      if (context.signal.aborted) throw new Error('fixture start cancelled');
      const port = stoppedPort(); owners++; peak = Math.max(peak, owners); let closed = false;
      return { ...port, close: async () => { if (!closed) { closed = true; owners--; } await port.close(); } };
    };
    const service = new ChannelService({ configRoot: root, factories: { discord: factory }, runTurn: async () => ({ reply: null }), backoffMs: [5] });
    try {
      const abandoned = service.connect({ id: 'discord', config: { bot_token: 'queued-fixture' } });
      const stopped = service.disconnect({ id: 'discord' }); await Promise.all([abandoned, stopped]); assertEqual(starts.length, 0, 'queued start was cancelled before resource acquisition');
      const first = service.connect({ id: 'discord', config: { bot_token: 'first-fixture' } }); await waitFor(() => starts.length === 1, 2000, 'first factory awaits cancellation');
      const second = service.connect({ id: 'discord', config: { bot_token: 'second-fixture' } });
      assertEqual(object(await first).ok, false, 'replaced start fails'); assertEqual(object(await second).ok, true, 'new account starts after old teardown'); assertEqual(peak, 1, 'one account resource owner');
      assertEqual(object(await service.connect({ id: 'discord', config: { bot_token: '' } })).ok, false, 'invalid replacement fails');
      assertEqual(owners, 1, 'invalid config does not stop the healthy account');
      const raw = kvGet('channel.discord.bot_token', root); assert(typeof raw === 'string' && raw !== 'second-fixture', 'new channel secrets retain the opaque envelope');
      await service.connect({ id: 'discord', config: { bot_token: raw as string } }); assertEqual(starts.at(-1), 'second-fixture', 'unchanged form envelope is not encrypted twice');
      await service.disconnect({ id: 'discord' }); assertEqual(owners, 0, 'disconnect drains resource'); assertEqual(kvGet('channel.discord.bot_token', root), '', 'required credentials cleared atomically');
    } finally { await service.close(); }
  });
  h.test('channel supervisor reports failure only after the fixed attempt limit and exposes every failed dial', async () => {
    const root = freshRoot(); let starts = 0, notifications = 0;
    const service = new ChannelService({ configRoot: root, factories: { discord: async () => { starts++; throw new Error('fixture dial refused'); } }, runTurn: async () => ({ reply: null }), backoffMs: [1], onFailure: () => { notifications++; } });
    try {
      const result = await service.connect({ id: 'discord', config: { bot_token: 'fixture-token' } }); assertEqual(result.ok, false, 'first failed dial is visible'); assertEqual(result.saved, true, 'configuration was saved');
      await waitFor(() => notifications === 1, 3000, 'supervisor exhausted'); assertEqual(starts, 10, 'bounded retry attempts');
      const row = service.list().find(value => value.id === 'discord')!; assertEqual(row.connected, false, 'failed attempts never connect'); assertEqual(object(row.status).state, 'failed', 'terminal failure snapshot');
      const log = readFileSync(join(root, 'logs/channel-activity.jsonl'), 'utf8'); assertEqual(log.split('\n').filter(line => line.includes('channel_failed')).length, 1, 'one failure breadcrumb');
    } finally { await service.close(); }
  });
  h.test('channel credential update failures preserve the original transaction and readonly failures are explicit', async () => {
    const root = freshRoot(), store = new ChannelSettingsStore(root);
    store.saveConfiguration('discord', { bot_token: 'old-fixture', owner_id: 'old-owner' });
    const before = store.configuration('discord');
    withSettingsDb(root, db => db.exec("CREATE TRIGGER reject_channel BEFORE INSERT ON settings WHEN NEW.key='channel.discord.enabled' BEGIN SELECT RAISE(ABORT, 'fixture denied'); END"));
    await assertRejects(async () => store.saveConfiguration('discord', { bot_token: 'new-fixture', owner_id: 'new-owner' }), 'transaction failure'); assertDeepEqual(store.configuration('discord'), before, 'all original rows preserved');
    const service = new ChannelService({ configRoot: root, store, factories: {}, runTurn: async () => ({ reply: null }) });
    try { store.configuration = () => { throw new Error('fixture read denied'); }; await assertRejects(async () => service.list(), 'list cannot turn denied data into empty authoritative roster'); }
    finally { await service.close(); }
  });
}
