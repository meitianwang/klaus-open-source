import { basename, extname } from 'node:path';
import { errorMessage, object, string, type JsonObject } from '../service-types';
import { TelegramApi, TelegramApiError, type TelegramApiOptions } from './telegram-api';
import { telegramChatId, telegramChunks, telegramId, telegramInbound, telegramSendOptions } from './telegram-wire';
import { channelDelay, type ChannelAdapter, type ChannelAdapterContext, type ChannelAdapterFactory, type ChannelSend } from './types';

export interface TelegramTransportOptions extends TelegramApiOptions { retryMs?: number }
export class TelegramTransport implements ChannelAdapter {
  readonly done: Promise<void>;
  private readonly controller: AbortController;
  private readonly signal: AbortSignal;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly seen = new Map<string, number>();
  private snapshot: JsonObject;
  private closing?: Promise<void>;
  private constructor(private readonly api: TelegramApi, private readonly identity: JsonObject, private readonly context: ChannelAdapterContext, private readonly options: TelegramTransportOptions, controller: AbortController, signal: AbortSignal) {
    this.controller = controller; this.signal = signal;
    this.snapshot = { channelId: 'telegram', running: true, connected: true, mode: 'polling', tokenStatus: 'valid', name: string(identity.first_name), lastConnectedAt: this.now() };
    this.done = this.loop().finally(async () => {
      this.controller.abort(); await Promise.allSettled([...this.pending]); this.seen.clear();
      this.patch({ running: false, connected: false, lastStopAt: this.now() });
    });
    void this.done.catch(() => undefined);
  }
  static async start(account: Record<string, string>, context: ChannelAdapterContext, options: TelegramTransportOptions = {}): Promise<TelegramTransport> {
    const token = (account.bot_token || account.botToken)?.trim();
    if (!token || /[\s/\\?#]/u.test(token)) throw new Error('Telegram bot token is not configured or invalid');
    if (context.signal.aborted) throw new Error('Telegram start was cancelled');
    if (options.retryMs !== undefined && (!Number.isSafeInteger(options.retryMs) || options.retryMs < 1)) throw new Error('Invalid Telegram retry interval');
    const controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal]);
    const api = new TelegramApi(token, context.configRoot, signal, options);
    try {
      const identity = object(await api.call('getMe', {}));
      if (!telegramId(identity.id) || typeof identity.username !== 'string') throw new Error('Telegram getMe returned an invalid bot identity');
      if (signal.aborted) throw new Error('Telegram start was cancelled');
      return new TelegramTransport(api, identity, context, options, controller, signal);
    } catch (error) { controller.abort(); throw error; }
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private active(signal = this.signal): void { if (signal.aborted) throw new Error('Telegram operation was cancelled'); }
  private patch(value: JsonObject): void { this.snapshot = { ...this.snapshot, ...value }; try { this.context.onStatus?.(this.status()); } catch { /* Presentation does not own the transport. */ } }
  status(): JsonObject { return { ...this.snapshot }; }
  private track<T>(work: () => Promise<T>): Promise<T> {
    this.active(); const pending = work(); this.pending.add(pending);
    return pending.finally(() => this.pending.delete(pending));
  }
  private async loop(): Promise<void> {
    try { await this.api.call('deleteWebhook', { drop_pending_updates: true }); }
    catch (error) { if (!this.signal.aborted) this.patch({ lastError: errorMessage(error) }); }
    let offset: number | undefined;
    while (!this.signal.aborted) {
      try {
        const updates = await this.api.call('getUpdates', { timeout: 30, allowed_updates: ['message'], ...(offset !== undefined ? { offset } : {}) });
        this.active(); if (!Array.isArray(updates)) throw new TelegramApiError('Telegram getUpdates returned a non-array result');
        this.patch({ connected: true, tokenStatus: 'valid' });
        for (const raw of updates) {
          const update = object(raw), id = update.update_id;
          if (typeof id === 'number' && Number.isSafeInteger(id) && id < Number.MAX_SAFE_INTEGER) offset = Math.max(offset ?? 0, id + 1);
          const message = object(update.message), inbound = telegramInbound(message, string(this.identity.username), telegramId(this.identity.id), this.now());
          if (!inbound) continue;
          const key = inbound.dedupKey!, old = this.seen.get(key);
          if (old !== undefined && this.now() - old < 60_000) continue;
          while (this.pending.size >= 128) { await Promise.race([...this.pending].map(job => job.catch(() => undefined))); this.active(); }
          this.seen.set(key, this.now());
          if (this.seen.size > 10_000) { for (const [seen, at] of this.seen) if (this.now() - at >= 60_000) this.seen.delete(seen); while (this.seen.size > 10_000) this.seen.delete(this.seen.keys().next().value!); }
          this.patch({ lastInboundAt: this.now() });
          const media: JsonObject[] = [], photo = Array.isArray(message.photo) ? object(message.photo.at(-1)) : {}, document = object(message.document);
          for (const [item, fallback, type] of [[photo, 'photo.jpg', 'image'], [document, string(document.file_name), 'file']] as const) {
            const fileId = string(item.file_id); if (!fileId) continue;
            try { const path = await this.api.download(fileId, fallback); media.push({ type, path, fileName: type === 'file' && fallback ? fallback : basename(path) }); }
            catch (error) { this.active(); this.patch({ lastError: 'Inbound attachment: ' + errorMessage(error) }); }
          }
          this.active(); if (media.length) inbound.media = media;
          const task = this.track(async () => {
            this.active(); const result = await this.context.inbound(inbound, this.signal); this.active();
            if (result.reply && !result.manuallySent && !result.dropped) {
              const delivered = await this.send({ targetId: inbound.targetId!, text: result.reply, replyToMessageId: inbound.messageId, threadId: inbound.threadId });
              if (delivered.ok !== true) throw new Error(string(delivered.error, 'Telegram reply failed'));
            }
          });
          void task.catch(error => { if (!this.signal.aborted) this.patch({ lastError: errorMessage(error) }); });
        }
      } catch (error) {
        if (this.signal.aborted) break;
        this.patch({ connected: false, lastError: errorMessage(error) });
        if (error instanceof TelegramApiError && error.code !== undefined && error.code !== 429) {
          this.patch({ tokenStatus: [401, 403].includes(error.code) ? 'invalid' : 'error' }); return;
        }
        const retry = error instanceof TelegramApiError && error.code === 429 ? (error.retryAfter ?? 3) * 1000 : this.options.retryMs ?? 3000;
        await channelDelay(Math.min(retry, 2_147_483_647), this.signal);
      }
    }
  }
  send(params: ChannelSend, signal?: AbortSignal): Promise<JsonObject> {
    try { return this.track(() => this.dispatch(params, signal)).catch(error => ({ ok: false, error: errorMessage(error) })); }
    catch (error) { return Promise.resolve({ ok: false, error: errorMessage(error) }); }
  }
  private async dispatch(params: ChannelSend, signal?: AbortSignal): Promise<JsonObject> {
    this.active(); if (signal) this.active(signal);
    const action = params.action || 'sendText';
    if (action === 'downloadAttachment') return { ok: true, path: await this.api.download(params.fileId || '', undefined, signal) };
    if (!params.targetId?.trim()) throw new Error('Telegram action requires targetId');
    const chat = telegramChatId(params.targetId), text = params.text ?? '', messageId = Number(params.messageId?.trim());
    if (action === 'react' || action === 'editMessage') {
      if (!Number.isSafeInteger(messageId) || messageId <= 0) throw new Error('Telegram action requires a positive messageId');
      if (action === 'react' && !params.emoji?.trim()) throw new Error('Telegram reaction requires emoji');
      const result = await this.api.call(action === 'react' ? 'setMessageReaction' : 'editMessageText', action === 'react'
        ? { chat_id: chat, message_id: messageId, reaction: [{ type: 'emoji', emoji: params.emoji! }] }
        : { chat_id: chat, message_id: messageId, text, ...telegramSendOptions(undefined, undefined, params.format) }, signal);
      if (action === 'react' ? result !== true : result !== true && !telegramId(object(result).message_id)) throw new Error('Telegram action returned no success receipt');
      return { ok: true, messageId: telegramId(object(result).message_id) || params.messageId! };
    }
    if (!['sendText', 'sendMessage'].includes(action)) throw new Error('Unsupported Telegram action: ' + action);
    if (params.files?.length && action !== 'sendMessage') throw new Error('Telegram attachments require sendMessage');
    const options = telegramSendOptions(params.replyToMessageId, params.threadId, action === 'sendMessage' ? params.format : undefined), ids: string[] = [];
    const chunks = action === 'sendMessage' && !text.trim() ? [] : telegramChunks(text);
    if (!chunks.length && !params.files?.length) throw new Error('Telegram send requires text or files');
    try {
      for (const chunk of chunks) {
        const result = object(await this.api.call('sendMessage', { chat_id: chat, text: chunk, ...options }, signal)), id = telegramId(result.message_id);
        if (!id) throw new Error('Telegram send response has no message_id'); ids.push(id); this.patch({ lastOutboundAt: this.now() });
      }
      for (const file of params.files ?? []) {
        if (typeof file !== 'string' || !file) throw new Error('Telegram files must contain absolute paths');
        const photo = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(extname(file).toLowerCase());
        const result = object(await this.api.upload(photo ? 'sendPhoto' : 'sendDocument', photo ? 'photo' : 'document', chat, file, options, signal)), id = telegramId(result.message_id);
        if (!id) throw new Error('Telegram upload response has no message_id'); ids.push(id); this.patch({ lastOutboundAt: this.now() });
      }
    } catch (error) { return { ok: false, error: errorMessage(error), ...(ids.length ? { messageId: ids[0]!, messageIds: ids } : {}) }; }
    return { ok: true, messageId: ids[0] ?? null, messageIds: ids };
  }
  close(): Promise<void> { if (!this.closing) { this.controller.abort(); this.closing = this.done; } return this.closing; }
}
export function telegramAdapter(options: TelegramTransportOptions = {}): ChannelAdapterFactory { return (account, context) => TelegramTransport.start(account, context, options); }
