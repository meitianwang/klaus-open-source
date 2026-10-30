import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { permitsChannelMessage } from '../main/services/channels/access-policy';
import { RecentChannelMessages } from '../main/services/channels/recent-messages';
import { ChannelService, type ChannelServiceDeps } from '../main/services/channels/service';
import { ChannelSettingsStore } from '../main/services/channels/settings-store';
import type { ChannelAdapterContext, ChannelId, ChannelInbound } from '../main/services/channels/types';
import { WechatPairingService } from '../main/services/channels/wechat-pairing';
import { wechatAdapter } from '../main/services/channels/wechat';
import { kvGet } from '../main/services/settings';
import { object, type JsonObject } from '../main/services/service-types';
import { createWechatTransportFixture } from './channel-runtime';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const inbound = (id: ChannelId, key: string, messageId = key): ChannelInbound => ({ sessionKey: id + ':' + key, senderId: 'sender', text: 'fixture', chatType: 'direct', messageId });
async function manager(root: string, options: Partial<Omit<ChannelServiceDeps, 'configRoot' | 'factories'>> = {}, id: ChannelId = 'telegram') {
  let context!: ChannelAdapterContext;
  const stopped = deferred(), store = new ChannelSettingsStore(root);
  store.saveConfiguration(id, id === 'feishu' ? { app_id: 'fixture', app_secret: 'fixture' } : { bot_token: 'fixture' });
  const service = new ChannelService({ configRoot: root, store, runTurn: async () => ({ reply: null }), ...options,
    factories: { [id]: async (_account: Record<string, string>, value: ChannelAdapterContext) => { context = value; return { done: stopped.promise, status: () => ({ running: true, connected: true }), send: async () => ({ ok: false }), close: async () => { stopped.resolve(); } }; } } });
  await service.restart(id);
  return { service, context, emit: (message: ChannelInbound) => context.inbound(message, context.signal) };
}

