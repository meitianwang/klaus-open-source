import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DiscordAccessService } from '../main/services/channels/discord-access';
import { DiscordApi } from '../main/services/channels/discord-api';
import { discordAdapter, DiscordTransport } from '../main/services/channels/discord';
import { discordChunks, discordInbound, discordTimestamp } from '../main/services/channels/discord-wire';
import { ChannelService, type ChannelTurnInput } from '../main/services/channels/service';
import { ChannelSettingsStore } from '../main/services/channels/settings-store';
import type { JsonObject } from '../main/services/service-types';
import { object } from '../main/services/service-types';
import { createDiscordFixture, type DiscordFixtureOptions } from './discord-fixture';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

const dm = (id: string, content = 'fixture', sender = '1', channel = '100'): JsonObject => ({ id, channel_id: channel, author: { id: sender, username: 'fixture-user' }, content });
async function setup(root: string, options: DiscordFixtureOptions = {}, runTurn: (input: ChannelTurnInput, signal: AbortSignal) => Promise<{ reply?: string | null }> = async () => ({ reply: 'fixture reply' })) {
  const fixture = await createDiscordFixture(options), access = new DiscordAccessService({ configRoot: root }), store = new ChannelSettingsStore(root), turns: ChannelTurnInput[] = [];
  store.saveConfiguration('discord', { bot_token: 'fixture.token' });
  const service = new ChannelService({ configRoot: root, store, factories: { discord: discordAdapter({ access, apiBase: fixture.apiBase, random: () => 0, backoffMs: [20], approvalsIntervalMs: 40, handshakeTimeoutMs: 1000 }) },
    runTurn: async (input, signal) => { turns.push(input); return runTurn(input, signal); }, backoffMs: [20] });
  return { ...fixture, access, service, turns, start: async () => { await service.restart('discord'); await waitFor(() => service.list().find(row => row.id === 'discord')!.connected === true, 3000, 'Discord READY'); },
    close: async () => { await service.close(); await access.close(); await fixture.close(); } };
}

