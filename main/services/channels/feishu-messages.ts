import { unlink } from 'node:fs/promises';
import { errorMessage, object, string, type JsonObject } from '../service-types';
import { FeishuApi } from './feishu-api';
import { feishuId, type FeishuConfig } from './feishu-config';
import { feishuContent, feishuForward, feishuNormalizeMentions, feishuPost, feishuStripBot } from './feishu-content';
import type { FeishuEvent } from './feishu-event';
import type { ChannelInbound } from './types';

export class FeishuMessages {
  private readonly names = new Map<string, { value: string; at: number }>();
  constructor(private readonly config: FeishuConfig, private readonly api: FeishuApi, private readonly signal: AbortSignal,
    private readonly warning: (message: string) => void, private readonly now: () => number, private readonly bot?: string) {}
  clear(): void { this.names.clear(); }
  async prepare(events: FeishuEvent[]): Promise<ChannelInbound> {
    const last = events.at(-1); if (!last) throw new Error('Empty Feishu message batch');
    const text: string[] = [], media: JsonObject[] = [], saved: string[] = []; let bytes = 0, mediaCount = 0;
    try {
      for (const event of events) {
        this.api.active(this.signal);
        let body = feishuContent(event.content, event.messageType), content: JsonObject = {};
        try { content = object(JSON.parse(event.content)); } catch { /* Plain vendor text remains visible through the content parser. */ }
        const assets: Array<{ key: string; name: string; kind: string }> = [];
        if (event.messageType === 'image' && string(content.image_key)) assets.push({ key: string(content.image_key), name: string(content.image_key), kind: 'image' });
        else if (['file', 'audio', 'video', 'media'].includes(event.messageType) && string(content.file_key)) assets.push({ key: string(content.file_key), name: string(content.file_name) || (event.messageType === 'audio' ? 'audio.opus' : ['video', 'media'].includes(event.messageType) ? 'video.mp4' : 'attachment'), kind: event.messageType === 'media' ? 'video' : event.messageType });
        else if (event.messageType === 'post') {
          const post = feishuPost(event.content);
          for (const key of post.imageKeys) assets.push({ key, name: key, kind: 'image' });
          for (const item of post.mediaKeys) assets.push({ key: item.fileKey, name: item.fileName || 'attachment', kind: 'file' });
        } else if (event.messageType === 'merge_forward') {
          try {
            const response = await this.api.call('/open-apis/im/v1/messages/' + encodeURIComponent(event.id), 'GET', undefined, {}, this.signal);
            const items = object(response.data).items;
            if (!Array.isArray(items)) throw new Error('Feishu forwarded messages are missing');
            body = feishuForward(JSON.stringify(items));
          } catch (error) { this.api.active(this.signal); this.warning(errorMessage(error)); body = '[Merged and Forwarded Message - could not load sub-messages]'; }
        }
        if (!event.direct) body = feishuNormalizeMentions(feishuStripBot(body, event.mentions, this.bot), event.mentions, this.bot);
        if (body.trim()) text.push(body);
        for (const asset of assets) {
          if (++mediaCount > 16) { text.push('[Additional Feishu attachments exceed the message limit]'); break; }
          try {
            const key = encodeURIComponent(feishuId(asset.key, 'media key'));
            const result = await this.api.download(asset.kind === 'image' ? '/open-apis/im/v1/images/' + key : '/open-apis/im/v1/messages/' + encodeURIComponent(event.id) + '/resources/' + key,
              asset.kind === 'image' ? {} : { type: 'file' }, event.sender, asset.name, asset.kind, this.signal, Math.min(16 * 1024 * 1024, 32 * 1024 * 1024 - bytes));
            media.push(result.media); saved.push(string(result.media.path)); bytes += result.bytes;
          } catch (error) { this.api.active(this.signal); this.warning(errorMessage(error)); text.push('[Feishu attachment could not be downloaded]'); }
        }
      }
      const body = text.join('\n\n'); if (Buffer.byteLength(body) > 1024 * 1024) throw new Error('Feishu combined message exceeds the size limit');
      const name = await this.name(last.sender);
      this.api.active(this.signal);
      return { sessionKey: last.sessionKey, senderId: last.sender, targetId: last.chat, chatType: last.direct ? 'private' : 'group', text: body,
        messageId: last.id, dedupKey: 'feishu:' + last.id, timestamp: last.timestamp, mentioned: events.some(event => event.mentioned),
        messageType: events.length > 1 ? 'text' : last.messageType === 'audio' ? 'voice' : last.messageType === 'sticker' ? 'emoji' : ['video', 'media'].includes(last.messageType) ? 'video' : ['image', 'file'].includes(last.messageType) ? last.messageType : 'text',
        ...(!last.direct ? { groupId: last.chat } : {}), ...(last.threadId ? { threadId: last.threadId } : {}),
        ...(name ? { senderName: name } : {}), ...(media.length ? { media } : {}) };
    } catch (error) { await Promise.allSettled(saved.map(path => unlink(path))); throw error; }
  }
  private async name(id: string): Promise<string | undefined> {
    if (!this.config.resolveSenderNames) return undefined;
    const at = this.now(), cached = this.names.get(id); if (cached && at - cached.at < 600_000) return cached.value;
    try {
      const response = await this.api.call('/open-apis/contact/v3/users/' + encodeURIComponent(id), 'GET', undefined,
        { user_id_type: id.startsWith('ou_') ? 'open_id' : id.startsWith('on_') ? 'union_id' : 'user_id' }, this.signal);
      const user = object(object(response.data).user), value = string(user.name) || string(user.display_name) || string(user.nickname) || string(user.en_name);
      if (!value || Buffer.byteLength(value) > 2048) return undefined;
      if (!this.names.has(id) && this.names.size >= 5000) this.names.delete(this.names.keys().next().value!);
      this.names.set(id, { value, at }); return value;
    } catch (error) { this.api.active(this.signal); this.warning(errorMessage(error)); return undefined; }
  }
}
