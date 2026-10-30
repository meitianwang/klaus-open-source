import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { atomicDocument, managedPath, readDocument } from '../extensions/file-store';
import { errorMessage, object, string, type JsonObject } from '../service-types';
import { RecentChannelMessages } from './recent-messages';
import { channelDelay, type ChannelAdapter, type ChannelAdapterContext, type ChannelAdapterFactory, type ChannelInbound, type ChannelSend } from './types';

const CHANNEL_VERSION = 'klaus-wechat-1.0';
const CONTEXT_LIMIT = 10_000;
export interface WechatTransportOptions {
  fetch?: typeof fetch; now?: () => number;
  pollTimeoutMs?: number; sendTimeoutMs?: number; errorBackoffMs?: number; expiredBackoffMs?: number;
}
export function wechatUin(bytes: Buffer): string {
  if (bytes.length !== 4) throw new Error('WeChat UIN requires four bytes');
  return Buffer.from(String(bytes.readUInt32BE()), 'utf8').toString('base64');
}
export function wechatMessageText(message: JsonObject): string {
  if (!Array.isArray(message.item_list)) return '';
  const parts: string[] = [];
  for (const value of message.item_list) {
    const item = object(value);
    if (item.type === 1) { const text = string(object(item.text_item).text); if (text) parts.push(text); }
    if (item.type === 2) parts.push('[\u56fe\u7247]');
    if (item.type === 3) parts.push(string(object(item.voice_item).text) || '[\u8bed\u97f3]');
    if (item.type === 4) parts.push('[\u6587\u4ef6: ' + (string(object(item.file_item).file_name) || '\u672a\u77e5') + ']');
    if (item.type === 5) parts.push('[\u89c6\u9891]');
  }
  return parts.join('\n').trim();
}
export function wechatInbound(message: JsonObject, now: number): ChannelInbound {
  const senderId = string(message.from_user_id) || 'unknown';
  const rawId = message.message_id ?? message.client_id;
  const messageId = typeof rawId === 'string' || typeof rawId === 'number' ? String(rawId) : undefined;
  const first = Array.isArray(message.item_list) ? object(message.item_list[0]) : {};
  return {
    sessionKey: 'wechat:' + senderId, senderId, text: wechatMessageText(message), chatType: 'private',
    messageType: ({ 2: 'image', 3: 'voice', 4: 'file', 5: 'video' } as Record<number, string>)[Number(first.type)] ?? 'text',
    timestamp: typeof message.create_time_ms === 'number' ? message.create_time_ms : now,
    ...(messageId !== undefined ? { messageId } : {}),
  };
}
function positive(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid WeChat transport timeout');
  return value;
}

