import { randomUUID } from 'node:crypto';
import { loadNativeAddon, type NativeWhatsAppBinding } from './binding';
import { beforeDeadline, validDeadline } from './pty';

export interface WhatsAppMessageEvent {
  kind: 'message'; resourceId: string; sequence: number;
  info: { id: string; chatJid: string; senderJid: string; isFromMe: boolean; timestampMs: number; pushName: string };
  message: { conversation: string | null; extendedText: string | null; imageCaption: string | null; videoCaption: string | null;
    image: boolean; video: boolean; audio: boolean; document: { fileName: string | null } | null; sticker: boolean; contact: boolean; location: boolean };
}
export type WhatsAppEvent = WhatsAppMessageEvent | { kind: 'qr'; resourceId: string; sequence: number; code: string; expiresInMs: number }
  | { kind: 'connected' | 'disconnected' | 'loggedOut' | 'connectFailure' | 'pairError' | 'streamReplaced' | 'clientOutdated' | 'temporaryBan' | 'networkError' | 'stopped'; resourceId: string; sequence: number; reason?: number; stage?: string };
export interface WhatsAppReport { resourceId: string; complete: boolean; closing: boolean; connected: boolean; opened: boolean; lastSequence: number;
  queuedEvents: number; queuedBytes: number; pendingOperations: string[]; error: string | null; terminal?: string | null }
export interface WhatsAppNativePort {
  readonly finished: Promise<void>;
  open(deadlineMs?: number, signal?: AbortSignal): Promise<void>;
  sendText(jid: string, text: string, deadlineMs?: number, signal?: AbortSignal): Promise<string>;
  report(): WhatsAppReport;
  close(deadlineMs?: number): Promise<WhatsAppReport>;
}
export interface WhatsAppNativeOptions { authDir: string; addonPath?: string }
export type WhatsAppNativeFactory = (options: WhatsAppNativeOptions, deliver: (event: WhatsAppEvent) => void) => WhatsAppNativePort;

