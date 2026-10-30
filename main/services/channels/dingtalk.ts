import WebSocket from 'ws';
import { SerialMutations, errorMessage, object, string, type JsonObject } from '../service-types';
import { DingTalkApi, DingTalkAuthenticationError, type DingTalkApiOptions } from './dingtalk-api';
import { DINGTALK_ROBOT_TOPIC, dingtalkAck, dingtalkId, dingtalkInbound } from './dingtalk-wire';
import { RecentChannelMessages } from './recent-messages';
import { channelDelay, type ChannelAdapter, type ChannelAdapterContext, type ChannelAdapterFactory, type ChannelInbound, type ChannelSend } from './types';

export interface DingTalkTransportOptions extends DingTalkApiOptions { handshakeTimeoutMs?: number; heartbeatIntervalMs?: number; backoffMs?: readonly number[] }
interface SocketOutcome { reason: string; connected: boolean; fatal?: boolean }

/** Stream I/O does not wait for inference. The injected host owns policy, sessions and all model work. */
export class DingTalkTransport implements ChannelAdapter {
  readonly done: Promise<void>;
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly api: DingTalkApi;
  private readonly clientId: string;
  private readonly recent = new RecentChannelMessages();
  private readonly work = new Set<Promise<unknown>>();
  private readonly queues = new Map<string, { queue: SerialMutations; pending: number }>();
  private readonly handshakeTimeout: number;
  private readonly heartbeatInterval: number;
  private readonly backoff: readonly number[];
  private socket?: WebSocket;
  private pendingInbound = 0;
  private pendingSends = 0;
  private snapshot: JsonObject = { channelId: 'dingtalk', running: true, connected: false, mode: 'stream', reconnectAttempts: 0 };
  private closing?: Promise<void>;
  private constructor(account: Record<string, string>, private readonly context: ChannelAdapterContext, private readonly options: DingTalkTransportOptions,
    private readonly ready: () => void, private readonly failStart: (error: Error) => void) {
    this.signal = AbortSignal.any([context.signal, this.controller.signal]);
    this.clientId = account.client_id || account.clientId || '';
    this.api = new DingTalkApi(this.clientId, account.client_secret || account.clientSecret || '', this.signal, options);
    this.handshakeTimeout = options.handshakeTimeoutMs ?? 30_000;
    this.heartbeatInterval = options.heartbeatIntervalMs ?? 8000;
    this.backoff = options.backoffMs ?? [1000, 2000, 5000, 10_000, 30_000, 60_000];
    if (![this.handshakeTimeout, this.heartbeatInterval, ...this.backoff].every(ms => Number.isSafeInteger(ms) && ms > 0) || !this.backoff.length) throw new Error('Invalid DingTalk transport timeout');
    this.done = this.run().finally(async () => {
      this.failStart(new Error('DingTalk stopped before connecting')); this.controller.abort();
      await this.api.close(); await Promise.allSettled([...this.work]); this.recent.clear(); this.queues.clear();
      this.patch({ running: false, connected: false, lastStopAt: this.now() });
    });
    void this.done.catch(() => undefined);
  }
  static async start(account: Record<string, string>, context: ChannelAdapterContext, options: DingTalkTransportOptions = {}): Promise<DingTalkTransport> {
    if (context.signal.aborted) throw new Error('DingTalk start was cancelled');
    let ready!: () => void, fail!: (error: Error) => void;
    const connected = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
    const port = new DingTalkTransport(account, context, options, ready, fail);
    try { await connected; return port; } catch (error) { await port.close(); throw error; }
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private active(signal = this.signal): void { if (this.signal.aborted || signal.aborted) throw new Error('DingTalk operation was cancelled'); }
  private patch(value: JsonObject): void { this.snapshot = { ...this.snapshot, ...value }; try { this.context.onStatus?.(this.status()); } catch { /* Observers do not own this connection. */ } }
  status(): JsonObject { return { ...this.snapshot }; }
  close(): Promise<void> { this.controller.abort(); return this.closing ??= this.done.catch(() => undefined); }
  private async run(): Promise<void> {
    let attempt = 0, started = false;
    while (!this.signal.aborted) {
      let outcome: SocketOutcome;
      try { outcome = await this.connectOnce(await this.api.gateway()); }
      catch (error) { outcome = { reason: errorMessage(error), connected: false, fatal: error instanceof DingTalkAuthenticationError }; }
      if (this.signal.aborted) return;
      if (outcome.connected) { started = true; attempt = 0; }
      this.patch({ connected: false, lastError: outcome.reason, lastDisconnect: { at: this.now(), reason: outcome.reason } });
      if (outcome.fatal) { this.patch({ tokenStatus: 'invalid', manualReconnectRequired: true }); this.failStart(new Error(outcome.reason)); throw new Error(outcome.reason); }
      if (!started) { this.failStart(new Error(outcome.reason)); return; }
      if (++attempt > 100) throw new Error('DingTalk reconnect attempts exhausted');
      this.patch({ reconnectAttempts: attempt }); await channelDelay(this.backoff[Math.min(attempt - 1, this.backoff.length - 1)]!, this.signal);
    }
  }
  private connectOnce(url: string): Promise<SocketOutcome> {
    this.active();
    return new Promise(resolve => {
      const limits: WebSocket.ClientOptions & { maxFragments: number; maxBufferedChunks: number } = { perMessageDeflate: false, followRedirects: false, maxPayload: 1024 * 1024, maxFragments: 1024, maxBufferedChunks: 4096, handshakeTimeout: this.handshakeTimeout };
      const socket = new WebSocket(url, limits); this.socket = socket;
      let reason: string | undefined, connected = false, alive = true, heartbeat: NodeJS.Timeout | undefined;
      const end = (value: string): void => { reason ??= value; if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); };
      const cancel = (): void => end('DingTalk transport stopped');
      const write = (value: JsonObject, sent?: () => void): void => {
        if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64 * 1024) { end('DingTalk gateway writer is unavailable'); return; }
        socket.send(JSON.stringify(value), error => { if (error) end('DingTalk gateway write failed'); else sent?.(); });
      };
      this.signal.addEventListener('abort', cancel, { once: true });
      socket.on('error', () => { reason ??= 'DingTalk gateway connection failed'; });
      socket.on('close', code => {
        clearInterval(heartbeat); this.signal.removeEventListener('abort', cancel); if (this.socket === socket) this.socket = undefined;
        resolve({ reason: reason ?? 'DingTalk gateway closed (code ' + code + ')', connected });
      });
      socket.on('open', () => {
        if (this.signal.aborted) { cancel(); return; }
        connected = true; this.patch({ connected: true, tokenStatus: 'valid', reconnectAttempts: 0, lastConnectedAt: this.now() }); this.ready();
        heartbeat = setInterval(() => {
          if (!alive) { end('DingTalk heartbeat timed out'); return; }
          alive = false;
          if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64 * 1024) { end('DingTalk gateway writer is unavailable'); return; }
          socket.ping(undefined, undefined, error => { if (error) end('DingTalk heartbeat write failed'); });
        }, this.heartbeatInterval);
      });
      socket.on('pong', () => { alive = true; });
      socket.on('message', data => {
        if (reason || this.signal.aborted) return;
        try {
          const frame = object(JSON.parse(data.toString())), headers = object(frame.headers), topic = string(headers.topic);
          if (frame.type === 'SYSTEM') {
            if (topic === 'ping') { alive = true; write({ code: 200, headers, message: 'OK', data: frame.data ?? null }); }
            else if (topic === 'KEEPALIVE') alive = true;
            else if (topic === 'disconnect') write({ code: 200, headers, message: 'OK', data: frame.data ?? null }, () => end('DingTalk gateway requested reconnect'));
            return;
          }
          const id = dingtalkId(headers.messageId, 'stream message id');
          if (frame.type === 'EVENT') { write(dingtalkAck(id, false)); return; }
          if (frame.type !== 'CALLBACK' || topic !== DINGTALK_ROBOT_TOPIC) return;
          if (this.recent.has('dingtalk:' + id, this.now())) { write(dingtalkAck(id, true)); return; }
          if (typeof frame.data !== 'string') throw new Error('Invalid DingTalk callback body');
          const inbound = dingtalkInbound(object(JSON.parse(frame.data)), id, this.clientId, this.now());
          if (!inbound || this.enqueue(inbound)) write(dingtalkAck(id, true));
        } catch { this.patch({ lastError: 'Invalid DingTalk gateway event' }); }
      });
      if (this.signal.aborted) cancel();
    });
  }
  send(params: ChannelSend, signal?: AbortSignal): Promise<JsonObject> {
    if (this.pendingSends >= 64) return Promise.resolve({ ok: false, error: 'DingTalk outbound queue capacity exceeded' });
    const combined = signal ? AbortSignal.any([this.signal, signal]) : this.signal; this.pendingSends++;
    const work = (async () => {
      try {
        this.active(combined); if (this.socket?.readyState !== WebSocket.OPEN) throw new Error('DingTalk gateway is not connected');
        const result = await this.api.send(params, combined); this.patch({ lastOutboundAt: this.now() }); return result;
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    })();
    this.work.add(work); return work.finally(() => { this.pendingSends--; this.work.delete(work); });
  }
  private enqueue(message: ChannelInbound): boolean {
    let entry = this.queues.get(message.sessionKey);
    if (this.pendingInbound >= 128 || (entry?.pending ?? 0) >= 32 || (!entry && this.queues.size >= 64)) { this.patch({ lastError: 'DingTalk inbound queue capacity exceeded' }); return false; }
    this.recent.add(message.dedupKey!, this.now()); if (!entry) { entry = { queue: new SerialMutations(), pending: 0 }; this.queues.set(message.sessionKey, entry); }
    entry.pending++; this.pendingInbound++; const captured = entry;
    const work = entry.queue.run(async () => {
      this.active(); this.patch({ lastInboundAt: this.now() }); const result = await this.context.inbound(message, this.signal); this.active();
      if (result.dropped || result.manuallySent || !result.reply) return;
      await this.api.reply(message, result.reply, this.signal); this.patch({ lastOutboundAt: this.now() });
    }).catch(error => { if (!this.signal.aborted) this.patch({ lastError: errorMessage(error) }); })
      .finally(() => { this.work.delete(work); this.pendingInbound--; if (--captured.pending === 0 && this.queues.get(message.sessionKey) === captured) this.queues.delete(message.sessionKey); });
    this.work.add(work); void work.catch(() => undefined); return true;
  }
}
export function dingtalkAdapter(options: DingTalkTransportOptions = {}): ChannelAdapterFactory { return (account, context) => DingTalkTransport.start(account, context, options); }
