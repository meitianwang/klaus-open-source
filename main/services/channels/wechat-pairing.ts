import { errorMessage, object, string, type JsonObject } from '../service-types';
import { ChannelSettingsStore } from './settings-store';
import { qrPngDataUrl } from './qr-code';

const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
const MAX_RESPONSE_BYTES = 64 * 1024;
interface PairingFlow {
  controller: AbortController;
  baseUrl?: string;
  qrcode?: string;
  poll?: Promise<JsonObject>;
}
export interface WechatPairingDeps {
  configRoot: string;
  store?: ChannelSettingsStore;
  fetch?: typeof fetch;
  encodeQr?: (text: string) => Promise<string>;
  startTimeoutMs?: number;
  pollTimeoutMs?: number;
  /** Must start the real adapter and honor cancellation during shutdown. */
  onPaired: (accountId: string, signal: AbortSignal) => Promise<void>;
}

function baseUrl(raw: string): string {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('Invalid WeChat gateway URL');
  return url.toString().replace(/\/+$/u, '') + '/';
}
function timeout(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) throw new Error('Invalid pairing timeout');
  return value;
}

/** Owns one QR flow. Old responses cannot overwrite a replacement account. */
export class WechatPairingService {
  private readonly store: ChannelSettingsStore;
  private readonly fetch: typeof fetch;
  private readonly startTimeoutMs: number;
  private readonly pollTimeoutMs: number;
  private readonly pending = new Set<Promise<unknown>>();
  private flow?: PairingFlow;
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly deps: WechatPairingDeps) {
    if (typeof deps.onPaired !== 'function') throw new Error('WeChat pairing requires a real adapter start hook');
    this.store = deps.store ?? new ChannelSettingsStore(deps.configRoot);
    this.fetch = deps.fetch ?? fetch;
    this.startTimeoutMs = timeout(deps.startTimeoutMs, 30_000);
    this.pollTimeoutMs = timeout(deps.pollTimeoutMs, 35_000);
  }
  private current(flow: PairingFlow): void {
    if (this.closed || flow.controller.signal.aborted || this.flow !== flow) throw new Error('WeChat pairing was cancelled');
  }
  private track(action: () => Promise<JsonObject>): Promise<JsonObject> {
    if (this.closed) return Promise.resolve({ ok: false, error: 'WeChat pairing service is closed' });
    const promise = action().catch(error => ({ ok: false, error: errorMessage(error) }));
    this.pending.add(promise);
    return promise.finally(() => { this.pending.delete(promise); });
  }
  private async request(flow: PairingFlow, endpoint: string, poll: boolean): Promise<JsonObject> {
    this.current(flow);
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    flow.controller.signal.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, poll ? this.pollTimeoutMs : this.startTimeoutMs);
    try {
      const response = await this.fetch(new URL(endpoint, flow.baseUrl), {
        method: 'GET', signal: controller.signal, redirect: 'error',
        ...(poll ? { headers: { 'iLink-App-ClientVersion': '1' } } : {}),
      });
      if (!response.ok) throw new Error(`${poll ? 'QR status poll' : 'QR code fetch'} failed: HTTP ${response.status}`);
      if (!response.body) throw new Error('Empty WeChat QR response');
      const reader = response.body.getReader();
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error('WeChat QR response is too large'); }
          parts.push(part.value);
        }
      } finally { reader.releaseLock(); }
      this.current(flow);
      let value: unknown;
      try { value = JSON.parse(Buffer.concat(parts).toString('utf8')); }
      catch { throw new Error('Invalid WeChat QR response'); }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid WeChat QR response');
      return object(value);
    } catch (error) {
      this.current(flow);
      if (timedOut && poll) return { status: 'wait' };
      if (timedOut) throw new Error('WeChat QR request timed out');
      // Network errors can contain the QR query or gateway response. Keep them local.
      if (error instanceof TypeError) throw new Error('WeChat QR request failed');
      throw error;
    } finally {
      clearTimeout(timer);
      flow.controller.signal.removeEventListener('abort', cancel);
    }
  }
  start(): Promise<JsonObject> {
    if (this.closed) return Promise.resolve({ ok: false, error: 'WeChat pairing service is closed' });
    this.flow?.controller.abort();
    const flow: PairingFlow = { controller: new AbortController() };
    this.flow = flow;
    return this.track(async () => {
      try {
        flow.baseUrl = baseUrl(this.store.get('channel.wechat.base_url') || DEFAULT_BASE_URL);
        const body = await this.request(flow, 'ilink/bot/get_bot_qrcode?bot_type=3', false);
        const qrcode = string(body.qrcode), content = string(body.qrcode_img_content);
        if (!qrcode || !content || qrcode.length > 4_096) throw new Error('Incomplete WeChat QR response');
        const qrcodeDataUrl = await (this.deps.encodeQr ?? qrPngDataUrl)(content);
        this.current(flow);
        flow.qrcode = qrcode;
        return { ok: true, qrcodeDataUrl };
      } catch (error) { if (this.flow === flow) this.flow = undefined; flow.controller.abort(); throw error; }
    });
  }
  poll(): Promise<JsonObject> {
    const flow = this.flow;
    if (!flow?.qrcode) return Promise.resolve({ ok: false, error: 'no active QR session' });
    if (flow.poll) return flow.poll;
    const pending = this.track(async (): Promise<JsonObject> => {
      const body = await this.request(flow, 'ilink/bot/get_qrcode_status?' + new URLSearchParams({ qrcode: flow.qrcode! }).toString(), true);
      this.current(flow);
      const status = string(body.status);
      if (!status) throw new Error('Invalid WeChat QR status');
      if (status === 'expired') { this.flow = undefined; flow.controller.abort(); }
      if (status !== 'confirmed') return { ok: true, status };
      const token = string(body.bot_token), accountId = string(body.ilink_bot_id);
      if (!token || !accountId) throw new Error('Confirmed WeChat pairing did not include credentials');
      const resolvedBase = body.baseurl ? baseUrl(string(body.baseurl)) : flow.baseUrl!;
      this.store.saveWechatPairing({ token, accountId, baseUrl: resolvedBase.replace(/\/$/u, '') });
      // Consume the grant, but keep the controller reachable until hot-start ends.
      flow.qrcode = undefined;
      try {
        await this.deps.onPaired(accountId, flow.controller.signal);
        if (this.closed || flow.controller.signal.aborted) throw new Error('WeChat pairing was cancelled');
      } catch (error) {
        return { ok: false, saved: true, accountId, error: 'WeChat account was saved, but starting the adapter failed: ' + errorMessage(error) };
      } finally { if (this.flow === flow) this.flow = undefined; }
      return { ok: true, status: 'confirmed', accountId };
    });
    flow.poll = pending;
    void pending.finally(() => { if (flow.poll === pending) flow.poll = undefined; }).catch(() => undefined);
    return pending;
  }
  cancel(): void { this.flow?.controller.abort(); this.flow = undefined; }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.cancel();
    return this.closing = Promise.allSettled([...this.pending]).then(() => undefined);
  }
}
