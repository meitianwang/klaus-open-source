import { constants } from 'node:fs';
import { open, realpath, unlink } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { managedPath } from '../extensions/file-store';
import { errorMessage, object, string, type JsonObject } from '../service-types';
import { channelDelay } from './types';

const ATTACHMENT_LIMIT = 25 * 1024 * 1024;
export interface DiscordApiOptions { apiBase?: string; fetch?: typeof fetch; requestTimeoutMs?: number; now?: () => number }
export class DiscordApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}
export function discordId(value: unknown, label = 'id'): string {
  if (typeof value !== 'string' || !/^\d{1,24}$/u.test(value)) throw new Error('Invalid Discord ' + label);
  return value;
}

/** Bot REST traffic is restricted to the configured API origin; downloads carry no token. */
export class DiscordApi {
  private readonly base: URL;
  private readonly fetch: typeof fetch;
  private readonly timeout: number;
  private globalRetryAt = 0;
  constructor(private readonly token: string, private readonly root: string, private readonly signal: AbortSignal, private readonly options: DiscordApiOptions) {
    if (!token || /[\x00-\x20\x7f]/u.test(token)) throw new Error('Invalid Discord bot token');
    this.base = new URL((options.apiBase || 'https://discord.com/api/v10').replace(/\/+$/u, '') + '/');
    if (!['https:', 'http:'].includes(this.base.protocol) || this.base.username || this.base.password || this.base.hash || this.base.search) throw new Error('Invalid Discord API URL');
    this.fetch = options.fetch ?? fetch; this.timeout = options.requestTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.timeout) || this.timeout < 1) throw new Error('Invalid Discord request timeout');
  }
  private active(signal: AbortSignal): void { if (signal.aborted) throw new Error('Discord operation was cancelled'); }
  private async request(url: URL, init: RequestInit, limit: number, signal: AbortSignal): Promise<{ status: number; bytes: Buffer; headers: Headers }> {
    const timeout = new AbortController(), combined = AbortSignal.any([this.signal, signal, timeout.signal]);
    this.active(combined); const timer = setTimeout(() => timeout.abort(), this.timeout);
    try {
      const response = await this.fetch(url, { ...init, signal: combined, redirect: 'error' });
      const reader = response.body?.getReader(), parts: Uint8Array[] = []; let length = 0;
      if (reader) try {
        for (;;) {
          const part = await reader.read(); if (part.done) break; length += part.value.byteLength;
          if (length > limit) { await reader.cancel(); throw new Error('Discord response exceeds the size limit'); }
          parts.push(part.value);
        }
      } finally { reader.releaseLock(); }
      this.active(combined);
      return { status: response.status, bytes: Buffer.concat(parts), headers: response.headers };
    } catch (error) {
      this.active(this.signal); this.active(signal);
      if (timeout.signal.aborted) throw new Error('Discord request timed out');
      throw new Error(errorMessage(error).replaceAll(this.token, '[redacted]'));
    } finally { clearTimeout(timer); }
  }
  async call(method: string, path: string, body?: JsonObject | FormData, signal = this.signal): Promise<unknown> {
    signal = AbortSignal.any([this.signal, signal]);
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\0#]/u.test(path)) throw new Error('Invalid Discord REST path');
    const url = new URL('.' + path, this.base);
    if (url.origin !== this.base.origin || !url.pathname.startsWith(this.base.pathname)) throw new Error('Discord REST path escaped the API root');
    for (let attempt = 0; attempt < 3; attempt++) {
      await channelDelay(Math.max(0, this.globalRetryAt - Date.now()), signal); this.active(signal);
      const multipart = body instanceof FormData;
      const response = await this.request(url, { method, headers: { Authorization: 'Bot ' + this.token, 'User-Agent': 'DiscordBot (https://github.com/klaus, 1.0)', ...(!multipart && body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: multipart ? body : JSON.stringify(body) } : {}) }, 4 * 1024 * 1024, signal);
      let value: unknown = null;
      if (response.bytes.length) try { value = JSON.parse(response.bytes.toString('utf8')); }
      catch { throw new DiscordApiError('Invalid Discord REST JSON', response.status); }
      if (response.status === 429 && attempt < 2) {
        const row = object(value), retry = row.retry_after ?? Number(response.headers.get('retry-after'));
        if (typeof retry !== 'number' || !Number.isFinite(retry) || retry < 0 || retry > 3600) throw new DiscordApiError('Invalid Discord rate-limit delay', 429);
        const ms = Math.max(1, Math.ceil(retry * 1000));
        if (row.global === true) this.globalRetryAt = Math.max(this.globalRetryAt, Date.now() + ms);
        await channelDelay(ms, signal); this.active(signal); continue;
      }
      if (response.status < 200 || response.status >= 300) throw new DiscordApiError(string(object(value).message, 'Discord REST HTTP ' + response.status).replaceAll(this.token, '[redacted]'), response.status);
      if (response.status !== 204 && (value === null || typeof value !== 'object')) throw new DiscordApiError('Malformed Discord REST result', response.status);
      return value;
    }
    throw new DiscordApiError('Discord REST rate-limit retries exhausted', 429);
  }
  async files(raw: unknown[], signal = this.signal): Promise<Array<{ name: string; bytes: Buffer }>> {
    signal = AbortSignal.any([this.signal, signal]);
    if (raw.length > 10) throw new Error('Discord allows at most 10 attachments per message');
    const result: Array<{ name: string; bytes: Buffer }> = [];
    for (const item of raw) {
      this.active(signal);
      if (typeof item !== 'string' || !isAbsolute(item) || item.includes('\0')) throw new Error('Discord attachment path must be absolute');
      const path = await realpath(item), sensitive = (name: string) => /^(?:\.env(?:\.|$))|\.(?:pem|key|p12|pfx)$|secret|token|credential|password/iu.test(name);
      if (sensitive(basename(item)) || sensitive(basename(path))) throw new Error('Refusing to send a sensitive-looking file');
      const state = await realpath(join(this.root, 'channels/discord')).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; });
      if (state) {
        const fromState = relative(state, path), fromInbox = relative(join(state, 'inbox'), path);
        if (fromState !== '..' && !fromState.startsWith('..' + sep) && !isAbsolute(fromState) && (fromInbox === '..' || fromInbox.startsWith('..' + sep) || isAbsolute(fromInbox))) throw new Error('Refusing to send Discord channel state');
      }
      const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > ATTACHMENT_LIMIT) throw new Error('Discord attachment must be a regular file no larger than 25 MB');
        const buffer = Buffer.alloc(stat.size + 1); let length = 0;
        while (length < buffer.length) { this.active(signal); const read = await handle.read(buffer, length, buffer.length - length, null); if (!read.bytesRead) break; length += read.bytesRead; }
        if (length !== stat.size) throw new Error('Discord attachment changed while reading');
        result.push({ name: basename(path), bytes: buffer.subarray(0, length) });
      } finally { await handle.close(); }
    }
    return result;
  }
  createMessage(channelId: string, payload: JsonObject, files: Array<{ name: string; bytes: Buffer }> = [], signal = this.signal): Promise<unknown> {
    let body: JsonObject | FormData = payload;
    if (files.length) {
      const form = new FormData(); form.set('payload_json', JSON.stringify(payload));
      files.forEach((file, index) => form.set('files[' + index + ']', new Blob([Uint8Array.from(file.bytes)]), file.name)); body = form;
    }
    return this.call('POST', '/channels/' + discordId(channelId, 'channel id') + '/messages', body, signal);
  }
  async download(attachment: JsonObject, signal = this.signal): Promise<string> {
    signal = AbortSignal.any([this.signal, signal]);
    if (typeof attachment.size === 'number' && attachment.size > ATTACHMENT_LIMIT) throw new Error('Discord attachment exceeds 25 MB');
    const url = new URL(string(attachment.url));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid Discord attachment URL');
    // Only URLs returned by a fetched Discord message reach here; the bot token
    // is intentionally absent even if the attachment uses another CDN origin.
    const response = await this.request(url, {}, ATTACHMENT_LIMIT, signal);
    if (response.status < 200 || response.status >= 300) throw new DiscordApiError('Discord download HTTP ' + response.status, response.status);
    const id = discordId(attachment.id, 'attachment id'), suffix = extname(string(attachment.filename)).replace(/[^a-z0-9.]/giu, '').slice(0, 30) || '.bin';
    const path = await managedPath(this.root, join('channels/discord/inbox', (this.options.now?.() ?? Date.now()) + '-' + id + suffix), true);
    this.active(signal); const handle = await open(path, 'wx', 0o600); let complete = false;
    try { this.active(signal); await handle.writeFile(response.bytes); this.active(signal); complete = true; }
    finally { await handle.close(); if (!complete) await unlink(path); }
    return path;
  }
}
