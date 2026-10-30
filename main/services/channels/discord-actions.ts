import { SerialMutations, errorMessage, object, string, type JsonObject } from '../service-types';
import { DiscordAccessService } from './discord-access';
import { DiscordApi, discordId } from './discord-api';
import { discordChunks, discordFetchedMessage } from './discord-wire';
import type { ChannelSend } from './types';

export class DiscordActions {
  private readonly queue = new SerialMutations();
  private readonly pending = new Set<Promise<JsonObject>>();
  constructor(private readonly api: DiscordApi, private readonly access: DiscordAccessService, private readonly signal: AbortSignal,
    private readonly botId: () => string, private readonly dmUser: (channel: string) => string | undefined, private readonly noteSent: (id: string) => void) {}
  private active(signal: AbortSignal): void { if (signal.aborted) throw new Error('Discord action was cancelled'); }
  private async allowed(channel: string, signal: AbortSignal): Promise<JsonObject> {
    const info = object(await this.api.call('GET', '/channels/' + discordId(channel, 'channel id'), undefined, signal));
    if (info.id !== channel || typeof info.type !== 'number') throw new Error('Discord returned an invalid channel');
    const access = await this.access.transportAccess(); this.active(signal);
    if (!['pairing', 'allowlist'].includes(string(access.dmPolicy))) throw new Error('Discord access is disabled');
    if (info.type === 1) {
      const recipients = Array.isArray(info.recipients) ? info.recipients : [];
      const user = string(info.recipient_id) || string(object(recipients[0]).id) || this.dmUser(channel);
      if (user && Array.isArray(access.allowFrom) && access.allowFrom.includes(user)) return access;
    } else if ([0, 5, 10, 11, 12].includes(info.type)) {
      const key = [10, 11, 12].includes(info.type) ? string(info.parent_id, channel) : channel;
      const groups = object(access.groups), policy = groups[key];
      if (Object.hasOwn(groups, key) && policy && typeof policy === 'object' && !Array.isArray(policy)) return access;
    }
    throw new Error('Discord channel ' + channel + ' is not allowlisted');
  }
  send(params: ChannelSend, signal = this.signal): Promise<JsonObject> {
    const combined = AbortSignal.any([this.signal, signal]);
    if (combined.aborted) return Promise.resolve({ ok: false, error: 'Discord action was cancelled' });
    if (this.pending.size >= 32) return Promise.resolve({ ok: false, error: 'Discord outbound queue capacity exceeded' });
    const operation = this.queue.run(() => this.dispatch(params, combined)).catch(error => ({ ok: false, error: errorMessage(error) }));
    this.pending.add(operation); return operation.finally(() => this.pending.delete(operation));
  }
  private async dispatch(params: ChannelSend, signal: AbortSignal): Promise<JsonObject> {
    this.active(signal); const channel = discordId(params.targetId, 'channel id'), action = params.action || 'sendText';
    const access = await this.allowed(channel, signal);
    if (action === 'sendText' || action === 'sendMessage') {
      if (params.files !== undefined && !Array.isArray(params.files)) throw new Error('Invalid Discord attachments');
      if (action === 'sendText' && params.files?.length) throw new Error('Discord attachments require sendMessage');
      const files = await this.api.files(params.files || [], signal), text = params.text || '';
      if (!text.trim() && !files.length) throw new Error('Discord message requires text or an attachment');
      const rawLimit = typeof access.textChunkLimit === 'number' ? access.textChunkLimit : 2000;
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(2000, Math.floor(rawLimit))) : 2000;
      const chunks = text.trim() ? discordChunks(text, limit, string(access.chunkMode, 'length')) : [''];
      const replyMode = string(access.replyToMode, 'first'), ids: string[] = [];
      if (params.replyToMessageId) discordId(params.replyToMessageId, 'reply message id');
      try {
        for (const [index, chunk] of chunks.entries()) {
          this.active(signal);
          // Access can be revoked while a multi-chunk message is being sent.
          if (index) await this.allowed(channel, signal);
          const reply = params.replyToMessageId && replyMode !== 'off' && (replyMode === 'all' || index === 0);
          const sent = object(await this.api.createMessage(channel, { ...(chunk ? { content: chunk } : {}), ...(reply ? { message_reference: { message_id: params.replyToMessageId!, fail_if_not_exists: false } } : {}) }, index === 0 ? files : [], signal));
          const id = discordId(sent.id, 'message receipt'); ids.push(id); this.noteSent(id);
        }
      } catch (error) { return { ok: false, error: errorMessage(error), ...(ids.length ? { messageIds: ids } : {}) }; }
      return { ok: true, messageId: ids[0]!, messageIds: ids };
    }
    if (action === 'react' || action === 'editMessage') {
      const messageId = discordId(params.messageId, 'message id'), path = '/channels/' + channel + '/messages/' + messageId;
      if (action === 'react') {
        if (!params.emoji || params.emoji.length > 256) throw new Error('Discord reaction requires an emoji');
        if (await this.api.call('PUT', path + '/reactions/' + encodeURIComponent(params.emoji) + '/@me', {}, signal) !== null) throw new Error('Invalid Discord reaction receipt');
      } else {
        if (typeof params.text !== 'string' || params.text.length > 2000) throw new Error('Discord edit requires text within 2000 characters');
        const edited = object(await this.api.call('PATCH', path, { content: params.text }, signal));
        if (edited.id !== messageId) throw new Error('Invalid Discord edit receipt');
      }
      return { ok: true, messageId };
    }
    if (action === 'fetchMessages') {
      const limit = params.limit === undefined ? 20 : params.limit;
      if (!Number.isFinite(limit)) throw new Error('Invalid Discord history limit');
      const query = new URLSearchParams({ limit: String(Math.max(1, Math.min(100, Math.floor(limit)))) });
      if (params.beforeMessageId) query.set('before', discordId(params.beforeMessageId));
      if (params.afterMessageId) query.set('after', discordId(params.afterMessageId));
      const fetched = await this.api.call('GET', '/channels/' + channel + '/messages?' + query.toString(), undefined, signal);
      if (!Array.isArray(fetched)) throw new Error('Invalid Discord history result');
      return { ok: true, messages: fetched.map(raw => { const row = object(raw); discordId(row.id, 'history message id'); return discordFetchedMessage(row, this.botId()); }).reverse() };
    }
    if (action === 'downloadAttachment') {
      const messageId = discordId(params.messageId, 'message id');
      const message = object(await this.api.call('GET', '/channels/' + channel + '/messages/' + messageId, undefined, signal));
      if (message.id !== messageId || !Array.isArray(message.attachments) || !message.attachments.length) throw new Error('Discord message has no attachments');
      if (message.attachments.length > 10) throw new Error('Discord message has too many attachments');
      const paths: string[] = [];
      try { for (const item of message.attachments) paths.push(await this.api.download(object(item), signal)); }
      catch (error) { return { ok: false, error: errorMessage(error), ...(paths.length ? { paths } : {}) }; }
      return { ok: true, path: paths[0]!, paths };
    }
    throw new Error('Unsupported Discord action: ' + action);
  }
  async close(): Promise<void> { await Promise.allSettled([...this.pending]); }
}
