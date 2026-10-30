import { randomBytes } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { basename } from 'node:path';
import { managedPath } from '../extensions/file-store';
import { object, string, type JsonObject } from '../service-types';
import { ChannelHttp, ChannelHttpError, channelUrl, waitForChannelOperation, type ChannelHttpOptions } from './channel-http';
import { feishuId, type FeishuConfig } from './feishu-config';
import type { ChannelSend } from './types';

export class FeishuApiError extends Error { constructor(readonly code: number, readonly withdrawn = false) { super('Feishu API rejected the request (code ' + code + ')'); } }
export class FeishuAuthenticationError extends Error {}
export interface FeishuApiOptions extends ChannelHttpOptions { now?: () => number }
export interface FeishuEndpoint { url: string; service: number; pingIntervalMs: number; reconnectCount: number; reconnectIntervalMs: number; reconnectNonceMs: number }
export function feishuTiming(value: unknown, previous = { pingIntervalMs: 120_000, reconnectCount: -1, reconnectIntervalMs: 120_000, reconnectNonceMs: 30_000 }): Pick<FeishuEndpoint, 'pingIntervalMs' | 'reconnectCount' | 'reconnectIntervalMs' | 'reconnectNonceMs'> {
  const input = object(value), result = { ...previous };
  for (const [key, output] of [['PingInterval', 'pingIntervalMs'], ['ReconnectInterval', 'reconnectIntervalMs'], ['ReconnectNonce', 'reconnectNonceMs']] as const) {
    if (input[key] === undefined) continue; const seconds = input[key];
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < (key === 'ReconnectNonce' ? 0 : 0.001) || seconds > 86_400) throw new Error('Invalid Feishu gateway timing'); result[output] = Math.max(0, Math.floor(seconds * 1000));
  }
  if (input.ReconnectCount !== undefined) { if (!Number.isSafeInteger(input.ReconnectCount) || Number(input.ReconnectCount) < -1 || Number(input.ReconnectCount) > 10_000) throw new Error('Invalid Feishu reconnect count'); result.reconnectCount = Number(input.ReconnectCount); }
  return result;
}
const envelope = (value: JsonObject): JsonObject => {
  if (!Number.isSafeInteger(value.code)) throw new Error('Feishu response is missing a valid result code');
  if (value.code !== 0) throw new FeishuApiError(Number(value.code), [230011, 231003].includes(Number(value.code)) || /withdrawn|not found/iu.test(string(value.msg)));
  return value;
};

