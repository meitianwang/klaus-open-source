import { string, type JsonObject } from '../service-types';
import { qqId, qqInteger, qqSendTarget } from './qq-wire';
import type { ChannelSend } from './types';

export interface QQApiOptions { apiBase?: string; tokenUrl?: string; requestTimeoutMs?: number; now?: () => number; fetch?: typeof fetch }
export class QQApiError extends Error { constructor(message: string, readonly status?: number, readonly authentication = false) { super(message); } }
export function qqUrl(raw: string, websocket = false): URL {
  const url = new URL(raw), secure = websocket ? 'wss:' : 'https:', insecure = websocket ? 'ws:' : 'http:';
  if ((url.protocol !== secure && !(url.protocol === insecure && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) || url.username || url.password || url.hash || (!websocket && url.search)) throw new Error('QQ requires a secure endpoint URL');
  return url;
}
function waitForToken<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('QQ operation was cancelled'));
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => reject(new Error('QQ operation was cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    void promise.then(value => { signal.removeEventListener('abort', cancel); resolve(value); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
    if (signal.aborted) cancel();
  });
}

/** Account-scoped token singleflight and bounded REST I/O; no credential file or global token cache. */
export class QQApi {
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly base: URL;
  private readonly tokenUrl: URL;
  private readonly timeout: number;
  private token?: { value: string; refreshAt: number };
  private tokenRequest?: Promise<string>;
  private sequence = 0;
  constructor(private readonly appId: string, private readonly secret: string, signal: AbortSignal, private readonly options: QQApiOptions = {}) {
    if (!/^\d{1,32}$/u.test(appId)) throw new Error('Invalid QQ app id');
    if (!secret.trim() || Buffer.byteLength(secret) > 16_384 || /[\u0000-\u001f\u007f]/u.test(secret)) throw new Error('Invalid QQ client secret');
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.base = qqUrl((options.apiBase ?? 'https://api.sgroup.qq.com').replace(/\/+$/u, '') + '/');
    this.tokenUrl = qqUrl(options.tokenUrl ?? 'https://bots.qq.com/app/getAppAccessToken');
    this.timeout = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1) throw new Error('Invalid QQ request timeout');
  }
  private active(signal: AbortSignal): void { if (signal.aborted) throw new Error('QQ operation was cancelled'); }
  clearToken(): void { this.token = undefined; }
  async close(): Promise<void> { this.controller.abort(); await Promise.allSettled([...this.pending]); await this.tokenRequest?.catch(() => undefined); this.clearToken(); }
  private request(url: URL, init: RequestInit, signal: AbortSignal): Promise<{ status: number; value: JsonObject }> {
    if (this.pending.size >= 64) return Promise.reject(new Error('QQ HTTP request capacity exceeded'));
    const operation = (async () => {
      const timeout = new AbortController(), combined = AbortSignal.any([this.signal, signal, timeout.signal]); this.active(combined);
      const timer = setTimeout(() => timeout.abort(), this.timeout);
      try {
        const response = await (this.options.fetch ?? fetch)(url, { ...init, redirect: 'error', signal: combined });
        const chunks: Uint8Array[] = [], reader = response.body?.getReader(); let size = 0;
        if (reader) try {
          for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > 1024 * 1024) { await reader.cancel(); throw new QQApiError('QQ response exceeds the size limit'); } chunks.push(chunk.value); }
        } finally { reader.releaseLock(); }
        this.active(combined);
        let parsed: unknown; try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new QQApiError('Malformed QQ HTTP response', response.status); }
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new QQApiError('Malformed QQ HTTP response', response.status);
        return { status: response.status, value: parsed as JsonObject };
      } catch (error) {
        this.active(this.signal); this.active(signal);
        if (timeout.signal.aborted) throw new Error('QQ request timed out');
        if (error instanceof QQApiError) throw error;
        // Vendor and transport errors can echo Authorization or clientSecret.
        throw new Error('QQ network request failed');
      } finally { clearTimeout(timer); }
    })();
    this.pending.add(operation); return operation.finally(() => this.pending.delete(operation));
  }
  accessToken(signal = this.signal): Promise<string> {
    this.active(this.signal); this.active(signal);
    if (this.token && (this.options.now?.() ?? Date.now()) < this.token.refreshAt) return Promise.resolve(this.token.value);
    if (!this.tokenRequest) this.tokenRequest = (async () => {
      const result = await this.request(this.tokenUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ appId: this.appId, clientSecret: this.secret }) }, this.signal);
      const value = string(result.value.access_token), ttl = qqInteger(result.value.expires_in);
      if (result.status < 200 || result.status >= 300 || !value || /[\u0000-\u0020\u007f]/u.test(value) || Buffer.byteLength(value) > 16_384 || !ttl || ttl > 31_536_000) throw new QQApiError('QQ access token request was rejected or malformed (HTTP ' + result.status + ')', result.status, result.status === 401 || result.status === 403 || (result.status >= 200 && result.status < 300));
      this.active(this.signal); this.token = { value, refreshAt: (this.options.now?.() ?? Date.now()) + Math.max(1, ttl * 1000 - 300_000) }; return value;
    })().finally(() => { this.tokenRequest = undefined; });
    return waitForToken(this.tokenRequest, AbortSignal.any([this.signal, signal]));
  }
  private async call(path: string, payload: JsonObject | undefined, signal: AbortSignal): Promise<JsonObject> {
    const url = new URL('.' + path, this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname)) throw new Error('QQ request escaped the API root');
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.accessToken(signal); this.active(signal);
      const result = await this.request(url, { method: payload ? 'POST' : 'GET', headers: { Authorization: 'QQBot ' + token, 'content-type': 'application/json' }, ...(payload ? { body: JSON.stringify(payload) } : {}) }, signal);
      if (result.status === 401 && attempt === 0) { if (this.token?.value === token) this.clearToken(); continue; }
      const code = qqInteger(result.value.code);
      if (result.status < 200 || result.status >= 300 || (result.value.code !== undefined && code !== 0)) throw new QQApiError('QQ API rejected the request (HTTP ' + result.status + (code === undefined ? '' : ', code ' + code) + ')', result.status, result.status === 401 || result.status === 403);
      return result.value;
    }
    throw new QQApiError('QQ token refresh did not restore authorization', 401, true);
  }
  async gateway(): Promise<string> { return qqUrl(string((await this.call('/gateway', undefined, this.signal)).url), true).toString(); }
  async send(params: ChannelSend, signal = this.signal): Promise<JsonObject> {
    this.active(this.signal); this.active(signal);
    if (!['sendText', 'sendMessage'].includes(params.action ?? 'sendText')) throw new Error('QQ does not support this action');
    if (params.files?.length) throw new Error('QQ channel replies do not support attachments yet');
    if (typeof params.text !== 'string' || !params.text.trim()) throw new Error('QQ channel reply text is empty');
    if (Buffer.byteLength(params.text) > 64 * 1024) throw new Error('QQ channel reply exceeds the size limit');
    const target = qqSendTarget(params), reply = params.replyToMessageId || params.messageId;
    if (reply !== undefined) qqId(reply, 'reply message id');
    if (this.sequence >= 2_147_483_647) throw new Error('QQ message sequence capacity exceeded');
    const payload: JsonObject = { content: params.text, msg_type: 0, msg_seq: ++this.sequence, ...(reply ? { msg_id: reply } : {}) };
    const result = await this.call('/v2/' + (target.group ? 'groups/' : 'users/') + target.id + '/messages', payload, signal);
    const id = qqId(result.id, 'outbound receipt id'); return { ok: true, messageId: id, messageIds: [id] };
  }
}
