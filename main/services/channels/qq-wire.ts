import { object, string, type JsonObject } from '../service-types';
import type { ChannelInbound, ChannelSend } from './types';

export const QQ = { dispatch: 0, heartbeat: 1, identify: 2, resume: 6, reconnect: 7, invalidSession: 9, hello: 10, heartbeatAck: 11 } as const;
export const QQ_INTENTS = (1 << 25) | (1 << 26) | (1 << 30) | (1 << 12);
export function qqInteger(value: unknown): number | undefined {
  const number = typeof value === 'string' && /^\d+$/u.test(value) ? Number(value) : value;
  return typeof number === 'number' && Number.isSafeInteger(number) && number >= 0 ? number : undefined;
}
export function qqId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Invalid QQ ' + label);
  return value;
}
export function qqOpenId(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/iu.test(value)) throw new Error('Invalid QQ openid');
  return value;
}
export function qqSendTarget(params: ChannelSend): { id: string; group: boolean } {
  const target = params.targetId;
  if (typeof target !== 'string') throw new Error('Invalid QQ target id');
  if (target.startsWith('qq:group:')) return { id: qqOpenId(target.slice(9)), group: true };
  if (target.startsWith('qq:c2c:')) return { id: qqOpenId(target.slice(7)), group: false };
  if (target.startsWith('qq:')) return { id: qqOpenId(target.slice(3)), group: false };
  return { id: qqOpenId(target), group: params.chatType === 'group' };
}
export function qqInbound(frame: JsonObject, now = Date.now()): ChannelInbound | undefined {
  const group = frame.t === 'GROUP_AT_MESSAGE_CREATE';
  if (qqInteger(frame.op) !== QQ.dispatch || (!group && frame.t !== 'C2C_MESSAGE_CREATE')) return undefined;
  const data = object(frame.d), author = object(data.author), raw = string(data.content);
  const text = (group ? raw.replace(/<@!?\w+>/gu, '') : raw).trim(); if (!text) return undefined;
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('QQ inbound text exceeds the size limit');
  const sender = qqOpenId(group ? author.member_openid : author.user_openid), target = group ? qqOpenId(data.group_openid) : sender;
  const messageId = qqId(data.id, 'message id'), timestamp = Date.parse(string(data.timestamp));
  return { sessionKey: group ? 'qq:group:' + target : 'qq:' + sender, senderId: sender, targetId: target, text, messageId, messageType: 'text',
    chatType: group ? 'group' : 'private', timestamp: Number.isFinite(timestamp) && timestamp !== 0 ? timestamp : now,
    dedupKey: 'qq:' + (group ? 'group:' : 'c2c:') + messageId, ...(group ? { groupId: target, mentioned: true } : {}),
    ...(group && typeof author.username === 'string' ? { senderName: author.username } : {}) };
}
