import { object, string, type JsonObject } from '../service-types';
import type { ChannelInbound, ChannelSend } from './types';

export const DINGTALK_ROBOT_TOPIC = '/v1.0/im/bot/messages/get';
export function dingtalkId(value: unknown, label = 'identifier'): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || Buffer.byteLength(value) > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error('Invalid DingTalk ' + label);
  return value;
}
function contentObject(value: unknown): JsonObject { if (typeof value !== 'string') return object(value); try { return object(JSON.parse(value)); } catch { return {}; } }
export function dingtalkContent(raw: JsonObject): { text: string; messageType: string } {
  const kind = string(raw.msgtype), content = contentObject(raw.content);
  if (kind === 'text' && string(object(raw.text).content)) return { text: string(object(raw.text).content).trim(), messageType: 'text' };
  if (kind === 'audio' && string(content.recognition)) return { text: string(content.recognition).trim(), messageType: 'text' };
  if (kind === 'richText') {
    let parts: unknown = content.richText; if (typeof parts === 'string') try { parts = JSON.parse(parts); } catch { parts = []; }
    if (Array.isArray(parts)) { const text = parts.filter(part => object(part).type === 'text').map(part => string(object(part).text)).join(''); if (text) return { text, messageType: 'text' }; }
  }
  if (kind === 'file' && string(content.fileName)) return { text: '[文件: ' + string(content.fileName) + ']', messageType: 'file' };
  if (raw.content !== undefined && raw.content !== null) {
    if (['image', 'picture'].includes(kind)) return { text: '[图片]', messageType: 'image' };
    if (kind === 'video') return { text: '[视频]', messageType: 'video' };
  }
  return { text: '[' + (kind || 'unknown') + ']', messageType: 'text' };
}
export function dingtalkInbound(raw: JsonObject, messageId: string, clientId: string, now = Date.now()): ChannelInbound | undefined {
  const id = dingtalkId(messageId, 'message id'), sender = dingtalkId(raw.senderId, 'sender id');
  if (raw.conversationType !== '1' && raw.conversationType !== '2') throw new Error('Invalid DingTalk conversation type');
  const group = raw.conversationType === '2', conversation = group ? dingtalkId(raw.conversationId, 'conversation id') : sender;
  const mentions = Array.isArray(raw.atUsers) ? raw.atUsers : [];
  const botId = string(raw.chatbotUserId) || clientId;
  const mentioned = typeof raw.isInAtList === 'boolean' ? raw.isInAtList : mentions.some(user => object(user).dingtalkId === botId);
  if (group && !mentioned) return undefined;
  const parsed = dingtalkContent(raw), text = group && mentions.length ? parsed.text.replace(/@\S+\s*/gu, '').trim() : parsed.text;
  if (!text.trim()) return undefined;
  if (Buffer.byteLength(text) > 64 * 1024) throw new Error('DingTalk inbound message exceeds the size limit');
  const timestamp = Number.isSafeInteger(raw.createAt) && Number(raw.createAt) >= 0 && Number(raw.createAt) <= 253_402_300_799_999 ? Number(raw.createAt) : now;
  // The encrypted senderId is the existing conversation identity; OpenAPI userIdType=1 needs senderStaffId.
  const target = group ? conversation : string(raw.senderStaffId) ? dingtalkId(raw.senderStaffId, 'staff user id') : sender;
  return { sessionKey: 'dingtalk:' + conversation, senderId: sender, targetId: target, text, messageId: id, messageType: parsed.messageType,
    chatType: group ? 'group' : 'private', timestamp, dedupKey: 'dingtalk:' + id, ...(group ? { groupId: conversation, mentioned: true } : {}),
    ...(string(raw.senderNick) ? { senderName: string(raw.senderNick) } : {}) };
}
export function dingtalkTarget(params: ChannelSend): { id: string; group: boolean } {
  let id = dingtalkId(params.targetId, 'send target'); if (id.startsWith('dingtalk:')) id = id.slice('dingtalk:'.length);
  const kind = params.chatType;
  if (kind !== undefined && !['direct', 'private', 'group'].includes(kind)) throw new Error('Invalid DingTalk send chat type');
  const group = kind ? kind === 'group' : id.startsWith('cid');
  if (!group && id.startsWith('$:')) throw new Error('DingTalk private delivery requires a staff user id');
  return { id: dingtalkId(id, 'send target'), group };
}
export function dingtalkTitle(text: string): string {
  const first = text.split('\n')[0]!.replace(/^[#*\->\s]+/u, ''); let title = '';
  for (const character of first) { if (title.length + character.length > 20) break; title += character; }
  return title || 'Klaus';
}
export function dingtalkAck(messageId: string, callback: boolean): JsonObject {
  return { code: 200, headers: { contentType: 'application/json', messageId }, message: 'OK', data: JSON.stringify(callback ? { response: { success: true } } : { status: 'SUCCESS' }) };
}
