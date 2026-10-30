import path from 'node:path';
import { NativeWhatsAppTransport, type WhatsAppEvent, type WhatsAppNativeFactory, type WhatsAppNativePort } from '../../native/whatsapp';
import { errorMessage, type JsonObject } from '../service-types';
import { RecentChannelMessages } from './recent-messages';
import { whatsappMessage, whatsappTargetJid } from './whatsapp-content';
import type { ChannelAdapter, ChannelAdapterContext, ChannelAdapterFactory, ChannelSend } from './types';

export interface WhatsAppTransportOptions {
  addonPath?: string; nativeFactory?: WhatsAppNativeFactory; now?: () => number;
  openTimeoutMs?: number; sendTimeoutMs?: number; closeTimeoutMs?: number;
}
export class WhatsAppTransport implements ChannelAdapter {
  readonly done: Promise<void>;
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly perSession = new Map<string, number>();
  private readonly seen = new RecentChannelMessages();
  private readonly native: WhatsAppNativePort;
  private readonly signal: AbortSignal;
  private readonly snapshot: JsonObject = { connected: false, running: true, mode: 'websocket', accountId: 'default' };
  private qr?: { code: string; until: number };
  private closing?: Promise<void>;
  private queuedBytes = 0;
  private sends = 0;
  private readonly abort = (): void => { void this.close().catch(error => this.patch({ lastError: errorMessage(error) })); };
  private readonly start: Promise<void>;
  private constructor(account: Record<string, string>, private readonly context: ChannelAdapterContext, private readonly options: WhatsAppTransportOptions) {
    this.signal = AbortSignal.any([this.controller.signal, context.signal]);
    const configured = account.authDir ?? account.auth_dir;
    const authDir = configured?.trim() || path.join(context.configRoot, 'whatsapp');
    if (!path.isAbsolute(authDir) || Buffer.byteLength(authDir) > 4096 || /[\0?#]/.test(authDir)) throw new Error('Invalid WhatsApp authentication directory');
    this.native = (options.nativeFactory ?? ((opts, deliver) => new NativeWhatsAppTransport(opts, deliver)))({ authDir, addonPath: options.addonPath }, event => this.receive(event));
    context.signal.addEventListener('abort', this.abort, { once: true });
    this.start = this.native.open(options.openTimeoutMs ?? 30_000, this.signal);
    this.done = this.lifecycle(); void this.done.catch(() => undefined);
    if (context.signal.aborted) this.abort();
  }
  static async start(account: Record<string, string>, context: ChannelAdapterContext, options: WhatsAppTransportOptions = {}): Promise<WhatsAppTransport> {
    if (context.signal.aborted) throw new Error('WhatsApp start was cancelled');
    const port = new WhatsAppTransport(account, context, options);
    try { await port.start; if (context.signal.aborted) throw new Error('WhatsApp start was cancelled'); return port; }
    catch (error) { await port.close(); throw error; }
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private patch(value: JsonObject): void { Object.assign(this.snapshot, value); this.context.onStatus?.({ ...this.snapshot }); }
  status(): JsonObject { return { ...this.snapshot }; }
  pairing(): { connected: boolean; qr?: string; error?: string } {
    if (this.signal.aborted) return { connected: false };
    return { connected: this.snapshot.connected === true, ...(this.qr && this.qr.until > this.now() ? { qr: this.qr.code } : {}),
      ...(typeof this.snapshot.lastError === 'string' && this.snapshot.lastError ? { error: this.snapshot.lastError } : {}) };
  }
  private receive(event: WhatsAppEvent): void {
    if (this.signal.aborted) return;
    if (event.kind === 'qr') { this.qr = { code: event.code, until: this.now() + event.expiresInMs }; this.patch({ connected: false, lastError: null }); return; }
    if (event.kind === 'connected') { this.qr = undefined; this.patch({ connected: true, lastError: null, lastConnectedAt: this.now(), tokenStatus: 'valid', manualReconnectRequired: false }); return; }
    if (event.kind === 'message') { this.admit(event); return; }
    if (['loggedOut', 'streamReplaced', 'clientOutdated', 'temporaryBan'].includes(event.kind)) {
      this.qr = undefined;
      this.patch({ connected: false, manualReconnectRequired: true, lastError: event.kind === 'loggedOut' ? 'Logged out. Re-scan QR code.' : 'WhatsApp ' + event.kind,
        lastDisconnect: { at: this.now(), reason: event.kind, ...('reason' in event && event.reason !== undefined ? { statusCode: event.reason } : {}) } });
      this.abort(); return;
    }
    if (event.kind === 'disconnected' || event.kind === 'stopped') {
      this.qr = undefined; this.patch({ connected: false, lastDisconnect: { at: this.now(), reason: event.kind } }); return;
    }
    if (event.kind === 'pairError' || event.kind === 'connectFailure') {
      this.qr = undefined; this.patch({ connected: false, lastError: 'WhatsApp ' + event.kind }); return;
    }
    this.patch({ lastError: 'WhatsApp ' + event.kind + ('stage' in event && event.stage ? ': ' + event.stage : '') });
  }
  private admit(event: Extract<WhatsAppEvent, { kind: 'message' }>): void {
    const message = whatsappMessage(event); if (!message) return;
    const key = message.messageId ? 'whatsapp:' + message.messageId : undefined;
    if (key && this.seen.has(key, this.now())) return;
    const bytes = Buffer.byteLength(message.text), count = this.perSession.get(message.sessionKey) ?? 0;
    if (this.pending.size >= 128 || count >= 32 || (!count && this.perSession.size >= 64) || this.queuedBytes + bytes > 8_388_608) {
      this.patch({ lastError: 'WhatsApp inbound queue capacity exceeded' }); return;
    }
    if (key) this.seen.add(key, this.now());
    this.queuedBytes += bytes; this.perSession.set(message.sessionKey, count + 1);
    this.patch({ lastInboundAt: this.now() });
    const task = Promise.resolve().then(async () => {
      if (this.signal.aborted) return;
      const outcome = await this.context.inbound(message, this.signal);
      if (!this.signal.aborted && !outcome.manuallySent && !outcome.dropped && outcome.reply?.trim()) {
        const result = await this.send({ targetId: message.targetId!, chatType: message.chatType, text: outcome.reply });
        if (result.ok !== true) throw new Error(String(result.error));
      }
    }).catch(error => { if (!this.signal.aborted) this.patch({ lastError: errorMessage(error) }); }).finally(() => {
      this.pending.delete(task); this.queuedBytes -= bytes;
      const remaining = (this.perSession.get(message.sessionKey) ?? 1) - 1;
      if (remaining) this.perSession.set(message.sessionKey, remaining); else this.perSession.delete(message.sessionKey);
    });
    this.pending.add(task);
  }
  send(params: ChannelSend, signal?: AbortSignal): Promise<JsonObject> {
    if (params.files?.length) return Promise.resolve({ ok: false, error: 'WhatsApp channel replies do not support attachments yet' });
    if (!params.text?.trim()) return Promise.resolve({ ok: false, error: 'WhatsApp channel reply text is empty' });
    if (params.action && !['send', 'sendText', 'sendMessage'].includes(params.action)) return Promise.resolve({ ok: false, error: 'Unsupported WhatsApp action: ' + params.action });
    if (this.signal.aborted || signal?.aborted || this.snapshot.connected !== true) return Promise.resolve({ ok: false, error: 'WhatsApp not connected' });
    if (this.sends >= 8) return Promise.resolve({ ok: false, error: 'WhatsApp outbound queue capacity exceeded' });
    let jid: string;
    try { jid = whatsappTargetJid(params.targetId, params.chatType); } catch (error) { return Promise.resolve({ ok: false, error: errorMessage(error) }); }
    this.sends++;
    const task = this.native.sendText(jid, params.text, this.options.sendTimeoutMs ?? 30_000, signal ? AbortSignal.any([this.signal, signal]) : this.signal)
      .then((messageId): JsonObject => { this.patch({ lastOutboundAt: this.now() }); return { ok: true, messageId, messageIds: [messageId] }; })
      .catch((error): JsonObject => { const message = errorMessage(error); this.patch({ lastError: message }); return { ok: false, error: message }; })
      .finally(() => { this.sends--; this.pending.delete(task); });
    this.pending.add(task); return task;
  }
  private async lifecycle(): Promise<void> {
    try { await this.start; await this.native.finished; }
    finally { await this.close(); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.controller.abort(); this.qr = undefined;
    this.context.signal.removeEventListener('abort', this.abort);
    this.patch({ connected: false, running: false });
    const closing = (async (): Promise<void> => {
      const report = await this.native.close(this.options.closeTimeoutMs ?? 10_000);
      if (!report.complete) throw new Error('WHATSAPP_CLOSE_INCOMPLETE');
      await Promise.allSettled([...this.pending]);
      this.seen.clear();
      if (report.terminal) this.patch({ manualReconnectRequired: true, lastError: report.terminal === 'loggedOut' ? 'Logged out. Re-scan QR code.' : 'WhatsApp ' + report.terminal });
      if (report.error) this.patch({ lastError: report.error });
      if (report.error === 'WHATSAPP_STORE_FLUSH_FAILED') throw new Error(report.error);
    })();
    this.closing = closing;
    void closing.catch(() => { if (this.closing === closing) this.closing = undefined; });
    return closing;
  }
}
export function whatsappAdapter(options: WhatsAppTransportOptions = {}): ChannelAdapterFactory {
  return (account, context) => WhatsAppTransport.start(account, context, options);
}
