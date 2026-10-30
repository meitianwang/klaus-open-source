import WebSocket from 'ws';
import { SerialMutations, errorMessage, object, string, type JsonObject } from '../service-types';
import { QQApi, QQApiError, type QQApiOptions } from './qq-api';
import { RecentChannelMessages } from './recent-messages';
import { QQ, QQ_INTENTS, qqId, qqInbound, qqInteger } from './qq-wire';
import { channelDelay, type ChannelAdapter, type ChannelAdapterContext, type ChannelAdapterFactory, type ChannelInbound, type ChannelSend } from './types';

export interface QQTransportOptions extends QQApiOptions { handshakeTimeoutMs?: number; backoffMs?: readonly number[] }
interface SocketOutcome { reason: string; fatal?: boolean; authenticated?: boolean }
interface GatewayConnection { socket: WebSocket; authenticated: boolean }

/** One account connection; all inference and access policy remain with the injected host owner. */
export class QQTransport implements ChannelAdapter {
  readonly done: Promise<void>;
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly api: QQApi;
  private readonly recent = new RecentChannelMessages();
  private readonly work = new Set<Promise<unknown>>();
  private readonly queues = new Map<string, { queue: SerialMutations; pending: number }>();
  private readonly handshakeTimeout: number;
  private readonly backoff: readonly number[];
  private sessionId?: string;
  private sequence?: number;
  private connection?: GatewayConnection;
  private pendingInbound = 0;
  private pendingSends = 0;
  private snapshot: JsonObject = { channelId: 'qq', running: true, connected: false, mode: 'websocket', reconnectAttempts: 0 };
  private closing?: Promise<void>;
  private constructor(account: Record<string, string>, private readonly context: ChannelAdapterContext, private readonly options: QQTransportOptions,
    private readonly ready: () => void, private readonly failStart: (error: Error) => void) {
    this.signal = AbortSignal.any([context.signal, this.controller.signal]);
    this.api = new QQApi(account.app_id || '', account.client_secret || '', this.signal, options);
    this.handshakeTimeout = options.handshakeTimeoutMs ?? 30_000;
    this.backoff = options.backoffMs ?? [1000, 2000, 5000, 10_000, 30_000, 60_000];
    if (!Number.isSafeInteger(this.handshakeTimeout) || this.handshakeTimeout < 1 || !this.backoff.length || this.backoff.some(ms => !Number.isSafeInteger(ms) || ms < 1)) throw new Error('Invalid QQ transport timeout');
    this.done = this.run().finally(async () => {
      this.failStart(new Error('QQ stopped before gateway authentication')); this.controller.abort();
      await this.api.close(); await Promise.allSettled([...this.work]); this.recent.clear(); this.queues.clear();
      this.patch({ running: false, connected: false, lastStopAt: this.now() });
    });
    void this.done.catch(() => undefined);
  }
  static async start(account: Record<string, string>, context: ChannelAdapterContext, options: QQTransportOptions = {}): Promise<QQTransport> {
    if (context.signal.aborted) throw new Error('QQ start was cancelled');
    let ready!: () => void, fail!: (error: Error) => void;
    const authenticated = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
    const transport = new QQTransport(account, context, options, ready, fail);
    try { await authenticated; return transport; } catch (error) { await transport.close(); throw error; }
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private active(signal = this.signal): void { if (signal.aborted) throw new Error('QQ operation was cancelled'); }
  private patch(value: JsonObject): void { this.snapshot = { ...this.snapshot, ...value }; try { this.context.onStatus?.(this.status()); } catch { /* Observers do not own this resource. */ } }
  status(): JsonObject { return { ...this.snapshot }; }
  close(): Promise<void> { this.controller.abort(); return this.closing ??= this.done.catch(() => undefined); }
  private async run(): Promise<void> {
    let attempt = 0, started = false;
    while (!this.signal.aborted) {
      let outcome: SocketOutcome;
      try { const url = await this.api.gateway(), token = await this.api.accessToken(); outcome = await this.connectOnce(url, token); }
      catch (error) { outcome = { reason: errorMessage(error), fatal: error instanceof QQApiError && error.authentication }; }
      if (this.signal.aborted) return;
      if (outcome.authenticated) { started = true; attempt = 0; }
      this.patch({ connected: false, lastError: outcome.reason, lastDisconnect: { at: this.now(), reason: outcome.reason } });
      if (outcome.fatal) { this.patch({ tokenStatus: 'invalid', manualReconnectRequired: true }); this.failStart(new Error(outcome.reason)); throw new Error(outcome.reason); }
      if (!started) { this.failStart(new Error(outcome.reason)); return; }
      if (++attempt > 100) throw new Error('QQ reconnect attempts exhausted');
      this.patch({ reconnectAttempts: attempt }); await channelDelay(this.backoff[Math.min(attempt - 1, this.backoff.length - 1)]!, this.signal);
    }
  }
  private connectOnce(url: string, token: string): Promise<SocketOutcome> {
    this.active();
    return new Promise(resolve => {
      const limits: WebSocket.ClientOptions & { maxFragments: number; maxBufferedChunks: number } = { perMessageDeflate: false, followRedirects: false, maxPayload: 1024 * 1024, maxFragments: 1024, maxBufferedChunks: 4096, handshakeTimeout: this.handshakeTimeout };
      const connection: GatewayConnection = { socket: new WebSocket(url, limits), authenticated: false }; this.connection = connection;
      const socket = connection.socket;
      let outcome: SocketOutcome | undefined, heartbeat: NodeJS.Timeout | undefined, awaitingHeartbeat = false, hello = false, resume = false;
      const end = (value: SocketOutcome): void => { outcome ??= value; if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); };
      const cancel = (): void => end({ reason: 'QQ transport stopped' });
      const timeout = setTimeout(() => end({ reason: 'QQ gateway authentication timed out' }), this.handshakeTimeout);
      const write = (frame: JsonObject): void => {
        if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64 * 1024) { end({ reason: 'QQ gateway writer is unavailable' }); return; }
        socket.send(JSON.stringify(frame), error => { if (error) end({ reason: 'QQ gateway write failed' }); });
      };
      const beat = (): void => { awaitingHeartbeat = true; write({ op: QQ.heartbeat, d: this.sequence ?? null }); };
      this.signal.addEventListener('abort', cancel, { once: true });
      socket.on('error', () => { outcome ??= { reason: 'QQ gateway connection failed' }; });
      socket.on('close', code => {
        clearTimeout(timeout); clearTimeout(heartbeat); this.signal.removeEventListener('abort', cancel);
        if (this.connection === connection) this.connection = undefined;
        if ([4006, 4007, 4009].includes(code)) { this.sessionId = undefined; this.sequence = undefined; this.api.clearToken(); }
        if ([4004, 4010, 4011, 4012, 4013, 4014].includes(code)) outcome = { reason: 'QQ gateway rejected the account or requested capabilities (code ' + code + ')', fatal: true };
        resolve({ ...(outcome ?? { reason: 'QQ gateway closed (code ' + code + ')' }), authenticated: connection.authenticated });
      });
      socket.on('message', data => {
        if (outcome || this.signal.aborted) return;
        try {
          let frame: JsonObject; try { frame = object(JSON.parse(data.toString())); } catch { this.patch({ lastError: 'Malformed QQ gateway frame' }); return; }
          const op = qqInteger(frame.op), value = object(frame.d), sequence = qqInteger(frame.s);
          if (op === QQ.dispatch && sequence !== undefined) this.sequence = sequence;
          if (op === QQ.hello) {
            if (hello) { end({ reason: 'QQ gateway sent a duplicate HELLO' }); return; } hello = true;
            const interval = qqInteger(value.heartbeat_interval);
            if (!interval || interval > 86_400_000) { end({ reason: 'Invalid QQ heartbeat interval' }); return; }
            resume = this.sessionId !== undefined && this.sequence !== undefined;
            write(resume ? { op: QQ.resume, d: { token: 'QQBot ' + token, session_id: this.sessionId!, seq: this.sequence! } }
              : { op: QQ.identify, d: { token: 'QQBot ' + token, intents: QQ_INTENTS, shard: [0, 1] } });
            const tick = (): void => { if (awaitingHeartbeat) { end({ reason: 'QQ heartbeat ACK timed out' }); return; } beat(); heartbeat = setTimeout(tick, interval); };
            heartbeat = setTimeout(tick, interval);
          } else if (op === QQ.heartbeatAck) awaitingHeartbeat = false;
          else if (op === QQ.heartbeat && hello) beat();
          else if (op === QQ.reconnect) end({ reason: 'QQ gateway requested reconnect' });
          else if (op === QQ.invalidSession) { this.sessionId = undefined; this.sequence = undefined; this.api.clearToken(); end({ reason: 'QQ gateway invalidated the session' }); }
          else if (op === QQ.dispatch && (frame.t === 'READY' || frame.t === 'RESUMED')) {
            if (!hello || (frame.t === 'RESUMED' && !resume)) { end({ reason: 'Unexpected QQ gateway authentication result' }); return; }
            if (frame.t === 'READY') this.sessionId = qqId(value.session_id, 'gateway session id');
            connection.authenticated = true; clearTimeout(timeout); this.patch({ connected: true, tokenStatus: 'valid', reconnectAttempts: 0, lastConnectedAt: this.now() }); this.ready();
          } else if (op === QQ.dispatch && connection.authenticated) {
            const inbound = qqInbound(frame, this.now()); if (inbound) this.enqueue(inbound);
          }
        } catch { this.patch({ lastError: 'Invalid QQ gateway event' }); }
      });
      if (this.signal.aborted) cancel();
    });
  }
  send(params: ChannelSend, signal?: AbortSignal): Promise<JsonObject> {
    if (this.pendingSends >= 64) return Promise.resolve({ ok: false, error: 'QQ outbound queue capacity exceeded' });
    const combined = signal ? AbortSignal.any([this.signal, signal]) : this.signal;
    this.pendingSends++;
    const work = (async () => {
      try {
        this.active(combined);
        if (!this.connection?.authenticated || this.connection.socket.readyState !== WebSocket.OPEN) throw new Error('QQ gateway is not connected');
        const result = await this.api.send(params, combined); this.patch({ lastOutboundAt: this.now() }); return result;
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    })();
    this.work.add(work); return work.finally(() => { this.pendingSends--; this.work.delete(work); });
  }
  private enqueue(message: ChannelInbound): void {
    const key = message.dedupKey!; if (this.recent.has(key, this.now())) return;
    let entry = this.queues.get(message.sessionKey);
    if (this.pendingInbound >= 128 || (entry?.pending ?? 0) >= 32 || (!entry && this.queues.size >= 64)) { this.patch({ lastError: 'QQ inbound queue capacity exceeded' }); return; }
    this.recent.add(key, this.now()); if (!entry) { entry = { queue: new SerialMutations(), pending: 0 }; this.queues.set(message.sessionKey, entry); }
    entry.pending++; this.pendingInbound++; const captured = entry;
    const work = entry.queue.run(async () => {
      this.active(); this.patch({ lastInboundAt: this.now() }); const result = await this.context.inbound(message, this.signal); this.active();
      if (result.dropped || result.manuallySent || !result.reply) return;
      const sent = await this.send({ targetId: message.targetId!, chatType: message.chatType, text: result.reply, replyToMessageId: message.messageId });
      if (sent.ok !== true) throw new Error(string(sent.error, 'QQ automatic reply failed'));
    }).catch(error => { if (!this.signal.aborted) this.patch({ lastError: errorMessage(error) }); })
      .finally(() => { this.work.delete(work); this.pendingInbound--; if (--captured.pending === 0 && this.queues.get(message.sessionKey) === captured) this.queues.delete(message.sessionKey); });
    this.work.add(work); void work.catch(() => undefined);
  }
}
export function qqAdapter(options: QQTransportOptions = {}): ChannelAdapterFactory { return (account, context) => QQTransport.start(account, context, options); }