export class FeishuApi {
  private readonly http: ChannelHttp;
  private token?: { value: string; refreshAt: number };
  private tokenRequest?: Promise<string>;
  private downloads = 0;
  private readonly fileWrites = new Set<Promise<unknown>>();
  constructor(readonly config: FeishuConfig, private readonly root: string, signal: AbortSignal, private readonly options: FeishuApiOptions = {}) {
    this.http = new ChannelHttp('Feishu', config.domain, signal, { ...options, requestTimeoutMs: options.requestTimeoutMs ?? config.httpTimeoutMs });
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  active(signal = this.http.signal): void { this.http.active(signal); }
  async close(): Promise<void> { await this.http.close(); await this.tokenRequest?.catch(() => undefined); await Promise.allSettled([...this.fileWrites]); this.token = undefined; }
  accessToken(signal = this.http.signal): Promise<string> {
    this.active(signal); if (this.token && this.now() < this.token.refreshAt) return Promise.resolve(this.token.value);
    if (!this.tokenRequest) this.tokenRequest = (async () => {
      let value: JsonObject;
      try { value = envelope(await this.http.request('/open-apis/auth/v3/tenant_access_token/internal', 'POST', { app_id: this.config.appId, app_secret: this.config.appSecret }, { 'user-agent': 'klaus-desktop/feishu' })); }
      catch (error) { if (error instanceof FeishuApiError || (error instanceof ChannelHttpError && [401, 403].includes(error.status ?? 0))) throw new FeishuAuthenticationError('Feishu account authorization was rejected'); throw error; }
      const token = string(value.tenant_access_token), ttl = value.expire;
      if (!token || Buffer.byteLength(token) > 16_384 || /[\u0000-\u0020\u007f]/u.test(token) || !Number.isSafeInteger(ttl) || Number(ttl) <= 0 || Number(ttl) > 31_536_000) throw new FeishuAuthenticationError('Feishu access token response is malformed');
      this.active(); this.token = { value: token, refreshAt: this.now() + Math.max(1, Number(ttl) * 1000 - 180_000) }; return token;
    })().finally(() => { this.tokenRequest = undefined; });
    return waitForChannelOperation(this.tokenRequest, AbortSignal.any([this.http.signal, signal]), 'Feishu');
  }
  async call(path: string, method = 'GET', payload?: JsonObject, query: Record<string, string> = {}, signal = this.http.signal): Promise<JsonObject> {
    const token = await this.accessToken(signal);
    try { return envelope(await this.http.request(path, method, payload, { authorization: 'Bearer ' + token, 'user-agent': 'klaus-desktop/feishu' }, signal, query)); }
    catch (error) { if (error instanceof ChannelHttpError && error.status === 401 && this.token?.value === token) this.token = undefined; throw error; }
  }
  async identity(signal = this.http.signal): Promise<{ id: string; name?: string }> {
    const value = await this.call('/open-apis/bot/v3/info', 'GET', undefined, {}, signal), bot = object(value.bot ?? object(value.data).bot);
    return { id: feishuId(bot.open_id, 'bot open id'), ...(string(bot.app_name) ? { name: string(bot.app_name) } : {}) };
  }
  async gateway(signal = this.http.signal): Promise<FeishuEndpoint> {
    let value: JsonObject;
    try { value = envelope(await this.http.request('/callback/ws/endpoint', 'POST', { AppID: this.config.appId, AppSecret: this.config.appSecret }, { locale: 'zh' }, signal)); }
    catch (error) { if (error instanceof FeishuApiError && ![1, 1_000_040_343].includes(error.code)) throw new FeishuAuthenticationError('Feishu gateway rejected the account'); throw error; }
    const data = object(value.data), url = channelUrl(string(data.URL), true), service = Number(url.searchParams.get('service_id'));
    if (!url.searchParams.has('service_id') || !Number.isSafeInteger(service) || service < 0 || service > 2_147_483_647) throw new Error('Invalid Feishu gateway service id');
    return { url: url.toString(), service, ...feishuTiming(data.ClientConfig) };
  }
  async send(params: ChannelSend, signal = this.http.signal): Promise<JsonObject> {
    this.active(signal);
    if (!['sendText', 'sendMessage'].includes(params.action ?? 'sendText')) throw new Error('Feishu does not support this action');
    if (params.files?.length) throw new Error('Feishu channel replies do not support attachments yet');
    if (typeof params.text !== 'string' || !params.text.trim()) throw new Error('Feishu channel reply text is empty');
    if (Buffer.byteLength(params.text) > 64 * 1024) throw new Error('Feishu reply exceeds the size limit');
    const target = feishuId(feishuId(params.targetId, 'send target').replace(/^feishu:/iu, ''), 'send target'), reply = params.replyToMessageId || params.messageId;
    if (reply) feishuId(reply, 'reply message id');
    if (params.threadId && !reply) throw new Error('Feishu thread delivery requires a reply message id');
    const card = this.config.renderMode === 'card' || (this.config.renderMode === 'auto' && /[*_`#[\]|>~]/u.test(params.text));
    const payload: JsonObject = { content: JSON.stringify(card ? { config: { wide_screen_mode: true }, elements: [{ tag: 'markdown', content: params.text }] } : { text: params.text }), msg_type: card ? 'interactive' : 'text' };
    const direct = (): Promise<JsonObject> => this.call('/open-apis/im/v1/messages', 'POST', { receive_id: target, ...payload }, { receive_id_type: target.startsWith('oc_') ? 'chat_id' : 'open_id' }, signal);
    let value: JsonObject;
    if (reply) {
      try { value = await this.call('/open-apis/im/v1/messages/' + encodeURIComponent(reply) + '/reply', 'POST', { ...payload, ...(params.threadId ? { reply_in_thread: true } : {}) }, {}, signal); }
      catch (error) { if (!(error instanceof FeishuApiError) || !error.withdrawn) throw error; if (params.threadId) throw new Error('Feishu thread reply target is unavailable; cannot safely fall back'); value = await direct(); }
    } else value = await direct();
    const id = feishuId(object(value.data).message_id, 'delivery receipt'); return { ok: true, messageId: id, messageIds: [id] };
  }
  download(path: string, query: Record<string, string>, sender: string, fallback: string, kind: string, signal = this.http.signal, limit = 16 * 1024 * 1024): Promise<{ media: JsonObject; bytes: number }> {
    if (this.downloads >= 4) return Promise.reject(new Error('Feishu media download capacity exceeded'));
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 * 1024 * 1024) return Promise.reject(new Error('Feishu media exceeds the size limit'));
    this.downloads++;
    const task = (async (): Promise<{ media: JsonObject; bytes: number }> => {
      const token = await this.accessToken(signal), result = await this.http.bytes(path, 'GET', undefined, { authorization: 'Bearer ' + token }, signal, query, limit);
      this.active(signal);
      if (result.headers.get('content-type')?.includes('json')) { let value: JsonObject = {}; try { value = object(JSON.parse(result.bytes.toString('utf8'))); } catch { /* A downloaded JSON document may be invalid user content. */ } if (typeof value.code === 'number' && value.code !== 0) throw new FeishuApiError(value.code); }
      const disposition = result.headers.get('content-disposition') ?? ''; let name = fallback;
      const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(disposition)?.[1], quoted = /filename="([^"]*)"/iu.exec(disposition)?.[1];
      if (encoded) try { name = decodeURIComponent(encoded); } catch { /* Preserve the known filename when the vendor header is malformed. */ } else if (quoted) name = quoted;
      if (kind === 'image') { const subtype = result.headers.get('content-type')?.split(';')[0]?.split('/')[1]; name = fallback + '.' + (subtype && /^[a-zA-Z0-9+-]{1,20}$/u.test(subtype) ? subtype.replace('svg+xml', 'svg') : 'png'); }
      let safeName = '', nameBytes = 0;
      for (const character of basename(name.replace(/\\/gu, '/')).replace(/[\u0000-\u001f\u007f<>:"|?*]/gu, '_')) {
        nameBytes += Buffer.byteLength(character); if (nameBytes > 180) break; safeName += character;
      }
      safeName ||= 'file';
      const relative = 'uploads/' + sender.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 128) + '/' + this.now() + '-' + randomBytes(8).toString('hex') + '-' + safeName;
      const destination = await managedPath(this.root, relative, true); this.active(signal);
      const output = await open(destination, 'wx', 0o600);
      try { await output.writeFile(result.bytes); await output.sync(); this.active(signal); }
      catch (error) { await output.close(); await unlink(destination).catch(() => undefined); throw error; }
      await output.close();
      if (signal.aborted) { await unlink(destination).catch(() => undefined); this.active(signal); }
      return { media: { type: kind, path: destination, ...(['image', 'file'].includes(kind) ? { fileName: kind === 'image' ? fallback : safeName } : {}) }, bytes: result.bytes.length };
    })();
    this.fileWrites.add(task); return task.finally(() => { this.downloads--; this.fileWrites.delete(task); });
  }
}
