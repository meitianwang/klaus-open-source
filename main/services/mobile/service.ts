import { isFastModePreferenceKey } from '../../../shared/model-fast-mode';
import { isTraeNativeEffort } from '../../../shared/trae-model-catalog';
import type { FriendMessage } from '../../../shared/friends';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import type { Json } from '../../ipc/contract';
import { object, SerialMutations, string, type JsonObject } from '../service-types';
import { modelSource, readSessionModel, THINKING_LEVELS } from '../session-store';
import { composerMenu, MobileProjection, projectRows } from './projection';
import { attachmentUpload, authMode, authorized, badRequest, elicitationResponse, mainModel, mediaItems, messageText, MOBILE_BODY_LIMIT, MOBILE_FEATURES, MobileError, mobileError, nonempty, optionText, pathBase, permissionResponse, questionAnswer, required, sameOwner, short, slashName, thinking, title, workdir, workspaceId, type IncomingMedia, type MobileAccount, type MobileCall, type MobileCallContext, type MobileDispatch, type MobileEngineOwner } from './protocol';
import { MobileRelay } from './relay';
import type { MobilePushKind } from './push';
import { mobileDeviceId, readMobileMachineIdentifier, MobileSettingsStore, type MobileSettings } from './settings';
import { encodedSocketFrame, httpReply, MESSAGE_CHUNKING_LEVEL, MESSAGE_OUTBOUND_CAPACITY, MESSAGE_CLIENT_IDLE_TIMEOUT_MS, MESSAGE_IDLE_SWEEP_INTERVAL_MS, readRequest, ReliableDelivery, ReliableDeliveryStore, responseText, socketBytes, stopSocket, type ChunkingProfile } from './transport';
import { MobileTaskStreams, taskCursor } from './task-stream';
import { REMOTE_THREAD_OPERATIONS, type RemoteThreadOperation } from '../remote-thread-client';
import { MobileCatalog, catalogAccountKey, catalogCursor, type CatalogSourcePage } from './catalog';
import { MobileHydrationQueue } from './hydration-queue';
import { diagnosticMetadata, diagnosticRequest, diagnosticResponse, MobileLoadDiagnostics, type DiagnosticMetadata } from './load-diagnostics';
import { splitDynamicToolMedia } from '../tool-media';
import { activeFollowEvents, followQuestions } from './follow-snapshot';
import { INLINE_VIS_MAX_BYTES } from '../../../contracts/inline-visualization';
import { applyModelPreference, MobileModelConfigProjection, modelConfigSession, modelConfigUpdate, modelPreference, type MobileModelPreference } from './model-config';
import { mobileNewChatBranch, mobileNewChatContext, mobileNewChatRun, type MobileNewChatRun } from './new-chat';
import { FOLLOW_UP_MODE_KEY, followUpMode, followUpPayload, uploadFollowUpMedia, mobileFollowUpIntent, MobileFollowUpControls, payloadFingerprint, type MobileFollowUpIntent } from './follow-ups';

export interface MobileThreadContext {
  accountId: string; localHostId: string; signal: AbortSignal; owner: MobileEngineOwner; assertCurrent(): void;
}

export interface MobileBridgeDeps {
  connectionChanged?: () => void;
  sessionInterestChanged?: (sessionId: string) => void;
  friendMessage?: (message: FriendMessage, signal: AbortSignal) => Promise<{ accepted: true; taskId: string; awaitingAuthorization: boolean; threadId?: string }>;
  friendRevoked?: (friendshipId: string) => Promise<void>;
  friendConnected?: () => void;
  friendDisconnected?: () => void;
  configRoot: string; relayURL: string; dispatch: MobileDispatch; engineOwner(): MobileEngineOwner | undefined;
  ensureEngineOwner?: (signal: AbortSignal) => Promise<void>;
  account(): MobileAccount | undefined; env?: NodeJS.ProcessEnv; fetch?: typeof fetch; platform?: NodeJS.Platform;
  machineIdentifier?: () => Promise<string | undefined>; hostname?: string; heartbeatMs?: number; retryDelaysMs?: number[]; requestTimeoutMs?: number;
  authorizationExpired?: () => void;
  /**
   * Live relay reachability per device id. The cloud list derives status from
   * heartbeats, which stay fresh for two minutes after a desktop went away;
   * the relay connection is what actually decides whether a mention can be
   * delivered, so it wins when known.
   */
  deviceStatus?: () => Promise<Record<string, string>>;
  socketHeartbeatMs?: number; socketPongTimeoutMs?: number; composerRetryDelaysMs?: number[];
  log?: (event: string, fields: JsonObject) => void;
  diagnosticsEnabled?: () => boolean;
  followSession?: (sessionId: string, context: MobileCallContext & { onHistory?: (history: Json) => void; priority?: 'interactive' | 'background' }) => Promise<Json>;
  catalogPage?: (cursor: string | undefined, context: MobileCallContext) => Promise<CatalogSourcePage>;
  catalogRow?: (sessionId: string, context: MobileCallContext, priority?: 'interactive' | 'background') => Promise<JsonObject | null>;
  catalogVisible?: (sessionId: string) => boolean;
  threadRequest?: (name: RemoteThreadOperation, payload: JsonObject, context: MobileThreadContext) => Promise<JsonObject>;
  mediaPreview?: (sessionId: string, path: string, signal: AbortSignal) => Promise<JsonObject>;
  inlineVisualizationPreview?: (sessionId: string, path: string) => Promise<JsonObject>;
  diagramPreview?: (sessionId: string, id: string) => JsonObject | Promise<JsonObject>;
}
interface TaskFollowState { snapshotting: boolean; revision: number; pending: JsonObject[]; pendingBytes: number; generation: number }
/** Byte ceiling for one peer's write queue; the envelope count is the primary bound. */
const SEND_QUEUE_BYTES = 64 * 1024 * 1024;
interface Peer { socket: WebSocket; subscriptions: Set<string>; follows: Map<string, TaskFollowState>; followRequests: Map<string, AbortController>; controller: AbortController; tail: Promise<void>; queuedBytes: number; queuedMessages: number; sendTail: Promise<void>; sendQueuedBytes: number; sendQueuedMessages: number; ready: boolean; outbound: JsonObject[]; outboundBytes: number; clientId?: string; delivery?: ReliableDelivery; /** Framing this peer advertised; absent means the level 2 shape. */ chunking: ChunkingProfile; lastActivityAt: number; /** Frames are admitted in call order even across a full queue. */ admissionTail: Promise<void>; admissionPending: number; capacityWaiters: Array<() => void>; catalogSync: boolean; catalogRequest?: AbortController; composerRefresh?: Promise<void>; composerRetry?: NodeJS.Timeout; composerAttempt: number; diagnostics: MobileLoadDiagnostics }
interface DraftPromotion { createdAt: number; fingerprint: string; owner: MobileEngineOwner; task?: Promise<JsonObject>; settled: boolean; ownedSessionId?: string; ownedWorktreePath?: string; cleanupFailures?: JsonObject[] }
interface RecentSend { createdAt: number; requestId: string; fingerprint: string; completion: Promise<JsonObject>; settled: boolean }
interface PendingMobileMessage { sessionId: string; clientMessageId: string; clientSeq?: number }
interface Run { server: Server; ws: WebSocketServer; controller: AbortController; sockets: Set<Socket>; peers: Set<Peer>; jobs: Set<Promise<unknown>>; config: MobileSettings; account?: MobileAccount; port: number; relay?: MobileRelay; recent: Map<string, RecentSend>; pendingSendBytes: number; pendingSendCount: number; promotions: Map<string, DraftPromotion>; followUps: MobileFollowUpControls; deliveries: ReliableDeliveryStore; catalog?: MobileCatalog; stateRefresh?: Promise<void>; stateRefreshAgain: boolean; idleSweep?: NodeJS.Timeout; stateIncludeSessions?: boolean; modelRefresh?: Promise<void>; modelRefreshAgain?: boolean; modelRevision?: number }
interface PendingInteraction { owner: MobileEngineOwner; sessionId: string | null; resolving?: boolean }
type InteractionKind = 'permission' | 'elicit';
const MAX_UNPROTECTED_FOLLOWS = 64;
const THREAD_TOOLS_PREFIX = '/api/mobile/thread-tools/';
export const MOBILE_DISPATCH_CHANNELS = [
  'session:list', 'projects:list', 'workspaces:list', 'settings:kv:get', 'engine:slashCommands', 'session:get-main-model', 'session:get-thinking-level', 'session:get-ultra-mode', 'session:get-fast-mode',
  'settings:output-styles:list', 'session:get-main-model-options', 'session:get-custom-main-model-options', 'session:new', 'projects:set-active',
  'session:history', 'session:set-workdir', 'session:clear-workdir', 'session:rename', 'session:delete', 'session:export', 'feedback:submit',
  'chat:follow-up', 'chat:client-queue-snapshot', 'chat:client-queue-add', 'chat:client-queue-remove', 'chat:client-queue-restore', 'chat:client-queue-reorder', 'chat:client-queue-resume', 'chat:client-queue-deliver', 'chat:client-queue-clear',
  'chat:interrupt', 'permission:respond', 'session:set-main-model', 'session:set-thinking-level', 'session:set-ultra-mode', 'session:set-fast-mode', 'settings:kv:set', 'settings:output-styles:set', 'chat:send', 'chat:upload',
  'permission:pending', 'elicit:pending', 'elicit:respond', 'question:pending', 'question:answer', 'agents:snapshot', 'agents:history', 'artifacts:read',
  'session:background-processes', 'session:stop-background-process',
  'auth:status', 'codex-auth:status', 'cursor-auth:status', 'qoder-auth:status', 'qwenwork-auth:status', 'qoderwork-auth:status', 'workbuddy-auth:status', 'antigravity-auth:status', 'trae-auth:status', 'kiro-auth:status', 'kimi-auth:status', 'bailian-auth:status', 'minimax-auth:status', 'zhipu-auth:status', 'ark-auth:status', 'settings:models:list',
  'git:branches', 'git:uncommitted', 'git:checkout', 'git:commit-paths', 'worktree:create-from-workdir', 'worktree:remove',
] as const;

