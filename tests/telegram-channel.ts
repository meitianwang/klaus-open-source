import { readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { ChannelService } from '../main/services/channels/service';
import { TelegramTransport, telegramAdapter } from '../main/services/channels/telegram';
import { telegramChatId, telegramChunks, telegramInbound, telegramSendOptions, telegramText } from '../main/services/channels/telegram-wire';
import { object, type JsonObject } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects, waitFor } from './harness';

const token = 'fixture:telegram';
interface Reply { body?: unknown; status?: number; raw?: string; hold?: boolean }
export async function createTelegramTransportFixture() {
  const requests: Array<{ method: string; body: JsonObject; raw: string; contentType: string; at: number }> = [];
  const replies = new Map<string, Reply[]>(), held: Array<{ method: string; response: ServerResponse }> = [];
  let messageId = 400, aborted = 0;
  const json = (response: ServerResponse, value: unknown, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  const server = createServer(async (request, response) => {
    response.once('close', () => { if (!response.writableFinished) aborted++; });
    const path = request.url || '';
    if (path.startsWith('/api/file/bot' + token + '/')) { response.writeHead(200); response.end(Buffer.from('fixture attachment bytes')); return; }
    if (!path.startsWith('/api/bot' + token + '/')) { json(response, {}, 404); return; }
    const method = path.slice(('/api/bot' + token + '/').length);
    let raw = ''; for await (const chunk of request) raw += String(chunk);
    let body: JsonObject = {}; try { body = object(JSON.parse(raw)); } catch { /* Multipart has its own assertions. */ }
    requests.push({ method, body, raw, contentType: String(request.headers['content-type'] || ''), at: Date.now() });
    const reply = replies.get(method)?.shift();
    if (reply?.hold || (!reply && method === 'getUpdates')) { held.push({ method, response }); return; }
    if (reply?.raw !== undefined) { response.writeHead(reply.status ?? 200); response.end(reply.raw); return; }
    if (reply) { json(response, reply.body, reply.status); return; }
    const result = method === 'getMe' ? { id: 900, username: 'FixtureBot', first_name: 'Fixture' }
      : method === 'deleteWebhook' || method === 'setMessageReaction' ? true
      : method === 'getFile' ? { file_path: 'documents/fixture.txt', file_unique_id: 'fixture-unique', file_size: 24 }
      : { message_id: ++messageId };
    json(response, { ok: true, result });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { apiBase: 'http://127.0.0.1:' + (server.address() as AddressInfo).port + '/api', requests,
    queue(method: string, ...next: Reply[]) { const pending = replies.get(method) ?? []; pending.push(...next); replies.set(method, pending); },
    updates(value: JsonObject[]) { const pending = held.findIndex(row => row.method === 'getUpdates' && !row.response.destroyed); assert(pending >= 0, 'actual long poll awaits updates'); const row = held.splice(pending, 1)[0]!; json(row.response, { ok: true, result: value }); },
    aborted: () => aborted,
    count: (method: string) => requests.filter(row => row.method === method).length,
    close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
  };
}
const direct = (id: number, text = 'fixture message'): JsonObject => ({ update_id: id, message: { message_id: id, chat: { id: 55, type: 'private' }, from: { id: 55, first_name: 'Fixture User' }, text } });
const topic = (id: number): JsonObject => ({ update_id: id, message: { message_id: id, chat: { id: -1002, type: 'supergroup', is_forum: true }, from: { id: 8, first_name: 'Cy' }, message_thread_id: 9, text: '@FixtureBot review' } });
async function polling(fixture: Awaited<ReturnType<typeof createTelegramTransportFixture>>, count = 1) { await waitFor(() => fixture.count('getUpdates') >= count, 8000, 'actual Telegram poll'); }

export function registerTelegramChannelTests(h: Harness, freshRoot: () => string): void {
  h.test('Telegram committed wire vector preserves DM/topic identity, mention filtering, captions and UTF-16 chunks', () => {
    const vector = JSON.parse(readFileSync(join(__dirname, '../../tests/vectors/telegram-channel.json'), 'utf8')) as { inbound: JsonObject; expected: JsonObject };
    assertDeepEqual(telegramInbound(vector.inbound, 'FixtureBot', '900', 1700000000123), vector.expected, 'inbound contract');
    assertDeepEqual(telegramText({ caption: 'caption wins', photo: [{}] }), { text: 'caption wins', messageType: 'text' }, 'caption precedes media placeholders');
    assertEqual(telegramInbound(object(topic(7).message), 'OtherBot', '900', 1), undefined, 'unmentioned group ignored');
    assertEqual(telegramInbound({ ...object(direct(1).message), from: { id: 900 } }, 'FixtureBot', '900', 1), undefined, 'own echo ignored');
    assertDeepEqual(['-1002', ' 42 ', '007', '@channelname'].map(telegramChatId), [-1002, 42, '007', '@channelname'], 'canonical chat ids');
    assertDeepEqual(telegramSendOptions('42', '9', 'markdownv2'), { reply_parameters: { message_id: 42 }, message_thread_id: 9, parse_mode: 'MarkdownV2' }, 'reply and topic options');
    assertDeepEqual(telegramChunks('a'.repeat(50) + '\n\n' + 'b'.repeat(60), 100), ['a'.repeat(50), 'b'.repeat(60)], 'blank line split');
    const unicode = telegramChunks('x' + '😀'.repeat(2100)); assertEqual(unicode.join(''), 'x' + '😀'.repeat(2100), 'emoji never split or replaced'); assert(unicode.every(part => part.length <= 4096), 'UTF-16 API limit');
  });
  h.test('Telegram real getMe/webhook/poll and topic replies reach the one injected engine owner', async () => {
    const f = await createTelegramTransportFixture(), root = freshRoot(), turns: JsonObject[] = [];
    const service = new ChannelService({ configRoot: root, factories: { telegram: telegramAdapter({ apiBase: f.apiBase }) }, runTurn: async input => { turns.push(input.channelContext); return { reply: input.text }; } });
    try {
      assertEqual(object(await service.connect({ id: 'telegram', config: { bot_token: token } })).ok, true, 'validated account starts'); await polling(f);
      assertDeepEqual(f.requests.slice(0, 3).map(row => [row.method, row.body]), [['getMe', {}], ['deleteWebhook', { drop_pending_updates: true }], ['getUpdates', { timeout: 30, allowed_updates: ['message'] }]], 'real wire handshake');
      f.updates([direct(1), topic(7), topic(7), { ...topic(8), message: { ...object(topic(8).message), text: 'no mention' } }, { ...direct(9), message: { ...object(direct(9).message), from: { id: 900 } } }]);
      await waitFor(() => f.count('sendMessage') === 2, 8000, 'two actual automatic replies'); await polling(f, 2);
      const sent = f.requests.filter(row => row.method === 'sendMessage').map(row => row.body);
      assert(sent.some(row => row.chat_id === 55 && object(row.reply_parameters).message_id === 1), 'DM reply targets original numeric chat');
      assert(sent.some(row => row.chat_id === -1002 && row.message_thread_id === 9 && row.text === 'review'), 'topic reply keeps thread and removes mention');
      assertEqual(f.requests.filter(row => row.method === 'getUpdates').at(-1)!.body.offset, 10, 'offset advances past filtered updates too');
      assertEqual(turns.length, 2, 'duplicate and bot/group filters happen before engine'); assertEqual(turns.find(row => row.targetId === '-1002')!.threadId, '9', 'host context preserves topic');
      assertEqual(service.list().find(row => row.id === 'telegram')!.connected, true, 'real validation marks connected');
    } finally { await service.close(); await f.close(); }
  });
  h.test('Telegram manual delivery suppression cannot swallow a reply to a different forum topic', async () => {
    const f = await createTelegramTransportFixture(), root = freshRoot(); let turn = 0;
    const service = new ChannelService({ configRoot: root, factories: { telegram: telegramAdapter({ apiBase: f.apiBase }) }, runTurn: async input => {
      const result = await service.send('telegram', { targetId: '-1002', text: 'manual', threadId: ++turn === 1 ? '99' : '9', sessionId: input.sessionKey }); assertEqual(result.ok, true, 'actual manual send'); return { reply: 'automatic' };
    } });
    try {
      await service.connect({ id: 'telegram', config: { bot_token: token } }); await polling(f); f.updates([topic(1)]);
      await waitFor(() => f.count('sendMessage') === 2, 8000, 'wrong-topic manual send plus correct automatic reply'); await polling(f, 2); f.updates([topic(2)]);
      await waitFor(() => turn === 2 && service.contextFor('telegram:-1002:topic:9') === undefined, 8000, 'same-topic manual completion');
      assertEqual(f.count('sendMessage'), 3, 'only same-topic delivery suppresses the automatic reply');
    } finally { await service.close(); await f.close(); }
  });
  h.test('Telegram real action receipts include multipart uploads, unchanged Markdown, reactions, edits and private downloads', async () => {
    const f = await createTelegramTransportFixture(), root = freshRoot(), control = new AbortController();
    const port = await TelegramTransport.start({ bot_token: token }, { configRoot: root, signal: control.signal, inbound: async () => ({}) }, { apiBase: f.apiBase });
    try {
      await polling(f); const image = join(root, 'fixture.png'); writeFileSync(image, 'fixture photo bytes');
      const sent = await port.send({ targetId: '-1002', text: '*raw* _markdown_', action: 'sendMessage', format: 'markdownv2', threadId: '9', replyToMessageId: '42', files: [image] });
      assertEqual(sent.ok, true, 'text and actual upload acknowledged'); assertEqual((sent.messageIds as unknown[]).length, 2, 'both wire receipts retained');
      const text = f.requests.find(row => row.method === 'sendMessage')!.body; assertEqual(text.text, '*raw* _markdown_', 'no extra Markdown escaping'); assertEqual(text.parse_mode, 'MarkdownV2', 'format option');
      const upload = f.requests.find(row => row.method === 'sendPhoto')!; assert(upload.contentType.startsWith('multipart/form-data; boundary='), 'actual multipart request'); assert(upload.raw.includes('fixture photo bytes') && upload.raw.includes('name="photo"; filename="fixture.png"'), 'actual file bytes'); assert(upload.raw.includes('{"message_id":42}'), 'multipart reply envelope');
      assertEqual((await port.send({ targetId: '55', action: 'react', messageId: '42', emoji: '👍' })).ok, true, 'real reaction');
      f.queue('editMessageText', { body: { ok: true, result: true } }); assertDeepEqual(await port.send({ targetId: '55', action: 'editMessage', messageId: '42', text: 'edited' }), { ok: true, messageId: '42' }, 'inline edit retains supplied id');
      const downloaded = await port.send({ targetId: '', action: 'downloadAttachment', fileId: 'fixture-id' }); assertEqual(downloaded.ok, true, 'actual getFile/download');
      assertEqual(readFileSync(String(downloaded.path), 'utf8'), 'fixture attachment bytes', 'downloaded bytes on disk'); assertEqual(statSync(String(downloaded.path)).mode & 0o777, 0o600, 'private inbox permissions');
      const secret = join(root, '.env'), alias = join(root, 'innocent.txt'); writeFileSync(secret, 'must not send'); symlinkSync(secret, alias);
      const before = f.requests.length; assertEqual((await port.send({ targetId: '55', action: 'sendMessage', files: [alias] })).ok, false, 'canonical secret path refused'); assertEqual(f.requests.length, before, 'secret never reaches HTTP');
      assertEqual((await port.send({ targetId: '55', action: 'poke' })).ok, false, 'unknown action explicit'); assertEqual((await port.send({ targetId: '55', action: 'sendMessage' })).ok, false, 'empty operation cannot claim a delivery');
    } finally { await port.close(); await f.close(); }
  });
  h.test('Telegram HTTP/vendor errors are explicit and partial deliveries retain their real message ids', async () => {
    const f = await createTelegramTransportFixture(), root = freshRoot();
    const port = await TelegramTransport.start({ bot_token: token }, { configRoot: root, signal: new AbortController().signal, inbound: async () => ({}) }, { apiBase: f.apiBase });
    try {
      await polling(f); f.queue('sendMessage', { body: { ok: true, result: { message_id: 11 } } }, { body: { ok: false, error_code: 400, description: 'fixture refused ' + token } });
      const result = await port.send({ targetId: '55', text: 'x'.repeat(4100) }); assertEqual(result.ok, false, 'second chunk refusal is not success'); assertDeepEqual(result.messageIds, ['11'], 'first committed delivery recorded'); assert(!String(result.error).includes(token), 'token redacted from vendor description');
      f.queue('sendMessage', { status: 500, body: { ok: true, result: { message_id: 22 } } }); assertEqual((await port.send({ targetId: '55', text: 'fixture' })).ok, false, 'HTTP failure outranks counterfeit success body');
      f.queue('getFile', { body: { ok: true, result: { file_path: '../escape', file_size: 1 } } }); assertEqual((await port.send({ targetId: '', action: 'downloadAttachment', fileId: 'x' })).ok, false, 'remote path traversal rejected');
      f.queue('getFile', { body: { ok: true, result: { file_path: 'large.bin', file_size: 51 * 1024 * 1024 } } }); assertEqual((await port.send({ targetId: '', action: 'downloadAttachment', fileId: 'x' })).ok, false, 'declared oversized attachment rejected');
    } finally { await port.close(); await f.close(); }
  });
  h.test('Telegram invalid identity never starts polling and cancelling real getMe closes its socket', async () => {
    const f = await createTelegramTransportFixture(), root = freshRoot();
    try {
      f.queue('getMe', { body: { ok: false, error_code: 401, description: 'fixture unauthorized' } });
      await assertRejects(() => TelegramTransport.start({ bot_token: token }, { configRoot: root, signal: new AbortController().signal, inbound: async () => ({}) }, { apiBase: f.apiBase }), 'invalid credentials fail startup'); assertEqual(f.count('getUpdates'), 0, 'no polling owner after auth failure');
      f.queue('getMe', { hold: true }); const controller = new AbortController();
      const waiting = TelegramTransport.start({ bot_token: token }, { configRoot: root, signal: controller.signal, inbound: async () => ({}) }, { apiBase: f.apiBase }).then(() => false, () => true);
      await waitFor(() => f.count('getMe') === 2, 8000, 'held getMe connection'); controller.abort(); assertEqual(await waiting, true, 'cancelled startup rejects'); await waitFor(() => f.aborted() > 0, 8000, 'actual startup socket closed');
    } finally { await f.close(); }
  });
  h.test('Telegram honors server rate-limit delay and a stopped account cancels that delay immediately', async () => {
    const f = await createTelegramTransportFixture(), root = freshRoot();
    f.queue('getUpdates', { body: { ok: false, error_code: 429, description: 'fixture wait', parameters: { retry_after: 1 } } });
    const port = await TelegramTransport.start({ bot_token: token }, { configRoot: root, signal: new AbortController().signal, inbound: async () => ({}) }, { apiBase: f.apiBase });
    try {
      await polling(f, 2); const polls = f.requests.filter(row => row.method === 'getUpdates'); assert(polls[1]!.at - polls[0]!.at >= 900, 'actual server-requested one-second backoff');
      f.queue('getUpdates', { body: { ok: false, error_code: 429, description: 'fixture long wait', parameters: { retry_after: 600 } } }); f.updates([]);
      await waitFor(() => port.status().lastError === 'fixture long wait', 8000, 'ten-minute backoff entered'); const before = Date.now(); await port.close(); assert(Date.now() - before < 2000, 'backoff cancelled'); assertEqual(port.status().connected, false, 'stopped status');
    } finally { await port.close(); await f.close(); }
  });
  h.test('Telegram shutdown drains accepted engine work and pending HTTP without a late automatic reply', async () => {
    const f = await createTelegramTransportFixture(), root = freshRoot(); let entered = false, cancelled = false;
    const service = new ChannelService({ configRoot: root, factories: { telegram: telegramAdapter({ apiBase: f.apiBase }) }, runTurn: async (_input, signal) => {
      entered = true; await new Promise<void>(resolve => signal.addEventListener('abort', () => { cancelled = true; resolve(); }, { once: true })); return { reply: 'late' };
    } });
    try {
      await service.connect({ id: 'telegram', config: { bot_token: token } }); await polling(f); f.updates([direct(1)]); await waitFor(() => entered, 8000, 'actual engine callback'); await polling(f, 2);
      await service.close(); assertEqual(cancelled, true, 'engine callback cancellation acknowledged'); assertEqual(f.count('sendMessage'), 0, 'no reply after close'); await waitFor(() => f.aborted() > 0, 8000, 'long poll socket cancelled');
      assertEqual(service.contextFor('telegram:55'), undefined, 'host context retired');
    } finally { await service.close(); await f.close(); }
  });
  h.test('Telegram revoked polling settles its resource before the manager replaces the account transport', async () => {
    const f = await createTelegramTransportFixture(), root = freshRoot();
    f.queue('getUpdates', { body: { ok: false, error_code: 401, description: 'fixture revoked' } });
    const service = new ChannelService({ configRoot: root, factories: { telegram: telegramAdapter({ apiBase: f.apiBase }) }, runTurn: async () => ({}), backoffMs: [1] });
    try {
      await service.connect({ id: 'telegram', config: { bot_token: token } });
      await waitFor(() => f.count('getMe') === 2 && f.count('getUpdates') === 2, 8000, 'replacement after actual revoked-token response');
      const row = service.list().find(value => value.id === 'telegram')!;
      assertEqual(object(row.status).restartCount, 1, 'one real replacement attempt'); assertEqual(row.connected, true, 'new getMe succeeded');
    } finally { await service.close(); await f.close(); }
  });
  h.test('Telegram inbound attachments download the largest photo and document before the host turn', async () => {
    const f = await createTelegramTransportFixture(), root = freshRoot(); let received: JsonObject[] | undefined;
    const service = new ChannelService({ configRoot: root, factories: { telegram: telegramAdapter({ apiBase: f.apiBase }) }, runTurn: async input => { received = input.media as JsonObject[]; return {}; } });
    try {
      await service.connect({ id: 'telegram', config: { bot_token: token } }); await polling(f);
      f.updates([{ update_id: 1, message: { message_id: 1, chat: { id: 55, type: 'private' }, from: { id: 55 }, caption: 'inspect fixture', photo: [{ file_id: 'small' }, { file_id: 'largest' }], document: { file_id: 'document', file_name: 'fixture.txt' } } }]);
      await waitFor(() => received !== undefined, 8000, 'host receives downloaded media');
      assertDeepEqual(f.requests.filter(row => row.method === 'getFile').map(row => row.body.file_id), ['largest', 'document'], 'only largest photo plus document');
      assertDeepEqual(received!.map(row => row.type), ['image', 'file'], 'current media types');
      for (const media of received!) { assert(String(media.path).startsWith(join(root, 'channels/telegram/inbox')), 'isolated inbox'); assertEqual(readFileSync(String(media.path), 'utf8'), 'fixture attachment bytes', 'actual downloaded attachment'); }
    } finally { await service.close(); await f.close(); }
  });
}
