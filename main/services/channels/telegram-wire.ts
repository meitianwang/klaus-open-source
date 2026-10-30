import { object, string, type JsonObject } from '../service-types';
import type { ChannelInbound } from './types';

export function telegramId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return '';
}
export function telegramChatId(raw: string): number | string {
  const trimmed = raw.trim(), number = Number(trimmed);
  return Number.isSafeInteger(number) && String(number) === trimmed ? number : raw;
}
export function telegramText(message: JsonObject): { text: string; messageType: string } {
  if (typeof message.text === 'string') return { text: message.text, messageType: 'text' };
  if (typeof message.caption === 'string') return { text: message.caption, messageType: 'text' };
  if (Array.isArray(message.photo) && message.photo.length) return { text: '[\u56fe\u7247]', messageType: 'image' };
  if (message.document !== undefined) return { text: '[\u6587\u4ef6: ' + string(object(message.document).file_name, 'file') + ']', messageType: 'file' };
  if (message.voice !== undefined) return { text: '[\u8bed\u97f3]', messageType: 'voice' };
  if (message.video !== undefined) return { text: '[\u89c6\u9891]', messageType: 'video' };
  if (message.sticker !== undefined) return { text: string(object(message.sticker).emoji, '[\u8d34\u7eb8]'), messageType: 'emoji' };
  return { text: '', messageType: 'text' };
}
export function telegramSessionKey(message: JsonObject): string {
  const chat = object(message.chat), chatId = telegramId(chat.id), group = ['group', 'supergroup'].includes(string(chat.type));
  if (!group) return 'telegram:' + (telegramId(object(message.from).id) || chatId);
  const thread = telegramId(message.message_thread_id);
  return 'telegram:' + chatId + (chat.is_forum === true && thread ? ':topic:' + thread : '');
}
export function telegramInbound(message: JsonObject, username: string, botId: string, now: number): ChannelInbound | undefined {
  const chat = object(message.chat), sender = object(message.from), targetId = telegramId(chat.id), messageId = telegramId(message.message_id);
  if (!targetId || !messageId || telegramId(sender.id) === botId) return;
  const group = ['group', 'supergroup'].includes(string(chat.type));
  const extracted = telegramText(message), mentioned = !!username && extracted.text.toLowerCase().includes('@' + username.toLowerCase());
  if (group && !mentioned) return;
  const escaped = username.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const text = group ? extracted.text.replace(new RegExp('@' + escaped + '\\b', 'giu'), '').trim() : extracted.text;
  if (!text.trim()) return;
  const threadId = telegramId(message.message_thread_id), replyId = telegramId(object(message.reply_to_message).message_id);
  return {
    sessionKey: telegramSessionKey(message), targetId, text, messageType: extracted.messageType, chatType: group ? 'group' : 'private',
    senderId: telegramId(sender.id) || 'unknown', timestamp: now, messageId, dedupKey: 'telegram:' + targetId + ':' + messageId,
    ...(message.from !== undefined ? { senderName: [string(sender.first_name), string(sender.last_name)].filter(Boolean).join(' ') } : {}),
    ...(group ? { groupId: targetId, mentioned: true } : {}), ...(threadId ? { threadId } : {}), ...(replyId ? { replyTo: { messageId: replyId } } : {}),
  };
}
export function telegramChunks(text: string, limit = 4096): string[] {
  if (!Number.isSafeInteger(limit) || limit < 2) throw new Error('Invalid Telegram text limit');
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  while (text) {
    if (text.length <= limit) { chunks.push(text); break; }
    let cut = text.lastIndexOf('\n\n', limit);
    if (cut < limit * .3) cut = text.lastIndexOf('\n', limit);
    if (cut < limit * .3) cut = limit;
    // A JSON string must not contain one half of an emoji at the chunk boundary.
    if (cut > 1 && /[\uD800-\uDBFF]/u.test(text[cut - 1]!) && /[\uDC00-\uDFFF]/u.test(text[cut]!)) cut--;
    chunks.push(text.slice(0, cut)); text = text.slice(cut).trimStart();
  }
  return chunks;
}
export function telegramSendOptions(replyTo?: string, threadId?: string, format?: string): JsonObject {
  const id = (raw: string): number => { const number = Number(raw.trim()); if (!Number.isSafeInteger(number) || number <= 0) throw new Error('Telegram message and thread ids must be positive integers'); return number; };
  return { ...(replyTo ? { reply_parameters: { message_id: id(replyTo) } } : {}), ...(threadId ? { message_thread_id: id(threadId) } : {}), ...(format === 'markdownv2' ? { parse_mode: 'MarkdownV2' } : {}) };
}
