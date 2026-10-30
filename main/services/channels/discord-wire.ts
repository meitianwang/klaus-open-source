import { object, string, type JsonObject } from '../service-types';
import type { ChannelInbound } from './types';

export function discordTimestamp(id: string): number {
  if (!/^\d{1,24}$/u.test(id)) return 0;
  const timestamp = Number((BigInt(id) >> 22n) + 1_420_070_400_000n);
  return Number.isSafeInteger(timestamp) && timestamp <= 8.64e15 ? timestamp : 0;
}
export function discordChunks(text: string, limit: number, mode: string): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 2000) throw new Error('Invalid Discord chunk limit');
  const result: string[] = [];
  while (text.length > limit) {
    let cut = limit;
    if (mode === 'newline') {
      const paragraph = text.lastIndexOf('\n\n', limit), line = text.lastIndexOf('\n', limit), space = text.lastIndexOf(' ', limit);
      cut = paragraph > limit / 2 ? paragraph : line > limit / 2 ? line : space > 0 ? space : limit;
    }
    if (/[\uD800-\uDBFF]/u.test(text[cut - 1]!) && /[\uDC00-\uDFFF]/u.test(text[cut]!)) {
      if (cut === 1) throw new Error('Discord chunk limit is too small for this emoji');
      cut--;
    }
    result.push(text.slice(0, cut)); text = text.slice(cut).replace(/^\n+/u, '');
  }
  if (text || !result.length) result.push(text);
  return result;
}
export function discordAttachmentName(value: JsonObject): string { return string(value.filename, string(value.name, string(value.id))).replace(/[\[\]\r\n;]/gu, '_'); }
export function discordInbound(message: JsonObject, botId: string, groupId?: string, mentioned = false): ChannelInbound | undefined {
  const channelId = string(message.channel_id), id = string(message.id), direct = !string(message.guild_id), author = object(message.author);
  if (!channelId || !id || !string(author.id) || author.bot === true) return;
  let text = string(message.content);
  if (!direct && botId) text = text.replaceAll('<@' + botId + '>', '').replaceAll('<@!' + botId + '>', '');
  const lines = Array.isArray(message.attachments) ? message.attachments.map(raw => {
    const attachment = object(raw); return discordAttachmentName(attachment) + ' (' + string(attachment.content_type, 'unknown') + ', ' + Math.round(Number(attachment.size || 0) / 1024) + 'KB)';
  }) : [];
  text = [text.trim(), lines.length ? '[Discord attachments on this message: ' + lines.join('; ') + ']' : ''].filter(Boolean).join('\n');
  if (!text) return;
  const reference = string(object(message.message_reference).message_id);
  return { sessionKey: 'discord:' + channelId, targetId: channelId, text, messageType: lines.length ? 'mixed' : 'text', chatType: direct ? 'private' : 'group', senderId: string(author.id),
    ...(typeof author.username === 'string' ? { senderName: author.username } : {}), messageId: id, timestamp: discordTimestamp(id),
    ...(!direct ? { groupId: groupId || channelId, mentioned } : {}), ...(reference ? { replyTo: { messageId: reference } } : {}) };
}
export function discordFetchedMessage(message: JsonObject, botId: string): JsonObject {
  const author = object(message.author), id = string(message.id), attachments = Array.isArray(message.attachments) ? message.attachments.map(raw => {
    const value = object(raw); return { id: value.id ?? null, name: discordAttachmentName(value), size: value.size ?? null, ...(value.content_type ? { contentType: value.content_type } : {}) };
  }) : [];
  return { id, authorId: string(author.id), authorName: author.username ?? null, text: string(message.content), createdAt: new Date(discordTimestamp(id)).toISOString(), isBot: author.id === botId, ...(attachments.length ? { attachments } : {}) };
}
