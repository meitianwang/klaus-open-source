import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import type { FriendMessage } from '../../../shared/friends';
import { object, string, type JsonObject } from '../service-types';
import { MOBILE_BODY_LIMIT, MOBILE_FEATURES, type MobileAccount } from './protocol';
import { mobileDeviceId, readMobileMachineIdentifier, type MobileSettings } from './settings';
import { responseText, sendSocket, stopSocket } from './transport';
import { MobilePushOutbox, type MobilePushNotice } from './push';
import { diagnosticFrame, MobileLoadDiagnostics, type DiagnosticMetadata } from './load-diagnostics';

const FRAME_LIMIT = 36 * 1024 * 1024;
/** Reconnect backoff grows from here and is never capped above the ceiling. */
const RECONNECT_BACKOFF_INITIAL_MS = 5_000;
const RECONNECT_BACKOFF_CAP_MS = 30_000;
/** Extra spread added on top of a server-specified retry deadline. */
const RETRY_AFTER_JITTER_MS = 30_000;
/** Ceiling on draining writers after the relay is told to stop. */
const SHUTDOWN_DRAIN_MS = 5_000;

/**
 * A server retry deadline is a lower bound, so the next attempt is uniformly
 * spread after it instead of landing on the same instant as every other desktop.
 */
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (/^\d+$/u.test(text)) {
    const at = now + Number(text) * 1_000;
    return Number.isFinite(at) && at > now ? at : undefined;
  }
  const at = Date.parse(text);
  return Number.isFinite(at) && at > now ? at : undefined;
}
type RelayPowerPhase = 'connecting' | 'connected' | 'disconnected' | 'error';
interface RelayDeps {
  connectionChanged?: () => void;
  friendMessage?: (message: FriendMessage, signal: AbortSignal) => Promise<{ accepted: true; taskId: string; awaitingAuthorization: boolean; threadId?: string }>;
  friendRevoked?: (friendshipId: string) => Promise<void>;
  friendConnected?: () => void;
  friendDisconnected?: () => void;
  configRoot: string; account(): MobileAccount | undefined; fetch?: typeof fetch; platform?: NodeJS.Platform;
  machineIdentifier?: () => Promise<string | undefined>; hostname?: string; heartbeatMs?: number; retryDelaysMs?: number[]; requestTimeoutMs?: number;
  authorizationExpired?: () => void;
  socketHeartbeatMs?: number; socketPongTimeoutMs?: number;
  log?: (event: string, fields: JsonObject) => void;
  diagnosticsEnabled?: () => boolean;
}
interface LocalQueuedFrame { data: string; diagnostic?: DiagnosticMetadata; queuedAt?: number }
interface LocalConnection { socket: WebSocket; queued: LocalQueuedFrame[]; bytes: number; paused: boolean; diagnostics: MobileLoadDiagnostics }
export class MobileRelay {
  private readonly abort = new AbortController();
  private readonly jobs = new Set<Promise<unknown>>();
  private readonly locals = new Map<string, LocalConnection>();
  private socket?: WebSocket;
  private readonly requests = new Set<string>();
  private readonly connections = new Set<Promise<void>>();
  private connected = false;
  private friendReady = false;
  private error: string | null = null;
  private stopped = false;
  private powerPhase: RelayPowerPhase = 'connecting';
  private enableFailed = false;
  private everConnected = false;
  private initialPowerTimer?: NodeJS.Timeout;
  private closing?: Promise<void>;
  private identity?: { account: MobileAccount; deviceId: string };
  private heartbeating = false;
  private outbox?: MobilePushOutbox;
  /** Server-specified earliest retry time, cleared once it is honoured. */
  private retryAt?: number;
  constructor(private readonly config: MobileSettings & { localBaseURL: string }, private readonly deps: RelayDeps) {}
  status(): { connected: boolean; friendReady: boolean; error: string | null } { return { connected: this.connected, friendReady: this.friendReady, error: this.error }; }
  powerStatus(): { status: RelayPowerPhase; enableFailed: boolean } { return { status: this.powerPhase, enableFailed: this.enableFailed }; }
  private powerChanged(phase: RelayPowerPhase): void {
    this.powerPhase = phase;
    if (phase === 'connected') {
      this.everConnected = true; this.enableFailed = false;
      if (this.initialPowerTimer) clearTimeout(this.initialPowerTimer);
    } else if (phase === 'error' && !this.everConnected) this.enableFailed = true;
    this.deps.connectionChanged?.();
  }
  async waitForFriendTransport(signal: AbortSignal): Promise<{ deviceId: string; connected: true }> {
    const waiting = AbortSignal.any([signal, this.abort.signal, AbortSignal.timeout(10_000)]);
    while (this.live()) {
      waiting.throwIfAborted();
      if (this.friendReady && this.connected && this.identity && this.deps.friendMessage) return { deviceId: this.identity.deviceId, connected: true };
      await delay(25, undefined, { signal: waiting });
    }
    throw new Error('Friends transport stopped before registering the current protocol');
  }
  start(): void {
    this.initialPowerTimer = setTimeout(() => { if (!this.connected) { this.enableFailed = true; this.deps.connectionChanged?.(); } }, 5000);
    this.initialPowerTimer.unref();
    this.track(this.supervise());
  }
  resetDiagnostics(): void {
    for (const local of this.locals.values()) {
      local.diagnostics.reset();
      for (const item of local.queued) { item.diagnostic = undefined; item.queuedAt = undefined; }
    }
  }
  publishNotice(notice: MobilePushNotice): void {
    if (!this.config.enabled || !this.live()) return;
    const account = this.account(); if (!account) return;
    const outbox = this.outbox ??= new MobilePushOutbox(this.deps.configRoot, account.userId,
      event => this.deps.log?.(event, {}));
    this.track(outbox.enqueue(notice).then(() => { if (this.live()) this.sendNotices(); }));
  }
  private sendNotices(): void {
    const socket = this.socket;
    if (!this.config.enabled || !socket || socket.readyState !== WebSocket.OPEN || !this.live()) return;
    for (const event of this.outbox?.notices() ?? []) sendSocket(socket, { type: 'push_event', event: { ...event } }, FRAME_LIMIT);
  }
  close(): Promise<void> {
    this.stop();
    return this.closing ??= (async () => {
      const drain = (async () => {
        while (this.jobs.size) await Promise.allSettled([...this.jobs]);
        await Promise.allSettled([...this.connections]);
        await this.outbox?.flush();
      })();
      // A wedged writer must not hold process shutdown open indefinitely.
      await Promise.race([drain, delay(SHUTDOWN_DRAIN_MS).catch(() => undefined)]);
    })();
  }
  private stop(): void {
    const hadFriendTransport = this.friendReady;
    this.stopped = true; this.connected = false; this.friendReady = false; this.abort.abort();
    if (this.initialPowerTimer) clearTimeout(this.initialPowerTimer);
    this.powerChanged('disconnected');
    if (hadFriendTransport) this.connectionEvent('friends_disconnected', this.deps.friendDisconnected);
    if (this.socket) this.trackConnection(stopSocket(this.socket));
    for (const local of this.locals.values()) { local.diagnostics.close(); this.trackConnection(stopSocket(local.socket)); }
    this.locals.clear();
  }
  private track(promise: Promise<unknown>): void { this.jobs.add(promise); void promise.catch(() => {}).finally(() => this.jobs.delete(promise)); }
  private trackConnection(promise: Promise<void>): void { this.connections.add(promise); void promise.finally(() => this.connections.delete(promise)); }
  private live(): boolean {
    if (this.abort.signal.aborted) return false;
    if (this.identity) {
      const current = this.account();
      if (current?.token !== this.identity.account.token || current.userId !== this.identity.account.userId) { this.stop(); return false; }
    }
    return true;
  }
  private account(): MobileAccount | undefined {
    const current = this.deps.account(); return current?.token && current.userId ? current : undefined;
  }
  private async supervise(): Promise<void> {
    let attempt = 0;
    while (this.live()) {
      let opened = false;
      this.powerChanged('connecting');
      try {
        if (await this.register()) {
          if (!this.heartbeating) { this.heartbeating = true; this.track(this.heartbeat()); }
          opened = await this.connection();
        }
        else if (this.live()) this.powerChanged('error');
      } catch { if (this.live()) { this.error = 'Relay registration failed'; this.powerChanged('error'); } }
      if (!this.live()) break;
      if (opened) attempt = 0;
      const server = this.retryAt; this.retryAt = undefined;
      if (server !== undefined) {
        const wait = Math.max(0, server - Date.now()) + Math.floor(Math.random() * RETRY_AFTER_JITTER_MS);
        await delay(wait, undefined, { signal: this.abort.signal }).catch(() => {});
        continue;
      }
      const configured = this.deps.retryDelaysMs ?? (this.everConnected ? undefined : [1000, 2000, 5000, 15_000]);
      if (configured?.length) {
        // Bring-up keeps a short ladder so a first registration is not delayed by
        // a full backoff step; an explicit schedule keeps its order, only the tail repeats.
        await delay(configured[Math.min(attempt++, configured.length - 1)] ?? RECONNECT_BACKOFF_CAP_MS,
          undefined, { signal: this.abort.signal }).catch(() => {});
        continue;
      }
      // After a working connection, a dropped relay retries on the growing ladder.
      const backoff = Math.min(RECONNECT_BACKOFF_CAP_MS, RECONNECT_BACKOFF_INITIAL_MS * 2 ** Math.min(attempt, 10));
      attempt++;
      // Spread the retry so a fleet that lost the same relay does not return in lockstep.
      await delay(backoff * (0.5 + Math.random() * 0.5), undefined, { signal: this.abort.signal }).catch(() => {});
    }
  }
  private connection(): Promise<boolean> {
    return new Promise(resolve => {
      if (!this.live() || !this.identity) { resolve(false); return; }
      const url = new URL(this.config.relayURL + '/api/mobile/relay/' + encodeURIComponent(this.config.relayId) + '/desktop');
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(url, { headers: { authorization: 'Bearer ' + this.identity.account.token, 'x-klaus-device-id': this.identity.deviceId }, maxPayload: FRAME_LIMIT, perMessageDeflate: false, followRedirects: false, handshakeTimeout: this.deps.requestTimeoutMs ?? 30_000 });
      this.socket = socket; let openedAt: number | undefined;
      let pingTimer: NodeJS.Timeout | undefined, pongTimer: NodeJS.Timeout | undefined, pingPayload: string | undefined;
      const connectionAbort = new AbortController(), relayAbort = (): void => connectionAbort.abort();
      this.abort.signal.addEventListener('abort', relayAbort, { once: true });
      socket.once('open', () => {
        if (!this.live()) { socket.terminate(); return; }
        openedAt = Date.now(); this.connected = true; this.error = null;
        this.powerChanged('connected');
        this.deps.log?.('relay_open', {});
        sendSocket(socket, { type: 'desktop_hello', protocolVersion: 1, friendsMessaging: this.deps.friendMessage ? 3 : 0, remoteAccessEnabled: this.config.enabled, desktopSecret: this.config.relaySecret, mobileTokenHash: createHash('sha256').update(this.config.token).digest('hex') }, FRAME_LIMIT);
        this.sendNotices();
        pingTimer = setInterval(() => {
          if (!this.live() || this.socket !== socket || socket.readyState !== WebSocket.OPEN || pongTimer) return;
          pingPayload = String(Date.now());
          pongTimer = setTimeout(() => {
            this.deps.log?.('relay_pong_timeout', {}); socket.terminate();
          }, this.deps.socketPongTimeoutMs ?? 60_000);
          pongTimer.unref();
          socket.ping(pingPayload, undefined, (error?: Error) => { if (error) socket.terminate(); });
        }, this.deps.socketHeartbeatMs ?? 10_000);
        pingTimer.unref();
      });
      socket.on('pong', data => {
        if (data.toString() !== pingPayload) return;
        if (pongTimer) clearTimeout(pongTimer); pongTimer = undefined; pingPayload = undefined;
      });
      socket.on('message', bytes => {
        if (!this.live() || this.socket !== socket) return;
        let message: JsonObject; try { message = object(JSON.parse(bytes.toString())); } catch { return; }
        this.message(message, socket, connectionAbort.signal);
      });
      socket.on('error', () => { if (this.live()) { this.error = 'Relay disconnected'; this.powerChanged('error'); } });
      socket.once('close', code => {
        if (pingTimer) clearInterval(pingTimer); if (pongTimer) clearTimeout(pongTimer);
        this.deps.log?.('relay_closed', { code, connectedMs: openedAt === undefined ? 0 : Date.now() - openedAt });
        connectionAbort.abort(); this.abort.signal.removeEventListener('abort', relayAbort);
        if (this.socket === socket) {
          const hadFriendTransport = this.friendReady;
          this.socket = undefined; this.connected = false; this.friendReady = false; if (!this.stopped) this.error = 'Relay disconnected';
          this.powerChanged(this.stopped ? 'disconnected' : 'error');
          if (hadFriendTransport) this.connectionEvent('friends_disconnected', this.deps.friendDisconnected);
          for (const local of this.locals.values()) { local.diagnostics.close(); this.trackConnection(stopSocket(local.socket)); } this.locals.clear();
        }
        resolve(openedAt !== undefined && Date.now() - openedAt >= 60_000);
      });
      if (!this.live()) socket.terminate();
    });
  }
  private message(message: JsonObject, socket: WebSocket, signal: AbortSignal): void {
    const clientId = string(message.clientId);
    switch (message.type) {
      case 'desktop_hello_ack': {
        if (message.friendsMessaging === 3 && message.remoteAccessEnabled === this.config.enabled && this.deps.friendMessage && !this.friendReady) {
          this.friendReady = true; this.connectionEvent('friends_connected', this.deps.friendConnected);
        }
        break;
      }
      case 'friend_revoked': {
        const friendshipId = string(message.friendshipId);
        if (this.friendReady && this.deps.friendRevoked && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(friendshipId)) {
          this.connectionEvent('friends_revoked', () => this.deps.friendRevoked!(friendshipId));
        }
        break;
      }
      case 'friend_message': {
        const requestId = string(message.requestId);
        if (!requestId || requestId.length > 256 || this.requests.has(requestId) || this.requests.size >= 64) return;
        this.requests.add(requestId);
        this.track((async () => {
          try {
            if (!this.deps.friendMessage || !this.friendReady) throw new Error('Friend tasks are unavailable on this desktop');
            const result = await this.deps.friendMessage(object(message.message) as unknown as FriendMessage, signal);
            if (!signal.aborted && this.live()) sendSocket(socket, { type: 'friend_message_response', requestId, ...result }, FRAME_LIMIT);
          } catch (error) {
            if (!signal.aborted && this.live()) sendSocket(socket, { type: 'friend_message_response', requestId, accepted: false, error: 'The receiving computer could not admit this friend task' }, FRAME_LIMIT);
          } finally { this.requests.delete(requestId); }
        })());
        break;
      }
      case 'push_event_ack': {
        const eventId = string(message.eventId);
        if (eventId && eventId.length <= 512 && this.outbox) this.track(this.outbox.acknowledge(eventId, message.resolved === true));
        break;
      }
      case 'http_request': {
        const id = string(message.requestId); if (!id || id.length > 256 || this.requests.has(id) || this.requests.size >= 64) return;
        this.requests.add(id); this.track(this.forwardHTTP(message, socket, signal).finally(() => this.requests.delete(id))); break;
      }
      case 'mobile_ws_open': if (clientId && clientId.length <= 256) this.openLocal(clientId, socket, signal, message.catalogSync === 1); break;
      case 'mobile_ws_flow': {
        const local = this.locals.get(clientId); if (!local || typeof message.paused !== 'boolean') return;
        local.paused = message.paused;
        local.diagnostics.flow(local.paused);
        if (local.socket.readyState === WebSocket.OPEN) {
          if (local.paused) local.socket.pause(); else local.socket.resume();
        }
        break;
      }
      case 'mobile_ws_message': {
        const local = this.locals.get(clientId), data = string(message.data); if (!local || !data) return;
        if (Buffer.byteLength(data) + local.bytes + local.socket.bufferedAmount > MOBILE_BODY_LIMIT * 2) { local.diagnostics.close(); this.locals.delete(clientId); this.trackConnection(stopSocket(local.socket)); return; }
        const observedAt = local.diagnostics.enabled() ? performance.now() : undefined;
        const frame = observedAt === undefined ? undefined : diagnosticFrame(data, true);
        const diagnostic = frame ? local.diagnostics.begin({ ...frame.metadata,
          type: frame.metadata.diagnosticOperation === 'catalog' ? 'catalog_sync' : 'follow_task' }, observedAt) : undefined;
        if (local.paused) local.diagnostics.flow(true);
        if (local.socket.readyState === WebSocket.OPEN) this.writeLocal(local, { data, diagnostic });
        else {
          const queuedAt = diagnostic ? performance.now() : undefined;
          if (diagnostic) local.diagnostics.record(diagnostic, 'bridge_local_queued', { bytes: Buffer.byteLength(data), queueBytes: local.bytes });
          local.queued.push({ data, diagnostic, queuedAt }); local.bytes += Buffer.byteLength(data);
        }
        break;
      }
      case 'mobile_ws_close': { const local = this.locals.get(clientId); if (local) { local.diagnostics.close(); this.locals.delete(clientId); this.trackConnection(stopSocket(local.socket)); } break; }
      default: break;
    }
  }
  private connectionEvent(event: string, callback?: () => void | Promise<void>): void {
    // The owning FriendsService drains its reconciliation jobs. Waiting for
    // them here could deadlock stop() against a queued ensureFriendTransport().
    try { void Promise.resolve(callback?.()).catch(() => this.deps.log?.(event + '_failed', {})); }
    catch { this.deps.log?.(event + '_failed', {}); }
  }
  private async forwardHTTP(message: JsonObject, socket: WebSocket, signal: AbortSignal): Promise<void> {
    const requestId = string(message.requestId);
    if (!this.config.enabled) {
      if (!signal.aborted && this.live()) sendSocket(socket, { type: 'http_response', requestId, status: 403,
        body: JSON.stringify({ error: { type: 'remote_access_disabled', message: 'Remote access is disabled' } }) }, FRAME_LIMIT);
      return;
    }
    try {
      const path = string(message.path), method = string(message.method) || 'GET';
      const url = new URL(path, this.config.localBaseURL);
      if (!['GET', 'POST'].includes(method) || !path.startsWith('/api/mobile/') || url.origin !== this.config.localBaseURL || !url.pathname.startsWith('/api/mobile/') || path.includes('\\')) throw new Error('Invalid desktop request');
      const body = typeof message.body === 'string' ? message.body : undefined;
      if (body && Buffer.byteLength(body) > MOBILE_BODY_LIMIT) throw new Error('Desktop request is too large');
      const timeout = AbortSignal.timeout(this.deps.requestTimeoutMs ?? 30_000);
      const response = await (this.deps.fetch ?? fetch)(url, { method, headers: { authorization: 'Bearer ' + this.config.token, 'content-type': 'application/json' }, body: method === 'POST' ? body : undefined, signal: AbortSignal.any([signal, timeout]), redirect: 'error' });
      const text = await responseText(response, MOBILE_BODY_LIMIT);
      if (!signal.aborted && this.live()) sendSocket(socket, { type: 'http_response', requestId, status: response.status, body: text, contentType: response.headers.get('content-type') || 'application/json; charset=utf-8' }, FRAME_LIMIT);
    } catch {
      if (!signal.aborted && this.live()) sendSocket(socket, { type: 'error', requestId, code: 'desktop_request_failed', message: 'Desktop request failed' }, FRAME_LIMIT);
    }
  }
  private openLocal(id: string, relay: WebSocket, signal: AbortSignal, catalogSync = false): void {
    if (!this.config.enabled) { if (!signal.aborted && this.live()) sendSocket(relay, { type: 'mobile_ws_close', clientId: id, code: 1008, reason: 'Remote access is disabled' }, FRAME_LIMIT); return; }
    const old = this.locals.get(id); if (old) { old.diagnostics.close(); this.trackConnection(stopSocket(old.socket)); }
    if (!old && this.locals.size >= 64) return;
    const socket = new WebSocket(this.config.localBaseURL.replace(/^http/u, 'ws') + '/api/mobile/ws', {
      headers: { authorization: 'Bearer ' + this.config.token, ...(catalogSync ? { 'x-klaus-mobile-catalog': '1' } : {}) },
      maxPayload: MOBILE_BODY_LIMIT, perMessageDeflate: false, handshakeTimeout: this.deps.requestTimeoutMs ?? 30_000,
    });
    const local: LocalConnection = { socket, queued: [], bytes: 0, paused: false,
      diagnostics: new MobileLoadDiagnostics(event => this.deps.log?.('load_diagnostic', event), undefined,
        { layer: 'outerRelay', enabled: () => this.deps.diagnosticsEnabled?.() === true }) }; this.locals.set(id, local);
    const current = (): boolean => this.live() && !signal.aborted && this.locals.get(id) === local;
    socket.once('open', () => {
      if (!current()) { socket.terminate(); return; }
      if (local.paused) socket.pause();
      for (const item of local.queued) {
        if (socket.bufferedAmount + Buffer.byteLength(item.data) > MOBILE_BODY_LIMIT * 2) { socket.close(1013, 'relay consumer too slow'); break; }
        this.writeLocal(local, item);
      }
      local.queued = []; local.bytes = 0;
    });
    socket.on('message', bytes => {
      if (!current()) return;
      const observedAt = local.diagnostics.enabled() ? performance.now() : undefined;
      const data = bytes.toString(), frame = observedAt === undefined ? undefined : diagnosticFrame(data);
      const sample = frame && (frame.fields.index === undefined || frame.fields.index === 0 || frame.last);
      local.diagnostics.observeResponse(frame?.metadata, observedAt);
      if (sample) local.diagnostics.record(frame.metadata, 'bridge_response_received', { ...frame.fields, bytes: Buffer.byteLength(data) }, observedAt);
      const startedAt = frame ? performance.now() : 0;
      const sent = sendSocket(relay, { type: 'mobile_ws_message', clientId: id, data }, FRAME_LIMIT, frame ? observation => {
        const fields = { ...frame.fields, bytes: observation.bytes, bufferedBytes: observation.bufferedBytes };
        if (observation.phase === 'started') {
          if (sample) local.diagnostics.record(frame.metadata, 'bridge_relay_write_started', fields);
        } else {
          const wireBytes = observation.success ? local.diagnostics.wrote(frame.metadata, observation.bytes) : undefined;
          if (sample) local.diagnostics.record(frame.metadata, 'bridge_relay_write_complete',
            { ...fields, wireBytes, durationMs: performance.now() - startedAt, errorCode: observation.success ? undefined : 'send_failed' });
          if (!observation.success) local.diagnostics.finish(frame.metadata, 'send_failed');
          else if (frame.last && ['task_follow_ready', 'error'].includes(frame.metadata.diagnosticMessage)) local.diagnostics.finish(frame.metadata);
        }
      } : undefined);
      if (!sent && frame) local.diagnostics.finish(frame.metadata, 'send_failed');
    });
    socket.on('error', () => { if (current()) sendSocket(relay, { type: 'error', clientId: id, code: 'desktop_ws_failed', message: 'Desktop WebSocket failed' }, FRAME_LIMIT); });
    socket.once('close', (code, reason) => {
      if (this.locals.get(id) !== local) return; local.diagnostics.close(); this.locals.delete(id);
      if (this.live() && !signal.aborted) sendSocket(relay, { type: 'mobile_ws_close', clientId: id, code, reason: reason.toString().slice(0, 120) }, FRAME_LIMIT);
    });
  }
  private writeLocal(local: LocalConnection, item: LocalQueuedFrame): void {
    const startedAt = item.diagnostic ? performance.now() : 0;
    if (item.diagnostic) local.diagnostics.record(item.diagnostic, 'bridge_local_write_started', {
      bytes: Buffer.byteLength(item.data), bufferedBytes: local.socket.bufferedAmount,
      durationMs: item.queuedAt === undefined ? undefined : startedAt - item.queuedAt,
    });
    local.socket.send(item.data, error => {
      if (error) local.socket.terminate();
      if (item.diagnostic) local.diagnostics.record(item.diagnostic, 'bridge_local_write_complete',
        { durationMs: performance.now() - startedAt, errorCode: error ? 'send_failed' : undefined });
      if (error) local.diagnostics.finish(item.diagnostic, 'send_failed');
    });
  }
  private async register(): Promise<boolean> {
    const account = this.account(); if (!account) { this.stop(); return false; }
    const platform = this.deps.platform ?? process.platform;
    if (!this.identity) {
      const deviceId = await mobileDeviceId(this.deps.configRoot, account.userId, platform, this.deps.machineIdentifier ?? (() => readMobileMachineIdentifier(platform)));
      const current = this.account();
      if (current?.token !== account.token || current.userId !== account.userId) { this.stop(); return false; }
      this.identity = { account: { ...account }, deviceId };
      this.outbox ??= new MobilePushOutbox(this.deps.configRoot, account.userId, event => this.deps.log?.(event, {}));
      await this.outbox.ready;
    }
    if (!this.live()) return false;
    const deviceId = this.identity.deviceId;
    const post = async (path: string, body: JsonObject): Promise<number> => {
      if (!this.live()) throw new DOMException('Account changed', 'AbortError');
      const response = await (this.deps.fetch ?? fetch)(this.config.relayURL + '/api/mobile/devices/' + path, { method: 'POST', headers: { authorization: 'Bearer ' + account.token, 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(this.deps.requestTimeoutMs ?? 30_000)]) });
      const retryAt = parseRetryAfter(response.headers.get('retry-after'));
      if (retryAt !== undefined) this.retryAt = retryAt;
      await response.body?.cancel();
      if (!this.live()) throw new DOMException('Account changed', 'AbortError');
      return response.status;
    };
    let status = await post('register', { deviceId, name: this.deps.hostname ?? hostname(), platform, relayId: this.config.relayId, relayUrl: this.config.relayURL,
      features: { ...MOBILE_FEATURES, friendsMessaging: this.deps.friendMessage ? 3 : 0 } });
    if (!this.deps.friendMessage && status !== 401 && (status < 200 || status >= 300)) status = await post('heartbeat', { deviceId, relayId: this.config.relayId });
    if (status === 401) { this.error = 'Account authorization expired'; this.stop(); this.deps.authorizationExpired?.(); return false; }
    return this.live() && status >= 200 && status < 300;
  }
  private async heartbeat(): Promise<void> {
    while (this.live()) {
      await delay(this.deps.heartbeatMs ?? 20_000, undefined, { signal: this.abort.signal }).catch(() => {});
      if (!this.live()) break;
      try { await this.register(); this.sendNotices(); } catch { /* A transient cloud request does not claim the relay has connected. */ }
    }
  }
}
