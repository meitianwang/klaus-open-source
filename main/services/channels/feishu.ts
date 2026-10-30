import { SerialMutations, errorMessage, object, string, type JsonObject } from '../service-types';
import { FeishuApi, FeishuAuthenticationError, feishuTiming, type FeishuApiOptions, type FeishuEndpoint } from './feishu-api';
import { feishuConfiguration, type FeishuConfig } from './feishu-config';
import { FeishuDedup } from './feishu-dedup';
import { decryptFeishuEnvelope, feishuEvent, parseFeishuEnvelope, type FeishuEvent } from './feishu-event';
import { FeishuMessages } from './feishu-messages';
import { startFeishuWebhook } from './feishu-webhook';
import { serveFeishuSocket, type FeishuAdmission, type FeishuSocketOutcome } from './feishu-websocket';
import { channelDelay, type ChannelAdapter, type ChannelAdapterContext, type ChannelAdapterFactory, type ChannelSend } from './types';

export interface FeishuTransportOptions extends FeishuApiOptions {
  handshakeTimeoutMs?: number; debounceMs?: number; maxBurstMs?: number; typingTimeoutMs?: number; webhookRequestTimeoutMs?: number; random?: () => number;
}
interface SessionQueue { queue: SerialMutations; pending: number }
interface Batch {
  key: string; events: FeishuEvent[]; bytes: number; queue: SessionQueue;
  timer: NodeJS.Timeout; maxTimer: NodeJS.Timeout; done: Promise<void>; finish: () => void;
}