/** Owns only the mobile transport. All product actions use the existing named dispatcher. */
export class MobileBridgeService {
  private readonly settings: MobileSettingsStore;
  private readonly mutations = new SerialMutations();
  private readonly taskStreams: MobileTaskStreams;
  private readonly hydration = new MobileHydrationQueue();
  private run?: Run;
  private closed = false;
  private closing?: Promise<void>;
  private activeSession?: string;
  private readonly working = new Set<string>();
  /// Sessions with an unanswered permission or elicitation: the phone's "waiting on you" badge
  /// and inbox are projections of this set, so a desktop turn blocked on approval is visible
  /// from any screen, not only from inside the blocked session.
  private readonly awaitingInteraction = new Set<string>();
  private readonly permissions = new Map<string, PendingInteraction>();
  private readonly elicitations = new Map<string, PendingInteraction>();
  private observedOwner?: MobileEngineOwner;
  constructor(private readonly deps: MobileBridgeDeps) {
    this.settings = new MobileSettingsStore(deps.configRoot, deps.relayURL, deps.env);
    this.taskStreams = new MobileTaskStreams((sessionId, frame) => this.broadcastTaskPatch(sessionId, frame), id => this.protectedFollow(id));
  }
  hasSessionInterest(sessionId: string): boolean {
    const run = this.run;
    if (!run || run.controller.signal.aborted) return false;
    return [...run.peers].some(peer => !peer.controller.signal.aborted
      && (peer.follows.has(sessionId) || peer.followRequests.has(sessionId) || peer.subscriptions.has(sessionId)));
  }
  /**
   * A transport identity that has sent nothing for the idle window is dropped:
   * its queued frames and partial assemblies go away, while the durable inbound
   * cursor keeps its own longer retention.
   */
  private sweepIdlePeers(run: Run): void {
    if (this.run !== run || run.controller.signal.aborted) return;
    const now = Date.now();
    for (const peer of [...run.peers]) {
      if (now - peer.lastActivityAt < MESSAGE_CLIENT_IDLE_TIMEOUT_MS) continue;
      this.deps.log?.('peer_idle_expired', { clientId: peer.clientId ?? null });
      peer.delivery?.clientChunks.clear();
      peer.delivery?.resetReplay();
      peer.controller.abort();
      peer.socket.close(4000, 'idle transport expired');
    }
  }
  private peerInterestChanged(peer: Peer): void {
    for (const id of new Set([...peer.follows.keys(), ...peer.followRequests.keys(), ...peer.subscriptions])) {
      this.deps.sessionInterestChanged?.(id);
    }
  }
  startFromSettings(): Promise<Json> {
    return this.mutations.run(async () => {
      this.checkOpen();
      const config = this.settings.read();
      if ((config.enabled || this.deps.friendMessage) && this.deps.account() && !this.run) await this.start(config);
      return this.status(config);
    });
  }
  get(): Promise<Json> { return this.mutations.run(async () => { this.checkOpen(); return this.status(this.settings.read()); }); }
  ensureFriendTransport(): Promise<{ deviceId: string; connected: boolean }> {
    return this.mutations.run(async () => {
      this.checkOpen();
      const account = this.deps.account();
      if (!account?.token || !this.deps.friendMessage) throw new MobileError(403, 'friends_transport_unavailable', 'Sign in to start friends messaging');
      const readinessDeadline = AbortSignal.timeout(10_000);
      const config = this.settings.read();
      if (this.run && (this.run.account?.userId !== account.userId || this.run.account?.token !== account.token || this.run.config.enabled !== config.enabled)) await this.stop();
      if (!this.run) await this.start(config);
      const run = this.run!;
      if (!run.relay) throw new MobileError(503, 'friends_transport_unavailable', 'Friends relay is not available');
      try { return await run.relay.waitForFriendTransport(AbortSignal.any([run.controller.signal, readinessDeadline])); }
      catch (error) { throw new MobileError(503, 'friends_transport_unavailable', error instanceof Error ? error.message : 'Friends transport did not register within ten seconds'); }
    });
  }
  listDevices(): Promise<Json> {
    return this.mutations.run(async (): Promise<Json> => {
      this.checkOpen();
      const account = this.deps.account();
      if (!account) return { ok: true, accountLinked: false, devices: [] };
      try {
        const response = await this.cloud(this.settings.read(), '/api/mobile/devices', { method: 'GET' });
        if (response.status < 200 || response.status >= 300) {
          return { ok: false, error: string(response.body.error) || 'device_list_failed', status: response.status };
        }
        const rows = Array.isArray(response.body.devices) ? response.body.devices : [];
        const live = await (this.deps.deviceStatus?.() ?? Promise.resolve({} as Record<string, string>)).catch(() => ({} as Record<string, string>));
        const devices = rows.flatMap(value => {
          const row = object(value), id = string(row.id), name = string(row.name);
          if (!id || !name) return [];
          const relayStatus = typeof live[id] === 'string' ? live[id] : '';
          return [{
            id,
            name,
            platform: string(row.platform, 'desktop'),
            status: ['online', 'reconnecting', 'offline'].includes(relayStatus) ? relayStatus
              : ['online', 'reconnecting', 'offline'].includes(string(row.status)) ? string(row.status) : 'offline',
            lastSeenAt: typeof row.lastSeenAt === 'number' ? row.lastSeenAt : null,
            appVersion: typeof row.appVersion === 'string' ? row.appVersion : null,
            isCurrent: row.isCurrent === true,
          }];
        });
        return { ok: true, accountLinked: true, devices };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'device_list_failed' };
      }
    });
  }
  removeDevice(payload: JsonObject): Promise<Json> {
    return this.mutations.run(async (): Promise<Json> => {
      this.checkOpen();
      const deviceId = string(payload.deviceId).trim();
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(deviceId)) return { ok: false, error: 'invalid_device' };
      if (!this.deps.account()) return { ok: false, error: 'account_required' };
      try {
        const response = await this.cloud(this.settings.read(), '/api/mobile/devices/' + encodeURIComponent(deviceId), { method: 'DELETE' });
        if (response.status >= 200 && response.status < 300) return { ok: true };
        return { ok: false, error: string(response.body.error) || 'device_remove_failed', status: response.status };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'device_remove_failed' };
      }
    });
  }
  renameDevice(payload: JsonObject): Promise<Json> {
    return this.mutations.run(async (): Promise<Json> => {
      this.checkOpen();
      const deviceId = string(payload.deviceId).trim();
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(deviceId)) return { ok: false, error: 'invalid_device' };
      if (typeof payload.name !== 'string') return { ok: false, error: 'invalid_name' };
      const name = payload.name.trim();
      if (name.length > 120) return { ok: false, error: 'invalid_name' };
      if (!this.deps.account()) return { ok: false, error: 'account_required' };
      try {
        const response = await this.cloud(this.settings.read(), '/api/mobile/devices/rename', {
          method: 'POST',
          body: JSON.stringify({ deviceId, name }),
        });
        if (response.status >= 200 && response.status < 300) return { ok: true, device: object(response.body.device) };
        return { ok: false, error: string(response.body.error) || 'device_rename_failed', status: response.status };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'device_rename_failed' };
      }
    });
  }
  set(payload: JsonObject): Promise<Json> { return this.reconfigure(payload); }
  rotateToken(): Promise<Json> { return this.reconfigure(undefined, true); }
  restart(): Promise<Json> { return this.reconfigure(); }
  refreshAccount(): Promise<Json> {
    return this.mutations.run(async () => {
      this.checkOpen();
      const config = this.settings.read();
      await this.stop();
      if ((config.enabled || this.deps.friendMessage) && this.deps.account()) await this.start(config);
      return this.status(config);
    });
  }
  private reconfigure(payload?: JsonObject, rotate = false): Promise<Json> {
    return this.mutations.run(async () => {
      this.checkOpen();
      const previous = this.settings.read();
      if (payload?.enabled === false && previous.enabled && !this.deps.friendMessage) await this.unregisterCurrent(previous);
      const config = this.settings.read(payload, rotate);
      await this.stop();
      if (config.enabled || this.deps.friendMessage && this.deps.account()) await this.start(config);
      return this.status(config);
    });
  }
  close(): Promise<void> { this.closed = true; this.run?.controller.abort(); return this.closing ??= this.mutations.run(() => this.stop()); }
  private checkOpen(): void { if (this.closed) throw new MobileError(503, 'bridge_closed', 'Mobile bridge closed'); }
  private async currentDeviceId(account: MobileAccount): Promise<string> {
    const platform = this.deps.platform ?? process.platform;
    return mobileDeviceId(
      this.deps.configRoot,
      account.userId,
      platform,
      this.deps.machineIdentifier ?? (() => readMobileMachineIdentifier(platform)),
    );
  }
  private async cloud(config: MobileSettings, path: string, init: RequestInit): Promise<{ status: number; body: JsonObject }> {
    const account = this.deps.account();
    if (!account?.token) throw new Error('account_required');
    const headers = new Headers(init.headers);
    headers.set('authorization', 'Bearer ' + account.token);
    if (init.body !== undefined) headers.set('content-type', 'application/json');
    const response = await (this.deps.fetch ?? fetch)(config.relayURL + path, {
      ...init,
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(this.deps.requestTimeoutMs ?? 30_000),
    });
    const text = await responseText(response, 512 * 1024);
    const current = this.deps.account();
    if (current?.userId !== account.userId || current.token !== account.token) throw new MobileError(409, 'account_changed', 'Account authorization changed');
    let body: JsonObject = {};
    if (text) {
      try { body = object(JSON.parse(text)); } catch { body = {}; }
    }
    if (response.status === 401) this.deps.authorizationExpired?.();
    return { status: response.status, body };
  }
  private async unregisterCurrent(config: MobileSettings): Promise<void> {
    const account = this.deps.account();
    if (!account) return;
    const deviceId = await this.currentDeviceId(account);
    const response = await this.cloud(config, '/api/mobile/devices/unregister', {
      method: 'POST',
      body: JSON.stringify({ deviceId }),
    });
    if ((response.status >= 200 && response.status < 300) || response.status === 404) return;
    throw new Error(string(response.body.error) || 'device_unregister_failed');
  }
  private status(config: MobileSettings): JsonObject {
    const relay = this.run?.relay?.status(), base = config.relayURL + '/api/mobile/relay/' + encodeURIComponent(config.relayId);
    return { ok: true, settings: { enabled: config.enabled, running: config.enabled && !!this.run, port: this.run?.port ?? config.port,
      friendTransportRunning: !!this.deps.friendMessage && !!this.run, friendTransportConnected: relay?.friendReady ?? false,
      baseUrl: base, relayEnabled: true, relayConnected: config.enabled && (relay?.connected ?? false),
      relayUrl: config.relayURL, relayUrlOverride: config.relayOverride, relayId: config.relayId, relayBaseUrl: base,
      relayError: relay?.error ?? null, accountLinked: !!this.deps.account(), token: config.token,
      allowLockedComputerUse: config.allowLockedComputerUse, features: MOBILE_FEATURES } };
  }
  /** Whether remote work may still drive apps while the screen is locked. */
  allowLockedComputerUse(): boolean {
    return this.run?.config.allowLockedComputerUse ?? this.settings.read().allowLockedComputerUse;
  }
  /** Remote availability follows connection establishment and failed-enable suppression. */
  remoteControlKeepsAwake(): boolean {
    const run = this.run, account = this.deps.account(), status = run?.relay?.powerStatus();
    return !!run?.config.enabled && !!account && run.account?.userId === account.userId && run.account?.token === account.token
      && !!status && !status.enableFailed && (status.status === 'connecting' || status.status === 'connected');
  }
  private async start(config: MobileSettings): Promise<void> {
    const server = createServer(), ws = new WebSocketServer({ noServer: true, maxPayload: MOBILE_BODY_LIMIT, perMessageDeflate: false });
    const account = this.deps.account();
    const run: Run = { server, ws, controller: new AbortController(), sockets: new Set(), peers: new Set(), jobs: new Set(), config, account: account ? { ...account } : undefined, port: 0, recent: new Map(), pendingSendBytes: 0, pendingSendCount: 0, promotions: new Map(), followUps: new MobileFollowUpControls(this.deps.configRoot), deliveries: new ReliableDeliveryStore(join(this.deps.configRoot, 'mobile-transport-v1.json')), stateRefreshAgain: false };
    server.maxConnections = 128;
    server.requestTimeout = this.deps.requestTimeoutMs ?? 30_000; server.headersTimeout = Math.min(server.requestTimeout, 30_000);
    server.on('connection', socket => { run.sockets.add(socket); socket.on('close', () => run.sockets.delete(socket)); });
    server.on('request', (request, response) => this.track(run, this.http(run, request, response)));
    server.on('upgrade', (request, socket, head) => {
      const url = this.url(request);
      if (!config.enabled || !url || url.pathname !== '/api/mobile/ws' || run.controller.signal.aborted || !authorized(request.headers, url, config.token) || run.peers.size >= 64) {
        socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); return;
      }
      ws.handleUpgrade(request, socket, head, client => this.peer(run, client, request.headers['x-klaus-mobile-catalog'] === '1' && !!this.deps.catalogPage));
    });
    const listen = (port: number): Promise<void> => new Promise((resolve, reject) => {
      const error = (cause: Error): void => { server.removeListener('listening', done); reject(cause); };
      const done = (): void => { server.removeListener('error', error); resolve(); };
      server.once('error', error); server.once('listening', done); server.listen(port, '127.0.0.1');
    });
    try { await run.deliveries.ready();
      try { await listen(config.port); } catch (error) { if (object(error).code === 'EADDRINUSE' && config.port !== 0) await listen(0); else throw error; }
      this.checkOpen(); const address = server.address(); if (!address || typeof address === 'string') throw new Error('Mobile listener address unavailable');
      run.port = address.port; this.run = run;
      if (this.deps.account()) { run.relay = new MobileRelay({ ...config, localBaseURL: 'http://127.0.0.1:' + run.port }, this.deps); run.relay.start(); }
      run.idleSweep = setInterval(() => this.sweepIdlePeers(run), MESSAGE_IDLE_SWEEP_INTERVAL_MS);
      run.idleSweep.unref();
      this.deps.connectionChanged?.();
    } catch (error) { run.controller.abort(); server.close(); ws.close(); for (const socket of run.sockets) socket.destroy(); await run.deliveries.close().catch(() => {}); throw error; }
  }
  resetDiagnostics(): void {
    for (const peer of this.run?.peers ?? []) peer.diagnostics.reset();
    this.run?.relay?.resetDiagnostics();
  }
  private async stop(): Promise<void> {
    const run = this.run; this.run = undefined; this.permissions.clear(); this.elicitations.clear(); this.working.clear(); this.observedOwner = undefined;
    this.deps.connectionChanged?.();
    if (!run) return;
    if (run.idleSweep) clearInterval(run.idleSweep);
    run.controller.abort(); await run.relay?.close(); await run.catalog?.close();
    const peers = [...run.peers].map(peer => {
      this.peerInterestChanged(peer);
      const followed = [...peer.follows.keys()]; peer.follows.clear();
      for (const sessionId of followed) this.taskStreams.unfollow(sessionId);
      peer.controller.abort(); return stopSocket(peer.socket);
    });
    const listener = new Promise<void>((resolve, reject) => { run.server.close(error => { if (error && object(error).code !== 'ERR_SERVER_NOT_RUNNING') reject(error); else resolve(); }); });
    for (const socket of run.sockets) socket.destroy();
    await Promise.all(peers); await listener;
    await new Promise<void>(resolve => run.ws.close(() => resolve()));
    while (run.jobs.size) await Promise.allSettled([...run.jobs]);
    run.recent.clear(); await run.deliveries.close(); this.taskStreams.reset();
  }
  private track(run: Run, promise: Promise<unknown>): void { run.jobs.add(promise); void promise.catch(() => {}).finally(() => run.jobs.delete(promise)); }
  private owner(): MobileEngineOwner {
    const owner = this.deps.engineOwner(); if (!owner) throw new MobileError(503, 'engine_unavailable', 'Desktop engine is unavailable');
    if (!sameOwner(this.observedOwner, owner)) {
      if (this.observedOwner) {
        this.taskStreams.reset(); this.run?.catalog?.invalidate();
        for (const peer of this.run?.peers ?? []) {
          this.peerInterestChanged(peer);
          for (const request of peer.followRequests.values()) request.abort();
          peer.followRequests.clear();
          const followed = [...peer.follows.keys()]; peer.follows.clear();
          // A new engine owns a different stream epoch. Explicitly invalidate
          // every retained follower instead of leaving an apparently live but
          // permanently silent subscription attached to the old owner.
          for (const id of followed) this.sendPeer(peer, this.taskStreams.gap(id));
        }
      }
      this.working.clear(); this.permissions.clear(); this.elicitations.clear(); this.awaitingInteraction.clear(); this.observedOwner = owner;
      // The phone's working/awaiting badges are projections of these sets; without a state
      // refresh they would stay stale until the next terminal event.
      if (this.run) {
        this.scheduleState(this.run, owner, true);
        for (const peer of this.run.peers) if (peer.ready) this.scheduleComposer(this.run, peer);
      }
    }
    return owner;
  }
  private async acquireOwner(signal: AbortSignal): Promise<MobileEngineOwner> {
    signal.throwIfAborted();
    if (!this.deps.engineOwner()) await this.deps.ensureEngineOwner?.(signal);
    signal.throwIfAborted();
    return this.owner();
  }
  private call(run: Run, owner: MobileEngineOwner, signal = run.controller.signal, onHistory?: (history: Json) => void, priority: 'interactive' | 'background' = 'interactive'): MobileCall {
    return async (channel, payload) => {
      signal.throwIfAborted(); run.controller.signal.throwIfAborted();
      if (this.run !== run || !sameOwner(owner, this.deps.engineOwner())) throw new MobileError(409, 'engine_replaced', 'Desktop engine changed; retry the request');
      const account = this.deps.account();
      if (account?.userId !== run.account?.userId || account?.token !== run.account?.token) throw new MobileError(401, 'account_changed', 'Account authorization changed');
      let answer: Json;
      if (channel === 'session:summary' && this.deps.catalogRow) {
        answer = await this.deps.catalogRow(required(object(payload).sessionId, 'sessionId'), { signal, owner }, priority);
      } else if (channel === 'session:follow') {
        if (!this.deps.followSession) throw new MobileError(503, 'follow_unavailable', 'The desktop task stream is unavailable');
        answer = await this.deps.followSession(required(object(payload).sessionId, 'sessionId'), { signal, owner, onHistory, priority });
      } else {
        if (!(MOBILE_DISPATCH_CHANNELS as readonly string[]).includes(channel)) throw new Error('Mobile dispatcher channel is not allowed');
        answer = await this.deps.dispatch(channel, payload === undefined || payload === null ? [] : [payload], { signal, owner });
      }
      signal.throwIfAborted();
      const latestAccount = this.deps.account();
      if (latestAccount?.userId !== run.account?.userId || latestAccount?.token !== run.account?.token) throw new MobileError(401, 'account_changed', 'Account authorization changed');
      if (!sameOwner(owner, this.deps.engineOwner())) throw new MobileError(409, 'engine_replaced', 'Desktop engine changed; retry the request');
      const row = object(answer);
      if (row.ok === false && channel !== 'chat:follow-up' && !channel.startsWith('chat:client-queue-')) {
        const code = string(row.error) || string(object(row.error).code) || 'desktop_error';
        throw new MobileError(code === 'export_session_empty' ? 422 : 500, code, string(object(row.error).message) || 'Desktop request failed');
      }
      return answer;
    };
  }
  private projection(call: MobileCall, catalog?: MobileCatalog): MobileProjection { return new MobileProjection(call, () => this.activeSession, this.working, this.awaitingInteraction, catalog ? () => catalog.cached() : undefined); }
  private catalog(run: Run): MobileCatalog {
    return run.catalog ??= new MobileCatalog({
      page: async (cursor, signal) => {
        if (!this.deps.catalogPage) throw new MobileError(503, 'catalog_unavailable', 'Desktop catalog is unavailable');
        const combined = AbortSignal.any([signal, run.controller.signal]), owner = await this.acquireOwner(combined);
        combined.throwIfAborted();
        const result = await this.deps.catalogPage(cursor, { owner, signal: combined });
        combined.throwIfAborted();
        if (this.run !== run || !sameOwner(owner, this.deps.engineOwner())) throw new MobileError(409, 'engine_replaced', 'Catalog belongs to a previous engine');
        return result;
      },
      row: async (id, signal) => {
        if (!this.deps.catalogRow) throw new MobileError(503, 'catalog_unavailable', 'Desktop catalog is unavailable');
        const combined = AbortSignal.any([signal, run.controller.signal]), owner = await this.acquireOwner(combined);
        const row = await this.deps.catalogRow(id, { owner, signal: combined });
        combined.throwIfAborted();
        if (this.run !== run || !sameOwner(owner, this.deps.engineOwner())) throw new MobileError(409, 'engine_replaced', 'Catalog belongs to a previous engine');
        return row;
      },
      visible: id => this.deps.catalogVisible?.(id) ?? true,
    }, {
      path: join(this.deps.configRoot, 'mobile-catalog', catalogAccountKey(run.account?.userId ?? 'local') + '.jsonl'),
      active: () => this.run === run && [...run.peers].some(peer => peer.ready && peer.catalogSync),
      changed: () => {
        for (const peer of run.peers) if (peer.catalogSync && peer.ready) this.sendPeer(peer, { type: 'catalog_changed' });
        const owner = this.deps.engineOwner(); if (owner) this.scheduleState(run, owner);
      },
      error: () => this.deps.log?.('catalog_refresh_failed', {}),
    });
  }
  private url(request: IncomingMessage): URL | undefined {
    const raw = request.url ?? ''; if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return undefined;
    try { return new URL(raw, 'http://127.0.0.1'); } catch { return undefined; }
  }
  private async http(run: Run, request: IncomingMessage, response: ServerResponse): Promise<void> {
    const disconnected = new AbortController(), onClose = (): void => { if (!response.writableEnded) disconnected.abort(); };
    response.once('close', onClose);
    try {
      const url = this.url(request); if (!url) throw new MobileError(404, 'not_found', 'Not found');
      if (url.pathname === '/healthz' && request.method === 'GET') { httpReply(response, 200, { ok: true }); return; }
      if (url.pathname === '/favicon.ico' && request.method === 'GET') { response.writeHead(204, { 'cache-control': 'public, max-age=86400' }); response.end(); return; }
      if (!url.pathname.startsWith('/api/mobile/')) throw new MobileError(404, 'not_found', 'Not found');
      if (!run.config.enabled) throw new MobileError(403, 'remote_access_disabled', 'Remote access is disabled');
      if (request.method === 'OPTIONS') { httpReply(response, 204, null); return; }
      if (run.controller.signal.aborted || this.run !== run) throw new MobileError(503, 'bridge_stopped', 'Mobile bridge stopped');
      if (!authorized(request.headers, url, run.config.token)) throw new MobileError(401, 'unauthorized', 'Pairing token is invalid');
      if (run.jobs.size >= 128) throw new MobileError(503, 'bridge_busy', 'Mobile bridge is busy; retry later');
      const signal = AbortSignal.any([run.controller.signal, disconnected.signal]), owner = await this.acquireOwner(signal), call = this.call(run, owner, signal);
      const payload = await readRequest(request, signal);
      if (request.method === 'POST' && (!payload || typeof payload !== 'object' || Array.isArray(payload))) throw badRequest('Request body must be an object');
      const threadOperation = url.pathname.startsWith(THREAD_TOOLS_PREFIX) ? url.pathname.slice(THREAD_TOOLS_PREFIX.length) : '';
      if ((REMOTE_THREAD_OPERATIONS as readonly string[]).includes(threadOperation) && request.method === 'POST') {
        if (!this.deps.threadRequest) throw new MobileError(501, 'thread_communication_unavailable', 'Desktop does not support remote chat communication');
        const account = run.account;
        if (!account) throw new MobileError(401, 'account_required', 'Sign in to use remote chat communication');
        const assertCurrent = (): void => {
          signal.throwIfAborted();
          const latest = this.deps.account();
          if (this.run !== run || !sameOwner(owner, this.deps.engineOwner())) throw new MobileError(409, 'engine_replaced', 'Desktop engine changed; retry the request');
          if (latest?.userId !== account.userId || latest.token !== account.token) throw new MobileError(401, 'account_changed', 'Account authorization changed');
        };
        assertCurrent(); const localHostId = await this.currentDeviceId(account); assertCurrent();
        const result = await this.deps.threadRequest(threadOperation as RemoteThreadOperation, object(payload), { accountId: account.userId, localHostId, signal, owner, assertCurrent });
        assertCurrent(); httpReply(response, 200, result); return;
      }
      const result = await this.route(run, call, owner, request.method || '', url.pathname, object(payload), signal, url.searchParams);
      httpReply(response, result.status, result.body);
    } catch (error) { const failure = mobileError(error); httpReply(response, failure.status, { error: { type: failure.code, message: failure.message } }); }
    finally { response.removeListener('close', onClose); }
  }
  private assertReadCurrent(run: Run, owner: MobileEngineOwner, signal: AbortSignal, account: MobileAccount | undefined): void {
    signal.throwIfAborted();
    if (this.run !== run || !sameOwner(owner, this.deps.engineOwner())) throw new MobileError(409, 'engine_replaced', 'Desktop engine changed; retry the request');
    const latest = this.deps.account();
    if (latest?.userId !== account?.userId || latest?.token !== account?.token) throw new MobileError(401, 'account_changed', 'Account authorization changed');
  }
  private async knownSessionSummary(call: MobileCall, id: string): Promise<JsonObject> {
    let row: JsonObject;
    if (this.deps.catalogRow) row = object(await call('session:summary', { sessionId: id }));
    else {
      const sessions = await call('session:list');
      row = object(Array.isArray(sessions) ? sessions.find(value => object(value).id === id) : null);
    }
    if (row.id !== id || row.archived === true) throw new MobileError(404, 'session_not_found', 'Session is not available on desktop');
    return { ...row, isWorking: this.working.has(id) };
  }
  private async knownSession(call: MobileCall, id: string): Promise<void> { await this.knownSessionSummary(call, id); }

  private async history(call: MobileCall, id: string): Promise<Json[]> {
    const result = object(await call('session:history', { sessionId: id }));
    if (!Array.isArray(result.messages)) throw new MobileError(500, 'invalid_history', 'Desktop returned an invalid conversation history');
    return result.messages;
  }
  /**
   * The per-turn metadata the phone needs to fold a finished turn's process the way the desktop
   * does, and to keep an interrupted turn expanded. `session:history` returns these beside
   * `messages`; forwarding only the rows left the phone unable to tell a completed turn from a
   * stopped one, so it could not apply the desktop's collapse rule at all.
   */
  private async historyWithTurns(call: MobileCall, id: string): Promise<JsonObject> {
    const result = object(await call('session:history', { sessionId: id }));
    if (!Array.isArray(result.messages)) throw new MobileError(500, 'invalid_history', 'Desktop returned an invalid conversation history');
    const turns = (key: string): JsonObject => object(result[key]);
    return { ...result, sessionId: id, turnStatuses: turns('turnStatuses'), turnDurations: turns('turnDurations') };
  }
  private async knownWorkdir(call: MobileCall, path: string | null, workspaceId: string | null = null): Promise<void> {
    if (workspaceId) {
      const groups = await this.projection(call).workspaceGroups();
      if (!groups.some(group => string(group.id) === workspaceId)) throw new MobileError(403, 'unknown_workspace', 'Workspace conversations can only be created under an existing desktop workspace');
      return;
    }
    if (!path) return; const projection = this.projection(call), projects = projectRows(await projection.sessions(), await projection.workspace());
    if (!projects.some(row => row.workdir === path)) throw new MobileError(403, 'unknown_project_workdir', 'Project conversations can only be created under an existing mobile project');
  }
  private async route(run: Run, call: MobileCall, owner: MobileEngineOwner, method: string, path: string, payload: JsonObject, signal = run.controller.signal, query = new URLSearchParams()): Promise<{ status: number; body: Json }> {
    const projection = this.projection(call), result = (status: number, body: Json): { status: number; body: Json } => ({ status, body });
    if (method === 'GET' && path === '/api/mobile/model-config') {
      if (query.getAll('sessionId').length > 1 || query.getAll('source').length > 1) throw badRequest('Model configuration query parameters must be unique');
      const sessionId = modelConfigSession(query.has('sessionId') ? query.get('sessionId') : undefined);
      if (sessionId) await this.knownSession(call, sessionId);
      const modelConfig = await new MobileModelConfigProjection(call, () => run.modelRevision ?? 0).snapshot(sessionId, query.has('source') ? authMode(query.get('source')) : undefined);
      this.assertReadCurrent(run, owner, signal, run.account);
      return result(200, { modelConfig });
    }
    if (method === 'POST' && path === '/api/mobile/model-config') {
      let sourceHint: string | undefined;
      if (payload.source === undefined && payload.selection === undefined && isTraeNativeEffort(payload.thinkingLevel)
        && !(THINKING_LEVELS as readonly string[]).includes(payload.thinkingLevel)) {
        const sessionId = modelConfigSession(payload.sessionId, true);
        if (sessionId) await this.knownSession(call, sessionId);
        sourceHint = string(object(await call('session:get-main-model', { ...(sessionId ? { sessionId } : {}), resolve: false })).source);
      }
      const update = modelConfigUpdate(payload, sourceHint);
      // A confirmed edit owns its admission even if the waiting phone disconnects.
      const task = this.mutations.run(() => this.setModelConfig(run, this.call(run, owner), update));
      this.track(run, task); return result(202, { ok: true, ...await task });
    }
    if (method === 'GET' && path === '/api/mobile/bootstrap') return result(200, await projection.bootstrap());
    if (method === 'GET' && path === '/api/mobile/desktop-state') { const desktopState = await projection.desktopState(); return result(200, { desktopState, projects: desktopState.projects! }); }
    if (method === 'GET' && path === '/api/mobile/runtime-config') return result(200, { runtimeConfig: await projection.runtimeConfig() });
    if (method === 'POST' && path === '/api/mobile/runtime-config') return result(202, { ok: true, runtimeConfig: await this.setRuntime(run, call, payload) });
    if (method === 'POST' && path === '/api/mobile/questions/answer') {
      const answer = questionAnswer(payload); await this.knownSession(call, string(answer.sessionId));
      return result(202, await call('question:answer', answer));
    }
    if (method === 'POST' && path === '/api/mobile/attachments') return result(201, await call('chat:upload', attachmentUpload(payload)));
    if (method === 'POST' && path === '/api/mobile/new-chat/context') {
      return result(200, await mobileNewChatContext(call, { workdir: workdir(payload.workdir), workspaceId: workspaceId(payload.workspaceId) }, (scope, dir, space) => this.knownWorkdir(scope, dir, space)));
    }
    if (method === 'POST' && path === '/api/mobile/new-chat/branch') {
      // A confirmed mutation owns its admission independently of the waiting HTTP connection.
      const task = mobileNewChatBranch(this.call(run, owner), { workdir: workdir(payload.workdir), workspaceId: workspaceId(payload.workspaceId) }, payload, (scope, dir, space) => this.knownWorkdir(scope, dir, space));
      this.track(run, task);
      return result(200, await task);
    }
    if (method === 'POST' && path === '/api/mobile/sessions') {
      if (payload.initialMessage === undefined) throw new MobileError(400, 'initial_message_required', 'A new mobile session requires its first message');
      const promoted = await this.promoteDraft(run, this.call(run, owner), owner, required(payload.clientDraftId, 'clientDraftId'), workdir(payload.workdir), workspaceId(payload.workspaceId), mobileNewChatRun(payload), object(payload.initialMessage), modelPreference(payload.modelPreference));
      return result(201, promoted);
    }
    if (method === 'POST' && path === '/api/mobile/active-workdir') {
      const dir = workdir(payload.workdir); await this.knownWorkdir(call, dir); await call('projects:set-active', { path: dir }); await this.broadcastState(run, call);
      return result(202, { ok: true, workdir: dir });
    }
    const responseKind = path === '/api/mobile/permissions/respond' ? 'permission' : path === '/api/mobile/elicitations/respond' ? 'elicit' : undefined;
    if (method === 'POST' && responseKind) {
      const id = required(payload.requestId, 'requestId');
      await this.respond(run, call, owner, id, responseKind === 'permission' ? permissionResponse(payload) : elicitationResponse(payload), responseKind);
      return result(202, { ok: true, requestId: id });
    }
    const childRoute = /^\/api\/mobile\/sessions\/([^/]+)\/(agents|diagrams)(?:\/([^/]+)(\/history)?)?$/u.exec(path);
    if (childRoute && method === 'GET') {
      const id = this.pathIdentity(childRoute[1]!); await this.knownSession(call, id);
      if (childRoute[2] === 'agents') {
        if (!childRoute[3]) {
          const snapshot = object(await call('agents:snapshot', { sessionId: id })), tasks = object(snapshot.tasks);
          const agents = Object.entries(tasks).map(([taskId, value]) => {
            const row = object(value), agentId = nonempty(row.agentId) || taskId;
            return { ...row, taskId, id: agentId, agentId, toolCallId: taskId };
          });
          return result(200, { sessionId: id, agents, tasks });
        }
        if (childRoute[4]) {
          const agentId = this.pathIdentity(childRoute[3]), history = object(await call('agents:history', { sessionId: id, agentId }));
          if (!Array.isArray(history.messages)) throw new MobileError(500, 'invalid_history', 'Desktop returned an invalid child conversation history');
          return result(200, { ...history, sessionId: id, agentId, turnStatuses: object(history.turnStatuses), turnDurations: object(history.turnDurations) });
        }
      } else if (childRoute[3] && !childRoute[4]) {
        if (!this.deps.diagramPreview) throw new MobileError(501, 'diagram_preview_unavailable', 'Diagram preview is unavailable');
        return result(200, { ...await this.deps.diagramPreview(id, this.pathIdentity(childRoute[3])), sessionId: id });
      }
      throw new MobileError(404, 'not_found', 'Not found');
    }
    const queueRoute = /^\/api\/mobile\/sessions\/([^/]+)\/queue(?:\/(remove|restore|reorder|resume|deliver|clear)|\/([^/]+)\/draft)?$/u.exec(path);
    if (queueRoute) {
      const sessionId = this.pathIdentity(queueRoute[1]!);
      await this.knownSession(call, sessionId);
      this.assertReadCurrent(run, owner, signal, run.account);
      if (method === 'GET' && !queueRoute[2]) {
        const answer = queueRoute[3] ? await run.followUps.draft(call, sessionId, this.pathIdentity(queueRoute[3])) : await run.followUps.snapshot(call, sessionId);
        this.assertReadCurrent(run, owner, signal, run.account);
        return result(200, answer);
      }
      if (method === 'POST' && queueRoute[2]) {
        const ownedCall = this.call(run, owner);
        const task = run.followUps.mutate(ownedCall, sessionId, queueRoute[2], payload);
        this.track(run, task);
        return result(200, await task);
      }
      throw new MobileError(404, 'not_found', 'Not found');
    }
    const match = /^\/api\/mobile\/(sessions|permissions|elicitations)\/([^/]+)\/(history|summary|messages|stop|respond|rename|workdir|delete|export|debug-report|media|file-preview|inline-visualization|background-processes|stop-background-process)$/u.exec(path);
    if (!match) throw new MobileError(404, 'not_found', 'Not found');
    const id = this.pathIdentity(match[2]!);
    const action = match[3]!;
    if (match[1] === 'permissions' && action === 'respond' && method === 'POST') { await this.respond(run, call, owner, id, permissionResponse(payload)); return result(202, { ok: true, requestId: id }); }
    if (match[1] === 'elicitations' && action === 'respond' && method === 'POST') { await this.respond(run, call, owner, id, elicitationResponse(payload), 'elicit'); return result(202, { ok: true, requestId: id }); }
    if (match[1] !== 'sessions') throw new MobileError(404, 'not_found', 'Not found');
    if (method === 'GET' && action === 'summary') {
      const account = run.account;
      const session = await this.knownSessionSummary(call, id);
      this.assertReadCurrent(run, owner, signal, account);
      return result(200, { session, sessionId: id });
    }
    if (method === 'GET' && action === 'history') { await this.knownSession(call, id); return result(200, await this.historyWithTurns(call, id)); }
    if (method !== 'POST' || action === 'history' || action === 'summary' || action === 'respond') throw new MobileError(404, 'not_found', 'Not found');
    await this.knownSession(call, id);
    if (action === 'media') {
      if (!this.deps.mediaPreview) throw new MobileError(501, 'media_preview_unavailable', 'Media preview is unavailable');
      const preview = await this.deps.mediaPreview(id, required(payload.path, 'path'), signal);
      signal.throwIfAborted();
      if (this.run !== run || !sameOwner(owner, this.deps.engineOwner())) throw new MobileError(409, 'engine_replaced', 'Desktop engine changed; retry the request');
      return result(200, preview);
    }
    if (action === 'inline-visualization') {
      if (!this.deps.inlineVisualizationPreview) throw new MobileError(501, 'inline_visualization_unavailable', 'Inline visualization is unavailable');
      const account = run.account;
      const preview = await this.deps.inlineVisualizationPreview(id, required(payload.path, 'path'));
      this.assertReadCurrent(run, owner, signal, account);
      if (preview.error || typeof preview.html !== 'string' || Buffer.byteLength(preview.html) > INLINE_VIS_MAX_BYTES) {
        throw new MobileError(403, 'inline_visualization_refused', string(preview.error) || 'Inline visualization is unavailable');
      }
      return result(200, { sessionId: id, html: preview.html });
    }
    if (action === 'file-preview') {
      const preview = object(await call('artifacts:read', { sessionId: id, filePath: required(payload.path, 'path') }));
      if (preview.error) throw new MobileError(403, 'file_preview_unavailable', string(preview.error));
      return result(200, { ...preview, sessionId: id });
    }
    if (action === 'messages') return result(202, this.acceptMessage(run, owner, id, payload));
    if (action === 'background-processes') {
      return result(200, { sessionId: id, ...object(await call('session:background-processes', { sessionId: id })) });
    }
    if (action === 'stop-background-process') {
      const body: JsonObject = { sessionId: id, shellId: required(payload.shellId, 'shellId') };
      if (payload.signal !== undefined) body.signal = required(payload.signal, 'signal');
      return result(202, { ok: true, ...(object(await call('session:stop-background-process', body))) });
    }
    const base: JsonObject = { ok: true, sessionId: id };
    switch (action) {
      case 'stop': {
        const expectedTurnId = payload.expectedTurnId === undefined ? undefined : required(payload.expectedTurnId, 'expectedTurnId');
        const interrupted = object(await call('chat:interrupt', { sessionId: id, ...(expectedTurnId === undefined ? {} : { expectedTurnId }) }));
        if (interrupted.accepted !== true) throw new MobileError(409, 'interrupt_rejected', 'Desktop did not accept this stop request');
        base.accepted = true;
        if (typeof interrupted.confirmed === 'boolean') base.confirmed = interrupted.confirmed;
        for (const field of ['interruptionError', 'goalPauseError'] as const) if (typeof interrupted[field] === 'string') base[field] = interrupted[field];
        if (interrupted.confirmed === false || interrupted.interruptionError || interrupted.goalPauseError) base.ok = false;
        await this.broadcastState(run, call); break;
      }
      case 'rename': base.title = title(payload.title); await call('session:rename', { sessionId: id, title: base.title }); run.catalog?.invalidate(id); await this.broadcastState(run, call, true); break;
      case 'workdir': {
        const history = await this.history(call, id);
        if (history.length) throw new MobileError(409, 'session_has_messages', 'Project can only be changed before the desktop session has messages');
        const dir = workdir(payload.workdir); await this.knownWorkdir(call, dir);
        await call(dir ? 'session:set-workdir' : 'session:clear-workdir', { sessionId: id, ...(dir ? { dir } : {}) }); base.workdir = dir; run.catalog?.invalidate(id); await this.broadcastState(run, call, true); break;
      }
      case 'delete':
        await call('session:delete', { sessionId: id, wipeWorkspace: false });
        this.forgetSession(id);
        for (const [key, entry] of this.permissions) if (entry.sessionId === id) this.permissions.delete(key);
        for (const [key, entry] of this.elicitations) if (entry.sessionId === id) this.elicitations.delete(key);
        await this.broadcastState(run, call, true); break;
      case 'export': {
        const exported = object(await call('session:export', { sessionId: id })), file = required(exported.filePath, 'Export path');
        Object.assign(base, { filePath: file, fileName: pathBase(file), url: pathToFileURL(file).href }); break;
      }
      case 'debug-report': {
        const report = object(await call('feedback:submit', { sessionId: id, description: short(payload.description) || 'Generated from Klaus iOS remote control.' }));
        Object.assign(base, { feedbackId: report.feedbackId ?? null, filePath: report.filePath ?? null, email: report.email ?? null }); break;
      }
      default: throw new MobileError(404, 'not_found', 'Not found');
    }
    return result(202, base);
  }
  /**
   * Promotes the phone's client-local draft into a real session only when its first message is
   * ready. The client draft id makes retries and rapid duplicate submits converge on one task; if
   * the first turn is rejected, the just-created placeholder is rolled back before the error is
   * returned so it cannot leak into either sidebar.
   */
  private async promoteDraft(run: Run, call: MobileCall, owner: MobileEngineOwner, draftId: string, dir: string | null, spaceId: string | null, mode: MobileNewChatRun, initial: JsonObject, preference?: MobileModelPreference): Promise<JsonObject> {
    if (Buffer.byteLength(draftId) > 128) throw badRequest('clientDraftId is too long');
    const media = mediaItems(initial.media, preference?.source ?? readSessionModel('', this.deps.configRoot).source), text = messageText(initial.text, !!media.length);
    const clientMessageId = short(initial.clientMessageId) || draftId;
    // Store only a bounded digest of the validated first turn, never another copy of its media.
    // The same id may retry this promotion, but cannot repurpose it for another computer target,
    // run mode, branch or message while an earlier request is pending or already accepted.
    const fingerprint = createHash('sha256').update(JSON.stringify({ dir, spaceId, mode, preference, text, clientMessageId,
      media: media.map(item => ({ type: item.type, filename: item.filename, mimeType: item.mimeType, hash: createHash('sha256').update(item.bytes).digest('hex') })),
    })).digest('hex');
    const now = Date.now();
    for (const [key, entry] of run.promotions) if (entry.settled && now - entry.createdAt > 600_000) run.promotions.delete(key);
    const existing = run.promotions.get(draftId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new MobileError(409, 'draft_context_mismatch', 'This draft was already submitted with different content or a different run target');
      if (!sameOwner(existing.owner, owner)) throw new MobileError(409, 'engine_replaced', 'This draft belongs to a previous desktop engine; refresh its outcome before retrying');
      if (existing.task) return existing.task;
    }
    if (!existing && run.promotions.size >= 500) throw new MobileError(429, 'too_many_drafts', 'Too many mobile drafts are being promoted');
    const entry: DraftPromotion = { createdAt: now, fingerprint, owner, settled: false };
    const task = (async (): Promise<JsonObject> => {
      await this.knownWorkdir(call, spaceId ? null : dir, spaceId);
      if (preference) await new MobileModelConfigProjection(call).validate(preference);
      let ownedWorktree: string | undefined, sessionId: string | undefined;
      let created: JsonObject = {};
      try {
        let worktree: JsonObject | undefined;
        if (mode.mode === 'worktree') {
          const context = await mobileNewChatContext(call, { workdir: dir, workspaceId: spaceId }, (scope, path, space) => this.knownWorkdir(scope, path, space));
          if (!context.worktreeEnabled) throw new MobileError(409, 'worktree_unavailable', 'Worktree mode is unavailable for this run target');
          if (mode.baseRef && mode.baseRef !== context.current && !(context.branches as string[]).includes(mode.baseRef)) throw badRequest('baseRef is not a known local branch');
          worktree = object(await call('worktree:create-from-workdir', { workdir: dir, ...(mode.baseRef ? { baseRef: mode.baseRef } : {}), includeUncommitted: mode.includeUncommitted }));
          ownedWorktree = nonempty(worktree.path) ?? undefined;
          if (ownedWorktree) entry.ownedWorktreePath = ownedWorktree.slice(0, 4096);
          if (!ownedWorktree || !nonempty(worktree.repoRoot)) throw new MobileError(500, 'invalid_worktree', 'Desktop did not create a valid worktree');
        }
        created = object(await call('session:new', worktree ? { workdir: ownedWorktree!, projectRoot: worktree.repoRoot! } : spaceId ? { workspaceId: spaceId } : dir ? { workdir: dir } : {}));
        sessionId = nonempty(created.id) ?? undefined;
        if (sessionId) entry.ownedSessionId = sessionId.slice(0, 128);
        if (!sessionId) throw new MobileError(500, 'invalid_session', 'Desktop did not create a session');
        if (preference) await applyModelPreference(call, sessionId, preference, false);
        // Install the subscription before send so synchronous first-turn events cannot be lost.
        for (const peer of run.peers) peer.subscriptions.add(sessionId);
        await this.sendMessage(run, call, sessionId, text, media);
      } catch (error) {
        // Only resources created by this promotion are eligible for rollback. Deleting the empty
        // session first releases its cwd lease; managed-worktree removal then drops copied edits
        // in the new directory while leaving the user's original checkout intact.
        if (sessionId) {
          for (const peer of run.peers) peer.subscriptions.delete(sessionId);
          try { await call('session:delete', { sessionId, wipeWorkspace: false }); delete entry.ownedSessionId; }
          catch (cleanup) {
            const failure = mobileError(cleanup), diagnostic = { resource: 'session', code: failure.code.slice(0, 128), message: failure.message.slice(0, 1024) };
            (entry.cleanupFailures ??= []).push(diagnostic);
            this.deps.log?.('mobile_draft_session_cleanup_failed', { sessionId: entry.ownedSessionId!, ...diagnostic });
          }
          run.catalog?.invalidate(sessionId);
        }
        if (ownedWorktree) {
          try { await call('worktree:remove', { path: ownedWorktree }); delete entry.ownedWorktreePath; }
          catch (cleanup) {
            const failure = mobileError(cleanup), diagnostic = { resource: 'worktree', code: failure.code.slice(0, 128), message: failure.message.slice(0, 1024) };
            (entry.cleanupFailures ??= []).push(diagnostic);
            this.deps.log?.('mobile_draft_worktree_cleanup_failed', { path: entry.ownedWorktreePath!, ...diagnostic });
          }
        }
        try { await this.broadcastState(run, call, true); } catch { /* Preserve the original promotion failure. */ }
        throw error;
      }
      run.catalog?.invalidate(sessionId!);
      // The first turn has been accepted. A later projection failure must not invalidate its
      // deduplication entry or make the phone retry it as another real conversation.
      try { await this.broadcastState(run, call, true); }
      catch (error) { this.deps.log?.('mobile_draft_state_refresh_failed', { sessionId: sessionId!, error: mobileError(error).message }); }
      return {
        id: sessionId!, title: nonempty(created.title) || 'New Chat',
        workdir: nonempty(created.workdir) || ownedWorktree || dir,
        workspaceId: nonempty(created.workspaceId) || spaceId,
        projectRoot: nonempty(created.projectRoot) || (ownedWorktree ? dir : null),
        createdAt: typeof created.createdAt === 'number' ? created.createdAt : Date.now(),
        updatedAt: Date.now(), isWorking: true, accepted: true, clientMessageId,
      };
    })();
    entry.task = task;
    run.promotions.set(draftId, entry);
    this.track(run, task);
    try { return await task; }
    catch (error) {
      // An unresolved owned resource retains the failed outcome; retrying it must not allocate
      // another checkout. Diagnostics and the bounded outcome keep the orphan visible without
      // operating on its old session through a replacement engine.
      if (run.promotions.get(draftId) === entry && !entry.ownedSessionId && !entry.ownedWorktreePath) entry.task = undefined;
      throw error;
    }
    finally { entry.settled = true; }
  }
  private pathIdentity(segment: string): string {
    let id: string; try { id = decodeURIComponent(segment); } catch { throw badRequest('Invalid identity'); }
    required(id, 'id'); if (id.includes('/') || id.includes('\\')) throw badRequest('Invalid identity');
    return id;
  }
  private acceptMessage(run: Run, owner: MobileEngineOwner, sessionId: string, payload: JsonObject, peer?: Peer, clientSeq?: number): JsonObject {
    const media = mediaItems(payload.media, readSessionModel(sessionId, this.deps.configRoot).source), text = messageText(payload.text, !!media.length), clientMessageId = short(payload.clientMessageId);
    const intent = mobileFollowUpIntent(payload);
    if (intent.mode && !clientMessageId) throw badRequest('A follow-up requires clientMessageId');
    const fingerprint = payloadFingerprint({ text, media: media.map(item => ({ type: item.type, mimeType: item.mimeType, filename: item.filename, digest: createHash('sha256').update(item.bytes).digest('hex') })), ...intent });
    const now = Date.now(); for (const [key, entry] of run.recent) if (entry.settled && now - entry.createdAt > 600_000) run.recent.delete(key);
    const key = JSON.stringify([sessionId, clientMessageId]), previous = clientMessageId ? run.recent.get(key) : undefined;
    if (previous && previous.fingerprint !== fingerprint) throw new MobileError(409, 'message_identity_conflict', 'This message identity already belongs to a different request');
    const duplicate = !!previous, requestId = previous?.requestId ?? randomUUID();
    let entry = previous;
    if (!entry) {
      const bytes = Buffer.byteLength(text) + media.reduce((total, item) => total + item.bytes.length, 0);
      if (run.pendingSendCount >= 64 || run.pendingSendBytes + bytes > 64 * 1024 * 1024) throw new MobileError(429, 'too_many_pending_messages', 'Desktop message queue is full');
      while (run.recent.size >= 500) {
        const oldest = [...run.recent].find(([, value]) => value.settled);
        if (!oldest) throw new MobileError(429, 'too_many_pending_messages', 'Too many messages are awaiting desktop acceptance');
        run.recent.delete(oldest[0]);
      }
      entry = { createdAt: now, requestId, fingerprint, completion: Promise.resolve().then(() => this.sendMessage(run, this.call(run, owner), sessionId, text, media, intent, clientMessageId)), settled: false };
      run.pendingSendBytes += bytes; run.pendingSendCount++;
      if (clientMessageId) run.recent.set(key, entry);
      const accepted = entry;
      this.track(run, entry.completion.finally(() => { accepted.settled = true; run.pendingSendBytes -= bytes; run.pendingSendCount--; }));
    }
    const correlation: JsonObject = { sessionId, clientMessageId, requestId, type: 'send_message' };
    this.track(run, entry.completion.then(metadata => {
      if (peer) this.sendPeer(peer, { type: 'message_accepted', sessionId, clientMessageId, requestId, ...metadata });
    }, error => {
      if (peer) { this.socketError(peer, error, correlation, clientSeq); return; }
      if (run.controller.signal.aborted || !sameOwner(owner, this.deps.engineOwner())) return;
      const failure = mobileError(error), frame = { type: 'error', code: failure.code, message: failure.message, requestId, sessionId, clientMessageId, action: 'send_message' };
      this.broadcast(run, frame, sessionId); this.taskStreams.publish(sessionId, frame);
    }));
    return { ok: true, accepted: true, sessionId, clientMessageId, requestId, ...(duplicate ? { duplicate: true } : {}) };
  }
  private async sendMessage(run: Run, call: MobileCall, sessionId: string, text: string, media: IncomingMedia[], intent: MobileFollowUpIntent = {}, clientMessageId?: string | null): Promise<JsonObject> {
    await this.knownSession(call, sessionId);
    const name = slashName(text); if (name) {
      const commands = await this.projection(call).commands(sessionId);
      if (!commands.length) throw new MobileError(403, 'slash_commands_unavailable', 'Desktop slash commands are unavailable');
      if (!commands.some(row => row.name === name)) throw new MobileError(403, 'unknown_slash_command', 'Slash command is not available for remote control');
    }
    if (intent.mode === 'queue') {
      const anchors = { ...(intent.beforeId === undefined ? {} : { beforeId: intent.beforeId }), ...(intent.afterId === undefined ? {} : { afterId: intent.afterId }) };
      return run.followUps.enqueue(call, sessionId, required(clientMessageId, 'clientMessageId'), text, media, anchors);
    }
    if (intent.mode === 'steer' && name) throw new MobileError(409, 'steer_slash_command', 'Slash commands must be queued for the next turn');
    const projected = followUpPayload(text, await uploadFollowUpMedia(call, media), readSessionModel(sessionId, this.deps.configRoot).source);
    if (intent.mode === 'steer') return run.followUps.steer(call, sessionId, projected, required(intent.expectedTurnId, 'expectedTurnId'));
    await call('chat:send', { sessionId, text: projected.finalText!, media: projected.media!, ...(projected.displayMetadata ? { displayMetadata: projected.displayMetadata } : {}) });
    return {};
  }
  private async setModelConfig(run: Run, call: MobileCall, update: ReturnType<typeof modelConfigUpdate>): Promise<JsonObject> {
    if (update.sessionId) await this.knownSession(call, update.sessionId);
    const projection = new MobileModelConfigProjection(call, () => run.modelRevision ?? 0), before = await projection.snapshot(update.sessionId);
    const source = update.source ?? (update.selection ? modelSource(update.selection) : undefined) ?? string(before.source);
    const selection = update.selection ?? (source !== before.source ? 'auto' : string(before.selection));
    const preference = { source, selection, thinkingLevel: update.thinkingLevel ?? string(before.thinkingLevel),
      ...(update.fastMode === undefined ? {} : { fastMode: update.fastMode }) };
    if (modelSource(selection) && modelSource(selection) !== source) throw badRequest('The model does not belong to this source');
    if (update.source !== undefined || update.selection !== undefined || update.thinkingLevel !== undefined && update.fastMode !== undefined) {
      await projection.validate(preference, update.thinkingLevel !== undefined);
      await applyModelPreference(call, update.sessionId, preference, true, update.thinkingLevel !== undefined);
    } else if (update.thinkingLevel !== undefined) {
      const answer = object(await call('session:set-thinking-level', { ...(update.sessionId ? { sessionId: update.sessionId } : {}), level: preference.thinkingLevel }));
      if (answer.ok !== true) throw new MobileError(409, 'model_configuration_rejected', string(answer.error) || 'Desktop did not accept the thinking level');
    }
    if (update.fastMode !== undefined && update.source === undefined && update.selection === undefined && update.thinkingLevel === undefined) {
      const answer = object(await call('session:set-fast-mode', { ...(update.sessionId ? { sessionId: update.sessionId } : {}), enabled: update.fastMode }));
      if (answer.ok !== true) throw new MobileError(409, 'model_configuration_rejected', string(answer.error) || 'Desktop did not accept Fast mode');
    }
    if (update.ultraMode !== undefined) {
      const answer = object(await call('session:set-ultra-mode', { ...(update.sessionId ? { sessionId: update.sessionId } : {}), enabled: update.ultraMode }));
      if (answer.ok !== true) throw new MobileError(409, 'model_configuration_rejected', string(answer.error) || 'Desktop did not accept Ultra mode');
    }
    run.modelRevision = (run.modelRevision ?? 0) + 1;
    try {
      const modelConfig = await new MobileModelConfigProjection(call, () => run.modelRevision ?? 0).snapshot(update.sessionId);
      this.broadcastModelConfig(run, modelConfig);
      return { modelConfig };
    } catch (error) {
      // The save and engine capture fence have already been accepted. Discovery
      // failure must not turn that committed edit into a rejected mutation.
      this.deps.log?.('model_config_saved_refresh_failed', { sessionId: update.sessionId, code: mobileError(error).code });
      const current = this.deps.engineOwner(); if (current) this.scheduleModelConfigs(run, current);
      return { modelConfigRefreshNeeded: true };
    }
  }
  private broadcastModelConfig(run: Run, modelConfig: JsonObject): void {
    const id = nonempty(modelConfig.sessionId);
    this.broadcast(run, { type: 'model_config_changed', sessionId: modelConfig.sessionId ?? null, modelConfig }, undefined,
      peer => !id || peer.follows.has(id) || peer.subscriptions.has(id), true);
  }
  /** Preference payloads contain a key only; re-read every followed scope from the host. */
  notePreferencesChanged(key: string): void {
    if (key === FOLLOW_UP_MODE_KEY) {
      const run = this.run;
      if (run) for (const peer of run.peers) if (peer.ready) this.scheduleComposer(run, peer);
      return;
    }
    if (!['composer.main_model', 'composer.thinking_level', 'composer.ultra_mode', 'modelProviders', 'auth_mode'].includes(key) && !isFastModePreferenceKey(key) && !key.startsWith('model_tiers:')) return;
    const run = this.run, owner = this.deps.engineOwner();
    if (run) run.modelRevision = (run.modelRevision ?? 0) + 1;
    if (run && owner) this.scheduleModelConfigs(run, owner);
  }
  private scheduleModelConfigs(run: Run, owner: MobileEngineOwner): void {
    if (this.run !== run || run.controller.signal.aborted || !run.peers.size) return;
    run.modelRefreshAgain = true;
    if (run.modelRefresh) return;
    const refresh = async (): Promise<void> => {
      do {
        run.modelRefreshAgain = false;
        const revision = run.modelRevision ?? 0;
        const call = this.call(run, owner), projection = new MobileModelConfigProjection(call, () => run.modelRevision ?? 0);
        const publish = async (id: string | null): Promise<void> => {
          const snapshot = await projection.snapshot(id);
          if (revision === (run.modelRevision ?? 0)) this.broadcastModelConfig(run, snapshot);
          else run.modelRefreshAgain = true;
        };
        try { await publish(null); }
        catch { this.deps.log?.('model_config_refresh_failed', { scope: 'default' }); }
        // Cache at most 64 identities per pass. Iterating peer subscriptions avoids
        // a second unbounded queue, and repeated edits coalesce into one latest pass.
        const completed = new Set<string>();
        for (const peer of run.peers) {
          if (peer.controller.signal.aborted) continue;
          for (const collection of [peer.follows.keys(), peer.subscriptions.values()]) for (const id of collection) {
            if (completed.has(id)) continue;
            if (completed.size >= 64) completed.clear();
            try { await this.knownSession(call, id); await publish(id); }
            catch { this.deps.log?.('model_config_refresh_failed', { scope: 'session' }); }
            completed.add(id);
          }
        }
      } while (run.modelRefreshAgain && this.run === run && !run.controller.signal.aborted && sameOwner(owner, this.deps.engineOwner()));
    };
    run.modelRefresh = Promise.resolve().then(refresh).finally(() => {
      run.modelRefresh = undefined;
      const current = this.deps.engineOwner();
      if (run.modelRefreshAgain && current) this.scheduleModelConfigs(run, current);
    });
    this.track(run, run.modelRefresh);
  }
  private async setRuntime(run: Run, call: MobileCall, payload: JsonObject): Promise<JsonObject> {
    // Validate the entire update before any setting changes.
    const model = payload.mainModel === undefined ? undefined : mainModel(payload.mainModel);
    const level = payload.thinkingLevel === undefined ? undefined : thinking(payload.thinkingLevel);
    const mode = payload.authMode === undefined ? undefined : authMode(payload.authMode);
    const style = payload.outputStyle === undefined ? undefined : optionText(payload.outputStyle);
    const followMode = payload.followUpMode === undefined ? undefined : followUpMode(payload.followUpMode);
    if (payload.outputStyle !== undefined && !style) throw badRequest('outputStyle is invalid');
    const changesModel = model !== undefined || level !== undefined;
    const sessionId = changesModel || Object.hasOwn(payload, 'sessionId') ? modelConfigSession(payload.sessionId, true) : null;
    if (sessionId) await this.knownSession(call, sessionId);
    // Compatibility writes must declare their scope; the renderer selection is not a phone target.
    const target: JsonObject = sessionId ? { sessionId } : {};
    if (model !== undefined) {
      const answer = object(await call('session:set-main-model', { mode: model, ...target }));
      if (answer.ok === false) throw new MobileError(409, 'runtime_configuration_rejected', string(answer.error) || 'Desktop did not accept the model');
    }
    if (level !== undefined) {
      const answer = object(await call('session:set-thinking-level', { level, ...target }));
      if (answer.ok === false) throw new MobileError(409, 'runtime_configuration_rejected', string(answer.error) || 'Desktop did not accept the thinking level');
    }
    if (mode !== undefined) await call('settings:kv:set', { key: 'auth_mode', value: mode });
    if (followMode !== undefined) {
      const saved = await call('settings:kv:set', { key: FOLLOW_UP_MODE_KEY, value: followMode });
      if (saved !== true && object(saved).ok !== true) throw new MobileError(409, 'runtime_configuration_rejected', 'Desktop did not accept the follow-up mode');
    }
    if (style) {
      const answer = object(await call('settings:output-styles:set', { style }));
      if (answer.ok !== true) throw new MobileError(409, 'runtime_configuration_rejected', string(answer.error) || 'Desktop did not accept the output style');
    }
    const runtimeConfig = await this.projection(call).runtimeConfig(sessionId); this.broadcast(run, { type: 'runtime_config_changed', runtimeConfig });
    await this.broadcastState(run, call); return runtimeConfig;
  }
  private pending(kind: InteractionKind): Map<string, PendingInteraction> { return kind === 'permission' ? this.permissions : this.elicitations; }
  private async respond(run: Run, call: MobileCall, owner: MobileEngineOwner, id: string, response: JsonObject, kind: InteractionKind = 'permission'): Promise<void> {
    const entries = this.pending(kind), pending = entries.get(id);
    if (!pending || pending.resolving || !sameOwner(pending.owner, owner) || !sameOwner(owner, this.deps.engineOwner())) throw new MobileError(409, kind + '_expired', 'The request is no longer available');
    // Claim before dispatch so concurrent phones cannot resolve the same request twice.
    pending.resolving = true;
    try { await call(kind + ':respond', { requestId: id, ...response }); }
    catch (error) { if (entries.get(id) === pending) pending.resolving = false; throw error; }
    if (entries.get(id) !== pending) throw new MobileError(409, kind + '_expired', 'The request is no longer available');
    entries.delete(id);
    if (pending.sessionId) this.publishPushNotice(pending.sessionId, kind === 'permission' ? 'permission' : 'elicitation', id, true);
    if (pending.sessionId && ![...entries.values()].some(row => row.sessionId === pending.sessionId)) {
      this.awaitingInteraction.delete(pending.sessionId);
      this.scheduleState(run, owner, true);
    }
    const frame = { type: kind + '_resolved', sessionId: pending.sessionId, requestId: id, ...response };
    this.broadcast(run, frame, pending.sessionId ?? undefined, () => true, true);
    if (pending.sessionId) this.taskStreams.publish(pending.sessionId, frame);
  }
  private peer(run: Run, socket: WebSocket, catalogSync = false): void {
    const peer: Peer = { socket, subscriptions: new Set(), follows: new Map(), followRequests: new Map(), controller: new AbortController(), tail: Promise.resolve(), queuedBytes: 0, queuedMessages: 0, sendTail: Promise.resolve(), sendQueuedBytes: 0, sendQueuedMessages: 0, ready: false, outbound: [], outboundBytes: 0, chunking: 'legacy', lastActivityAt: Date.now(), admissionTail: Promise.resolve(), admissionPending: 0, capacityWaiters: [], catalogSync, composerAttempt: 0,
      diagnostics: new MobileLoadDiagnostics(event => this.deps.log?.('load_diagnostic', event), undefined,
        { enabled: () => this.deps.diagnosticsEnabled?.() === true }) }; run.peers.add(peer);
    const signal = AbortSignal.any([run.controller.signal, peer.controller.signal]);
    peer.tail = (async () => {
      const owner = await this.acquireOwner(signal), call = this.call(run, owner, signal);
      const projection = this.projection(call, catalogSync ? this.catalog(run) : undefined);
      this.sendWire(peer, { type: 'hello', ...await projection.bootstrap(catalogSync, true) }); await peer.sendTail;
      signal.throwIfAborted(); peer.ready = true;
      for (const payload of peer.outbound) this.sendPeer(peer, payload);
      peer.outbound = []; peer.outboundBytes = 0;
      // Connection readiness does not depend on provider catalogs or command discovery.
      this.scheduleComposer(run, peer);
    })().catch(error => { peer.ready = true; peer.outbound = []; peer.outboundBytes = 0; this.socketError(peer, error); });
    this.track(run, peer.tail);
    socket.on('message', bytes => {
      if (signal.aborted) return;
      peer.lastActivityAt = Date.now();
      const buffer = socketBytes(bytes); let size = buffer.byteLength, payload: JsonObject | undefined, parseError: unknown;
      try {
        const value: unknown = JSON.parse(buffer.toString());
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MobileError(400, 'invalid_json', 'Invalid JSON');
        payload = object(value);
        if (payload.type === 'client_message_chunk') {
          if (!peer.delivery) throw badRequest('Resume the transport before sending fragments');
          if (typeof payload.seq === 'number' && Number.isSafeInteger(payload.seq) && payload.seq > 0
            && peer.delivery.acceptClient(payload.seq) === 'duplicate') {
            this.sendWire(peer, { type: 'client_ack', seq: payload.seq }); return;
          }
          const fragment = payload;
          payload = peer.delivery.clientChunks.receive(fragment);
          this.sendWire(peer, { type: 'client_chunk_ack', seq: fragment.seq!, index: fragment.index!, count: fragment.count! });
          if (!payload) return;
          size = Buffer.byteLength(JSON.stringify(payload));
        }
        // Cumulative receipts are independent of slow engine actions. They must not
        // fill the business queue while a history snapshot is waiting on disk.
        if (peer.ready && this.socketControl(peer, payload)) return;
      } catch (error) { parseError = error instanceof MobileError ? error : new MobileError(400, 'invalid_json', 'Invalid JSON'); }
      const diagnostic = peer.diagnostics.begin(payload);
      const queuedAt = diagnostic && peer.diagnostics.enabled() ? performance.now() : undefined;
      peer.queuedBytes += size; peer.queuedMessages++;
      if (peer.queuedBytes > MOBILE_BODY_LIMIT * 2 || peer.queuedMessages > 64) {
        this.deps.log?.('peer_queue_full', { bytes: peer.queuedBytes, messages: peer.queuedMessages });
        peer.controller.abort(); socket.close(1013, 'mobile request queue is full'); return;
      }
      peer.tail = peer.tail.then(async () => {
        signal.throwIfAborted(); if (parseError) throw parseError;
        peer.diagnostics.record(diagnostic, 'admission_started', { durationMs: queuedAt === undefined ? undefined : performance.now() - queuedAt });
        const ownerStartedAt = diagnostic && peer.diagnostics.enabled() ? performance.now() : undefined;
        peer.diagnostics.record(diagnostic, 'owner_acquire_started');
        const owner = await this.acquireOwner(signal), call = this.call(run, owner, signal);
        peer.diagnostics.record(diagnostic, 'owner_acquire_complete', { durationMs: ownerStartedAt === undefined ? undefined : performance.now() - ownerStartedAt });
        await this.socketMessage(run, peer, call, owner, payload!);
      }).catch(error => this.socketError(peer, error, payload)).finally(() => { peer.queuedBytes -= size; peer.queuedMessages--; });
      this.track(run, peer.tail);
    });
    socket.on('error', () => {}); socket.once('close', code => {
      this.deps.log?.('peer_closed', { code, reliable: !!peer.delivery, queuedMessages: peer.queuedMessages });
      peer.diagnostics.close();
      this.peerInterestChanged(peer);
      const followed = [...peer.follows.keys()]; peer.follows.clear();
      for (const sessionId of followed) this.taskStreams.unfollow(sessionId);
      if (peer.composerRetry) clearTimeout(peer.composerRetry);
      peer.controller.abort(); run.peers.delete(peer);
    });
  }
  private scheduleComposer(run: Run, peer: Peer): void {
    if (peer.controller.signal.aborted || this.run !== run || peer.composerRefresh) return;
    if (peer.composerRetry) clearTimeout(peer.composerRetry);
    peer.composerRetry = undefined;
    const signal = AbortSignal.any([peer.controller.signal, run.controller.signal]);
    const refresh = async (): Promise<void> => {
      const owner = await this.acquireOwner(signal), projection = this.projection(this.call(run, owner, signal), peer.catalogSync ? this.catalog(run) : undefined);
      const sessionId = projection.activeFor(await projection.sessions());
      const [commands, runtime] = await Promise.allSettled([projection.commands(sessionId), projection.runtimeConfig(sessionId)]);
      signal.throwIfAborted();
      const metadata: JsonObject = {};
      if (commands.status === 'fulfilled') metadata.slashCommands = commands.value;
      if (runtime.status === 'fulfilled') metadata.runtimeConfig = runtime.value;
      if (commands.status === 'fulfilled' && runtime.status === 'fulfilled') metadata.composerAddMenu = composerMenu(commands.value, runtime.value);
      if (Object.keys(metadata).length) {
        this.sendPeer(peer, { type: 'sessions_changed', ...await projection.bootstrap(peer.catalogSync, true), ...metadata });
      }
      if (commands.status === 'rejected' || runtime.status === 'rejected') throw new Error('Mobile composer discovery is temporarily unavailable');
      peer.composerAttempt = 0;
    };
    peer.composerRefresh = Promise.resolve().then(refresh).catch(error => {
      if (signal.aborted || this.run !== run) return;
      this.deps.log?.('composer_refresh_failed', { attempt: peer.composerAttempt, message: error instanceof Error ? error.message : 'Discovery failed' });
      const delays = this.deps.composerRetryDelaysMs ?? [1000, 2000, 4000, 8000, 16000, 32000, 60000];
      const delay = delays[Math.min(peer.composerAttempt++, delays.length - 1)] ?? 60000;
      peer.composerRetry = setTimeout(() => { peer.composerRetry = undefined; this.scheduleComposer(run, peer); }, delay);
      peer.composerRetry.unref();
    }).finally(() => { peer.composerRefresh = undefined; });
    this.track(run, peer.composerRefresh);
  }
  private socketError(peer: Peer, error: unknown, request: JsonObject = {}, clientSeq?: number): void {
    if (peer.controller.signal.aborted && !peer.delivery) return;
    const failure = mobileError(error), correlation: JsonObject = {};
    for (const key of ['sessionId', 'clientMessageId', 'requestId', 'transportRequestId'] as const) if (typeof request[key] === 'string') correlation[key] = request[key];
    if (typeof request.type === 'string') correlation.action = request.type;
    if (clientSeq !== undefined) correlation.clientSeq = clientSeq;
    this.deps.log?.('request_rejected', { code: failure.code, ...correlation });
    this.sendPeer(peer, diagnosticResponse({ type: 'error', code: failure.code, message: failure.message, ...correlation }, diagnosticRequest(request)));
  }
  /**
   * A peer advertises its segmented framing on envelopes it already sends. The
   * field is additive, so a peer that never sends it keeps the older framing,
   * and the switch is applied per message once it is observed.
   */
  private observeChunking(peer: Peer, payload: JsonObject): void {
    const advertised = Number(payload.chunking);
    if (Number.isSafeInteger(advertised) && advertised >= MESSAGE_CHUNKING_LEVEL) peer.chunking = 'next';
  }
  private socketControl(peer: Peer, payload: JsonObject): boolean {
    this.observeChunking(peer, payload);
    if (payload.type === 'transport_ping') {
      // A stream-level keepalive: answer on the same socket and never replay
      // history for it. Without this answer a phone treats the stream as dead.
      this.sendWire(peer, { type: 'transport_pong' });
      return true;
    }
    if (payload.type === 'server_chunk_ack') {
      const { seq, index, count } = payload;
      if (typeof seq === 'number' && typeof index === 'number' && typeof count === 'number') peer.delivery?.acknowledgeChunk(seq, index, count);
      return true;
    }
    if (payload.type === 'server_ack') {
      const seq = payload.seq; if (peer.delivery && typeof seq === 'number') peer.delivery.acknowledge(seq);
      return true;
    }
    if (payload.type === 'task_ack') {
      const follow = peer.follows.get(string(payload.sessionId)), revision = payload.revision;
      if (follow && typeof revision === 'number' && Number.isSafeInteger(revision) && revision >= follow.revision) follow.revision = revision;
      return true;
    }
    return false;
  }
  private pendingMessages(value: Json | undefined): PendingMobileMessage[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 128) throw badRequest('Invalid pending message receipts');
    const result: PendingMobileMessage[] = [], seen = new Set<string>();
    for (const row of value) {
      const request = object(row), sessionId = required(request.sessionId, 'sessionId'), clientMessageId = required(request.clientMessageId, 'clientMessageId');
      const seq = request.clientSeq, key = JSON.stringify([sessionId, clientMessageId]);
      if (sessionId.length > 256 || clientMessageId.length > 128 || seen.has(key)
        || (seq !== undefined && (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 1))) throw badRequest('Invalid pending message receipts');
      seen.add(key); result.push({ sessionId, clientMessageId, ...(typeof seq === 'number' ? { clientSeq: seq } : {}) });
    }
    return result;
  }
  private recoverPendingMessages(run: Run, peer: Peer, pending: PendingMobileMessage[]): void {
    if (!peer.delivery || peer.controller.signal.aborted) return;
    for (const request of pending) {
      if (request.clientSeq !== undefined && request.clientSeq > peer.delivery.committedClientSeq()) continue;
      const entry = run.recent.get(JSON.stringify([request.sessionId, request.clientMessageId]));
      // A live admission still owns its original completion, which sendPeer routes
      // to this replacement socket. Only settled receipts need another response.
      if (entry && !entry.settled) continue;
      const correlation: JsonObject = { ...request, type: 'send_message', ...(entry ? { requestId: entry.requestId } : {}) };
      if (entry) {
        this.track(run, entry.completion.then(metadata => this.sendPeer(peer, {
          type: 'message_accepted', sessionId: request.sessionId, clientMessageId: request.clientMessageId, requestId: entry.requestId, ...metadata,
        }), error => this.socketError(peer, error, correlation, request.clientSeq)));
      } else {
        this.socketError(peer, new MobileError(409, 'outcome_unknown', 'The previous delivery result is unknown. Check the desktop conversation before retrying.'), correlation, request.clientSeq);
      }
    }
  }
  private async socketMessage(run: Run, peer: Peer, call: MobileCall, owner: MobileEngineOwner, payload: JsonObject, clientSeq?: number): Promise<void> {
    this.observeChunking(peer, payload);
    const type = string(payload.type), diagnostic = diagnosticRequest(payload);
    if (type === 'catalog_sync' || type === 'follow_task') peer.diagnostics.record(diagnostic, 'request_admitted');
    if (type === 'transport_resume') {
      const clientId = required(payload.clientId, 'clientId');
      const lastServerSeq = payload.lastServerSeq;
      if (!/^[A-Za-z0-9_-]{1,128}$/u.test(clientId) || typeof lastServerSeq !== 'number' || !Number.isSafeInteger(lastServerSeq) || lastServerSeq < 0) throw badRequest('Invalid transport cursor');
      const pending = this.pendingMessages(payload.pendingMessages);
      for (const previous of run.peers) {
        if (previous !== peer && previous.clientId === clientId) {
          previous.controller.abort(); previous.socket.close(4001, 'replaced by a newer transport');
        }
      }
      const delivery = run.deliveries.get(clientId);
      delivery.resumeChunkReceipts(payload.chunkAcknowledgements === true, payload.serverChunks);
      // A subscriber may name the exact watermark it retained; an empty cursor
      // keeps the sequence-based resume path.
      const subscribeCursor = typeof payload.subscribeCursor === 'string' ? payload.subscribeCursor.trim() : '';
      const afterSeq = /^\d+$/u.test(subscribeCursor) ? Number(subscribeCursor) : lastServerSeq;
      const replay = delivery.replay(afterSeq), clientChunks = delivery.clientChunks.receipts();
      peer.clientId = clientId; peer.delivery = delivery;
      if (replay.stale) {
        const latestSeq = delivery.resetReplay();
        this.sendWire(peer, { type: 'transport_reset', latestSeq });
        this.sendWire(peer, { type: 'transport_ready', latestSeq, lastClientSeq: replay.lastClientSeq, clientChunks });
      } else {
        this.sendWire(peer, { type: 'transport_ready', latestSeq: replay.latestSeq, lastClientSeq: replay.lastClientSeq, clientChunks });
        await this.sendReplay(peer, replay.frames);
      }
      this.recoverPendingMessages(run, peer, pending);
      return;
    }
    if (this.socketControl(peer, payload)) return;
    if (type === 'client_message') {
      const seq = payload.seq, message = object(payload.message);
      const delivery = peer.delivery;
      if (!delivery || typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq <= 0) throw badRequest('Invalid reliable client message');
      await delivery.processClient(async () => {
        const accepted = delivery.acceptClient(seq);
        if (accepted === 'gap') { this.sendWire(peer, { type: 'client_gap', expectedSeq: delivery.expectedClientSeq() }); return; }
        if (accepted === 'accept') {
          try {
            if (['client_message', 'client_message_chunk', 'transport_resume', 'server_ack'].includes(string(message.type))) throw badRequest('Transport envelopes cannot contain another transport envelope');
            await this.socketMessage(run, peer, call, owner, message, seq);
          } catch (error) { this.socketError(peer, error, message, seq); }
          // Rejection is also a processed request. Its correlated error is retained
          // for replay, and must not poison every later message's sequence.
          delivery.commitClient(seq);
        }
        this.sendWire(peer, { type: 'client_ack', seq });
      }); return;
    }
    if (type === 'set_runtime_config') { await this.setRuntime(run, call, payload); this.sendPeer(peer, { type: 'action_result', action: type, ok: true }); return; }
    if (type === 'permission_respond') { const id = required(payload.requestId, 'requestId'); await this.respond(run, call, owner, id, permissionResponse(payload)); this.sendPeer(peer, { type: 'action_result', action: type, ok: true, requestId: id }); return; }
    if (type === 'elicit_respond') { const id = required(payload.requestId, 'requestId'); await this.respond(run, call, owner, id, elicitationResponse(payload), 'elicit'); this.sendPeer(peer, { type: 'action_result', action: type, ok: true, requestId: id }); return; }
    if (type === 'unfollow_task') {
      const id = required(payload.sessionId, 'sessionId');
      peer.followRequests.get(id)?.abort(); peer.followRequests.delete(id);
      if (peer.follows.delete(id)) this.taskStreams.unfollow(id);
      this.deps.sessionInterestChanged?.(id);
      return;
    }
    if (type === 'catalog_sync') {
      if (!peer.catalogSync) throw new MobileError(400, 'catalog_not_negotiated', 'Catalog synchronization was not negotiated');
      const requestId = required(payload.requestId, 'requestId'), cursor = catalogCursor(payload.cursor);
      if (requestId.length > 128) throw badRequest('Invalid catalog request identity');
      peer.catalogRequest?.abort(); const controller = new AbortController(); peer.catalogRequest = controller;
      const signal = AbortSignal.any([controller.signal, peer.controller.signal, run.controller.signal]);
      this.track(run, (async () => {
        for await (const page of this.catalog(run).pages(requestId, cursor, signal)) {
          signal.throwIfAborted();
          peer.diagnostics.record(diagnostic, 'catalog_page_prepared', { count: Array.isArray(page.sessions) ? page.sessions.length : 0 });
          this.sendPeer(peer, diagnosticResponse(page, diagnostic)); await peer.sendTail;
        }
        peer.diagnostics.finish(diagnostic);
      })().catch(error => {
        peer.diagnostics.finish(diagnostic, signal.aborted ? 'cancelled' : 'rejected');
        if (!signal.aborted) this.socketError(peer, error, { ...payload, type: 'catalog_sync' }, clientSeq);
      })
        .finally(() => { if (peer.catalogRequest === controller) peer.catalogRequest = undefined; }));
      return;
    }
    if (type === 'follow_task') {
      const id = required(payload.sessionId, 'sessionId'), cursor = taskCursor(payload.cursor);
      const transportRequestId = nonempty(payload.transportRequestId);
      if (transportRequestId && transportRequestId.length > 128) throw badRequest('Invalid follow request identity');
      const retained = new Set([...peer.follows.keys(), ...peer.followRequests.keys()]);
      if (!retained.has(id) && !this.protectedFollow(id)
        && [...retained].filter(key => !this.protectedFollow(key)).length >= MAX_UNPROTECTED_FOLLOWS) {
        throw new MobileError(429, 'too_many_task_follows', 'Too many idle task subscriptions. Close an unused task and retry.');
      }
      peer.followRequests.get(id)?.abort(); const controller = new AbortController(); peer.followRequests.set(id, controller);
      this.deps.sessionInterestChanged?.(id);
      const signal = AbortSignal.any([controller.signal, peer.controller.signal, run.controller.signal]);
      const priority = payload.foreground === true ? 'interactive' : 'background';
      const read = this.call(run, owner, signal, undefined, priority);
      const hydrationQueuedAt = diagnostic && peer.diagnostics.enabled() ? performance.now() : undefined;
      peer.diagnostics.record(diagnostic, 'hydration_queued');
      this.track(run, this.hydration.run(async () => {
        peer.diagnostics.record(diagnostic, 'hydration_started', { durationMs: hydrationQueuedAt === undefined ? undefined : performance.now() - hydrationQueuedAt });
        await this.knownSession(read, id);
        await this.followTask(peer, read, owner, id, cursor, transportRequestId ?? undefined, payload.historyRead === true, signal, priority, diagnostic);
        if (diagnostic) void peer.sendTail.then(() => peer.diagnostics.finish(diagnostic));
      }, signal, payload.foreground === true).catch(error => {
        peer.diagnostics.finish(diagnostic, signal.aborted ? 'cancelled' : 'rejected');
        if (peer.followRequests.get(id) === controller && peer.follows.delete(id)) this.taskStreams.unfollow(id);
        if (!signal.aborted) this.socketError(peer, error, payload, clientSeq);
      })
        .finally(() => {
          if (peer.followRequests.get(id) === controller) { peer.followRequests.delete(id); this.deps.sessionInterestChanged?.(id); }
        }));
      return;
    }
    if (!['subscribe', 'send_message', 'stop_generation', 'rename_session', 'delete_session'].includes(type)) throw new MobileError(400, 'unknown_message_type', 'Unknown message type');
    const id = required(payload.sessionId, 'sessionId');
    if (type === 'send_message') {
      await this.knownSession(call, id);
      peer.subscriptions.add(id); this.deps.sessionInterestChanged?.(id);
      this.acceptMessage(run, owner, id, payload, peer, clientSeq); return;
    }
    await this.knownSession(call, id);
    if (type === 'subscribe') {
      peer.subscriptions.add(id); this.deps.sessionInterestChanged?.(id);
      this.sendPeer(peer, { type: 'history', ...await this.historyWithTurns(call, id) });
      for (const kind of ['permission', 'elicit'] as const) {
        const cards = await call(kind + ':pending', { sessionId: id });
        if (Array.isArray(cards)) for (const card of cards) {
          const frame = this.pendingFrame(object(card), owner, kind);
          if (frame) this.sendPeer(peer, frame);
        }
      }
      for (const frame of followQuestions(await call('question:pending', { sessionId: id }), id, []).interactions) this.sendPeer(peer, frame);
      return;
    }
    const action = type === 'stop_generation' ? 'stop' : type === 'rename_session' ? 'rename' : 'delete';
    const response = await this.route(run, call, owner, 'POST', '/api/mobile/sessions/' + encodeURIComponent(id) + '/' + action, payload);
    this.sendPeer(peer, { type: 'action_result', action: type, ok: true, sessionId: id, ...(action === 'stop' ? object(response.body) : {}) });
  }
  private protectedFollow(sessionId: string): boolean {
    if (this.working.has(sessionId)) return true;
    for (const pending of this.permissions.values()) if (pending.sessionId === sessionId) return true;
    for (const pending of this.elicitations.values()) if (pending.sessionId === sessionId) return true;
    return false;
  }
  private async followTask(peer: Peer, call: MobileCall, owner: MobileEngineOwner, sessionId: string, cursor?: { streamId: string; revision: number }, transportRequestId?: string, historyRead = false, signal?: AbortSignal, priority: 'interactive' | 'background' = 'background', diagnostic?: DiagnosticMetadata): Promise<void> {
    let follow = peer.follows.get(sessionId);
    if (!follow) {
      follow = { snapshotting: true, revision: cursor?.revision ?? 0, pending: [], pendingBytes: 0, generation: 0 };
      peer.follows.set(sessionId, follow); this.taskStreams.follow(sessionId);
      this.deps.sessionInterestChanged?.(sessionId);
    } else {
      follow.snapshotting = true; follow.pending = []; follow.pendingBytes = 0;
    }
    const generation = ++follow.generation;
    const correlation: JsonObject = transportRequestId ? { transportRequestId } : {};
    const current = (): boolean => peer.follows.get(sessionId) === follow && follow.generation === generation && !signal?.aborted;
    if (cursor) {
      const replay = this.taskStreams.replay(sessionId, cursor);
      if (peer.follows.get(sessionId) !== follow || follow.generation !== generation) return;
      if (replay) {
        for (const frame of replay) this.sendPeer(peer, frame);
        follow.snapshotting = false;
        follow.revision = replay.length ? Number(replay.at(-1)!.revision) : cursor.revision;
        follow.pending = []; follow.pendingBytes = 0;
        if (peer.catalogSync) this.sendPeer(peer, diagnosticResponse({ type: 'task_follow_ready', sessionId, streamId: cursor.streamId, revision: follow.revision, mode: 'replay', ...correlation }, diagnostic));
        return;
      }
      this.sendPeer(peer, { ...this.taskStreams.gap(sessionId, cursor), ...correlation });
    }
    const followCall = historyRead ? this.call(this.run!, owner, signal, history => {
      if (current()) {
        peer.diagnostics.record(diagnostic, 'history_prepared', { count: Array.isArray(object(history).messages) ? (object(history).messages as Json[]).length : 0 });
        this.sendPeer(peer, diagnosticResponse({ type: 'task_history', sessionId, history: { ...object(history), sessionId }, ...correlation }, diagnostic));
      }
    }, priority) : call;
    const snapshot = object(await followCall('session:follow', { sessionId }));
    if (peer.follows.get(sessionId) !== follow || follow.generation !== generation) return;
    if (snapshot.mode !== 'snapshot' || typeof snapshot.streamId !== 'string' || typeof snapshot.revision !== 'number') {
      throw new MobileError(500, 'invalid_follow_snapshot', 'Desktop returned an invalid task snapshot');
    }
    peer.diagnostics.record(diagnostic, 'snapshot_prepared', { count: Array.isArray(snapshot.messages) ? snapshot.messages.length : 0 });
    const interactions: JsonObject[] = [];
    for (const kind of ['permission', 'elicit'] as const) {
      const cards = await call(kind + ':pending', { sessionId });
      if (Array.isArray(cards)) for (const card of cards) {
        const frame = this.pendingFrame(object(card), owner, kind);
        if (frame) interactions.push(frame);
      }
    }
    const pendingQuestions = await call('question:pending', { sessionId });
    if (peer.follows.get(sessionId) !== follow || follow.generation !== generation) return;
    const cut = this.taskStreams.snapshotCut(sessionId, follow.pending, snapshot.streamId, snapshot.revision);
    if (peer.follows.get(sessionId) !== follow || follow.generation !== generation) return;
    const questionSnapshot = followQuestions(pendingQuestions, sessionId, cut.liveEvents);
    interactions.push(...questionSnapshot.interactions);
    const liveInteractions = new Set(cut.liveEvents.flatMap(event => {
      const requestId = nonempty(event.requestId), type = nonempty(event.type);
      return requestId && type ? [type + ':' + requestId] : [];
    }));
    this.sendPeer(peer, {
      type: 'task_snapshot', sessionId, streamId: cut.streamId, ...correlation,
      ...(diagnostic ? { ...diagnostic, diagnosticMessage: 'task_snapshot' } : {}),
      // `session:follow` projects the engine history WITHOUT a `sessionId`, but the phone's
      // history envelope requires it: the missing key made the phone throw away the whole
      // snapshot frame and spin on an empty transcript.
      revision: cut.revision, history: { ...snapshot, sessionId }, liveEvents: cut.liveEvents,
      activeEvents: activeFollowEvents(snapshot, sessionId, result => splitDynamicToolMedia(result, this.deps.configRoot)),
      coveredMessageIds: snapshot.coveredMessageIds ?? [],
      coveredToolResults: snapshot.coveredToolResults ?? [],
      working: this.working.has(sessionId), questions: questionSnapshot.questions, interactions: interactions.filter(frame => {
        const requestId = nonempty(frame.requestId), type = nonempty(frame.type);
        return !requestId || !type || !liveInteractions.has(type + ':' + requestId);
      }),
    });
    follow.snapshotting = false; follow.revision = cut.revision;
    const queued = follow.pending.splice(0).filter(frame => Number(frame.revision) > cut.revision);
    follow.pendingBytes = 0;
    for (const frame of queued) this.sendPeer(peer, frame);
    if (peer.catalogSync) this.sendPeer(peer, diagnosticResponse({ type: 'task_follow_ready', sessionId, streamId: cut.streamId,
      revision: queued.length ? Number(queued.at(-1)!.revision) : cut.revision, mode: 'snapshot', ...correlation }, diagnostic));
  }
  private broadcastTaskPatch(sessionId: string, frame: JsonObject): void {
    const run = this.run; if (!run || run.controller.signal.aborted) return;
    let bytes: number | undefined;
    for (const peer of run.peers) {
      const follow = peer.follows.get(sessionId); if (!follow) continue;
      if (follow.snapshotting) {
        bytes ??= Buffer.byteLength(JSON.stringify(frame));
        if (follow.pending.length >= 1024 || follow.pendingBytes + bytes > 8 * 1024 * 1024) {
          peer.followRequests.get(sessionId)?.abort(); peer.followRequests.delete(sessionId);
          peer.follows.delete(sessionId); this.taskStreams.unfollow(sessionId);
          this.deps.sessionInterestChanged?.(sessionId);
          this.socketError(peer, new MobileError(409, 'history_changed_too_quickly', 'The conversation changed too quickly while loading. Reopen the task to retry.'), { type: 'follow_task', sessionId });
          continue;
        }
        follow.pending.push(frame); follow.pendingBytes += bytes;
      }
      else this.sendPeer(peer, frame);
    }
  }
  private sendPeer(peer: Peer, payload: JsonObject): void {
    if (!peer.delivery) { this.sendWire(peer, payload); return; }
    const target = [...this.run?.peers ?? []].find(candidate => candidate.delivery === peer.delivery
      && !candidate.controller.signal.aborted && candidate.socket.readyState === WebSocket.OPEN) ?? peer;
    for (const frame of peer.delivery.enqueue(payload, peer.chunking)) this.sendWire(target, frame, 150 * 1024);
  }
  private sendReplay(peer: Peer, frames: JsonObject[]): Promise<void> {
    // Replay already belongs to the bounded journal. Queue one streaming writer
    // job, not up to thousands of physical frames ahead of the first socket send.
    // Live messages join after this job so their sequence cannot overtake replay.
    peer.sendQueuedMessages++;
    peer.sendTail = peer.sendTail.then(async () => {
      for (const frame of frames) {
        if (peer.controller.signal.aborted || peer.socket.readyState !== WebSocket.OPEN) return;
        const { text, bytes } = encodedSocketFrame(frame);
        if (bytes > 150 * 1024) throw new Error('Invalid replay frame size');
        await new Promise<void>((resolve, reject) => {
          peer.socket.send(text, error => error ? reject(error) : resolve());
        });
      }
    }).catch(() => {
      if (!peer.controller.signal.aborted) { peer.controller.abort(); peer.socket.terminate(); }
    }).finally(() => { peer.sendQueuedMessages--; });
    return peer.sendTail;
  }
  private sendWire(peer: Peer, payload: JsonObject, limit = MOBILE_BODY_LIMIT): void {
    // Fast path: with room in the queue the frame is written in call order without
    // deferring to a microtask, so existing write ordering and diagnostics hold.
    if (peer.admissionPending === 0 && !this.queueIsFull(peer, payload, limit)) { this.writeAdmitted(peer, payload, limit); return; }
    peer.admissionPending++;
    // A full queue makes the writer wait: frames are neither dropped nor
    // overwritten, and the connection stays open until the peer drains it.
    peer.admissionTail = peer.admissionTail.then(async () => {
      while (!peer.controller.signal.aborted && peer.socket.readyState === WebSocket.OPEN
        && this.queueIsFull(peer, payload, limit)) {
        await new Promise<void>(resolve => peer.capacityWaiters.push(resolve));
      }
      if (!peer.controller.signal.aborted && peer.socket.readyState === WebSocket.OPEN) this.writeAdmitted(peer, payload, limit);
    }).catch(() => {}).finally(() => { peer.admissionPending--; });
  }
  private queueIsFull(peer: Peer, payload: JsonObject, limit: number): boolean {
    const { bytes } = encodedSocketFrame(payload);
    return bytes <= limit && (peer.sendQueuedMessages >= MESSAGE_OUTBOUND_CAPACITY || peer.sendQueuedBytes + bytes > SEND_QUEUE_BYTES);
  }
  private writeAdmitted(peer: Peer, payload: JsonObject, limit: number): void {
    if (peer.controller.signal.aborted || peer.socket.readyState !== WebSocket.OPEN) return;
    const { text, bytes } = encodedSocketFrame(payload), diagnostic = diagnosticMetadata(payload);
    if (bytes > limit) {
      peer.diagnostics.finish(diagnostic, 'limit');
      peer.controller.abort(); peer.socket.close(1013, 'frame exceeds the transport limit'); return;
    }
    const queuedAt = performance.now(), first = payload.type !== 'server_message_chunk' || payload.index === 0;
    const last = payload.type !== 'server_message_chunk' || payload.index === Number(payload.count) - 1;
    const fields = { bytes, sequence: payload.seq, index: payload.index, chunkCount: payload.count };
    if (first) peer.diagnostics.record(diagnostic, 'send_queued', { ...fields, queueBytes: peer.sendQueuedBytes });
    peer.sendQueuedBytes += bytes; peer.sendQueuedMessages++;
    peer.sendTail = peer.sendTail.then(() => new Promise<void>((resolve, reject) => {
      if (peer.controller.signal.aborted || peer.socket.readyState !== WebSocket.OPEN) { resolve(); return; }
      if (first) peer.diagnostics.record(diagnostic, 'write_started', { ...fields, durationMs: performance.now() - queuedAt });
      try { peer.socket.send(text, error => {
        if (error) { peer.diagnostics.finish(diagnostic, 'send_failed'); reject(error); return; }
        const wireBytes = peer.diagnostics.wrote(diagnostic, bytes);
        if (last) peer.diagnostics.record(diagnostic, 'write_complete', { ...fields, wireBytes });
        resolve();
      }); }
      catch (error) { peer.diagnostics.finish(diagnostic, 'send_failed'); reject(error); }
    })).catch(() => {
      if (!peer.controller.signal.aborted) { peer.controller.abort(); peer.socket.terminate(); }
    }).finally(() => {
      peer.sendQueuedBytes -= bytes; peer.sendQueuedMessages--;
      // Wake exactly one waiting admission; it re-checks the threshold itself.
      peer.capacityWaiters.shift()?.();
    });
  }
  private broadcast(run: Run, payload: JsonObject, sessionId?: string, include: (peer: Peer) => boolean = () => true, unconditional = false): void {
    if (this.run !== run || run.controller.signal.aborted) return;
    for (const peer of run.peers) if (include(peer) && (unconditional || !sessionId || (!peer.follows.size && (!peer.subscriptions.size || peer.subscriptions.has(sessionId))))) {
      if (peer.ready) this.sendPeer(peer, payload);
      else {
        peer.outboundBytes += Buffer.byteLength(JSON.stringify(payload));
        if (peer.outboundBytes > MOBILE_BODY_LIMIT) { peer.controller.abort(); peer.socket.terminate(); }
        else peer.outbound.push(payload);
      }
    }
  }
  private async broadcastState(run: Run, call: MobileCall, sessions = false): Promise<void> {
    if (!run.peers.size) return;
    try {
      for (const catalogSync of [false, true]) {
        if (![...run.peers].some(peer => peer.catalogSync === catalogSync)) continue;
        const projection = this.projection(call, catalogSync ? this.catalog(run) : undefined);
        const include = (peer: Peer): boolean => peer.catalogSync === catalogSync;
        // Legacy bootstrap already contains desktop state. Do not perform a
        // second catalog scan for the separate compatibility notification.
        const bootstrap = sessions && !catalogSync ? await projection.bootstrap(false, true) : undefined;
        if (bootstrap) this.broadcast(run, { type: 'sessions_changed', ...bootstrap }, undefined, include);
        const desktopState = bootstrap ? object(bootstrap.desktopState) : await projection.desktopState();
        this.broadcast(run, { type: 'desktop_state_changed', desktopState, projects: desktopState.projects! }, undefined, include);
      }
    } catch { /* A failed refresh must not turn an already committed action into a retry. */ }
  }
  private scheduleState(run: Run, owner: MobileEngineOwner, sessions = false): void {
    run.stateRefreshAgain = true; run.stateIncludeSessions ||= sessions;
    if (run.stateRefresh) return;
    const refresh = async (): Promise<void> => {
      do {
        const includeSessions = run.stateIncludeSessions; run.stateRefreshAgain = false; run.stateIncludeSessions = false;
        await this.broadcastState(run, this.call(run, owner), includeSessions);
      } while (run.stateRefreshAgain && this.run === run && !run.controller.signal.aborted);
    };
    run.stateRefresh = refresh().finally(() => { run.stateRefresh = undefined; });
    this.track(run, run.stateRefresh);
  }
  noteRendererSession(args: Json[], channel?: string): void {
    const id = nonempty(object(args[0]).sessionId);
    if (id && this.activeSession !== id) {
      this.activeSession = id;
      const owner = this.deps.engineOwner(); if (this.run && owner) this.scheduleState(this.run, owner);
    }
    if (id && channel && ['session:rename', 'session:set-pinned', 'session:set-workdir', 'session:clear-workdir', 'session:archive', 'session:unarchive'].includes(channel)) this.noteSessionMetadata(id);
    const workspaceMutation = channel === 'workspaces:save' || channel === 'workspaces:delete';
    if (workspaceMutation) this.run?.catalog?.invalidate();
    if (channel?.startsWith('projects:') || workspaceMutation) {
      const owner = this.deps.engineOwner(); if (this.run && owner) this.scheduleState(this.run, owner);
    }
  }
  noteSessionMetadata(id: string): void { this.run?.catalog?.invalidate(id); }
  /** A desktop answer must close the same card on connected phones. */
  noteRendererResponse(channel: string, args: Json[]): void {
    const kind = channel === 'permission:respond' ? 'permission' : channel === 'elicit:respond' ? 'elicit' : undefined;
    if (!kind) return;
    const payload = object(args[0]), id = string(payload.requestId), entries = this.pending(kind), pending = entries.get(id), run = this.run;
    if (!run || !pending || !sameOwner(pending.owner, this.deps.engineOwner())) return;
    entries.delete(id);
    if (pending.sessionId) this.publishPushNotice(pending.sessionId, kind === 'permission' ? 'permission' : 'elicitation', id, true);
    if (pending.sessionId && ![...entries.values()].some(row => row.sessionId === pending.sessionId)) {
      this.awaitingInteraction.delete(pending.sessionId);
      this.scheduleState(run, pending.owner, true);
    }
    const frame = { type: kind + '_resolved', sessionId: pending.sessionId, requestId: id,
      ...(kind === 'permission' ? { decision: payload.decision ?? null,
        ...(payload.updatedInput === undefined ? {} : { updatedInput: payload.updatedInput }),
        ...(payload.answers === undefined ? {} : { answers: payload.answers }) } : { response: payload.response ?? null }) };
    this.broadcast(run, frame, pending.sessionId ?? undefined, () => true, true);
    if (pending.sessionId) this.taskStreams.publish(pending.sessionId, frame);
  }
  forgetSession(id: string): void {
    this.run?.catalog?.invalidate(id);
    for (const peer of this.run?.peers ?? []) {
      peer.followRequests.get(id)?.abort(); peer.followRequests.delete(id);
      peer.follows.delete(id); peer.subscriptions.delete(id);
    }
    this.deps.sessionInterestChanged?.(id);
    if (this.activeSession === id) this.activeSession = undefined;
    this.working.delete(id);
    this.taskStreams.forget(id);
    for (const [key, entry] of this.permissions) if (entry.sessionId === id) this.permissions.delete(key);
    for (const [key, entry] of this.elicitations) if (entry.sessionId === id) this.elicitations.delete(key);
  }
  publishTaskNotice(sessionId: string, turnId: string, failed: boolean): void {
    this.publishPushNotice(sessionId, failed ? 'failed' : 'done', turnId);
  }
  private publishPushNotice(sessionId: string, kind: MobilePushKind, key: string, resolved = false): void {
    const run = this.run, current = this.deps.account();
    if (!run?.relay || !run.config.enabled || !run.account || run.account.userId !== current?.userId || run.account.token !== current.token
      || !sessionId || !key || this.deps.catalogVisible?.(sessionId) === false) return;
    run.relay.publishNotice({ sessionId, kind, eventId: `${kind}:${sessionId}:${key}`, occurredAt: Date.now(), ...(resolved ? { resolved: true } : {}) });
  }
  publishEngineEvent(event: JsonObject, owner: MobileEngineOwner): void {
    if (!sameOwner(owner, this.deps.engineOwner())) return; this.owner();
    const type = string(event.type), id = nonempty(event.sessionId);
    // `stream_mode` precedes EVERY delta (`ipc/project.ts:955-959`), and its modes include
    // `responding`, `thinking`, `tool-use` and `idle`. Adding on any of them re-lit a session that
    // had already settled — including `idle`, which is the opposite of working — so only the
    // frame that opens a turn counts.
    const started = id && type === 'stream_mode' && event.mode === 'requesting' && !this.working.has(id);
    if (started) this.working.add(id);
    // `api_error` ends a turn ONLY when it is terminal (`contracts/vectors/turn-termination-vectors.json`:
    // `apiErrorIsTerminal`). A non-terminal one is a follow-up or compaction notice, and clearing
    // here published a `desktop_state_changed` that told the phone the turn was over while the
    // desktop was still running it.
    const settled = type === 'done' || type === 'interrupted' || (type === 'api_error' && event.terminal === true);
    if (id && settled) this.working.delete(id);
    const run = this.run; if (!run) return;
    const engineFrame = { type: 'engine_event', event };
    this.broadcast(run, engineFrame, id ?? undefined);
    if (id) this.taskStreams.publish(id, engineFrame);
    if (type === 'permission_cancelled' || type === 'elicit_cancelled') {
      const requestId = string(event.requestId); this.pending(type === 'permission_cancelled' ? 'permission' : 'elicit').delete(requestId);
      if (id) this.publishPushNotice(id, type === 'permission_cancelled' ? 'permission' : 'elicitation', requestId, true);
      if (id && ![...this.pending(type === 'permission_cancelled' ? 'permission' : 'elicit').values()].some(row => row.sessionId === id)) {
        this.awaitingInteraction.delete(id);
        this.scheduleState(run, owner, true);
      }
      const frame = { type, sessionId: id, requestId };
      this.broadcast(run, frame, id ?? undefined, () => true, true);
      if (id) this.taskStreams.publish(id, frame);
    }
    if (id && (started || settled || type === 'session_title_updated')) run.catalog?.invalidate(id);
    if (started || settled || type === 'session_title_updated') this.scheduleState(run, owner, !started);
  }
  publishPermissionRequest(card: JsonObject, owner: MobileEngineOwner): void {
    this.publishInteraction(card, owner, 'permission');
  }
  publishElicitationRequest(card: JsonObject, owner: MobileEngineOwner): void {
    this.publishInteraction(card, owner, 'elicit');
  }
  /// Independent desktop channels (`goal:updated`, `background-process:changed`,
  /// `engine:status`) never ride the chat event stream, so the phone had no goal, no
  /// background-process state and no engine reconnect signal at all. They are folded into the
  /// same `engine_event` envelope the phone already decodes, broadcast unconditionally: none of
  /// them belongs to one followed session.
  publishDesktopStateEvent(type: string, payload: JsonObject, owner: MobileEngineOwner): void {
    if (!sameOwner(owner, this.deps.engineOwner())) return;
    const run = this.run; if (!run) return;
    const sessionId = nonempty(payload.sessionId);
    if ((type === 'question_requested' || type === 'question_resolved' && ['answered', 'expired', 'cancelled'].includes(string(payload.state))
      || type === 'planning_input_requested' || type === 'planning_input_resolved' && ['answered', 'skipped', 'expired', 'cancelled'].includes(string(payload.status))) && sessionId) {
      const requestId = nonempty(payload.requestId), turnId = nonempty(payload.turnId);
      if (requestId && turnId) this.publishPushNotice(sessionId, 'question', `${turnId}:${requestId}`, type === 'question_resolved' || type === 'planning_input_resolved');
    }
    const frame = { type: 'engine_event', event: { ...payload, type } };
    this.broadcast(run, frame, sessionId ?? undefined);
    if (sessionId) this.taskStreams.publish(sessionId, frame);
  }
  private pendingFrame(card: JsonObject, owner: MobileEngineOwner, kind: InteractionKind): JsonObject | undefined {
    if (!sameOwner(owner, this.deps.engineOwner())) return; this.owner();
    const requestId = nonempty(card.requestId); if (!requestId) return;
    const sessionId = nonempty(card.sessionId), entries = this.pending(kind);
    if (!entries.has(requestId)) {
      entries.set(requestId, { owner, sessionId });
      const run = this.run;
      if (sessionId && run) { this.awaitingInteraction.add(sessionId); this.scheduleState(run, owner, true); }
    }
    return { ...(kind === 'permission' ? { toolName: null, message: null } : {}), ...card, ...(kind === 'elicit' && card.type ? { elicitationType: card.type } : {}),
      type: kind + '_pending', sessionId, requestId, responseChannel: kind };
  }
  private publishInteraction(card: JsonObject, owner: MobileEngineOwner, kind: InteractionKind): void {
    const run = this.run; if (!run) return;
    const frame = this.pendingFrame(card, owner, kind); if (!frame) return;
    // Unconditional: a peer following another session must still see this session's approval
    // request, or the desktop turn waits on an answer no phone screen can show. The phone
    // deduplicates by requestId, so a later follow replay cannot double the card.
    this.broadcast(run, frame, nonempty(frame.sessionId) ?? undefined, () => true, true);
    const sessionId = nonempty(frame.sessionId);
    if (sessionId) {
      this.taskStreams.publish(sessionId, frame);
      this.publishPushNotice(sessionId, kind === 'permission' ? 'permission' : 'elicitation', string(frame.requestId));
    }
  }
}