export function registerDiscordChannelTests(h: Harness, freshRoot: () => string): void {
  h.test('Discord wire preserves snowflake time, thread target and bounded UTF-16 chunk content', () => {
    const payload = { ...dm('175928847299117063', '<@900> text'), guild_id: '300', attachments: [{ id: '10', filename: 'a;[b].txt', content_type: 'text/plain', size: 1536 }], message_reference: { message_id: '55' } };
    assertDeepEqual(discordInbound(payload, '900', '200', true), { sessionKey: 'discord:100', targetId: '100', text: 'text\n[Discord attachments on this message: a__b_.txt (text/plain, 2KB)]', messageType: 'mixed', chatType: 'group', senderId: '1', senderName: 'fixture-user', messageId: '175928847299117063', timestamp: 1462015105796, groupId: '200', mentioned: true, replyTo: { messageId: '55' } }, 'committed inbound behavior');
    const text = 'a😀b😀c'; assertEqual(discordChunks(text, 3, 'length').join(''), text, 'emoji is never split or replaced');
    assertDeepEqual(discordChunks('aaaa\n\nbbbb', 6, 'newline'), ['aaaa', 'bbbb'], 'paragraph boundary'); assertEqual(discordTimestamp('bad'), 0, 'invalid snowflake');
  });
  h.test('Discord pairing transport shares atomic UI state, replay limits and approval drop-box ownership', async () => {
    const root = freshRoot(); let now = 100;
    const access = new DiscordAccessService({ configRoot: root, now: () => now });
    try {
      const one = await access.authorizeDirect('1', '100'); assert(one.kind === 'pair' && /^[a-f0-9]{6}$/u.test(one.code), 'new secure lookup code');
      assertDeepEqual(await access.authorizeDirect('1', '100'), { kind: 'pair', code: one.code, isResend: true }, 'single resend');
      assertEqual((await access.authorizeDirect('1', '100')).kind, 'drop', 'third response throttled');
      await Promise.all([access.authorizeDirect('2', '101'), access.authorizeDirect('3', '102')]);
      assertEqual((await access.authorizeDirect('4', '103')).kind, 'drop', 'three pending senders total');
      assertEqual((await access.approvePending({ code: one.code })).ok, true, 'UI approves actual pending code');
      assertEqual((await access.authorizeDirect('1', '100')).kind, 'deliver', 'approval enters transport');
      assertDeepEqual(await access.drainApprovals(), [{ senderId: '1', chatId: '100' }], 'existing disk notification consumed'); assertDeepEqual(await access.drainApprovals(), [], 'single use');
      await access.removeAllowFrom({ senderId: '1' }); await access.setDmPolicy({ dmPolicy: 'disabled' }); assertEqual((await access.authorizeDirect('1', '100')).kind, 'drop', 'no pairing after disable');
      now += 3_600_000; assertDeepEqual((await access.access()).pending, [], 'exact expiry prunes old codes');
      assertEqual(readdirSync(join(root, 'channels/discord/approved')).length, 0, 'drop-box files drained');
    } finally { await access.close(); }
  });
  h.test('real Discord gateway pairs an unknown DM, admits UI approval and sends one engine reply', async () => {
    const f = await setup(freshRoot());
    try {
      await f.start(); const identify = f.frames.find(row => row.value.op === 2)!;
      assertDeepEqual(object(identify.value.d).intents, 37377, 'four product intents');
      assertEqual(object(identify.value.d).token, 'fixture.token', 'token only in identify');
      f.message(dm('1')); await waitFor(() => f.sends().length === 1, 3000, 'pairing response delivered'); assertEqual(f.turns.length, 0, 'unknown sender never reaches engine');
      assertEqual(object(f.service.list().find(row => row.id === 'discord')!.status).pendingPairings, 1, 'channel list shows the actual pending request');
      const pending = (await f.access.access()).pending as JsonObject[]; assertEqual(pending.length, 1, 'UI sees transport pairing');
      await f.access.approvePending({ code: pending[0]!.code! }); await waitFor(() => f.sends().length === 2, 3000, 'approval confirmation');
      f.message(dm('2', 'approved fixture')); await waitFor(() => f.sends().length === 3, 3000, 'engine reply delivered');
      assertEqual(f.turns[0]!.sessionKey, 'discord:100', 'actual DM channel binding'); assertEqual(f.turns[0]!.channelContext.targetId, '100', 'target remains channel not sender');
      assertEqual(f.sends()[2]!.body.content, 'fixture reply', 'completed engine result reaches REST');
      f.message(dm('2', 'duplicate')); await new Promise(resolve => setTimeout(resolve, 70)); assertEqual(f.turns.length, 1, 'replayed dispatch never starts second turn');
    } finally { await f.close(); }
  });
  h.test('Discord thread-parent allowlist and mentions gate actual dispatches while disable blocks all traffic', async () => {
    const f = await setup(freshRoot());
    try {
      await f.access.upsertGroup({ channelId: '200', requireMention: true, allowFrom: ['1'] }); await f.start();
      f.message({ ...dm('10', 'not addressed', '1', '201'), guild_id: '300' });
      f.message({ ...dm('11', '<@900> addressed', '2', '201'), guild_id: '300', mentions: [{ id: '900' }] });
      f.message({ ...dm('12', '<@900> addressed', '1', '201'), guild_id: '300', mentions: [{ id: '900' }] });
      await waitFor(() => f.sends().length === 1, 3000, 'authorized thread reply'); assertEqual(f.turns.length, 1, 'only one policy-admitted message'); assertEqual(f.turns[0]!.sessionKey, 'discord:201', 'thread owns independent conversation');
      await f.access.setDmPolicy({ dmPolicy: 'disabled' }); f.message({ ...dm('13', '<@900> disabled', '1', '201'), guild_id: '300', mentions: [{ id: '900' }] });
      await new Promise(resolve => setTimeout(resolve, 70)); assertEqual(f.turns.length, 1, 'Discord disable also blocks configured group');
      assertEqual((await f.service.send('discord', { targetId: '201', text: 'disabled' })).ok, false, 'outbound rechecks disable');
    } finally { await f.close(); }
  });
  h.test('Discord resume uses READY URL and last sequence, and invalid sessions re-identify', async () => {
    const f = await setup(freshRoot());
    try {
      await f.start(); f.event({ op: 0, t: 'IGNORED', s: 99, d: {} }); f.event({ op: 7, d: null });
      await waitFor(() => f.frames.some(row => row.connection === 1 && row.value.op === 6), 3000, 'real resumed socket');
      const resume = f.frames.find(row => row.connection === 1 && row.value.op === 6)!; assertEqual(object(resume.value.d).seq, 99, 'latest sequence resumed'); assertEqual(object(resume.value.d).session_id, 'fixture-session', 'same gateway session');
      assertEqual(f.gatewayPaths[1], '/resume?v=10&encoding=json', 'READY resume URL with pinned wire encoding');
      f.event({ op: 9, d: false }); await waitFor(() => f.frames.some(row => row.connection === 2 && row.value.op === 2), 3000, 'fresh identify after invalidation');
      assert(f.closedSockets() >= 2, 'replaced sockets actually closed');
    } finally { await f.close(); }
  });
  h.test('Discord heartbeats remain responsive during a blocked engine turn and shutdown cancels it', async () => {
    let entered = false, aborted = false;
    const f = await setup(freshRoot(), { heartbeatMs: 100 }, async (_input, signal) => {
      entered = true; await new Promise<void>(resolve => signal.addEventListener('abort', () => { aborted = true; resolve(); }, { once: true })); return { reply: 'late' };
    });
    try {
      await f.access.addAllowFrom({ senderId: '1' }); await f.start(); f.message(dm('20'));
      await waitFor(() => entered && f.frames.filter(row => row.value.op === 1).length >= 4, 3000, 'heartbeats while turn waits');
      assertEqual(f.sockets.length, 1, 'healthy ACKs avoid reconnect'); await f.service.close();
      assert(aborted, 'accepted engine callback cancelled'); assertEqual(f.sends().length, 0, 'no late reply');
      await waitFor(() => f.closedSockets() === 1, 3000, 'actual gateway socket closed'); assertEqual(f.service.contextFor('discord:100'), undefined, 'host context drained');
    } finally { await f.close(); }
  });
  h.test('Discord missing heartbeat ACK triggers a real reconnect and HELLO absence never marks connected', async () => {
    const f = await setup(freshRoot(), { heartbeatMs: 30, acknowledge: false });
    try { await f.start(); await waitFor(() => f.sockets.length >= 2, 3000, 'zombie socket replaced'); assert(f.closedSockets() >= 1, 'old zombie closed'); }
    finally { await f.close(); }
    const root = freshRoot(), silent = await createDiscordFixture({ hello: false }), access = new DiscordAccessService({ configRoot: root }), controller = new AbortController();
    const port = await DiscordTransport.start({ bot_token: 'fixture.token' }, { configRoot: root, signal: controller.signal, inbound: async () => ({}) }, { access, apiBase: silent.apiBase, handshakeTimeoutMs: 40, backoffMs: [1000] });
    try { await waitFor(() => silent.closedSockets() === 1, 3000, 'silent handshake socket closed'); assertEqual(port.status().connected, false, 'no fake READY'); }
    finally { await port.close(); await access.close(); await silent.close(); }
  });
  h.test('Discord fatal gateway termination drains its resources before the supervisor replaces the account', async () => {
    const f = await setup(freshRoot());
    try {
      await f.start(); f.sockets[0]!.close(4014, 'fixture missing privileged intent');
      await waitFor(() => f.sockets.length === 2 && f.service.list().find(row => row.id === 'discord')!.connected === true, 3000, 'supervisor starts replacement after fatal owner ends');
      assertEqual(f.closedSockets(), 1, 'failed socket fully closed before replacement ready');
      assertEqual(f.frames.filter(row => row.value.op === 2).length, 2, 'new transport uses fresh identity');
    } finally { await f.close(); }
  });
  h.test('Discord dispatch flood rejects bounded channel work without blocking heartbeats or shutdown', async () => {
    let entered = 0;
    const f = await setup(freshRoot(), { heartbeatMs: 100 }, async (_input, signal) => { entered++; await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true })); return {}; });
    try {
      await f.access.addAllowFrom({ senderId: '1' }); await f.start();
      for (let index = 1; index <= 100; index++) f.message(dm(String(index)));
      await waitFor(() => String(object(f.service.list().find(row => row.id === 'discord')!.status).lastError).includes('capacity') && entered === 1, 3000, 'adapter queue refuses flood');
      await f.service.close(); assertEqual(entered, 1, 'queued work never enters engine after cancellation'); assertEqual(f.sends().length, 0, 'no response for dropped or cancelled work');
    } finally { await f.close(); }
  });
  h.test('Discord fragment flood is bounded independently of payload byte count', async () => {
    const root = freshRoot(), f = await createDiscordFixture(), access = new DiscordAccessService({ configRoot: root }), controller = new AbortController();
    const port = await DiscordTransport.start({ bot_token: 'fixture.token' }, { configRoot: root, signal: controller.signal, inbound: async () => ({}) }, { access, apiBase: f.apiBase, backoffMs: [1000] });
    try {
      await waitFor(() => port.status().connected === true, 3000, 'ready socket');
      for (let index = 0; index < 1030; index++) f.sockets[0]!.send('', { fin: false });
      await waitFor(() => f.closedSockets() === 1, 3000, 'fragment limit terminated actual socket');
      // The status flip is one async hop behind the server-side close
      // observation; bound it instead of asserting with zero slack.
      await waitFor(() => port.status().connected === false, 3000, 'flood never leaves connected status');
    } finally { await port.close(); await access.close(); await f.close(); }
  });
  h.test('Discord actions send real multipart, reactions, edits, history and private attachment downloads', async () => {
    const root = freshRoot(), f = await setup(root); const file = join(root, 'report.txt'); writeFileSync(file, 'report fixture bytes');
    try {
      await f.access.addAllowFrom({ senderId: '1' }); await f.start();
      const sent = await f.service.send('discord', { action: 'sendMessage', targetId: '100', text: 'attached fixture', files: [file] }); assertEqual(sent.ok, true, 'multipart sent');
      assert(f.sends()[0]!.raw.includes('report fixture bytes') && f.sends()[0]!.raw.includes('payload_json'), 'real file bytes and payload fields');
      assertEqual((await f.service.send('discord', { action: 'react', targetId: '100', messageId: '25', emoji: '👍' })).ok, true, 'reaction receipt');
      assert(f.requests.some(row => row.path.includes('%F0%9F%91%8D')), 'emoji encoded as path component');
      assertEqual((await f.service.send('discord', { action: 'editMessage', targetId: '100', messageId: '25', text: 'edited fixture' })).ok, true, 'edit receipt');
      f.messages.set('26', { id: '26', author: { id: '1', username: 'fixture-user' }, content: 'newer' }); f.messages.set('25', { id: '25', author: { id: '900', username: 'fixture-bot' }, content: 'older' });
      const history = await f.service.send('discord', { action: 'fetchMessages', targetId: '100', limit: 2, beforeMessageId: '27' }); assertEqual(history.ok, true, 'actual history'); assertDeepEqual((history.messages as JsonObject[]).map(row => row.id), ['25', '26'], 'chronological projection');
      f.messages.set('27', { id: '27', attachments: [{ id: '70', filename: 'fixture.txt', size: 24, url: f.origin + '/asset' }] });
      const download = await f.service.send('discord', { action: 'downloadAttachment', targetId: '100', messageId: '27' }); assertEqual(download.ok, true, 'real attachment fetched');
      assertEqual(readFileSync(String(download.path), 'utf8'), 'fixture attachment bytes', 'download bytes');
      if (process.platform !== 'win32') assertEqual(statSync(String(download.path)).mode & 0o777, 0o600, 'private inbox file');
      assertEqual(f.requests.find(row => row.path === '/asset')!.authorization, undefined, 'CDN download never receives bot token');
      await f.access.removeAllowFrom({ senderId: '1' }); assertEqual((await f.service.send('discord', { targetId: '100', text: 'revoked' })).ok, false, 'revoke denies next action');
    } finally { await f.close(); }
  });
  h.test('Discord actions reject sensitive files and malformed receipts and retain actual partial send IDs', async () => {
    const root = freshRoot(); let sends = 0;
    const f = await setup(root, { respond: (method, path) => {
      if (method === 'POST' && path.endsWith('/messages')) return ++sends === 1 ? { body: { id: '600' } } : { status: 403, body: { message: 'fixture forbidden' } };
      return;
    } });
    try {
      await f.access.addAllowFrom({ senderId: '1' }); await f.access.updateDelivery({ textChunkLimit: 3 }); await f.start();
      const secret = join(root, '.env'); writeFileSync(secret, 'synthetic fixture'); const alias = join(root, 'alias.txt'); symlinkSync(secret, alias);
      for (const path of [secret, alias, join(root, 'channels/discord/access.json')]) assertEqual((await f.service.send('discord', { action: 'sendMessage', targetId: '100', files: [path] })).ok, false, 'sensitive path refused');
      assertEqual(sends, 0, 'no HTTP file disclosure');
      const partial = await f.service.send('discord', { targetId: '100', text: 'abcdef' }); assertEqual(partial.ok, false, 'second chunk fails'); assertDeepEqual(partial.messageIds, ['600'], 'first real receipt retained');
      assertEqual((await f.service.send('discord', { action: 'bogus', targetId: '100' })).ok, false, 'unsupported action is explicit');
    } finally { await f.close(); }
    const bad = await setup(freshRoot(), { respond: (method, path) => method === 'POST' && path.endsWith('/messages') ? { body: {} } : undefined });
    try { await bad.access.addAllowFrom({ senderId: '1' }); await bad.start(); assertEqual((await bad.service.send('discord', { targetId: '100', text: 'fixture' })).ok, false, 'empty receipt never succeeds'); }
    finally { await bad.close(); }
  });
  h.test('Discord rate-limit retries use the actual delay and shutdown aborts an in-flight REST connection', async () => {
    const root = freshRoot(); let attempts = 0;
    const f = await createDiscordFixture({ respond: (_method, path) => path === '/api/v10/users/@me' && attempts++ === 0 ? { status: 429, body: { retry_after: .04, global: true } } : undefined });
    const controller = new AbortController(), api = new DiscordApi('fixture.token', root, controller.signal, { apiBase: f.apiBase });
    try { await api.call('GET', '/users/@me'); const calls = f.requests.filter(row => row.path.endsWith('/users/@me')); assertEqual(calls.length, 2, 'one actual retry'); assert(calls[1]!.at - calls[0]!.at >= 35, 'Retry-After respected'); }
    finally { controller.abort(); await f.close(); }
    const held = await setup(freshRoot(), { respond: (method, path) => method === 'POST' && path.endsWith('/messages') ? { hold: true } : undefined });
    try {
      await held.access.addAllowFrom({ senderId: '1' }); await held.start(); const send = held.service.send('discord', { targetId: '100', text: 'pending' });
      await waitFor(() => held.held.length > 0, 3000, 'actual REST body awaits server'); await held.service.close();
      assertEqual((await send).ok, false, 'accepted action cancelled'); await waitFor(() => held.closedHttp() === 1, 3000, 'actual HTTP connection closed');
    } finally { await held.close(); }
  });
  h.test('Discord invalid bot identity and failed authorization cannot produce a connected transport', async () => {
    for (const response of [{ status: 401, body: { message: 'fixture.token unauthorized' } }, { body: { id: '900', bot: false } }]) {
      const root = freshRoot(), f = await createDiscordFixture({ respond: (_method, path) => path.endsWith('/users/@me') ? response : undefined }), access = new DiscordAccessService({ configRoot: root });
      try {
        let message = ''; try { await DiscordTransport.start({ bot_token: 'fixture.token' }, { configRoot: root, signal: new AbortController().signal, inbound: async () => ({}) }, { access, apiBase: f.apiBase }); }
        catch (error) { message = String(error); }
        assert(message.length > 0 && !message.includes('fixture.token'), 'invalid identity rejected without token in diagnostics'); assertEqual(f.sockets.length, 0, 'no gateway acquired');
      } finally { await access.close(); await f.close(); }
    }
  });
  h.test('Discord close drains already accepted access writes without creating a second credential file', async () => {
    const root = freshRoot(), access = new DiscordAccessService({ configRoot: root });
    const work = access.authorizeDirect('1', '100'); const closing = access.close(); await work; await closing;
    await assertRejects(() => access.authorizeDirect('2', '101'), 'closed access owner refuses new writes');
    assert(existsSync(join(root, 'channels/discord/access.json')), 'existing policy format retained'); assert(!existsSync(join(root, 'discord-token.json')), 'transport introduces no credential copy');
  });
}