/** One account owns its sockets, API token and bounded queues; the injected host owns model turns. */
export class FeishuTransport implements ChannelAdapter {
  readonly done: Promise<void>;
  private readonly controller = new AbortController();
  private readonly resources = new AbortController();
  private readonly signal: AbortSignal;
  private readonly config: FeishuConfig;
  private readonly api: FeishuApi;
  private readonly dedup: FeishuDedup;
  private readonly work = new Set<Promise<unknown>>();
  private readonly batches = new Map<string, Batch>();
  private readonly queues = new Map<string, SessionQueue>();
  private readonly debounce: number;
  private readonly maxBurst: number;
  private readonly handshakeTimeout: number;
  private readonly typingTimeout: number;
  private messages?: FeishuMessages;
  private bot?: string;
  private pendingInbound = 0;
  private pendingBytes = 0;
  private pendingSends = 0;
  private snapshot: JsonObject = { channelId: 'feishu', running: true, connected: false, reconnectAttempts: 0 };
  private closing?: Promise<void>;
  private constructor(account: Record<string, string>, private readonly context: ChannelAdapterContext, private readonly options: FeishuTransportOptions,
    private readonly ready: () => void, private readonly failStart: (error: Error) => void) {
    this.config = feishuConfiguration(account); this.signal = AbortSignal.any([context.signal, this.controller.signal]);
    this.debounce = options.debounceMs ?? 300; this.maxBurst = options.maxBurstMs ?? 2000;
    this.handshakeTimeout = options.handshakeTimeoutMs ?? 30_000; this.typingTimeout = options.typingTimeoutMs ?? 2000;
    if (![this.debounce, this.maxBurst, this.handshakeTimeout, this.typingTimeout].every(value => Number.isSafeInteger(value) && value > 0 && value <= 300_000) || this.maxBurst < this.debounce) throw new Error('Invalid Feishu transport timeout');
    this.api = new FeishuApi(this.config, context.configRoot, this.resources.signal, options);
    this.dedup = new FeishuDedup(context.configRoot, () => this.now()); this.snapshot.mode = this.config.connectionMode;
    this.done = this.run().catch(error => { this.patch({ lastError: errorMessage(error) }); this.failStart(error instanceof Error ? error : new Error('Feishu transport failed')); throw error; })
      .finally(async () => {
        this.controller.abort(); this.failStart(new Error('Feishu stopped before connecting'));
        for (const batch of [...this.batches.values()]) this.release(batch);
        await Promise.allSettled([...this.work]);
        // Typing cleanup has its own short deadline and finishes before the API resource is retired.
        this.resources.abort(); await this.api.close(); this.messages?.clear(); this.queues.clear();
        this.patch({ running: false, connected: false, lastStopAt: this.now() });
      });
    void this.done.catch(() => undefined);
  }
  static async start(account: Record<string, string>, context: ChannelAdapterContext, options: FeishuTransportOptions = {}): Promise<FeishuTransport> {
    if (context.signal.aborted) throw new Error('Feishu start was cancelled');
    let ready!: () => void, fail!: (error: Error) => void;
    const connected = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
    const port = new FeishuTransport(account, context, options, ready, fail);
    try { await connected; return port; } catch (error) { await port.close(); throw error; }
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private active(signal = this.signal): void { if (this.signal.aborted || signal.aborted) throw new Error('Feishu operation was cancelled'); }
  private patch(value: JsonObject): void { this.snapshot = { ...this.snapshot, ...value }; try { this.context.onStatus?.(this.status()); } catch { /* Observers do not own this connection. */ } }
  status(): JsonObject { return { ...this.snapshot, pendingInbound: this.pendingInbound, pendingSends: this.pendingSends }; }
  close(): Promise<void> { this.controller.abort(); return this.closing ??= this.done.catch(() => undefined); }
  private async run(): Promise<void> {
    await this.dedup.load(); this.active();
    try { const bot = await this.api.identity(this.signal); this.bot = bot.id; this.patch({ botOpenId: bot.id, ...(bot.name ? { botName: bot.name } : {}), tokenStatus: 'valid' }); }
    catch (error) { this.active(); if (error instanceof FeishuAuthenticationError) { this.patch({ tokenStatus: 'invalid', manualReconnectRequired: true }); throw error; } this.patch({ lastError: errorMessage(error) }); }
    this.messages = new FeishuMessages(this.config, this.api, this.signal, message => this.patch({ lastError: message }), () => this.now(), this.bot);
    if (this.config.connectionMode === 'webhook') {
      const listener = await startFeishuWebhook(this.config, this.signal, payload => this.admit(payload), { requestTimeoutMs: this.options.webhookRequestTimeoutMs, now: () => this.now() });
      this.patch({ connected: true, webhookPort: listener.port, lastConnectedAt: this.now() }); this.ready();
      await listener.done; if (!this.signal.aborted) throw new Error('Feishu webhook listener stopped unexpectedly'); return;
    }
    let attempt = 0, started = false, endpoint: FeishuEndpoint = { url: '', service: 0, ...feishuTiming({}) };
    while (!this.signal.aborted) {
      let outcome: FeishuSocketOutcome;
      try {
        endpoint = await this.api.gateway(this.signal);
        outcome = await serveFeishuSocket(endpoint, this.signal, { handshakeTimeoutMs: this.handshakeTimeout, now: () => this.now(),
          connected: () => { this.patch({ connected: true, tokenStatus: 'valid', reconnectAttempts: 0, lastConnectedAt: this.now() }); this.ready(); },
          error: message => this.patch({ lastError: message }), event: payload => this.admit(payload) });
        endpoint = outcome.endpoint;
      } catch (error) {
        if (error instanceof FeishuAuthenticationError) { this.patch({ tokenStatus: 'invalid', manualReconnectRequired: true }); throw error; }
        outcome = { reason: errorMessage(error), connected: false, endpoint };
      }
      if (this.signal.aborted) return;
      this.patch({ connected: false, lastError: outcome.reason, lastDisconnect: { at: this.now(), reason: outcome.reason } });
      if (outcome.connected) { started = true; attempt = 0; }
      if (!started) throw new Error(outcome.reason);
      if (++attempt > endpoint.reconnectCount && endpoint.reconnectCount >= 0) throw new Error('Feishu reconnect attempts exhausted');
      this.patch({ reconnectAttempts: attempt });
      const random = this.options.random?.() ?? Math.random(); if (!Number.isFinite(random) || random < 0 || random > 1) throw new Error('Invalid Feishu reconnect jitter');
      await channelDelay(outcome.connected ? Math.floor(endpoint.reconnectNonceMs * random) : endpoint.reconnectIntervalMs, this.signal);
    }
  }
  private admit(payload: JsonObject): FeishuAdmission {
    this.active();
    const decoded = decryptFeishuEnvelope(payload, this.config.encryptKey);
    if (decoded.type === 'url_verification') {
      if (typeof decoded.challenge !== 'string' || Buffer.byteLength(decoded.challenge) > 16_384) return { accepted: false };
      return { accepted: true, result: { challenge: decoded.challenge } };
    }
    const parsed = parseFeishuEnvelope(payload, this.config.encryptKey);
    if (parsed.type !== 'im.message.receive_v1') return { accepted: true };
    const event = feishuEvent(parsed.data, this.config, this.bot, this.now());
    if (!event || this.dedup.has(event.id)) return { accepted: true };
    return { accepted: this.enqueue(event) };
  }
  private enqueue(event: FeishuEvent): boolean {
    let queue = this.queues.get(event.sessionKey);
    const bytes = Buffer.byteLength(JSON.stringify(event)), key = JSON.stringify([event.sessionKey, event.sender, event.threadId ?? '']);
    if (this.pendingInbound >= 128 || this.pendingBytes + bytes > 8 * 1024 * 1024 || (queue?.pending ?? 0) >= 32 || (!queue && this.queues.size >= 64) || (!this.batches.has(key) && this.batches.size >= 64)) {
      this.patch({ lastError: 'Feishu inbound queue capacity exceeded' }); return false;
    }
    if (!this.dedup.claim(event.id)) return true;
    if ((this.batches.get(key)?.bytes ?? 0) + bytes > 1024 * 1024) this.flush(key);
    if (!queue) { queue = { queue: new SerialMutations(), pending: 0 }; this.queues.set(event.sessionKey, queue); }
    queue.pending++; this.pendingInbound++; this.pendingBytes += bytes;
    let batch = this.batches.get(key);
    if (!batch) {
      let finish!: () => void; const done = new Promise<void>(resolve => { finish = resolve; });
      const timer = setTimeout(() => this.flush(key), this.debounce), maxTimer = setTimeout(() => this.flush(key), this.maxBurst);
      batch = { key, events: [], bytes: 0, queue, done, finish, timer, maxTimer }; this.batches.set(key, batch); this.work.add(done);
    } else { clearTimeout(batch.timer); batch.timer = setTimeout(() => this.flush(key), this.debounce); }
    batch.events.push(event); batch.bytes += bytes; return true;
  }
  private flush(key: string): void {
    const batch = this.batches.get(key); if (!batch) return;
    clearTimeout(batch.timer); clearTimeout(batch.maxTimer); this.batches.delete(key);
    void batch.queue.queue.run(() => this.process(batch)).catch(error => { if (!this.signal.aborted) this.patch({ lastError: errorMessage(error) }); })
      .finally(() => this.release(batch));
  }
  private release(batch: Batch): void {
    clearTimeout(batch.timer); clearTimeout(batch.maxTimer); if (this.batches.get(batch.key) === batch) this.batches.delete(batch.key);
    this.dedup.release(batch.events.map(event => event.id)); this.pendingInbound -= batch.events.length; this.pendingBytes -= batch.bytes;
    batch.queue.pending -= batch.events.length;
    const session = batch.events[0]!.sessionKey; if (!batch.queue.pending && this.queues.get(session) === batch.queue) this.queues.delete(session);
    this.work.delete(batch.done); batch.finish();
  }
  private async process(batch: Batch): Promise<void> {
    this.active(); const last = batch.events.at(-1)!;
    let reaction: string | undefined, handled = false;
    try {
      const message = await this.messages!.prepare(batch.events); this.active();
      if (this.config.typingIndicator) {
        try {
          const response = await this.api.call('/open-apis/im/v1/messages/' + encodeURIComponent(last.id) + '/reactions', 'POST', { reaction_type: { emoji_type: 'Typing' } }, {}, AbortSignal.any([this.signal, AbortSignal.timeout(this.typingTimeout)]));
          reaction = string(object(response.data).reaction_id); if (!reaction || Buffer.byteLength(reaction) > 2048) throw new Error('Feishu typing response has no reaction id');
        } catch (error) { this.active(); this.patch({ lastError: errorMessage(error) }); }
      }
      this.active(); this.patch({ lastInboundAt: this.now() });
      const result = await this.context.inbound(message, this.signal); handled = true; this.active();
      if (result.dropped || result.manuallySent || !result.reply) return;
      await this.api.send({ targetId: last.chat, text: result.reply, replyToMessageId: last.id, ...(last.threadId ? { threadId: last.threadId } : {}) }, this.signal);
      this.patch({ lastOutboundAt: this.now() });
    } finally {
      if (reaction) {
        try { await this.api.call('/open-apis/im/v1/messages/' + encodeURIComponent(last.id) + '/reactions/' + encodeURIComponent(reaction), 'DELETE', undefined, {}, AbortSignal.timeout(this.typingTimeout)); }
        catch (error) { this.patch({ lastError: errorMessage(error) }); }
      }
      if (handled) await this.dedup.complete(batch.events.map(event => event.id));
    }
  }
  send(params: ChannelSend, signal?: AbortSignal): Promise<JsonObject> {
    if (this.pendingSends >= 64) return Promise.resolve({ ok: false, error: 'Feishu outbound queue capacity exceeded' });
    const combined = signal ? AbortSignal.any([this.signal, signal]) : this.signal; this.pendingSends++;
    const task = (async () => {
      try { this.active(combined); if (!this.snapshot.connected) throw new Error('Feishu channel is not connected'); const result = await this.api.send(params, combined); this.patch({ lastOutboundAt: this.now() }); return result; }
      catch (error) { return { ok: false, error: errorMessage(error) }; }
    })();
    this.work.add(task); return task.finally(() => { this.pendingSends--; this.work.delete(task); });
  }
}
export function feishuAdapter(options: FeishuTransportOptions = {}): ChannelAdapterFactory { return (account, context) => FeishuTransport.start(account, context, options); }
