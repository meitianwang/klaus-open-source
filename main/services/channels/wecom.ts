import WebSocket from 'ws';
import { SerialMutations, errorMessage, object, string, type JsonObject } from '../service-types';
import { RecentChannelMessages } from './recent-messages';
import { WECOM, wecomFrame, wecomId, wecomInbound, wecomReply, wecomRequestId } from './wecom-wire';
import { channelDelay, type ChannelAdapter, type ChannelAdapterContext, type ChannelAdapterFactory, type ChannelInbound, type ChannelSend } from './types';

export interface WeComTransportOptions {
  wsUrl?: string; handshakeTimeoutMs?: number; heartbeatIntervalMs?: number; replyAckTimeoutMs?: number;
  backoffMs?: readonly number[]; now?: () => number;
}
interface Connection { socket: WebSocket; generation: number; authenticated: boolean }
interface PendingAck { generation: number; settle: (error?: Error) => void }
interface SocketOutcome { reason: string; manualReconnectRequired?: boolean; fatal?: boolean }
const positive = (value: number | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid WeCom transport timeout'); return value;
};
const errorCode = (value: unknown): string => typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : 'invalid';

/** The manager owns account policy and engine turns; this resource owns one WeCom socket. */
export class WeComTransport implements ChannelAdapter {
  readonly done: Promise<void>;
  private readonly controller = new AbortController();
  private readonly signal: AbortSignal;
  private readonly recent = new RecentChannelMessages();
  private readonly pending = new Map<string, PendingAck>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly queues = new Map<string, { queue: SerialMutations; pending: number }>();
  private readonly url: string;
  private readonly handshakeTimeout: number;
  private readonly heartbeatInterval: number;
  private readonly ackTimeout: number;
  private readonly backoff: readonly number[];
  private connection?: Connection;
  private generation = 0;
  private snapshot: JsonObject = { channelId: 'wecom', running: true, connected: false, mode: 'websocket', reconnectAttempts: 0 };
  private closing?: Promise<void>;
  private constructor(private readonly botId: string, private readonly secret: string, private readonly context: ChannelAdapterContext, private readonly options: WeComTransportOptions,
    private readonly ready: () => void, private readonly failStart: (error: Error) => void) {
    this.signal = AbortSignal.any([context.signal, this.controller.signal]);
    const url = new URL(options.wsUrl ?? 'wss://openws.work.weixin.qq.com');
    if (!['wss:', 'ws:'].includes(url.protocol) || url.username || url.password || url.hash || (url.protocol === 'ws:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('WeCom requires a secure WebSocket URL');
    this.url = url.toString(); this.handshakeTimeout = positive(options.handshakeTimeoutMs, 30_000);
    this.heartbeatInterval = positive(options.heartbeatIntervalMs, 30_000); this.ackTimeout = positive(options.replyAckTimeoutMs, 5000);
    this.backoff = options.backoffMs ?? [1000, 2000, 4000, 8000, 16_000, 30_000];
    if (!this.backoff.length || this.backoff.some(ms => !Number.isSafeInteger(ms) || ms < 1)) throw new Error('Invalid WeCom reconnect backoff');
    this.done = this.run().finally(async () => {
      this.failStart(new Error('WeCom stopped before authentication'));
      this.controller.abort(); this.rejectPending('WeCom transport stopped'); await Promise.allSettled([...this.work]);
      this.recent.clear(); this.queues.clear(); this.patch({ running: false, connected: false, lastStopAt: this.now() });
    });
    void this.done.catch(() => undefined);
  }
  static async start(account: Record<string, string>, context: ChannelAdapterContext, options: WeComTransportOptions = {}): Promise<WeComTransport> {
    const bot = wecomId(account.bot_id || account.botId, 'bot id'), secret = account.secret || '';
    if (!secret.trim() || Buffer.byteLength(secret) > 16_384 || /[\r\n\u0000]/u.test(secret)) throw new Error('Invalid WeCom bot secret');
    if (context.signal.aborted) throw new Error('WeCom start was cancelled');
    let ready!: () => void, fail!: (error: Error) => void;
    const authenticated = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
    const transport = new WeComTransport(bot, secret, context, options, ready, fail);
    try { await authenticated; return transport; }
    catch (error) { await transport.close(); throw error; }
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private error(error: unknown): string { return errorMessage(error).replaceAll(this.secret, '[redacted]'); }
  private active(signal = this.signal): void { if (signal.aborted) throw new Error('WeCom operation was cancelled'); }
  private patch(value: JsonObject): void {
    this.snapshot = { ...this.snapshot, ...value };
    try { this.context.onStatus?.(this.status()); } catch { /* Status observers do not own this transport. */ }
  }
  status(): JsonObject { return { ...this.snapshot }; }
  close(): Promise<void> { this.controller.abort(); return this.closing ??= this.done.catch(() => undefined); }
  private rejectPending(reason: string, generation?: number): void {
    for (const entry of [...this.pending.values()]) if (generation === undefined || entry.generation === generation) entry.settle(new Error(reason));
  }
  private async run(): Promise<void> {
    let attempt = 0;
    while (!this.signal.aborted) {
      const outcome = await this.connectOnce(); if (this.signal.aborted) return;
      this.patch({ connected: false, lastError: outcome.reason, lastDisconnect: { at: this.now(), reason: outcome.reason } });
      if (outcome.manualReconnectRequired) { this.patch({ manualReconnectRequired: true }); return; }
      if (outcome.fatal) throw new Error(outcome.reason);
      this.patch({ reconnectAttempts: ++attempt }); await channelDelay(this.backoff[Math.min(attempt - 1, this.backoff.length - 1)]!, this.signal);
    }
  }
  private connectOnce(): Promise<SocketOutcome> {
    this.active();
    return new Promise(resolve => {
      const limits: WebSocket.ClientOptions & { maxFragments: number; maxBufferedChunks: number } = {
        perMessageDeflate: false, followRedirects: false, maxPayload: 1024 * 1024, maxFragments: 1024, maxBufferedChunks: 4096, handshakeTimeout: this.handshakeTimeout,
      };
      const connection: Connection = { socket: new WebSocket(this.url, limits), generation: ++this.generation, authenticated: false };
      const { socket, generation } = connection; this.connection = connection;
      let outcome: SocketOutcome | undefined, heartbeat: NodeJS.Timeout | undefined;
      const pings = new Set<string>(), authId = wecomRequestId(WECOM.subscribe, this.now());
      const end = (value: SocketOutcome): void => { outcome ??= value; if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); };
      const handshake = setTimeout(() => end({ reason: 'WeCom authentication timed out' }), this.handshakeTimeout);
      const cancel = (): void => end({ reason: 'WeCom transport stopped' });
      const write = (value: JsonObject): void => {
        const data = JSON.stringify(value);
        if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > 64 * 1024) { end({ reason: 'WeCom socket writer is unavailable' }); return; }
        socket.send(data, error => { if (error) end({ reason: 'WeCom socket write failed' }); });
      };
      const beat = (): void => {
        if (pings.size >= 2) { end({ reason: 'WeCom heartbeat ACK timed out' }); return; }
        const requestId = wecomRequestId(WECOM.ping, this.now()); pings.add(requestId); write(wecomFrame(WECOM.ping, requestId));
        heartbeat = setTimeout(beat, this.heartbeatInterval);
      };
      this.signal.addEventListener('abort', cancel, { once: true });
      socket.on('open', () => write(wecomFrame(WECOM.subscribe, authId, { bot_id: this.botId, secret: this.secret })));
      socket.on('error', error => { outcome ??= { reason: this.error(error) }; });
      socket.on('close', (code) => {
        clearTimeout(handshake); clearTimeout(heartbeat); this.signal.removeEventListener('abort', cancel);
        if (this.connection === connection) this.connection = undefined;
        this.rejectPending('WeCom connection closed before reply acknowledgement', generation);
        if (!connection.authenticated) this.failStart(new Error(outcome?.reason ?? 'WeCom socket closed before authentication'));
        resolve(outcome ?? { reason: 'WeCom socket closed ' + code });
      });
      socket.on('message', data => {
        if (outcome || this.signal.aborted) return;
        try {
          let frame: JsonObject;
          try { frame = object(JSON.parse(data.toString())); } catch { this.patch({ lastError: 'Malformed WeCom frame' }); return; }
          const requestId = string(object(frame.headers).req_id);
          if (!frame.cmd) {
            if (requestId === authId) {
              if (connection.authenticated) return;
              if (frame.errcode !== 0) { this.patch({ tokenStatus: 'invalid' }); end({ reason: 'WeCom authentication failed (code ' + errorCode(frame.errcode) + ')', fatal: true }); return; }
              connection.authenticated = true; clearTimeout(handshake);
              this.patch({ connected: true, tokenStatus: 'valid', reconnectAttempts: 0, lastConnectedAt: this.now() }); this.ready(); heartbeat = setTimeout(beat, this.heartbeatInterval);
            } else if (pings.has(requestId) && frame.errcode === 0) pings.delete(requestId);
            else {
              const pending = this.pending.get(requestId);
              if (pending?.generation === generation) pending.settle(frame.errcode === 0 ? undefined : new Error('WeCom reply rejected (code ' + errorCode(frame.errcode) + ')'));
            }
          } else if (connection.authenticated && frame.cmd === WECOM.event) {
            this.patch({ lastEventAt: this.now() });
            if (object(object(frame.body).event).eventtype === 'disconnected_event') end({ reason: 'A newer WeCom connection replaced this account connection', manualReconnectRequired: true });
          } else if (connection.authenticated && frame.cmd === WECOM.callback) {
            const inbound = wecomInbound(frame, this.now()); if (inbound) this.enqueue(inbound.message, inbound.requestId, connection);
          }
        } catch (error) { this.patch({ lastError: this.error(error) }); }
      });
      if (this.signal.aborted) cancel();
    });
  }
  private acknowledgement(frame: JsonObject, signal: AbortSignal, expected?: Connection): Promise<void> {
    this.active(signal);
    const connection = this.connection, requestId = wecomId(object(frame.headers).req_id, 'request id'), data = JSON.stringify(frame);
    if (!connection?.authenticated || connection.socket.readyState !== WebSocket.OPEN || (expected && expected !== connection)) throw new Error('No active WeCom connection for this reply');
    if (this.pending.size >= 64 || this.pending.has(requestId) || connection.socket.bufferedAmount > 64 * 1024) throw new Error('WeCom reply queue capacity exceeded');
    if (Buffer.byteLength(data) > 128 * 1024) throw new Error('WeCom outbound frame is too large');
    return new Promise<void>((resolve, reject) => {
      const settle = (error?: Error): void => {
        if (this.pending.get(requestId) !== entry) return;
        this.pending.delete(requestId); clearTimeout(timer); signal.removeEventListener('abort', cancel); error ? reject(error) : resolve();
      };
      const entry: PendingAck = { generation: connection.generation, settle };
      const cancel = (): void => settle(new Error('WeCom reply was cancelled'));
      const timer = setTimeout(() => settle(new Error('WeCom reply ACK timed out')), this.ackTimeout);
      this.pending.set(requestId, entry); signal.addEventListener('abort', cancel, { once: true });
      connection.socket.send(data, error => { if (error) settle(new Error('WeCom reply write failed')); });
      if (signal.aborted) cancel();
    });
  }
  send(params: ChannelSend, signal?: AbortSignal): Promise<JsonObject> {
    const combined = signal ? AbortSignal.any([this.signal, signal]) : this.signal;
    const work = (async (): Promise<JsonObject> => {
      try {
        this.active(combined);
        if (!['sendText', 'sendMessage'].includes(params.action ?? 'sendText')) throw new Error('WeCom does not support this action');
        if (params.files?.length) throw new Error('WeCom channel replies do not support attachments yet');
        const target = wecomId(params.targetId, 'target id'), text = this.replyText(params.text);
        await this.acknowledgement(wecomFrame(WECOM.send, wecomRequestId(WECOM.send, this.now()), { chatid: target, msgtype: 'markdown', markdown: { content: text } }), combined);
        this.patch({ lastOutboundAt: this.now() }); return { ok: true };
      } catch (error) { return { ok: false, error: this.error(error) }; }
    })();
    this.work.add(work); void work.finally(() => this.work.delete(work)); return work;
  }
  private replyText(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error('WeCom channel reply text is empty');
    if (Buffer.byteLength(value) > 20_480) throw new Error('WeCom reply exceeds 20480 bytes'); return value;
  }
  private enqueue(message: ChannelInbound, requestId: string, connection: Connection): void {
    const key = message.dedupKey ?? requestId; if (this.recent.has(key, this.now())) return;
    let entry = this.queues.get(message.sessionKey);
    if (this.work.size >= 128 || (entry?.pending ?? 0) >= 32 || (!entry && this.queues.size >= 64)) { this.patch({ lastError: 'WeCom inbound queue capacity exceeded' }); return; }
    this.recent.add(key, this.now());
    if (!entry) { entry = { queue: new SerialMutations(), pending: 0 }; this.queues.set(message.sessionKey, entry); }
    entry.pending++; const captured = entry;
    const work = entry.queue.run(async () => {
      this.active(); if (this.connection !== connection || !connection.authenticated) throw new Error('WeCom callback connection was retired');
      this.patch({ lastInboundAt: this.now() }); const outcome = await this.context.inbound(message, this.signal); this.active();
      if (outcome.dropped || outcome.manuallySent || !outcome.reply) return;
      const text = this.replyText(outcome.reply);
      try { await this.acknowledgement(wecomReply(requestId, text), this.signal, connection); }
      catch (error) {
        this.active();
        // The current product uses a proactive markdown fallback when a stream receipt fails.
        const fallback = await this.send({ targetId: message.targetId!, text });
        if (fallback.ok !== true) throw new Error(this.error(error) + '; fallback failed: ' + string(fallback.error));
      }
      this.patch({ lastOutboundAt: this.now() });
    }).catch(error => { if (!this.signal.aborted) this.patch({ lastError: this.error(error) }); })
      .finally(() => { this.work.delete(work); if (--captured.pending === 0 && this.queues.get(message.sessionKey) === captured) this.queues.delete(message.sessionKey); });
    this.work.add(work); void work.catch(() => undefined);
  }
}
export function wecomAdapter(options: WeComTransportOptions = {}): ChannelAdapterFactory { return (account, context) => WeComTransport.start(account, context, options); }
