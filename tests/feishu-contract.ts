import { createCipheriv, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { FeishuShards, decodeFeishuFrame, encodeFeishuFrame, type FeishuFrame } from '../main/services/channels/feishu-codec';
import { feishuConfiguration } from '../main/services/channels/feishu-config';
import { feishuContent, feishuForward, feishuGroupSession, feishuMentioned, feishuNormalizeMentions, feishuPost, feishuStripBot } from '../main/services/channels/feishu-content';
import { FeishuDedup } from '../main/services/channels/feishu-dedup';
import { decryptFeishuEnvelope, feishuEvent, feishuWebhookAuthorized } from '../main/services/channels/feishu-event';
import { ChannelSettingsStore } from '../main/services/channels/settings-store';
import { withSettingsDb } from '../main/services/settings';
import { object, string, type JsonObject } from '../main/services/service-types';
import { Harness, assert, assertDeepEqual, assertEqual, assertRejects } from './harness';

const account = { app_id: 'cli_fixture', app_secret: 'fixture-feishu-secret' };
export function sealFeishu(value: JsonObject, key: string): string {
  const iv = Buffer.alloc(16, 7), cipher = createCipheriv('aes-256-cbc', createHash('sha256').update(key).digest(), iv);
  return Buffer.concat([iv, cipher.update(JSON.stringify(value)), cipher.final()]).toString('base64');
}
export function registerFeishuContractTests(h: Harness, freshRoot: () => string): void {
  h.test('Feishu content, mention and topic-session committed vectors remain byte stable', () => {
    const vectors = object(JSON.parse(readFileSync(resolve(__dirname, '../../contracts/channels/feishu-wire-vectors.json'), 'utf8')));
    const cases = (name: string): JsonObject[] => (vectors[name] as unknown[]).map(object);
    for (const row of cases('parseMessageContent')) assertEqual(feishuContent(string(row.content), string(row.messageType)), row.out, 'content vector');
    for (const row of cases('parsePostContent')) assertDeepEqual(feishuPost(string(row.content)), row.out, 'post vector');
    for (const row of cases('parseMergeForwardContent')) assertEqual(feishuForward(string(row.content)), row.out, 'forward vector');
    for (const row of cases('stripBotMention')) assertEqual(feishuStripBot(string(row.text), (row.mentions as unknown[]).map(object), string(row.botOpenId) || undefined), row.out, 'strip vector');
    for (const row of cases('normalizeMentions')) assertEqual(feishuNormalizeMentions(string(row.text), (row.mentions as unknown[]).map(object), string(row.botOpenId) || undefined), row.out, 'mention vector');
    const roster = cases('stripBotMention')[0]!.mentions as unknown[];
    for (const row of cases('isBotMentioned')) assertEqual(feishuMentioned(roster.map(object), string(row.botOpenId) || undefined), row.out, 'bot identity vector');
    for (const row of cases('resolveFeishuGroupSession')) { const params = object(row.params); assertDeepEqual(feishuGroupSession({ chatId: string(params.chatId), senderOpenId: string(params.senderOpenId), messageId: string(params.messageId), rootId: string(params.rootId) || undefined, threadId: string(params.threadId) || undefined, groupSessionScope: string(params.groupSessionScope) || undefined, replyInThread: string(params.replyInThread) || undefined, topicSessionMode: string(params.topicSessionMode) || undefined }), row.out, 'group identity vector'); }
    assertEqual(cases('parseMessageContent').length + cases('parsePostContent').length + cases('parseMergeForwardContent').length + cases('stripBotMention').length + cases('normalizeMentions').length + cases('isBotMentioned').length + cases('resolveFeishuGroupSession').length, 52, 'full committed corpus');
  });
  h.test('Feishu pbbp2 codec retains uint64 identity and rejects malformed wire lengths and types', () => {
    const ping: FeishuFrame = { seqId: 0n, logId: 0n, service: 7, method: 0, headers: [['type', 'ping']] };
    assertEqual(encodeFeishuFrame(ping).toString('hex'), '08001000180720002a0c0a0474797065120470696e67', 'committed ping wire bytes');
    const data: FeishuFrame = { seqId: 300n, logId: 0xffffffffffffffffn, service: 9, method: 1, headers: [['type', 'event'], ['sum', '2']], payloadEncoding: 'json', payloadType: 'event', payload: Buffer.from('{"a":1}'), logIdNew: 'abc' };
    const decoded = decodeFeishuFrame(encodeFeishuFrame(data)); assertEqual(decoded.logId, data.logId, 'no JS number precision loss'); assertEqual(decoded.seqId, 300n, 'varint sequence'); assertDeepEqual(decoded.headers, data.headers, 'ordered headers'); assertEqual(decoded.payload!.toString(), '{"a":1}', 'actual payload');
    assertEqual(decodeFeishuFrame(Buffer.concat([encodeFeishuFrame(ping), Buffer.from([0x78, 0x2a, 0x7a, 1, 120])])).service, 7, 'unknown legal fields skipped');
    for (const hex of ['0a00', '42ff', '0880808080808080808080', '0880808080808080808002', '00', '2a050a04ff', '4f']) { let failed = false; try { decodeFeishuFrame(Buffer.from(hex, 'hex')); } catch { failed = true; } assert(failed, 'malformed wire rejected: ' + hex); }
  });
  h.test('Feishu shards handle out-of-order frames with independent count, size and expiry limits', () => {
    let now = 0; const shards = new FeishuShards(() => now);
    assertEqual(shards.merge('m1', 2, 1, Buffer.from('\":1}')), undefined, 'second shard pending');
    assertEqual(shards.merge('m1', 2, 0, Buffer.from('{\"a'))!.toString(), '{"a":1}', 'out-of-order result');
    for (let id = 0; id < 64; id++) shards.merge('pending-' + id, 2, 0, Buffer.from('{'));
    let overflow = false; try { shards.merge('overflow', 2, 0, Buffer.from('{')); } catch { overflow = true; } assert(overflow, 'incomplete message capacity enforced');
    now = 10_001; assertEqual(shards.merge('fresh', 1, 0, Buffer.from('{}'))!.toString(), '{}', 'expired fragments release capacity');
    for (const [sum, seq] of [[0, 0], [129, 0], [2, 2], [2, -1]]) { let failed = false; try { shards.merge('bad', sum!, seq!, Buffer.from('x')); } catch { failed = true; } assert(failed, 'invalid shard count or index rejected'); }
    shards.merge('change', 2, 0, Buffer.from('a')); let changed = false; try { shards.merge('change', 2, 0, Buffer.from('b')); } catch { changed = true; } assert(changed, 'conflicting duplicate cannot rewrite an accepted fragment');
  });
  h.test('Feishu stored booleans and scoped ID policies do not open access on malformed or missing identities', () => {
    const config = feishuConfiguration({ ...account, group_policy: 'allowlist', group_sender_allow_from: '["Feishu:ON_ALLOWED"]', require_mention: 'false', typing_indicator: 'false', groups: '{"OC_ROOM":{"groupSessionScope":"group_topic_sender"}}' });
    assertEqual(config.typingIndicator, false, 'string row decoded as false');
    const event: JsonObject = { sender: { sender_id: { open_id: 'ou_sender', union_id: 'on_allowed' } }, message: { message_id: 'om_one', chat_id: 'oc_room', chat_type: 'group', content: '{"text":"hello"}', message_type: 'text', root_id: 'om_root', thread_id: 'omt_topic' } };
    const accepted = feishuEvent(event, config)!; assertEqual(accepted.sessionKey, 'feishu:oc_room:topic:om_root:sender:ou_sender', 'case-insensitive group override and topic identity'); assertEqual(accepted.threadId, 'omt_topic', 'real thread delivery identity');
    assertEqual(feishuEvent({ ...event, sender: { sender_id: { open_id: 'on_allowed-display-name' } } }, config), undefined, 'display resemblance does not grant access');
    let missing = false; try { feishuEvent({ ...event, sender: {} }, config); } catch { missing = true; } assert(missing, 'missing sender is rejected rather than bypassing allowlist');
    const invalid: JsonObject[] = [{ requireMention: 'perhaps' }, { groupPolicy: 'unknown' }, { groups: 'malformed' }];
    for (const patch of invalid) { let rejected = false; try { feishuConfiguration({ ...account, ...patch }); } catch { rejected = true; } assert(rejected, 'malformed config does not silently open'); }
  });
  h.test('Feishu webhook supports encrypted challenge and signed bodies but refuses unsigned or stale events', () => {
    const now = 1_700_000_000_000, config = feishuConfiguration({ ...account, connection_mode: 'webhook', encrypt_key: 'fixture-encryption-key', verification_token: 'fixture-verification-token' });
    const body = { schema: '2.0', header: { token: config.verificationToken! }, event: { type: 'fixture' } }, raw = Buffer.from(JSON.stringify(body, null, 2));
    const stamp = String(now / 1000), nonce = 'fixture-nonce', signature = createHash('sha256').update(stamp + nonce + config.encryptKey).update(raw).digest('hex');
    assert(feishuWebhookAuthorized(raw, body, { 'x-lark-request-timestamp': stamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': signature }, config, now), 'raw body signature accepted');
    assert(!feishuWebhookAuthorized(raw, body, {}, config, now), 'unsigned event refused');
    assert(!feishuWebhookAuthorized(raw, body, { 'x-lark-request-timestamp': stamp, 'x-lark-request-nonce': nonce, 'x-lark-signature': signature }, config, now + 300_001), 'old signed replay refused');
    const challenge = { encrypt: sealFeishu({ type: 'url_verification', token: config.verificationToken!, challenge: 'fixture-challenge' }, config.encryptKey!) };
    assert(feishuWebhookAuthorized(Buffer.from(JSON.stringify(challenge)), challenge, {}, config, now), 'encrypted verification challenge does not need request signature headers');
    assertEqual(decryptFeishuEnvelope(challenge, config.encryptKey).challenge, 'fixture-challenge', 'actual AES-CBC challenge');
    assert(!feishuWebhookAuthorized(Buffer.from('{}'), { token: 'wrong' }, {}, feishuConfiguration({ ...account, connection_mode: 'webhook', verification_token: 'right' })), 'plain verification token compared');
  });
  h.test('Feishu webhook keys use the existing credential envelope and older plaintext rows remain readable', () => {
    const root = freshRoot(), store = new ChannelSettingsStore(root);
    store.saveConfiguration('feishu', { ...account, encrypt_key: 'fixture-aes-one', encryptKey: 'fixture-aes-two' });
    assert(store.configuration('feishu').encrypt_key !== 'fixture-aes-one' && store.configuration('feishu').encryptKey !== 'fixture-aes-two', 'both key spellings encrypted');
    assertEqual(store.configuration('feishu', true).encrypt_key, 'fixture-aes-one', 'snake key roundtrip'); assertEqual(store.configuration('feishu', true).encryptKey, 'fixture-aes-two', 'camel key roundtrip');
    const previous = store.configuration('feishu'); store.saveConfiguration('feishu', { ...account, encrypt_key: previous.encrypt_key! }); assertEqual(store.configuration('feishu').encrypt_key, previous.encrypt_key, 'opaque encrypted envelope is not encrypted twice');
    withSettingsDb(root, db => db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('fixture-old-plaintext', 'channel.feishu.encrypt_key'));
    assertEqual(store.configuration('feishu', true).encrypt_key, 'fixture-old-plaintext', 'existing plaintext key remains readable without a data migration');
    store.saveConfiguration('feishu', { ...account, encrypt_key: 'fixture-old-plaintext' });
    assert(store.configuration('feishu').encrypt_key !== 'fixture-old-plaintext', 'saving an unchanged legacy plaintext key upgrades the envelope');
    store.saveConfiguration('feishu', { ...account, encrypt_key: 'fixture-rotated' });
    assert(store.configuration('feishu').encrypt_key !== 'fixture-rotated', 'rotated key uses the existing encrypted format');
  });
  h.test('Feishu persisted replay protection is profile isolated and never replaces a malformed file', async () => {
    const root = freshRoot(), now = 1_700_000_000_000, store = new FeishuDedup(root, () => now); await store.load();
    assert(store.claim('om_once'), 'first processing claim'); assert(!store.claim('om_once'), 'concurrent claim refused'); await store.complete(['om_once']);
    const reopened = new FeishuDedup(root, () => now + 1000); await reopened.load(); assert(!reopened.claim('om_once'), 'actual file prevents replay after restart');
    const other = new FeishuDedup(freshRoot(), () => now); await other.load(); assert(other.claim('om_once'), 'separate profile has no cross-profile suppression');
    const badRoot = freshRoot(), path = join(badRoot, 'feishu/dedup/global.json'); mkdirSync(join(badRoot, 'feishu/dedup'), { recursive: true }); writeFileSync(path, '{broken-fixture');
    await assertRejects(() => new FeishuDedup(badRoot).load(), 'malformed replay ledger is explicit'); assertEqual(readFileSync(path, 'utf8'), '{broken-fixture', 'original bytes preserved');
    const fullRoot = freshRoot(), fullPath = join(fullRoot, 'feishu/dedup/global.json'); mkdirSync(join(fullRoot, 'feishu/dedup'), { recursive: true });
    writeFileSync(fullPath, JSON.stringify(Object.fromEntries(Array.from({ length: 10_000 }, (_, index) => ['om_' + index, now]))));
    const full = new FeishuDedup(fullRoot, () => now); await full.load(); assert(full.claim('om_newest'), 'new record is accepted at the same millisecond'); await full.complete(['om_newest']);
    const reloaded = new FeishuDedup(fullRoot, () => now); await reloaded.load(); assert(!reloaded.claim('om_newest'), 'capacity pruning retains the just-completed record even with tied timestamps');
    assertEqual(Object.keys(JSON.parse(readFileSync(fullPath, 'utf8'))).length, 10_000, 'persistent record count remains bounded');
  });
}
