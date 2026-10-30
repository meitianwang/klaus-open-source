import { randomBytes } from 'node:crypto';
import { object, string, type JsonObject } from '../service-types';
import type { ChannelInbound } from './types';

export const WECOM = { subscribe: 'aibot_subscribe', ping: 'ping', response: 'aibot_respond_msg', send: 'aibot_send_msg', callback: 'aibot_msg_callback', event: 'aibot_event_callback' } as const;
export const wecomRequestId = (command: string, now = Date.now()): string => command + '_' + now + '_' + randomBytes(4).toString('hex');
export function wecomId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > 1024 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('Invalid WeCom ' + label);
  return value.trim();
}
export function wecomText(body: JsonObject): { text: string; messageType: string } | undefined {
  const kind = string(body.msgtype);
  if (['event', 'stream'].includes(kind)) return undefined;
  if (kind === 'text' || kind === 'voice') {
    const text = string(object(body[kind]).content).trim(); return text ? { text, messageType: 'text' } : undefined;
  }
  if (kind === 'image') return { text: '[图片]', messageType: 'image' };
  if (kind === 'file') return { text: '[文件: ' + string(object(body.file).filename, 'file') + ']', messageType: 'file' };
  return { text: '[' + (kind || 'unknown') + ']', messageType: 'text' };
}
export function wecomInbound(frame: JsonObject, now = Date.now()): { message: ChannelInbound; requestId: string } | undefined {
  if (frame.cmd !== WECOM.callback) return undefined;
  const body = object(frame.body), content = wecomText(body); if (!content) return undefined;
  const requestId = wecomId(object(frame.headers).req_id, 'callback request id'), sender = wecomId(object(body.from).userid, 'sender id');
  const group = string(body.chattype).toLowerCase() === 'group', target = group ? wecomId(body.chatid, 'chat id') : sender;
  const id = body.msgid === undefined ? undefined : wecomId(body.msgid, 'message id');
  return { requestId, message: { sessionKey: 'wecom:' + target, ...content, chatType: group ? 'group' : 'private', senderId: sender,
    targetId: target, timestamp: now, ...(group ? { groupId: target } : {}), ...(id ? { messageId: id, dedupKey: 'wecom:' + id } : {}) } };
}
export function wecomFrame(command: string, requestId: string, body?: JsonObject): JsonObject {
  return { cmd: command, headers: { req_id: requestId }, ...(body ? { body } : {}) };
}
export function wecomReply(requestId: string, content: string): JsonObject {
  return wecomFrame(WECOM.response, requestId, { msgtype: 'stream', stream: { id: randomBytes(16).toString('hex'), finish: true, content } });
}
