import { object, string, type JsonObject } from '../service-types';

const LIMIT = 1024 * 1024;
const textLimit = (value: string): string => { if (Buffer.byteLength(value) > LIMIT) throw new Error('Feishu content exceeds the size limit'); return value; };
const escapeMarkdown = (text: string): string => text.replace(/[\\`*_{}[\]()#+!|>~\-]/gu, '\\$&');
const first = (...values: unknown[]): string => values.map(value => string(value)).find(Boolean) ?? '';
const truth = (value: unknown): boolean => value === true || value === 1 || value === 'true';
const parse = (content: string): unknown => JSON.parse(textLimit(content));
function inline(text: string): string {
  let longest = 0; for (const match of text.matchAll(/`+/gu)) longest = Math.max(longest, match[0].length);
  const fence = '`'.repeat(longest + 1); return text.startsWith('`') || text.endsWith('`') ? fence + ' ' + text + ' ' + fence : fence + text + fence;
}
export interface FeishuPost { textContent: string; imageKeys: string[]; mediaKeys: Array<{ fileKey: string; fileName?: string }>; mentionedOpenIds: string[] }
export function feishuPost(content: string): FeishuPost {
  textLimit(content);
  const out: FeishuPost = { textContent: '[Rich text message]', imageKeys: [], mediaKeys: [], mentionedOpenIds: [] };
  let parsed: JsonObject; try { parsed = object(parse(content)); } catch { return out; }
  const direct = (value: unknown): JsonObject | undefined => Array.isArray(object(value).content) ? object(value) : undefined;
  const locale = (value: unknown): JsonObject | undefined => direct(value) ?? Object.values(object(value)).map(direct).find(Boolean);
  const payload = direct(parsed) ?? locale(parsed.post) ?? locale(parsed); if (!payload) return out;
  let elements = 0;
  const render = (raw: unknown): string => {
    if (++elements > 8192) throw new Error('Feishu rich text element capacity exceeded');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return escapeMarkdown(string(raw));
    const e = object(raw), tag = string(e.tag).toLowerCase(), text = string(e.text), style = object(e.style);
    switch (tag) {
      case 'text': {
        if (truth(style.code)) return inline(text); let value = escapeMarkdown(text); if (!value) return '';
        if (truth(style.bold)) value = '**' + value + '**'; if (truth(style.italic)) value = '*' + value + '*';
        if (truth(style.underline)) value = '<u>' + value + '</u>';
        if (truth(style.strikethrough) || truth(style.line_through) || truth(style.lineThrough)) value = '~~' + value + '~~'; return value;
      }
      case 'a': { const href = string(e.href).trim(), value = text || href; return href ? '[' + escapeMarkdown(value) + '](' + href + ')' : escapeMarkdown(value); }
      case 'at': { const id = first(e.open_id, e.user_id); if (id) out.mentionedOpenIds.push(id); const value = first(e.user_name, e.user_id, e.open_id); return value ? '@' + escapeMarkdown(value) : ''; }
      case 'img': if (string(e.image_key)) out.imageKeys.push(string(e.image_key)); return '![image]';
      case 'media': if (string(e.file_key)) out.mediaKeys.push({ fileKey: string(e.file_key), ...(string(e.file_name) ? { fileName: string(e.file_name) } : {}) }); return '[media]';
      case 'emotion': return escapeMarkdown(first(e.emoji, e.text, e.emoji_type));
      case 'br': return '\n';
      case 'hr': return '\n\n---\n\n';
      case 'code': { const value = first(e.text, e.content); return value ? inline(value) : ''; }
      case 'code_block': case 'pre': { const language = first(e.language, e.lang).trim().replace(/[^a-zA-Z0-9_+#.\-]/gu, ''), value = first(e.text, e.content).replace(/\r\n/gu, '\n'); return '```' + language + '\n' + value + (value.endsWith('\n') ? '' : '\n') + '```'; }
      default: return escapeMarkdown(text);
    }
  };
  const paragraphs = (payload.content as unknown[]).filter(Array.isArray).map(row => textLimit(row.map(render).join('')));
  const combined = [escapeMarkdown(string(payload.title).trim()), paragraphs.join('\n').trim()].filter(Boolean).join('\n\n').trim();
  out.textContent = textLimit(combined || '[Rich text message]'); return out;
}
export function feishuContent(content: string, type: string): string {
  textLimit(content);
  if (type === 'post') return feishuPost(content).textContent;
  let parsed: JsonObject; try { parsed = object(parse(content)); } catch { return content; }
  switch (type) {
    case 'text': return parsed.text ? String(parsed.text) : '';
    case 'share_chat': return string(parsed.body).trim() || string(parsed.summary).trim() || (typeof parsed.share_chat_id === 'string' ? '[Forwarded message: ' + parsed.share_chat_id + ']' : '[Forwarded message]');
    case 'merge_forward': return '[Merged and Forwarded Message - loading...]';
    case 'image': return '[图片]'; case 'file': return '[文件: ' + (parsed.file_name || '未知') + ']';
    case 'audio': return '[语音]'; case 'video': return '[视频]'; case 'sticker': return '[表情]'; case 'share_user': return '[分享名片]';
    case 'interactive': {
      const elements = Array.isArray(parsed.elements) ? parsed.elements : object(parsed.body).elements;
      if (!Array.isArray(elements)) return '[Interactive Card]';
      return elements.map(element => { const e = object(element); return e.tag === 'div' ? string(object(e.text).content) : e.tag === 'markdown' ? string(e.content) : ''; }).filter(Boolean).join('\n').trim() || '[Interactive Card]';
    }
    default: return content;
  }
}
export function feishuForward(content: string): string {
  textLimit(content);
  let items: unknown; try { items = parse(content); } catch { return '[Merged and Forwarded Message - parse error]'; }
  if (!Array.isArray(items) || !items.length) return '[Merged and Forwarded Message - no sub-messages]';
  const sub = items.map(object).filter(item => Boolean(item.upper_message_id)).sort((a, b) => (parseInt(string(a.create_time), 10) || 0) - (parseInt(string(b.create_time), 10) || 0));
  if (!sub.length) return '[Merged and Forwarded Message - no sub-messages found]';
  const lines = sub.slice(0, 50).map(item => {
    const raw = string(object(item.body).content), type = string(item.msg_type, 'text'); let value: JsonObject;
    try { value = object(parse(raw)); } catch { return '- ' + raw; }
    const body = type === 'text' ? value.text || raw : type === 'post' ? feishuPost(raw).textContent : type === 'file' ? '[File: ' + (value.file_name || 'unknown') + ']'
      : ({ image: '[Image]', audio: '[Audio]', video: '[Video]', sticker: '[Sticker]', merge_forward: '[Nested Merged Forward]' } as Record<string, string>)[type] ?? '[' + type + ']';
    return '- ' + body;
  });
  return textLimit(['[Merged and Forwarded Messages]', ...lines, ...(sub.length > 50 ? ['... and ' + (sub.length - 50) + ' more messages'] : [])].join('\n'));
}

/** Preserve the committed replacement-string rules without unbounded prefix/suffix expansion. */
function replaceLiteral(text: string, key: string, replacement: string): string {
  if (!key) return text; const pieces: string[] = []; let length = 0, cursor = 0;
  const add = (piece: string): void => { length += piece.length; if (length > LIMIT) throw new Error('Feishu mention expansion exceeds the size limit'); pieces.push(piece); };
  for (;;) {
    const at = text.indexOf(key, cursor); if (at < 0) { add(text.slice(cursor)); break; }
    add(text.slice(cursor, at)); let start = 0;
    for (const match of replacement.matchAll(/\$(\$|&|`|')/gu)) {
      add(replacement.slice(start, match.index)); const symbol = match[1]; add(symbol === '$' ? '$' : symbol === '&' ? key : symbol === '`' ? text.slice(0, at) : text.slice(at + key.length)); start = match.index + 2;
    }
    add(replacement.slice(start)); cursor = at + key.length;
  }
  return textLimit(pieces.join(''));
}
export const feishuMentioned = (mentions: JsonObject[], bot?: string): boolean => Boolean(bot && mentions.some(mention => object(mention.id).open_id === bot));
export function feishuStripBot(text: string, mentions: JsonObject[], bot?: string): string {
  if (!bot) return text; let out = text;
  for (const mention of mentions) if (object(mention.id).open_id === bot) out = replaceLiteral(out, string(mention.key), '').trim(); return out;
}
export function feishuNormalizeMentions(text: string, mentions: JsonObject[], bot?: string): string {
  let out = text;
  for (const mention of mentions) {
    if (bot && object(mention.id).open_id === bot) continue;
    const id = first(object(mention.id).open_id, object(mention.id).user_id).replace(/"/gu, '&quot;');
    const name = string(mention.name).replace(/[<>&"]/gu, character => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[character]!);
    out = replaceLiteral(out, string(mention.key), '<at user_id="' + id + '">' + name + '</at>');
  }
  return out;
}
export interface FeishuGroupSessionInput { chatId: string; senderOpenId: string; messageId: string; rootId?: string; threadId?: string; groupSessionScope?: string; replyInThread?: string; topicSessionMode?: string }
export function feishuGroupSession(input: FeishuGroupSessionInput): { peerId: string; replyInThread: boolean; threadReply: boolean } {
  const root = input.rootId?.trim(), thread = input.threadId?.trim(), threadReply = Boolean(root || thread);
  const replyInThread = input.replyInThread === 'enabled' || threadReply, scope = input.groupSessionScope ?? (input.topicSessionMode === 'enabled' ? 'group_topic' : 'group');
  const topic = root || thread || (replyInThread ? input.messageId : undefined);
  let peerId = input.chatId;
  if (['group_topic', 'group_topic_sender'].includes(scope) && topic) peerId += ':topic:' + topic;
  if (['group_sender', 'group_topic_sender'].includes(scope)) peerId += ':sender:' + input.senderOpenId;
  return { peerId, replyInThread, threadReply };
}
