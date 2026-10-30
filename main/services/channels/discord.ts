import WebSocket from 'ws';
import { SerialMutations, errorMessage, object, string, type JsonObject } from '../service-types';
import { permitsChannelMessage } from './access-policy';
import { DiscordAccessService } from './discord-access';
import { DiscordActions } from './discord-actions';
import { DiscordApi, discordId, type DiscordApiOptions } from './discord-api';
import { discordInbound } from './discord-wire';
import { RecentChannelMessages } from './recent-messages';
import { channelDelay, type ChannelAdapter, type ChannelAdapterContext, type ChannelAdapterFactory, type ChannelSend } from './types';

export interface DiscordTransportOptions extends DiscordApiOptions {
  access: DiscordAccessService;
  handshakeTimeoutMs?: number; approvalsIntervalMs?: number; backoffMs?: readonly number[]; random?: () => number;
}
const INTENTS = (1 << 12) | (1 << 0) | (1 << 9) | (1 << 15);
const positive = (value: number | undefined, fallback: number): number => {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Invalid Discord transport timeout'); return value;
};
interface GatewaySession { id?: string; sequence?: number; resumeUrl?: string }
interface SocketOutcome { fatal?: boolean; reason: string }

/** Gateway v10 and REST only. The shared manager owns accounts and engine turns. */
export class DiscordTransport implements ChannelAdapter {
  readonly done: Promise<void>;
  private readonly actions: DiscordActions;
  private readonly recent = new RecentChannelMessages();
  private readonly sent = new RecentChannelMessages(1000, 3_600_000);
  private readonly dmUsers = new Map<string, string>();
  private readonly queues = new Map<string, { queue: SerialMutations; pending: number }>();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly handshakeTimeout: number;
  private readonly approvalInterval: number;
  private readonly backoff: readonly number[];
  private snapshot: JsonObject = { channelId: 'discord', running: true, connected: false, mode: 'gateway', tokenStatus: 'valid' };
  private closing?: Promise<void>;
  private constructor(private readonly token: string, private readonly botId: string, private readonly api: DiscordApi,
    private readonly controller: AbortController, private readonly signal: AbortSignal, private readonly context: ChannelAdapterContext, private readonly options: DiscordTransportOptions) {
    this.handshakeTimeout = positive(options.handshakeTimeoutMs, 30_000); this.approvalInterval = positive(options.approvalsIntervalMs, 5000);
    this.backoff = options.backoffMs ?? [1000, 2000, 4000, 8000, 16_000, 30_000];
    if (!this.backoff.length || this.backoff.some(ms => !Number.isSafeInteger(ms) || ms < 1)) throw new Error('Invalid Discord gateway backoff');
    this.actions = new DiscordActions(api, options.access, signal, () => botId, channel => this.dmUsers.get(channel), id => this.sent.add(id, this.now()));
    const gateway = this.gatewayLoop().finally(() => this.controller.abort());
    const approvals = this.approvalLoop();
    this.done = Promise.allSettled([gateway, approvals]).then(async results => {
      this.controller.abort(); await Promise.allSettled([...this.jobs]); await this.actions.close();
      this.recent.clear(); this.sent.clear(); this.dmUsers.clear(); this.queues.clear();
      this.patch({ running: false, connected: false, lastStopAt: this.now() });
      const failed = results.find(result => result.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
    });
    void this.done.catch(() => undefined);
  }
  static async start(account: Record<string, string>, context: ChannelAdapterContext, options: DiscordTransportOptions): Promise<DiscordTransport> {
    if (!options.access) throw new Error('Discord requires the application access store');
    const token = account.bot_token || account.botToken || '', controller = new AbortController(), signal = AbortSignal.any([context.signal, controller.signal]);
    const api = new DiscordApi(token, context.configRoot, signal, options);
    try {
      const me = object(await api.call('GET', '/users/@me'));
      const id = discordId(me.id, 'bot id'); if (me.bot !== true) throw new Error('Discord requires a bot account');
      if (signal.aborted) throw new Error('Discord start was cancelled');
      return new DiscordTransport(token, id, api, controller, signal, context, options);
    } catch (error) { controller.abort(); throw error; }
  }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private active(): void { if (this.signal.aborted) throw new Error('Discord operation was cancelled'); }
  private patch(value: JsonObject): void {
    this.snapshot = { ...this.snapshot, ...value };
    try { this.context.onStatus?.(this.status()); } catch { /* Diagnostics do not own the transport. */ }
  }
  status(): JsonObject { return { ...this.snapshot }; }
  private async refreshAccess(): Promise<JsonObject> {
    const access = await this.options.access.transportAccess(); this.active();
    this.patch({ dmPolicy: access.dmPolicy!, allowFrom: access.allowFrom!, pendingPairings: Object.keys(object(access.pending)).length });
    return access;
  }
  send(params: ChannelSend, signal?: AbortSignal): Promise<JsonObject> { return this.actions.send(params, signal); }
  close(): Promise<void> { this.controller.abort(); return this.closing ??= this.done.catch(() => undefined); }
  private gatewayUrl(raw: string): string {
    const url = new URL(raw);
    if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Invalid Discord gateway URL');
    if (url.protocol === 'ws:') {
      const api = this.options.apiBase ? new URL(this.options.apiBase) : undefined;
      if (!api || api.protocol !== 'http:' || api.hostname !== url.hostname || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Discord gateway requires TLS');
    }
    url.searchParams.set('v', '10'); url.searchParams.set('encoding', 'json'); url.searchParams.delete('compress'); return url.toString();
  }
  private async gatewayLoop(): Promise<void> {
    let base: string | undefined, attempt = 0; const session: GatewaySession = {};
    while (!this.signal.aborted) {
      try {
        if (!base) {
          const gateway = object(await this.api.call('GET', '/gateway/bot')); base = this.gatewayUrl(string(gateway.url));
          const limit = object(gateway.session_start_limit);
          if (limit.remaining === 0) {
            const reset = limit.reset_after;
            if (typeof reset !== 'number' || !Number.isSafeInteger(reset) || reset < 1) throw new Error('Discord session start limit has no valid reset');
            this.patch({ lastError: 'Discord session start limit reached', connected: false }); await channelDelay(reset, this.signal); this.active();
          }
        }
        const outcome = await this.connectOnce(session.id && session.resumeUrl ? session.resumeUrl : base, session);
        if (this.signal.aborted) break;
        this.patch({ connected: false, lastError: outcome.reason, lastDisconnect: { at: this.now(), reason: outcome.reason } });
        if (outcome.fatal) { this.patch({ tokenStatus: 'invalid' }); throw new Error(outcome.reason); }
        if (session.id) attempt = 0;
      } catch (error) {
        if (this.signal.aborted) break;
        this.patch({ connected: false, lastError: errorMessage(error).replaceAll(this.token, '[redacted]') }); throw error;
      }
      await channelDelay(this.backoff[Math.min(attempt++, this.backoff.length - 1)]!, this.signal);
    }
  }
  private connectOnce(raw: string, session: GatewaySession): Promise<SocketOutcome> {
    this.active(); const url = this.gatewayUrl(raw);
    return new Promise(resolve => {
      const limits: WebSocket.ClientOptions & { maxFragments: number; maxBufferedChunks: number } = {
        perMessageDeflate: false, followRedirects: false, maxPayload: 1024 * 1024, maxFragments: 1024, maxBufferedChunks: 4096, handshakeTimeout: this.handshakeTimeout,
      };
      const socket = new WebSocket(url, limits);
      let outcome: SocketOutcome | undefined, heartbeat: NodeJS.Timeout | undefined, awaitingAck = false, hello = false, ready = false;
      const handshake = setTimeout(() => end({ reason: 'Discord gateway handshake timed out' }), this.handshakeTimeout);
      const end = (next: SocketOutcome): void => { outcome ??= next; if (socket.readyState !== WebSocket.CLOSED) socket.terminate(); };
      const cancel = (): void => end({ reason: 'Discord gateway stopped' });
      const send = (value: JsonObject): void => {
        const data = JSON.stringify(value);
        if (socket.readyState !== WebSocket.OPEN || Buffer.byteLength(data) > 4096 || socket.bufferedAmount > 64 * 1024) { end({ reason: 'Discord gateway writer is unavailable' }); return; }
        socket.send(data, error => { if (error) end({ reason: 'Discord gateway write failed' }); });
      };
      const beat = (interval: number): void => {
        if (awaitingAck) { end({ reason: 'Discord heartbeat ACK timed out' }); return; }
        awaitingAck = true; send({ op: 1, d: session.sequence ?? null });
        heartbeat = setTimeout(() => beat(interval), interval);
      };
      this.signal.addEventListener('abort', cancel, { once: true });
      socket.on('error', error => { outcome ??= { reason: errorMessage(error).replaceAll(this.token, '[redacted]') }; });
      socket.on('close', (code, reason) => {
        clearTimeout(handshake); clearTimeout(heartbeat); this.signal.removeEventListener('abort', cancel);
        if ([4007, 4009].includes(code)) { delete session.id; delete session.sequence; delete session.resumeUrl; }
        resolve(outcome ?? { reason: 'Discord gateway closed ' + code + ': ' + reason.toString().replaceAll(this.token, '[redacted]'), fatal: [4004, 4010, 4011, 4012, 4013, 4014].includes(code) });
      });
      socket.on('message', data => {
        if (this.signal.aborted || outcome) return;
        try {
          const event = object(JSON.parse(data.toString()));
          if (typeof event.s === 'number' && Number.isSafeInteger(event.s) && event.s >= 0) session.sequence = Math.max(session.sequence ?? 0, event.s);
          if (event.op === 10) {
            if (hello) throw new Error('Duplicate Discord HELLO'); hello = true;
            const interval = object(event.d).heartbeat_interval;
            if (typeof interval !== 'number' || !Number.isSafeInteger(interval) || interval < 1 || interval > 300_000) throw new Error('Invalid Discord heartbeat interval');
            const jitter = this.options.random?.() ?? Math.random(); if (!Number.isFinite(jitter) || jitter < 0 || jitter >= 1) throw new Error('Invalid Discord heartbeat jitter');
            heartbeat = setTimeout(() => beat(interval), Math.floor(interval * jitter));
            send(session.id && session.sequence !== undefined ? { op: 6, d: { token: this.token, session_id: session.id, seq: session.sequence } }
              : { op: 2, d: { token: this.token, intents: INTENTS, properties: { os: process.platform, browser: 'klaus', device: 'klaus' } } });
          } else if (event.op === 11) awaitingAck = false;
          else if (event.op === 1) send({ op: 1, d: session.sequence ?? null });
          else if (event.op === 7) end({ reason: 'Discord requested reconnect' });
          else if (event.op === 9) { if (event.d !== true) { delete session.id; delete session.sequence; delete session.resumeUrl; } end({ reason: 'Discord invalidated the session' }); }
          else if (event.op === 0) {
            const payload = object(event.d);
            if (event.t === 'READY') {
              if (!hello || string(object(payload.user).id) !== this.botId || !string(payload.session_id)) throw new Error('Invalid Discord READY identity');
              session.id = string(payload.session_id); session.resumeUrl = this.gatewayUrl(string(payload.resume_gateway_url));
              ready = true; clearTimeout(handshake);
              this.patch({ connected: true, tokenStatus: 'valid', name: string(object(payload.user).username), lastConnectedAt: this.now() });
            } else if (event.t === 'RESUMED') {
              if (!hello || !session.id) throw new Error('Invalid Discord RESUMED event'); ready = true; clearTimeout(handshake); this.patch({ connected: true, lastConnectedAt: this.now() });
            } else if (event.t === 'MESSAGE_CREATE' && ready) this.enqueue(payload);
          }
        } catch (error) { end({ reason: errorMessage(error).replaceAll(this.token, '[redacted]') }); }
      });
      if (this.signal.aborted) cancel();
    });
  }
  private enqueue(message: JsonObject): void {
    if (object(message.author).bot === true) return;
    const channel = discordId(message.channel_id, 'channel id'), id = discordId(message.id, 'message id'), key = channel + ':' + id;
    if (this.recent.has(key, this.now())) return;
    let entry = this.queues.get(channel);
    if (this.jobs.size >= 128 || (entry?.pending ?? 0) >= 32 || (!entry && this.queues.size >= 64)) { this.patch({ lastError: 'Discord inbound queue capacity exceeded' }); return; }
    this.recent.add(key, this.now());
    if (!entry) { entry = { queue: new SerialMutations(), pending: 0 }; this.queues.set(channel, entry); }
    entry.pending++; const captured = entry;
    const work = entry.queue.run(() => this.handle(message)).catch(error => { if (!this.signal.aborted) this.patch({ lastError: errorMessage(error).replaceAll(this.token, '[redacted]') }); })
      .finally(() => { this.jobs.delete(work); if (--captured.pending === 0 && this.queues.get(channel) === captured) this.queues.delete(channel); });
    this.jobs.add(work); void work.catch(() => undefined);
  }
  private async handle(message: JsonObject): Promise<void> {
    this.active(); const channel = discordId(message.channel_id), sender = discordId(object(message.author).id, 'sender id'), messageId = discordId(message.id);
    const direct = !string(message.guild_id); let access: JsonObject, group = channel, mentioned = false;
    if (direct) {
      const verdict = await this.options.access.authorizeDirect(sender, channel); this.active();
      await this.refreshAccess();
      if (verdict.kind === 'drop') return;
      if (verdict.kind === 'pair') {
        const lead = verdict.isResend ? 'Still pending' : 'Pairing required';
        await this.api.createMessage(channel, { content: lead + '. Open Klaus → Channels → Discord and approve pairing code: ' + verdict.code, message_reference: { message_id: messageId, fail_if_not_exists: false } }); return;
      }
      access = verdict.access; this.dmUsers.delete(channel); this.dmUsers.set(channel, sender);
      if (this.dmUsers.size > 10_000) this.dmUsers.delete(this.dmUsers.keys().next().value!);
    } else {
      access = await this.refreshAccess();
      if (!['pairing', 'allowlist'].includes(string(access.dmPolicy))) return;
      const info = object(await this.api.call('GET', '/channels/' + channel));
      if (info.id !== channel) throw new Error('Invalid Discord channel response');
      if ([10, 11, 12].includes(Number(info.type))) group = string(info.parent_id, channel);
      const policy = object(object(access.groups)[group]);
      if (policy.requireMention !== false) mentioned = await this.mentioned(message, access);
    }
    const inbound = discordInbound(message, this.botId, group, mentioned); if (!inbound) return;
    if (!permitsChannelMessage('discord', access, inbound)) return;
    this.patch({ dmPolicy: access.dmPolicy!, allowFrom: access.allowFrom!, pendingPairings: Object.keys(object(access.pending)).length, lastInboundAt: this.now() });
    await this.api.call('POST', '/channels/' + channel + '/typing', {}).catch(() => undefined);
    const ack = string(access.ackReaction);
    if (ack) await this.api.call('PUT', '/channels/' + channel + '/messages/' + messageId + '/reactions/' + encodeURIComponent(ack) + '/@me', {}).catch(() => undefined);
    this.active(); const outcome = await this.context.inbound(inbound, this.signal); this.active();
    if (outcome.dropped || outcome.manuallySent || !outcome.reply) return;
    const sent = await this.actions.send({ action: 'sendText', targetId: channel, text: outcome.reply, replyToMessageId: messageId });
    if (sent.ok !== true) throw new Error(string(sent.error, 'Discord reply failed')); this.patch({ lastOutboundAt: this.now() });
  }
  private async mentioned(message: JsonObject, access: JsonObject): Promise<boolean> {
    if (message.mention_everyone === true || (Array.isArray(message.mentions) && message.mentions.some(value => object(value).id === this.botId))) return true;
    const reference = string(object(message.message_reference).message_id);
    if (reference) {
      if (this.sent.has(reference, this.now())) return true;
      try { if (object(object(await this.api.call('GET', '/channels/' + discordId(message.channel_id) + '/messages/' + discordId(reference))).author).id === this.botId) return true; }
      catch { this.active(); }
    }
    if (Array.isArray(access.mentionPatterns)) for (const pattern of access.mentionPatterns) {
      if (typeof pattern !== 'string') continue;
      try { if (new RegExp(pattern, 'i').test(string(message.content))) return true; } catch { /* Invalid configured patterns are ignored. */ }
    }
    return false;
  }
  private async approvalLoop(): Promise<void> {
    while (!this.signal.aborted) {
      await channelDelay(this.approvalInterval, this.signal); if (this.signal.aborted) break;
      try {
        for (const approval of await this.options.access.drainApprovals()) {
          this.active(); const result = await this.actions.send({ targetId: approval.chatId, text: 'Paired. You can now message Klaus here.' });
          if (result.ok !== true) this.patch({ lastError: string(result.error, 'Discord pairing confirmation failed') });
        }
        await this.refreshAccess();
      } catch (error) { if (!this.signal.aborted) this.patch({ lastError: errorMessage(error) }); }
    }
  }
}
export function discordAdapter(options: DiscordTransportOptions): ChannelAdapterFactory { return (account, context) => DiscordTransport.start(account, context, options); }
