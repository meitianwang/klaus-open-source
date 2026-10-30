import { constants } from 'node:fs';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join } from 'node:path';
import { managedPath } from '../extensions/file-store';
import { errorMessage, object, string, type JsonObject } from '../service-types';

export const TELEGRAM_ATTACHMENT_LIMIT = 50 * 1024 * 1024;
export interface TelegramApiOptions { fetch?: typeof fetch; apiBase?: string; requestTimeoutMs?: number; now?: () => number }
export class TelegramApiError extends Error {
  constructor(message: string, readonly code?: number, readonly retryAfter?: number) { super(message); }
}
export class TelegramApi {
  private readonly base: URL;
  private readonly fetch: typeof fetch;
  private readonly timeout: number;
  constructor(private readonly token: string, private readonly configRoot: string, private readonly signal: AbortSignal, private readonly options: TelegramApiOptions) {
    if (!/^[a-z0-9_:-]+$/iu.test(token)) throw new Error('Invalid Telegram bot token');
    this.base = new URL((options.apiBase || 'https://api.telegram.org').replace(/\/+$/u, '') + '/');
    if (!['https:', 'http:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.hash || this.base.search) throw new Error('Invalid Telegram API URL');
    this.fetch = options.fetch ?? fetch; this.timeout = options.requestTimeoutMs ?? 60_000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1) throw new Error('Invalid Telegram request timeout');
  }
  private active(signal: AbortSignal): void { if (signal.aborted) throw new Error('Telegram operation was cancelled'); }
  private async request(path: string, init: RequestInit, limit: number, signal?: AbortSignal): Promise<Buffer> {
    const timeout = new AbortController(), combined = AbortSignal.any([this.signal, ...(signal ? [signal] : []), timeout.signal]);
    this.active(combined);
    const timer = setTimeout(() => timeout.abort(), this.timeout);
    try {
      // Bot tokens contain ':', so an unprefixed relative path would be parsed
      // as a URL scheme instead of remaining under the configured API origin.
      const response = await this.fetch(new URL('./' + path, this.base), { ...init, signal: combined, redirect: 'error' });
      const reader = response.body?.getReader(), parts: Uint8Array[] = []; let length = 0;
      if (reader) try {
        for (;;) {
          const part = await reader.read(); if (part.done) break;
          length += part.value.byteLength;
          if (length > limit) { await reader.cancel(); throw new Error('Telegram response exceeds the size limit'); }
          parts.push(part.value);
        }
      } finally { reader.releaseLock(); }
      this.active(combined);
      const bytes = Buffer.concat(parts);
      if (!response.ok) {
        let apiFailure = false;
        if (init.method) try { apiFailure = object(JSON.parse(bytes.toString('utf8'))).ok === false; } catch { /* Preserve HTTP failure. */ }
        if (!apiFailure) throw new TelegramApiError('Telegram request failed: HTTP ' + response.status);
      }
      return bytes;
    } catch (error) {
      this.active(this.signal); if (signal) this.active(signal);
      if (timeout.signal.aborted) throw new TelegramApiError('Telegram request timed out');
      throw new TelegramApiError(errorMessage(error).replaceAll(this.token, '[redacted]'));
    } finally { clearTimeout(timer); }
  }
  private decode(raw: Buffer): unknown {
    let value: unknown;
    try { value = JSON.parse(raw.toString('utf8')); } catch { throw new TelegramApiError('Invalid Telegram API JSON'); }
    const response = object(value);
    if (response.ok === true && Object.hasOwn(response, 'result')) return response.result;
    if (response.ok !== false) throw new TelegramApiError('Malformed Telegram API result');
    const retry = object(response.parameters).retry_after;
    throw new TelegramApiError(string(response.description, 'Telegram Bot API call failed').replaceAll(this.token, '[redacted]'), typeof response.error_code === 'number' ? response.error_code : 0, typeof retry === 'number' && Number.isSafeInteger(retry) && retry >= 0 ? retry : undefined);
  }
  async call(method: string, body: JsonObject, signal?: AbortSignal): Promise<unknown> {
    return this.decode(await this.request('bot' + this.token + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, 4 * 1024 * 1024, signal));
  }
  async upload(method: string, field: string, chatId: string | number, raw: string, options: JsonObject, signal?: AbortSignal): Promise<unknown> {
    if (!isAbsolute(raw) || raw.includes('\0')) throw new Error('Telegram file path must be absolute');
    const sensitive = (name: string): boolean => /^(?:\.env(?:\.|$))|\.(?:pem|key|p12|pfx)$|secret|token|credential|password/iu.test(name);
    const resolved = await realpath(raw);
    if (sensitive(basename(raw)) || sensitive(basename(resolved))) throw new Error('Refusing to send a sensitive-looking file');
    const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    let data: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > TELEGRAM_ATTACHMENT_LIMIT) throw new Error('Telegram attachment must be a regular file no larger than 50 MB');
      data = Buffer.alloc(Math.min(info.size + 1, TELEGRAM_ATTACHMENT_LIMIT + 1)); let length = 0;
      while (length < data.length) { const next = await handle.read(data, length, data.length - length, null); if (!next.bytesRead) break; length += next.bytesRead; }
      if (length !== info.size) throw new Error('Telegram attachment changed while reading');
      data = data.subarray(0, length);
    } finally { await handle.close(); }
    this.active(this.signal); if (signal) this.active(signal);
    const form = new FormData(); form.set('chat_id', String(chatId));
    for (const [name, value] of Object.entries(options)) form.set(name, typeof value === 'string' ? value : JSON.stringify(value));
    form.set(field, new Blob([Uint8Array.from(data)]), basename(resolved));
    return this.decode(await this.request('bot' + this.token + '/' + method, { method: 'POST', body: form }, 4 * 1024 * 1024, signal));
  }
  async download(fileId: string, fallbackName?: string, signal?: AbortSignal): Promise<string> {
    if (!fileId) throw new Error('Telegram download requires fileId');
    const file = object(await this.call('getFile', { file_id: fileId }, signal)), path = string(file.file_path);
    if (!path || path.startsWith('/') || path.split('/').some(part => !part || part === '.' || part === '..') || /[\\\0?#]/u.test(path)) throw new Error('Telegram returned an invalid file_path');
    if (typeof file.file_size === 'number' && file.file_size > TELEGRAM_ATTACHMENT_LIMIT) throw new Error('Telegram attachment exceeds 50 MB');
    const bytes = await this.request('file/bot' + this.token + '/' + path.split('/').map(encodeURIComponent).join('/'), {}, TELEGRAM_ATTACHMENT_LIMIT, signal);
    const id = (string(file.file_unique_id) || fileId).replace(/[^a-z0-9_-]/giu, '').slice(0, 80) || 'file';
    let extension = (extname(fallbackName || '') || extname(path) || '.bin').replace(/[^a-z0-9.]/giu, '') || '.bin';
    if (!extension.startsWith('.')) extension = '.' + extension;
    const name = String(this.options.now?.() ?? Date.now()) + '-' + id + extension;
    const destination = await managedPath(this.configRoot, join('channels/telegram/inbox', name), true);
    this.active(this.signal); if (signal) this.active(signal);
    await mkdir(dirname(destination), { recursive: true });
    this.active(this.signal); if (signal) this.active(signal);
    const output = await open(destination, 'wx', 0o600);
    let complete = false;
    try {
      this.active(this.signal); if (signal) this.active(signal);
      await output.writeFile(bytes);
      this.active(this.signal); if (signal) this.active(signal);
      complete = true;
    } finally {
      await output.close();
      if (!complete) await unlink(destination);
    }
    return destination;
  }
}