export function registerChannelManagerBoundaryTests(h: Harness, freshRoot: () => string): void {
  h.test('channel access distinguishes Discord adapter disable from other platforms DM policy', () => {
    const direct = inbound('telegram', 'fixture'), group: ChannelInbound = { ...direct, chatType: 'group', groupId: 'room', mentioned: true };
    const access: JsonObject = { dmPolicy: 'disabled', allowFrom: ['sender'], groups: { room: {} } };
    assertEqual(permitsChannelMessage('discord', access, direct), false, 'Discord disabled DM');
    assertEqual(permitsChannelMessage('discord', access, group), false, 'Discord disabled group contract');
    assertEqual(permitsChannelMessage('feishu', access, direct), false, 'other DM disabled');
    assertEqual(permitsChannelMessage('feishu', access, group), true, 'registered group independent of DM disable');
    access.dmPolicy = 'open'; access.allowFrom = [];
    assertEqual(permitsChannelMessage('telegram', access, direct), true, 'explicit open DM');
    assertEqual(permitsChannelMessage('discord', access, direct), false, 'unsupported Discord policy does not open access');
    access.dmPolicy = 'pairing';
    assertEqual(permitsChannelMessage('telegram', access, direct), false, 'unknown pairing sender never reaches engine');
    assertEqual(permitsChannelMessage('telegram', access, { ...group, mentioned: false }), false, 'empty registered group defaults to mention');
    access.groups = { room: { requireMention: false, allowFrom: 'invalid' } };
    assertEqual(permitsChannelMessage('telegram', access, group), false, 'malformed group allowlist is not an open door');
  });
  h.test('manager re-reads actual access files and fails closed on corrupt or denied data', async () => {
    const root = freshRoot(); let calls = 0;
    const f = await manager(root, { runTurn: async () => { calls++; return {}; } }, 'feishu');
    const path = join(root, 'channels/feishu/access.json'); mkdirSync(join(root, 'channels/feishu'), { recursive: true });
    try {
      writeFileSync(path, JSON.stringify({ dmPolicy: 'open', allowFrom: [], groups: { room: {} } }));
      await f.emit(inbound('feishu', 'one')); assertEqual(calls, 1, 'open reaches actual turn callback');
      writeFileSync(path, JSON.stringify({ dmPolicy: 'disabled', groups: { room: {} } }));
      assertEqual((await f.emit(inbound('feishu', 'two'))).reason, 'access_policy', 'disabled DM drops');
      await f.emit({ ...inbound('feishu', 'three'), chatType: 'group', groupId: 'room', mentioned: true }); assertEqual(calls, 2, 'registered group still reaches engine');
      writeFileSync(path, '{broken'); assertEqual((await f.emit(inbound('feishu', 'four'))).dropped, true, 'invalid JSON rejected');
      unlinkSync(path); mkdirSync(path); assertEqual((await f.emit(inbound('feishu', 'five'))).dropped, true, 'unreadable document never falls back to no policy');
      assertEqual(calls, 2, 'corrupt file never starts a turn');
      const blocked = readFileSync(join(root, 'logs/channel-activity.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => object(JSON.parse(line))).filter(entry => entry.kind === 'blocked');
      assertEqual(blocked.length, 3, 'every denied message leaves a blocked record');
      assertEqual(blocked.map(entry => entry.reason).join(','), 'access_policy,access_unreadable,access_unreadable', 'blocked reason separates policy denial from unreadable access file');
      assert(blocked.every(entry => !('preview' in entry)), 'blocked records carry no message content');
    } finally { await f.service.close(); }
  });
  h.test('deduplication stays bounded during a same-window flood and expires at the exact TTL', () => {
    const cache = new RecentChannelMessages();
    for (let index = 0; index < 25_000; index++) cache.add('message-' + index, 100);
    assertEqual(cache.size, 10_000, 'fixed memory bound even without expiry');
    assertEqual(cache.has('message-0', 101), false, 'oldest keys evicted'); assertEqual(cache.has('message-24999', 101), true, 'newest replay rejected');
    assertEqual(cache.has('message-24999', 60_100), false, 'TTL boundary expires');
    cache.add('fresh', 60_100); assertEqual(cache.size, 1, 'expired flood reclaimed');
    cache.clear(); assertEqual(cache.size, 0, 'shutdown releases retained keys');
  });
  h.test('per-session turn admission rejects capacity without poisoning retry deduplication and keeps FIFO', async () => {
    const root = freshRoot(), held = deferred(), calls: string[] = [];
    const f = await manager(root, { inboundLimits: { turnsPerSession: 2 }, runTurn: async input => { calls.push(input.text); if (calls.length === 1) await held.promise; return {}; } });
    try {
      const first = f.emit({ ...inbound('telegram', 'room', '1'), text: 'first' });
      await waitFor(() => calls.length === 1, 2000, 'first turn active');
      const second = f.emit({ ...inbound('telegram', 'room', '2'), text: 'second' });
      const retry = { ...inbound('telegram', 'room', '3'), text: 'third' };
      await assertRejects(() => f.emit(retry), 'full session queue rejects');
      assertEqual(calls.length, 1, 'queued work has not entered engine');
      held.resolve(); await Promise.all([first, second]); await f.emit(retry);
      assertDeepEqual(calls, ['first', 'second', 'third'], 'retry runs after capacity is released');
      assertEqual(f.service.contextFor('telegram:room'), undefined, 'completed context is released');
    } finally { held.resolve(); await f.service.close(); }
  });
  h.test('global pending and distinct-session limits bound contexts and release all accepted work on close', async () => {
    for (const limits of [{ pendingTurns: 2, sessions: 10 }, { pendingTurns: 10, sessions: 2 }]) {
      let calls = 0, cancelled = 0;
      const f = await manager(freshRoot(), { inboundLimits: limits, runTurn: async (_input, signal) => {
        calls++; await new Promise<void>(resolve => { signal.addEventListener('abort', () => { cancelled++; resolve(); }, { once: true }); }); return { reply: 'late' };
      } });
      const first = f.emit(inbound('telegram', 'first')).catch(() => undefined), second = f.emit(inbound('telegram', 'second')).catch(() => undefined);
      try {
        await waitFor(() => calls === 2, 2000, 'two accepted sessions');
        await assertRejects(() => f.emit(inbound('telegram', 'third')), 'global admission bound');
        assertEqual(f.service.contextFor('telegram:third'), undefined, 'rejected work has no context');
        await f.service.close(); await Promise.all([first, second]);
        assertEqual(cancelled, 2, 'all admitted turns cancelled');
        assertEqual(f.service.contextFor('telegram:first'), undefined, 'first context released');
        assertEqual(f.service.contextFor('telegram:second'), undefined, 'second context released');
      } finally { await f.service.close(); }
    }
  });
  h.test('deduplication keys cannot suppress a different platform with the same adapter-provided key', async () => {
    const root = freshRoot(), contexts = new Map<string, ChannelAdapterContext>(), store = new ChannelSettingsStore(root); let calls = 0;
    for (const id of ['discord', 'telegram']) store.saveConfiguration(id, { bot_token: 'fixture' });
    const factory = (id: string) => async (_account: Record<string, string>, context: ChannelAdapterContext) => {
      contexts.set(id, context); const stopped = deferred();
      return { done: stopped.promise, status: () => ({ running: true, connected: true }), send: async () => ({ ok: false }), close: async () => { stopped.resolve(); } };
    };
    const service = new ChannelService({ configRoot: root, store, factories: { telegram: factory('telegram'), discord: factory('discord') }, runTurn: async () => { calls++; return {}; } });
    try {
      await service.restart('telegram'); await service.restart('discord');
      const telegram = contexts.get('telegram')!, discord = contexts.get('discord')!;
      await telegram.inbound({ ...inbound('telegram', 'one'), dedupKey: 'shared' }, telegram.signal);
      assertEqual((await telegram.inbound({ ...inbound('telegram', 'two'), dedupKey: 'shared' }, telegram.signal)).reason, 'duplicate', 'adapter-wide key is a replay');
      await discord.inbound({ ...inbound('discord', 'one'), dedupKey: 'shared' }, discord.signal);
      assertEqual(calls, 2, 'independent platform accepts the same local key');
    } finally { await service.close(); }
  });
  h.test('real WeChat polling reports queue overflow and stops accepted turns without late replies', async () => {
    const root = freshRoot(), messages = Array.from({ length: 5 }, (_, index) => ({ from_user_id: 'fixture-sender', message_id: index + 1, context_token: 'fixture-context', item_list: [{ type: 1, text_item: { text: 'fixture' } }] }));
    const transport = await createWechatTransportFixture([{ msgs: messages }]), store = new ChannelSettingsStore(root);
    store.saveWechatPairing({ token: 'fixture-token', baseUrl: transport.base, accountId: 'fixture-bot' });
    let calls = 0;
    const service = new ChannelService({ configRoot: root, store, factories: { wechat: wechatAdapter() }, inboundLimits: { turnsPerSession: 2 }, runTurn: async (_input, signal) => {
      calls++; await new Promise<void>(resolve => { signal.addEventListener('abort', () => resolve(), { once: true }); }); return { reply: 'late' };
    } });
    try {
      await service.restart('wechat');
      await waitFor(() => String(object(service.list().find(row => row.id === 'wechat')!.status).lastError).includes('capacity'), 2000, 'real transport surfaces capacity refusal');
      await waitFor(() => calls > 0, 2000, 'accepted turn entered the serialized engine gate');
      assertEqual(calls, 1, 'one running turn for shared session'); await service.close();
      assertEqual(calls, 1, 'queued turn never runs after close'); assertEqual(transport.sends().length, 0, 'no late HTTP reply');
    } finally { await service.close(); await transport.close(); }
  });
  h.test('disconnect cancels a real pending WeChat QR poll before clearing the account', async () => {
    const root = freshRoot(); let held: ServerResponse | undefined, closed = 0, starts = 0;
    const server = createServer((request, response) => {
      if (request.url?.includes('get_bot_qrcode')) { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ qrcode: 'fixture', qrcode_img_content: 'fixture' })); }
      else { held = response; response.once('close', () => { closed++; }); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const store = new ChannelSettingsStore(root); store.saveConfiguration('wechat', { base_url: 'http://127.0.0.1:' + (server.address() as AddressInfo).port });
    const qr = new WechatPairingService({ configRoot: root, store, encodeQr: async () => 'data:image/png;base64,fixture', onPaired: async () => { starts++; } });
    const service = new ChannelService({ configRoot: root, store, factories: {}, runTurn: async () => ({}), beforeDisconnect: id => { if (id === 'wechat') qr.cancel(); } });
    try {
      assertEqual((await qr.start()).ok, true, 'real QR start'); const poll = qr.poll();
      await waitFor(() => held !== undefined, 2000, 'real long poll pending');
      assertEqual(await service.disconnect({ id: 'wechat' }), true, 'disconnect complete');
      assertEqual((await poll).ok, false, 'pending flow reports cancellation'); await waitFor(() => closed === 1, 2000, 'QR socket closed');
      assertEqual(kvGet('channel.wechat.enabled', root), '0', 'disabled persisted'); assertEqual(starts, 0, 'late grant never starts adapter');
    } finally { await service.close(); await qr.close(); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
  });
  h.test('disconnect awaits asynchronous cancellation failure and service close drains the callback', async () => {
    const held = deferred(), root = freshRoot(); let entered = false;
    const service = new ChannelService({ configRoot: root, factories: {}, runTurn: async () => ({}), beforeDisconnect: async () => { entered = true; await held.promise; throw new Error('fixture QR cancellation refused'); } });
    const stopped = service.disconnect({ id: 'wechat' }); const failed = assertRejects(() => stopped, 'failed prerequisite is visible');
    assert(entered, 'cancellation runs before waiting for mutation queue');
    let closed = false; const closing = service.close().then(() => { closed = true; });
    await new Promise(resolve => setImmediate(resolve)); assertEqual(closed, false, 'close waits accepted cancellation');
    held.resolve(); await Promise.all([failed, closing]); assertEqual(kvGet('channel.wechat.enabled', root), null, 'failed prerequisite did not report successful disable');
  });
}
