import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto';
import { object, string, type JsonObject } from '../service-types';
import { feishuAllows, feishuGroupConfig, feishuId, type FeishuConfig } from './feishu-config';
import { feishuGroupSession, feishuMentioned } from './feishu-content';

export interface FeishuEvent {
  id: string; sender: string; senderIds: string[]; chat: string; direct: boolean; messageType: string; content: string;
  mentions: JsonObject[]; timestamp: number; sessionKey: string; replyInThread: boolean; threadId?: string; mentioned: boolean;
}
export function decryptFeishuEnvelope(input: JsonObject, key?: string): JsonObject {
  if (input.encrypt === undefined) return input;
  if (!key || typeof input.encrypt !== 'string' || !/^[a-zA-Z0-9+/]+={0,2}$/u.test(input.encrypt)) throw new Error('Feishu event decryption failed');
  const bytes = Buffer.from(input.encrypt, 'base64'); if (bytes.length < 32 || bytes.length % 16 !== 0) throw new Error('Feishu event decryption failed');
  try {
    const decipher = createDecipheriv('aes-256-cbc', createHash('sha256').update(key).digest(), bytes.subarray(0, 16));
    const parsed = object(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(16)), decipher.final()]).toString('utf8')));
    const { encrypt: _encrypt, ...rest } = input; return { ...parsed, ...rest };
  } catch { throw new Error('Feishu event decryption failed'); }
}
export function parseFeishuEnvelope(input: JsonObject, key?: string): { type: string; data: JsonObject } {
  const value = decryptFeishuEnvelope(input, key), { header, event, ...rest } = value;
  return Object.hasOwn(value, 'schema') ? { type: string(object(header).event_type), data: { ...rest, ...object(header), ...object(event) } }
    : { type: string(object(event).type), data: { ...object(event), ...rest, ...(header === undefined ? {} : { header }) } };
}
export function feishuWebhookAuthorized(raw: Buffer, payload: JsonObject, headers: Record<string, string | string[] | undefined>, config: FeishuConfig, now = Date.now()): boolean {
  const equal = (a: string, b: string): boolean => { const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); };
  let decoded: JsonObject; try { decoded = decryptFeishuEnvelope(payload, config.encryptKey); } catch { return false; }
  const token = string(decoded.token) || string(object(decoded.header).token);
  if (config.verificationToken && !equal(token, config.verificationToken)) return false;
  if (!config.encryptKey) return Boolean(config.verificationToken);
  if (decoded.type === 'url_verification' && typeof payload.encrypt === 'string') return true;
  const stamp = headers['x-lark-request-timestamp'], nonce = headers['x-lark-request-nonce'], signature = headers['x-lark-signature'];
  if (typeof stamp !== 'string' || !/^\d+$/u.test(stamp) || !Number.isSafeInteger(Number(stamp)) || Math.abs(now - Number(stamp) * 1000) > 300_000 || typeof nonce !== 'string' || !nonce || nonce.length > 1024 || typeof signature !== 'string' || !/^[a-f0-9]{64}$/u.test(signature)) return false;
  const hash = (body: Buffer | string): string => createHash('sha256').update(stamp).update(nonce).update(config.encryptKey!).update(body).digest('hex');
  // Existing profiles signed re-serialized JSON; also accept the vendor's exact raw-body signature.
  return equal(signature, hash(raw)) || equal(signature, hash(JSON.stringify(payload)));
}
export function feishuEvent(data: JsonObject, config: FeishuConfig, bot?: string, now = Date.now()): FeishuEvent | undefined {
  const message = object(data.message), senderObject = object(object(data.sender).sender_id);
  const senderIds = [senderObject.open_id, senderObject.user_id, senderObject.union_id].filter((value): value is string => typeof value === 'string' && Boolean(value)).map(value => feishuId(value, 'sender id'));
  const sender = feishuId(senderIds[0], 'sender id'); if (bot && senderObject.open_id === bot) return undefined;
  const id = feishuId(message.message_id, 'message id'), chat = feishuId(message.chat_id, 'chat id'), direct = message.chat_type === 'p2p';
  if (!['p2p', 'group'].includes(string(message.chat_type))) throw new Error('Invalid Feishu chat type');
  if (typeof message.content !== 'string' || Buffer.byteLength(message.content) > 1024 * 1024) throw new Error('Invalid Feishu message content');
  if (message.mentions !== undefined && (!Array.isArray(message.mentions) || message.mentions.length > 256)) throw new Error('Invalid Feishu mention list');
  const mentions = (Array.isArray(message.mentions) ? message.mentions : []).map(value => {
    const raw = object(value), id = object(raw.id), key = string(raw.key), name = string(raw.name), identifiers: JsonObject = {};
    if (Buffer.byteLength(key) > 2048 || Buffer.byteLength(name) > 2048) throw new Error('Invalid Feishu mention');
    for (const field of ['open_id', 'user_id', 'union_id']) if (id[field] !== undefined && id[field] !== '') identifiers[field] = feishuId(id[field], 'mention id');
    return { key, name, id: identifiers };
  }), mentioned = feishuMentioned(mentions, bot), override = feishuGroupConfig(config, chat);
  if (direct) { if (config.dmPolicy === 'disabled' || (config.dmPolicy === 'allowlist' && !feishuAllows(config.allowFrom, [sender]))) return undefined; }
  else {
    if (config.groupPolicy === 'disabled' || override?.enabled === false) return undefined;
    if (config.groupPolicy === 'allowlist' && !feishuAllows(override?.allowFrom ?? config.groupSenderAllowFrom ?? config.groupAllowFrom, senderIds)) return undefined;
    if ((override?.requireMention ?? config.requireMention ?? true) && !mentioned) return undefined;
  }
  const root = string(message.root_id).trim() || undefined, thread = string(message.thread_id).trim() || undefined;
  if (root) feishuId(root, 'root message id'); if (thread) feishuId(thread, 'thread id');
  const resolved = feishuGroupSession({ chatId: chat, senderOpenId: sender, messageId: id, rootId: root, threadId: thread,
    groupSessionScope: override?.groupSessionScope ?? config.groupSessionScope, replyInThread: override?.replyInThread ?? config.replyInThread, topicSessionMode: override?.topicSessionMode ?? config.topicSessionMode });
  const stamp = parseInt(string(message.create_time), 10), timestamp = Number.isSafeInteger(stamp) && stamp >= 0 && stamp <= 253_402_300_799_999 ? stamp : now;
  const messageType = string(message.message_type); if (!messageType || messageType.length > 64) throw new Error('Invalid Feishu message type');
  return { id, sender, senderIds, chat, direct, messageType, content: message.content, mentions, timestamp,
    sessionKey: 'feishu:' + (direct ? sender : resolved.peerId), replyInThread: resolved.replyInThread, ...(resolved.replyInThread ? { threadId: thread || root || id } : {}), mentioned };
}