/** iLink transport only. The injected host owns engine turns and account policy. */
export class WechatTransport implements ChannelAdapter {
  readonly done: Promise<void>;
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly tokens = new Map<string, string>();
  private readonly seen = new RecentChannelMessages();
  private readonly fetch: typeof fetch;
  private readonly base: URL;
  private snapshot: JsonObject = { running: true, connected: false, mode: 'long-poll' };
  private closing?: Promise<void>;
  private readonly pollTimeout: number;
  private readonly sendTimeout: number;
  private readonly errorBackoff: number;
  private readonly expiredBackoff: number;
  private constructor(private readonly token: string, private readonly context: ChannelAdapterContext, private readonly options: WechatTransportOptions, base: string) {
    this.base = new URL(base.replace(/\/+$/u, '') + '/');
    if (!['http:', 'https:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.hash || this.base.search) throw new Error('Invalid WeChat gateway URL');
    this.fetch = options.fetch ?? fetch;
    this.signal = AbortSignal.any([context.signal, this.controller.signal]);
    this.pollTimeout = positive(options.pollTimeoutMs, 35_000);
    this.sendTimeout = positive(options.sendTimeoutMs, 15_000);
    this.errorBackoff = positive(options.errorBackoffMs, 5_000);
    this.expiredBackoff = positive(options.expiredBackoffMs, 3_600_000);
    this.done = this.loop().finally(async () => {
      this.controller.abort();
      await Promise.allSettled([...this.pending]);
      this.tokens.clear(); this.seen.clear();
      this.patch({ running: false, connected: false });
    });
    // A caller can attach a supervisor after construction without an unhandled rejection.
    void this.done.catch(() => undefined);
  }
  static async start(account: Record<string, string>, context: ChannelAdapterContext, options: WechatTransportOptions = {}): Promise<WechatTransport> {
    const token = account.token?.trim(), accountId = account.account_id || account.accountId;
    if (!token || !accountId?.trim()) throw new Error('WeChat account is not paired');
    if (context.signal.aborted) throw new Error('WeChat start was cancelled');
    return new WechatTransport(token, context, options, account.base_url || account.baseUrl || 'https://ilinkai.weixin.qq.com');
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private active(signal = this.signal): void { if (signal.aborted) throw new Error('WeChat operation was cancelled'); }
  private patch(value: JsonObject): void {
    this.snapshot = { ...this.snapshot, ...value };
    try { this.context.onStatus?.(this.status()); } catch { /* Diagnostics cannot stop delivery. */ }
  }
  status(): JsonObject { return { ...this.snapshot }; }
  private async request(endpoint: string, body: JsonObject, limit: number, signal: AbortSignal, waiting = false): Promise<string | undefined> {
    this.active(signal);
    const timeout = new AbortController(), combined = AbortSignal.any([signal, timeout.signal]);
    const timer = setTimeout(() => timeout.abort(), limit);
    try {
      const response = await this.fetch(new URL(endpoint, this.base), {
        method: 'POST', signal: combined, redirect: 'error',
        headers: { 'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token', 'X-WECHAT-UIN': wechatUin(randomBytes(4)), Authorization: 'Bearer ' + this.token },
        body: JSON.stringify(body),
      });
      const reader = response.body?.getReader();
      const parts: Uint8Array[] = []; let size = 0;
      if (reader) try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 4 * 1024 * 1024) { await reader.cancel(); throw new Error('WeChat API response is too large'); }
          parts.push(part.value);
        }
      } finally { reader.releaseLock(); }
      this.active(signal);
      const text = Buffer.concat(parts).toString('utf8');
      if (!response.ok) throw new Error('WeChat API ' + endpoint + ': HTTP ' + response.status + ' - ' + text.slice(0, 2048).replaceAll(this.token, '[redacted]'));
      return text;
    } catch (error) {
      this.active(signal);
      if (timeout.signal.aborted && waiting) return undefined;
      if (timeout.signal.aborted) throw new Error('WeChat API request aborted (timeout)');
      if (error instanceof TypeError) throw new Error('WeChat API request failed');
      throw error;
    } finally { clearTimeout(timer); }
  }
  private async loadCursor(): Promise<string> {
    try { return string(object(JSON.parse(await readDocument(await managedPath(this.context.configRoot, 'wechat/sync.json')))).buf); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.patch({ lastError: 'Could not restore WeChat sync cursor: ' + errorMessage(error) });
      return '';
    }
  }
  private duplicate(message: ChannelInbound): boolean {
    if (!message.messageId) return false;
    const key = message.sessionKey + ':' + message.messageId, now = this.now();
    if (this.seen.has(key, now)) return true;
    this.seen.add(key, now);
    return false;
  }
  private async loop(): Promise<void> {
    let cursor = await this.loadCursor();
    while (!this.signal.aborted) {
      try {
        const raw = await this.request('ilink/bot/getupdates', { get_updates_buf: cursor, base_info: { channel_version: CHANNEL_VERSION } }, this.pollTimeout, this.signal, true);
        this.active();
        if (raw === undefined) continue;
        let parsed: unknown;
        try { parsed = JSON.parse(raw); } catch { throw new Error('Invalid WeChat update response'); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid WeChat update response');
        const response = object(parsed);
        if (response.errcode === -14) {
          this.patch({ connected: false, tokenStatus: 'expired', lastError: 'Session expired. Please re-login via Settings > Channels.' });
          await channelDelay(this.expiredBackoff, this.signal); continue;
        }
        if (typeof response.errcode === 'number' && response.errcode !== 0) throw new Error('WeChat update errcode=' + response.errcode);
        const nextCursor = string(response.get_updates_buf);
        if (nextCursor) {
          await atomicDocument(this.context.configRoot, join('wechat', 'sync.json'), JSON.stringify({ buf: nextCursor }));
          cursor = nextCursor;
        }
        this.active();
        this.patch({ connected: true, lastConnectedAt: this.now(), tokenStatus: 'valid' });
        if (!Array.isArray(response.msgs)) continue;
        for (const value of response.msgs) {
          this.active();
          const message = object(value); if (message.message_type === 2) continue;
          const inbound = wechatInbound(message, this.now());
          if (!inbound.text || this.duplicate(inbound)) continue;
          while (this.pending.size >= 128) { await Promise.race(this.pending); this.active(); }
          const contextToken = string(message.context_token);
          if (contextToken) {
            this.tokens.set(inbound.senderId, contextToken);
            if (this.tokens.size > CONTEXT_LIMIT) this.tokens.delete(this.tokens.keys().next().value!);
          }
          const work = this.handle(inbound, contextToken).catch(error => { if (!this.signal.aborted) this.patch({ lastError: 'Error: ' + errorMessage(error) }); });
          this.pending.add(work); void work.finally(() => this.pending.delete(work)).catch(() => undefined);
        }
      } catch (error) {
        if (this.signal.aborted) break;
        this.patch({ connected: false, lastError: 'Error: ' + errorMessage(error) });
        await channelDelay(this.errorBackoff, this.signal);
      }
    }
  }
  private async handle(message: ChannelInbound, contextToken: string): Promise<void> {
    this.patch({ lastInboundAt: this.now() });
    const outcome = await this.context.inbound(message, this.signal);
    this.active();
    if (!outcome.reply || outcome.manuallySent || outcome.dropped) return;
    await this.sendText(message.senderId, outcome.reply, contextToken || undefined, this.signal);
    this.patch({ lastOutboundAt: this.now() });
  }
  private async sendText(target: string, text: string, contextToken: string | undefined, signal: AbortSignal): Promise<void> {
    const raw = await this.request('ilink/bot/sendmessage', {
      msg: { from_user_id: '', to_user_id: target, client_id: 'klaus-wechat-' + randomUUID(), message_type: 2, message_state: 2,
        item_list: [{ type: 1, text_item: { text } }], ...(contextToken ? { context_token: contextToken } : {}) },
      base_info: { channel_version: CHANNEL_VERSION },
    }, this.sendTimeout, signal);
    let result: JsonObject;
    // The existing iLink send contract accepts a non-JSON HTTP success body.
    try { result = object(JSON.parse(raw ?? '')); } catch { return; }
    if (typeof result.errcode === 'number' && result.errcode !== 0) {
      const detail = string(result.errmsg).replaceAll(this.token, '[redacted]').slice(0, 2048);
      throw new Error('WeChat API sendmessage errcode=' + result.errcode + (detail ? ' ' + detail : '') + (contextToken ? '' : ' (no context_token — a user must DM the bot first before outbound send will deliver)'));
    }
  }
  send(params: ChannelSend, signal?: AbortSignal): Promise<JsonObject> {
    const combined = signal ? AbortSignal.any([this.signal, signal]) : this.signal;
    const work = (async (): Promise<JsonObject> => {
      this.active(combined);
      if (params.action && !['sendText', 'sendMessage'].includes(params.action)) throw new Error('WeChat action is not supported: ' + params.action);
      if (params.files?.length) throw new Error('WeChat channel replies do not support attachments yet');
      if (!params.targetId || !params.text?.trim()) throw new Error('WeChat channel reply target and text are required');
      await this.sendText(params.targetId, params.text, this.tokens.get(params.targetId), combined);
      this.patch({ lastOutboundAt: this.now() });
      return { ok: true };
    })().catch(error => ({ ok: false, error: errorMessage(error) }));
    this.pending.add(work); return work.finally(() => this.pending.delete(work));
  }
  close(): Promise<void> { this.controller.abort(); return this.closing ??= this.done; }
}
export function wechatAdapter(options: WechatTransportOptions = {}): ChannelAdapterFactory { return (account, context) => WechatTransport.start(account, context, options); }
