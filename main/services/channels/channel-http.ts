import type { JsonObject } from '../service-types';

export interface ChannelHttpOptions { apiBase?: string; requestTimeoutMs?: number; fetch?: typeof fetch }
export class ChannelHttpError extends Error {
  constructor(message: string, readonly kind: 'rejected' | 'malformed' | 'transport', readonly status?: number) { super(message); }
}
export function channelUrl(raw: string, websocket = false): URL {
  let url: URL; try { url = new URL(raw); } catch { throw new Error('Invalid channel endpoint URL'); }
  const secure = websocket ? 'wss:' : 'https:', insecure = websocket ? 'ws:' : 'http:';
  if ((url.protocol !== secure && !(url.protocol === insecure && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) || url.username || url.password || url.hash || (!websocket && url.search)) throw new Error('Channel endpoint must use secure transport');
  return url;
}
export function waitForChannelOperation<T>(promise: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error(label + ' operation was cancelled'));
  return new Promise<T>((resolve, reject) => {
    const cancel = (): void => reject(new Error(label + ' operation was cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    void promise.then(value => { signal.removeEventListener('abort', cancel); resolve(value); }, error => { signal.removeEventListener('abort', cancel); reject(error); });
    if (signal.aborted) cancel();
  });
}

/** Bounded account-owned HTTP. Vendor bodies, credentials and endpoint tickets never enter errors. */
export class ChannelHttp {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly base: URL;
  private readonly timeout: number;
  constructor(private readonly label: string, defaultBase: string, signal: AbortSignal, private readonly options: ChannelHttpOptions = {}) {
    this.signal = AbortSignal.any([signal, this.controller.signal]);
    this.base = channelUrl((options.apiBase ?? defaultBase).replace(/\/+$/u, '') + '/');
    this.timeout = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1) throw new Error('Invalid channel HTTP timeout');
  }
  active(signal = this.signal): void { if (this.signal.aborted || signal.aborted) throw new Error(this.label + ' operation was cancelled'); }
  async close(): Promise<void> { this.controller.abort(); await Promise.allSettled([...this.pending]); }
  async request(path: string, method: string, body?: JsonObject, headers: Record<string, string> = {}, signal = this.signal, query: Record<string, string> = {}): Promise<JsonObject> {
    const response = await this.bytes(path, method, body, headers, signal, query, 1024 * 1024);
    let value: unknown;
    try { value = JSON.parse(response.bytes.toString('utf8')); } catch { throw new ChannelHttpError(this.label + ' response is malformed', 'malformed', response.status); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ChannelHttpError(this.label + ' response is malformed', 'malformed', response.status);
    return value as JsonObject;
  }
  bytes(path: string, method: string, body: JsonObject | undefined, headers: Record<string, string>, signal = this.signal, query: Record<string, string> = {}, limit = 16 * 1024 * 1024): Promise<{ bytes: Buffer; headers: Headers; status: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 * 1024 * 1024) return Promise.reject(new Error('Invalid channel response limit'));
    if (this.pending.size >= 64) return Promise.reject(new Error(this.label + ' HTTP request capacity exceeded'));
    const operation = (async () => {
      this.active(signal);
      const url = new URL('.' + path, this.base);
      if (!path.startsWith('/') || url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname) || url.search || url.hash) throw new Error('Channel request escaped the API root');
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
      const timeout = new AbortController(), combined = AbortSignal.any([this.signal, signal, timeout.signal]);
      const timer = setTimeout(() => timeout.abort(), this.timeout);
      try {
        const response = await (this.options.fetch ?? fetch)(url, { method, headers: { ...headers, 'content-type': 'application/json', accept: 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: combined });
        if (!response.ok) { await response.body?.cancel().catch(() => undefined); throw new ChannelHttpError(this.label + ' request was rejected (HTTP ' + response.status + ')', 'rejected', response.status); }
        const chunks: Uint8Array[] = [], reader = response.body?.getReader(); let size = 0;
        if (reader) try {
          for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.byteLength; if (size > limit) { await reader.cancel(); throw new ChannelHttpError(this.label + ' response exceeds the size limit', 'malformed', response.status); } chunks.push(chunk.value); }
        } finally { reader.releaseLock(); }
        this.active(combined);
        return { bytes: Buffer.concat(chunks, size), headers: response.headers, status: response.status };
      } catch (error) {
        this.active(signal);
        if (timeout.signal.aborted) throw new ChannelHttpError(this.label + ' request timed out', 'transport');
        if (error instanceof ChannelHttpError) throw error;
        throw new ChannelHttpError(this.label + ' network request failed', 'transport');
      } finally { clearTimeout(timer); }
    })();
    this.pending.add(operation); return operation.finally(() => this.pending.delete(operation));
  }
}
