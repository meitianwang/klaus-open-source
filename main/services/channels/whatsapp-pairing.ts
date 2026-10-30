import { errorMessage, type JsonObject } from '../service-types';
import { qrPngDataUrl } from './qr-code';
import { channelDelay, type ChannelAdapterFactory } from './types';
import { WhatsAppTransport, type WhatsAppTransportOptions } from './whatsapp';

export interface WhatsAppPairingDeps extends WhatsAppTransportOptions {
  /** Save enabled configuration and start through the one ChannelService owner. */
  enable: (signal: AbortSignal) => Promise<void>;
  startWaitMs?: number;
  qrPng?: (code: string) => Promise<string>;
}
/** Owns ephemeral QR presentation, never a second socket or account supervisor. */
export class WhatsAppPairingService {
  readonly factory: ChannelAdapterFactory;
  private current?: WhatsAppTransport;
  private generation = 0;
  private flow?: { controller: AbortController; result: Promise<JsonObject> };
  private closed = false;
  private polling?: Promise<JsonObject>;
  private readonly pending = new Set<Promise<unknown>>();
  private readonly waitMs: number;
  constructor(private readonly deps: WhatsAppPairingDeps) {
    if (typeof deps.enable !== 'function') throw new Error('WhatsApp pairing requires the real channel owner');
    this.waitMs = deps.startWaitMs ?? 10_000;
    if (!Number.isSafeInteger(this.waitMs) || this.waitMs < 1 || this.waitMs > 10_000) throw new Error('Invalid WhatsApp pairing wait');
    this.factory = async (account, context) => {
      if (this.closed) throw new Error('WhatsApp pairing service is closed');
      const generation = ++this.generation;
      const port = await WhatsAppTransport.start(account, context, deps);
      if (this.closed || generation !== this.generation) { await port.close(); throw new Error('WhatsApp start was superseded'); }
      this.current = port;
      void port.done.finally(() => { if (this.current === port) this.current = undefined; }).catch(() => undefined);
      return port;
    };
  }
  private track<T>(operation: Promise<T>): Promise<T> {
    this.pending.add(operation); void operation.finally(() => this.pending.delete(operation)).catch(() => undefined); return operation;
  }
  start(): Promise<JsonObject> {
    if (this.closed) return Promise.resolve({ ok: false, error: 'WhatsApp pairing service is closed' });
    if (this.flow) return this.flow.result;
    const controller = new AbortController();
    const result = this.track((async (): Promise<JsonObject> => {
      try {
        if (!this.current?.pairing().connected) await this.deps.enable(controller.signal);
        const until = Date.now() + this.waitMs;
        while (!controller.signal.aborted && !this.closed) {
          const value = await this.poll();
          if (controller.signal.aborted || this.closed) return { ok: false, error: 'WhatsApp pairing was cancelled' };
          if (value.ok === false || value.status !== 'waiting' || Date.now() >= until) return value;
          await channelDelay(Math.min(100, until - Date.now()), controller.signal);
        }
        return { ok: false, error: 'WhatsApp pairing was cancelled' };
      } catch (error) { return { ok: false, error: controller.signal.aborted ? 'WhatsApp pairing was cancelled' : errorMessage(error) }; }
    })());
    this.flow = { controller, result };
    void result.finally(() => { if (this.flow?.result === result) this.flow = undefined; }).catch(() => undefined);
    return result;
  }
  poll(): Promise<JsonObject> {
    if (this.polling) return this.polling;
    const result = this.track((async (): Promise<JsonObject> => {
      if (this.closed) return { ok: false, error: 'WhatsApp pairing service is closed' };
      const port = this.current, state = port?.pairing();
      if (state?.connected) return { ok: true, status: 'connected' };
      if (state?.qr) {
        try {
          const data = await (this.deps.qrPng ?? qrPngDataUrl)(state.qr);
          const fresh = port?.pairing();
          if (this.closed) return { ok: false, error: 'WhatsApp pairing service is closed' };
          if (this.current !== port || !fresh?.qr || fresh.qr !== state.qr) return fresh?.error
            ? { ok: false, error: fresh.error } : { ok: true, status: fresh?.connected ? 'connected' : 'waiting' };
          return { ok: true, status: 'qr', qrcodeDataUrl: data };
        } catch (error) { return { ok: false, error: errorMessage(error) }; }
      }
      return state?.error ? { ok: false, error: state.error } : { ok: true, status: 'waiting' };
    })());
    this.polling = result;
    void result.finally(() => { if (this.polling === result) this.polling = undefined; }).catch(() => undefined);
    return result;
  }
  /** Called before ChannelService waits for its disconnect mutation gate. */
  cancel(): void { this.flow?.controller.abort(); }
  async close(): Promise<void> {
    this.closed = true; this.cancel(); ++this.generation;
    await Promise.allSettled([...this.pending]); this.current = undefined;
  }
}