/** A single in-process protocol/SQLite resource. No account or engine supervision lives here. */
export class NativeWhatsAppTransport implements WhatsAppNativePort {
  readonly resourceId: string;
  readonly finished: Promise<void>;
  private readonly binding: NativeWhatsAppBinding;
  private readonly pending = new Set<Promise<unknown>>();
  private sequence = 0;
  private closing = false;
  private eventError?: string;
  constructor(options: WhatsAppNativeOptions, private readonly deliver: (event: WhatsAppEvent) => void,
    fixture?: { resourceId: string; binding: NativeWhatsAppBinding }) {
    this.resourceId = fixture?.resourceId ?? randomUUID();
    if (fixture?.binding) this.binding = fixture.binding;
    else if (options.addonPath) this.binding = new (loadNativeAddon(options.addonPath).NativeWhatsApp)(this.resourceId, JSON.stringify({ authDir: options.authDir }));
    else throw new Error('WHATSAPP_ADDON_PATH_REQUIRED');
    this.finished = this.pump();
  }
  private async pump(): Promise<void> {
    try {
      while (!this.closing) {
        const raw = await this.binding.readEvent();
        if (raw === null || this.closing) break;
        if (Buffer.byteLength(raw) > 1_048_576) throw new Error('WHATSAPP_EVENT_SIZE_LIMIT');
        const event = JSON.parse(raw) as WhatsAppEvent;
        if (event.resourceId !== this.resourceId || event.sequence !== this.sequence + 1 || !KINDS.has(event.kind)) throw new Error('WHATSAPP_EVENT_INVALID');
        if (event.kind === 'qr' && (typeof event.code !== 'string' || !event.code || Buffer.byteLength(event.code) > 4096
          || !Number.isSafeInteger(event.expiresInMs) || event.expiresInMs < 1 || event.expiresInMs > 120_000)) throw new Error('WHATSAPP_QR_INVALID');
        if (event.kind === 'message') validateMessage(event);
        this.sequence = event.sequence;
        // Delivery only admits bounded host work; it must never wait for a model turn.
        this.deliver(event);
      }
    } catch (error) {
      this.eventError = error instanceof Error ? error.message : String(error);
      this.closing = true;
      await this.binding.shutdown(5000).catch(() => undefined);
    }
  }
  private run<T>(invoke: (operationId: string) => Promise<string>, signal?: AbortSignal): Promise<T> {
    if (this.closing || signal?.aborted) return Promise.reject(new Error('CLOSED: WhatsApp operation was cancelled'));
    const operationId = randomUUID(), cancel = (): void => { this.binding.cancel(operationId); };
    let raw: Promise<string>;
    try { raw = invoke(operationId); } catch (error) { return Promise.reject(error); }
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const result = raw.then(value => {
      const envelope = JSON.parse(value) as { resourceId: string; operationId: string; result: T };
      if (envelope.resourceId !== this.resourceId || envelope.operationId !== operationId) throw new Error('WHATSAPP_RESPONSE_INVALID');
      return envelope.result;
    }).finally(() => { signal?.removeEventListener('abort', cancel); this.pending.delete(result); });
    this.pending.add(result); return result;
  }
  async open(deadlineMs = 30_000, signal?: AbortSignal): Promise<void> {
    validDeadline(deadlineMs);
    const result = await this.run<{ started: boolean }>(id => this.binding.open(id, deadlineMs), signal);
    if (result.started !== true) throw new Error('WHATSAPP_OPEN_RESPONSE_INVALID');
  }
  async sendText(jid: string, text: string, deadlineMs = 30_000, signal?: AbortSignal): Promise<string> {
    validDeadline(deadlineMs);
    const result = await this.run<{ messageId: string }>(id => this.binding.sendText(id, jid, text, deadlineMs), signal);
    if (typeof result.messageId !== 'string' || !result.messageId || Buffer.byteLength(result.messageId) > 1024) throw new Error('WHATSAPP_SEND_OUTCOME_UNKNOWN');
    return result.messageId;
  }
  report(): WhatsAppReport {
    const report = JSON.parse(this.binding.report()) as WhatsAppReport;
    if (report.resourceId !== this.resourceId || typeof report.complete !== 'boolean' || !Array.isArray(report.pendingOperations)) throw new Error('WHATSAPP_REPORT_INVALID');
    return this.eventError ? { ...report, error: this.eventError } : report;
  }
  async close(deadlineMs = 5000): Promise<WhatsAppReport> {
    validDeadline(deadlineMs); this.closing = true;
    const until = Date.now() + deadlineMs;
    await this.binding.shutdown(deadlineMs);
    const settled = await beforeDeadline(Promise.allSettled([this.finished, ...this.pending]), until);
    const report = this.report();
    return { ...report, complete: report.complete && settled.done && this.pending.size === 0 };
  }
}
const KINDS = new Set(['message', 'qr', 'connected', 'disconnected', 'loggedOut', 'connectFailure', 'pairError', 'streamReplaced', 'clientOutdated', 'temporaryBan', 'networkError', 'stopped']);
function validateMessage(event: WhatsAppMessageEvent): void {
  const { info, message } = event;
  if (!info || !message || typeof info.isFromMe !== 'boolean' || !Number.isSafeInteger(info.timestampMs)
    || ['id', 'chatJid', 'senderJid', 'pushName'].some(key => typeof info[key as keyof typeof info] !== 'string')) throw new Error('WHATSAPP_MESSAGE_EVENT_INVALID');
  for (const key of ['conversation', 'extendedText', 'imageCaption', 'videoCaption'] as const) {
    const value = message[key]; if (value !== null && (typeof value !== 'string' || Buffer.byteLength(value) > 65_536)) throw new Error('WHATSAPP_MESSAGE_EVENT_INVALID');
  }
  if (['image', 'video', 'audio', 'sticker', 'contact', 'location'].some(key => typeof message[key as keyof typeof message] !== 'boolean')
    || (message.document !== null && (!message.document || (message.document.fileName !== null && typeof message.document.fileName !== 'string')))) throw new Error('WHATSAPP_MESSAGE_EVENT_INVALID');
}
