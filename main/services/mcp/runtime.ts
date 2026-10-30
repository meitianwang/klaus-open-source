import type { Json } from '../../ipc/contract';
import { IpcHandlerError } from '../../ipc/registry';
import { SerialMutations, errorMessage, object, string, type EngineRequest, type JsonObject } from '../service-types';
import type { McpConfigurationService } from './configuration';
import type { McpDeclarations } from './entries';
import { captureMcpOAuthCode } from './loopback';
import type { McpOAuthService } from './oauth';
import { strings } from './oauth-schema';

export interface McpRuntimeContext { cwd: string; rendererId?: string; engineId?: string; generation?: number }
export interface McpRuntimeDeps {
  configuration: Pick<McpConfigurationService, 'resolvedServerSet' | 'oauthServerConfig'>;
  oauth: Pick<McpOAuthService, 'authenticate' | 'cancel' | 'close'>;
  /** Read the existing focused binding. Opening an MCP settings page must not create a session. */
  context: () => Promise<McpRuntimeContext>;
  isCurrent: (context: McpRuntimeContext) => boolean;
  /** Include host-managed capabilities and bind them to this exact renderer session. */
  connectReadyServers?: (context: McpRuntimeContext) => Promise<JsonObject[]>;
  /** Atomically compose and reload inside the host's session lifecycle gate. */
  reloadServers?: (context: McpRuntimeContext) => Promise<JsonObject>;
  request: EngineRequest;
  requestAcknowledged: (method: string, params: JsonObject, field: string) => Promise<unknown>;
  /** Member folders of the context session's workspace, so workspace-scoped project servers authorize like they connect. */
  extraRoots?: (rendererId?: string) => string[];
  openExternal: (url: string) => Promise<void>;
  onStatusChanged: (cwd?: string) => void | Promise<void>;
  authorizationTimeoutMs?: number;
}
interface PendingAuthorization {
  context: McpRuntimeContext; requestId: string; name: string; authorizationUrl: string; redirectUri: string;
  controller: AbortController; timer: ReturnType<typeof setTimeout>; settling?: Promise<JsonObject>; run?: Promise<Json>;
}
const records = (value: unknown): JsonObject[] => Array.isArray(value) ? value.filter((item): item is JsonObject => item !== null && typeof item === 'object' && !Array.isArray(item)) : [];
const key = (context: McpRuntimeContext, requestId: string): string => JSON.stringify([context.generation, context.engineId, requestId]);
const contextKey = (context: McpRuntimeContext): string => JSON.stringify([context.generation, context.engineId, context.rendererId, context.cwd]);
const same = (left: McpRuntimeContext, right: McpRuntimeContext): boolean => left.engineId === right.engineId && left.generation === right.generation && left.rendererId === right.rendererId && left.cwd === right.cwd;
const state = (value: string): string => value === 'ready' ? 'connected' : value === 'connecting' ? 'pending' : ['failed', 'closed', 'cancelled'].includes(value) ? 'failed' : value === 'needs-auth' ? value : 'disconnected';
function runtimeServers(reply: JsonObject): JsonObject[] {
  const servers = object(reply.runtime).servers;
  if (!Array.isArray(servers) || servers.some(row => !string(object(row).name) || !string(object(row).state) || !Array.isArray(object(row).tools))) throw new Error('Invalid MCP runtime snapshot');
  return servers as JsonObject[];
}
function ruleToolName(rule: string): string { const open = [...rule].findIndex((char, index, chars) => char === '(' && (index === 0 || chars[index - 1] !== '\\')); return open > 0 && rule.endsWith(')') ? rule.slice(0, open) : rule; }
export function mcpToolRequiresApproval(rules: string[], tool: string): boolean {
  const lower = tool.toLowerCase();
  return rules.some(raw => {
    const rule = ruleToolName(raw).trim().toLowerCase();
    if (rule.endsWith('*')) { const prefix = rule.slice(0, -1); return prefix.split('__').length >= 3 && lower.startsWith(prefix); }
    const parts = rule.split('__'); return parts.length === 2 && parts[0] === 'mcp' && parts[1] ? lower.startsWith(rule + '__') : rule === lower;
  });
}
export function projectMcpStatus(servers: JsonObject[], declarations: McpDeclarations, askRules: string[]): JsonObject[] {
  const config = new Map(declarations.servers.map(row => [string(row.name), row]));
  const rows = servers.map(server => {
    const name = string(server.name), denied = strings(config.get(name)?.disabledTools), approval = (tool: string) => mcpToolRequiresApproval(askRules, tool) ? 'ask' : 'auto';
    const tools: JsonObject[] = records(server.tools).map(tool => ({ name: string(tool.name), description: typeof tool.description === 'string' ? tool.description : null, exposure: typeof tool.exposure === 'string' ? tool.exposure : null, enabled: true, approval: approval(string(tool.name)) }));
    for (const raw of denied) { const full = 'mcp__' + name + '__' + raw; if (!tools.some(tool => tool.name === full)) tools.push({ name: full, description: null, exposure: null, enabled: false, approval: approval(full) }); }
    const row: JsonObject = { name, status: state(string(server.state)), toolCount: tools.length, tools };
    for (const field of ['authStatus', 'error', 'failureReason']) if (typeof server[field] === 'string') row[field] = server[field]!;
    if (server.state === 'needs-auth') row.klausNeedsAuth = true; return row;
  });
  for (const skipped of declarations.skipped) rows.push({ name: skipped.name, status: 'disconnected', toolCount: 0, tools: [], ...(skipped.reason === 'disabled' ? {} : { error: 'unsupported transport: ' + skipped.reason }) });
  return rows;
}

/** Projects engine-owned MCP state and answers each parked authorization against its original binding. */
export class McpRuntimeService {
  private readonly mutations = new SerialMutations();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly authorizations = new Map<string, PendingAuthorization>();
  private readonly hostAuthorizations = new Map<symbol, { context: McpRuntimeContext; config: JsonObject }>();
  private readonly liveAuthorizations = new Map<string, { context: McpRuntimeContext; name: string; controller: AbortController; promise: Promise<Json> }>();
  private readonly prompts = new Map<string, { context: McpRuntimeContext; rows: JsonObject[] }>();
  private readonly runtimeReads = new Map<string, Promise<JsonObject[]>>();
  private readonly runtimeSnapshots = new Map<string, { context: McpRuntimeContext; servers: JsonObject[] }>();
  private readonly statusWaiters = new Map<string, Set<() => void>>();
  private readonly retired = new Set<string>();
  private closed = false;
  private closing?: Promise<void>;
  constructor(private readonly deps: McpRuntimeDeps) {}
  private active(): void { if (this.closed) throw new IpcHandlerError('SERVICE_CLOSED', 'The MCP runtime service is closed'); }
  private track<T>(action: () => Promise<T>, allowClosed = false): Promise<T> {
    if (!allowClosed) try { this.active(); } catch (error) { return Promise.reject(error); }
    const pending = action(); this.pending.add(pending); return pending.finally(() => { this.pending.delete(pending); });
  }
  private current(context: McpRuntimeContext): void { if (!this.deps.isCurrent(context)) throw new IpcHandlerError('STALE_SESSION', 'The MCP session binding changed'); }
  private bound(context: McpRuntimeContext): asserts context is McpRuntimeContext & { engineId: string; rendererId: string; generation: number } {
    this.current(context); if (!context.engineId || !context.rendererId || !Number.isSafeInteger(context.generation)) throw new IpcHandlerError('MCP_REQUIRES_SESSION', 'rust_mcp_authorization_requires_session');
  }
  private async query(method: string, params: JsonObject, field?: string): Promise<JsonObject> {
    const reply = object(await this.deps.request(method, params)); if (reply.error !== undefined) throw new Error(errorMessage(reply.error));
    const value = field ? reply[field] : reply;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ' + method + ' response'); return value as JsonObject;
  }
  private async acknowledged(method: string, params: JsonObject, field: string): Promise<JsonObject> {
    const reply = await this.deps.requestAcknowledged(method, params, field);
    if (reply === null || typeof reply !== 'object' || Array.isArray(reply)) throw new Error('Invalid ' + method + ' terminal response');
    const result = reply as JsonObject; if (result.error !== undefined) throw new Error(errorMessage(result.error)); return result;
  }
  private cachePrompts(context: McpRuntimeContext, servers: JsonObject[]): void {
    if (!context.rendererId) return;
    this.prompts.set(context.rendererId, { context, rows: servers.flatMap(server => records(server.prompts).filter(prompt => string(prompt.name)).map(prompt => ({
      name: 'mcp:' + string(server.name) + ':' + string(prompt.name), displayName: string(server.name) + '/' + string(prompt.name), description: string(prompt.description), scope: 'global', type: 'prompt', source: 'mcp',
    }))) });
  }
  promptRows(rendererId: string): JsonObject[] { const cached = this.prompts.get(rendererId); return !this.closed && cached && this.deps.isCurrent(cached.context) ? structuredClone(cached.rows) : []; }
  private notifyStatus(context: McpRuntimeContext): void { for (const resolve of this.statusWaiters.get(contextKey(context)) ?? []) resolve(); }
  private readRuntime(context: McpRuntimeContext): Promise<JsonObject[]> {
    const identity = contextKey(context), existing = this.runtimeReads.get(identity); if (existing) return existing;
    // The injected facade request has the engine client's bounded RPC deadline.
    // Keep the original request tracked after a settings read returns needs-auth.
    const reading = this.track(async () => {
      const reply = await this.query('session/mcpRuntime', { sessionId: context.engineId! }, 'mcpRuntime'), servers = runtimeServers(reply); this.current(context);
      if (!this.closed && !this.retired.has(identity)) {
        this.runtimeSnapshots.set(identity, { context: { ...context }, servers: structuredClone(servers) }); this.cachePrompts(context, servers);
      }
      return servers;
    }).finally(() => { if (this.runtimeReads.get(identity) === reading) this.runtimeReads.delete(identity); });
    this.runtimeReads.set(identity, reading); void reading.catch(() => undefined); return reading;
  }
  private pendingStatus(context: McpRuntimeContext): JsonObject[] | undefined {
    const authorizations = [...this.authorizations.values()].filter(row => same(row.context, context) && !row.settling);
    if (!authorizations.length) return undefined;
    const snapshot = this.runtimeSnapshots.get(contextKey(context));
    const rows = snapshot && this.deps.isCurrent(snapshot.context) ? structuredClone(snapshot.servers) : [];
    for (const row of authorizations) {
      const pending: JsonObject = { name: row.name, state: 'needs-auth', authStatus: 'notLoggedIn', tools: [] };
      const index = rows.findIndex(server => server.name === row.name); if (index < 0) rows.push(pending); else rows[index] = pending;
    }
    return rows;
  }
  private async visibleRuntime(context: McpRuntimeContext): Promise<JsonObject[]> {
    const identity = contextKey(context);
    this.active(); this.current(context); if (this.retired.has(identity)) throw new IpcHandlerError('STALE_SESSION', 'The MCP session binding is retiring');
    const reading = this.readRuntime(context);
    for (;;) {
      this.active(); this.current(context); if (this.retired.has(identity)) throw new IpcHandlerError('STALE_SESSION', 'The MCP session binding was retired');
      const pending = this.pendingStatus(context); if (pending) return pending;
      let wake!: () => void; const changed = new Promise<{ changed: true }>(resolve => { wake = () => resolve({ changed: true }); });
      const waiters = this.statusWaiters.get(identity) ?? new Set<() => void>(); waiters.add(wake); this.statusWaiters.set(identity, waiters);
      try {
        // Recheck after subscribing so a received authorization cannot be missed.
        const pending = this.pendingStatus(context); if (pending) return pending;
        const next = await Promise.race([reading.then(servers => ({ servers })), changed]);
        if ('servers' in next) return next.servers;
      } finally { waiters.delete(wake); if (!waiters.size) this.statusWaiters.delete(identity); }
    }
  }
  hasLiveSession(): Promise<boolean> {
    return this.track(async () => {
      const context = await this.deps.context(); this.current(context)
      return !!context.engineId
    })
  }
  status(): Promise<Json> {
    return this.track(async () => {
      const context = await this.deps.context(), declarations = await this.deps.configuration.resolvedServerSet(context.cwd); this.current(context);
      if (!context.engineId) return projectMcpStatus([], declarations, []);
      this.bound(context);
      const [servers, permissions] = await Promise.all([this.visibleRuntime(context), this.query('engine/permissionRules', {})]);
      if (!Array.isArray(permissions.ask) || permissions.ask.some(rule => typeof rule !== 'string')) throw new Error('Invalid MCP permission snapshot');
      this.current(context); return projectMcpStatus(servers, declarations, strings(permissions.ask));
    });
  }
  reconnect(): Promise<Json> {
    return this.track(() => this.mutations.run(async () => {
      this.active(); const context = await this.deps.context(); this.current(context);
      // Reconnect is also exposed from the settings page, which may be open
      // before any conversation has started. There is nothing to reload in
      // that state, and treating it as an authorization error makes a harmless
      // refresh look like a broken connector.
      if (!context.engineId) { await this.deps.onStatusChanged(context.cwd); return null; }
      this.bound(context);
      const reply = this.deps.reloadServers ? await this.deps.reloadServers(context) : await (async () => {
        if (!this.deps.connectReadyServers) throw new Error('MCP host capabilities are unavailable');
        const servers = await this.deps.connectReadyServers(context); this.current(context);
        return this.acknowledged('session/reloadMcpServers', { sessionId: context.engineId, servers }, 'mcpRuntime');
      })();
      this.current(context);
      this.cachePrompts(context, runtimeServers(reply));
      await this.deps.onStatusChanged(context.cwd); return null;
    }));
  }
  revokeAuth(payload: JsonObject): Promise<Json> {
    return this.track(() => this.mutations.run(async (): Promise<Json> => {
      this.active(); const context = await this.deps.context(); this.bound(context);
      await this.cancelAuthorizations(context, string(payload.name)); this.current(context);
      const reply = await this.acknowledged('session/revokeMcpAuthorization', { sessionId: context.engineId, serverName: string(payload.name) }, 'mcpAuthorizationRevoked'); this.current(context);
      if (typeof reply.revoked !== 'boolean') throw new Error('Invalid MCP revoke outcome'); await this.deps.onStatusChanged(context.cwd);
      return { ok: reply.revoked, engine: { mcpAuthorizationRevoked: reply } };
    })).catch(error => ({ ok: false, error: errorMessage(error) }));
  }
  needsAuth(): Promise<Json> {
    return this.track(async () => {
      const context = await this.deps.context(); this.current(context);
      return [...this.authorizations.values()].filter(row => same(row.context, context) && !row.settling).map(row => ({ name: row.name, authorizationUrl: row.authorizationUrl, state: 'needs-auth' }));
    });
  }
  receiveAuthorization(request: JsonObject, context: McpRuntimeContext): Promise<void> {
    return this.track(async () => {
      this.bound(context); const requestId = string(request.requestId);
      if (!requestId) throw new Error('MCP authorization request has no requestId');
      const identity = key(context, requestId); if (this.authorizations.has(identity)) return;
      const row: PendingAuthorization = { context: { ...context }, requestId, name: string(request.serverName) || string(request.name), authorizationUrl: string(request.authorizationUrl), redirectUri: string(request.redirectUri), controller: new AbortController(), timer: undefined as never };
      row.timer = setTimeout(() => { row.controller.abort(); void this.settle(row, { kind: 'decline', reason: 'rust_mcp_oauth_timeout' }).catch(() => undefined); }, this.deps.authorizationTimeoutMs ?? 300_000);
      this.authorizations.set(identity, row);
      this.notifyStatus(context);
      const cancelled = [...this.liveAuthorizations.values()].some(flow => same(flow.context, context) && flow.name === row.name && flow.controller.signal.aborted);
      if (!row.name || !row.authorizationUrl || this.closed || cancelled) await this.settle(row, { kind: 'decline', reason: cancelled || this.closed ? 'rust_mcp_oauth_cancelled' : 'mcp_authorization_request_incomplete' });
      await this.deps.onStatusChanged(context.cwd);
    }, true);
  }
  private settle(row: PendingAuthorization, response: JsonObject): Promise<JsonObject> {
    if (row.settling) return row.settling;
    clearTimeout(row.timer);
    return row.settling = this.track(async () => {
      try {
        if (!this.deps.isCurrent(row.context)) return { accepted: false };
        const reply = await this.acknowledged('session/resolveMcpAuthorization', { sessionId: row.context.engineId!, requestId: row.requestId, response }, 'mcpAuthorizationResolved');
        if (reply.requestId !== row.requestId || typeof reply.accepted !== 'boolean') throw new Error('Invalid MCP authorization resolution'); return reply;
      } finally { if (!row.run) this.authorizations.delete(key(row.context, row.requestId)); }
    }, true);
  }
  private async waitReady(row: PendingAuthorization): Promise<void> {
    const deadline = Date.now() + (this.deps.authorizationTimeoutMs ?? 30_000);
    while (Date.now() < deadline) {
      if (row.controller.signal.aborted) throw new Error('MCP authorization cancelled'); this.current(row.context);
      const servers = await this.readRuntime(row.context); this.current(row.context);
      const server = servers.find(server => server.name === row.name);
      if (server?.state === 'ready') return;
      if (server && ['failed', 'closed', 'cancelled'].includes(string(server.state))) throw new Error(string(server.error) || 'MCP authorization did not connect the server');
      await new Promise<void>(resolve => {
        const done = (): void => { clearTimeout(timer); row.controller.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 50); row.controller.signal.addEventListener('abort', done, { once: true }); if (row.controller.signal.aborted) done();
      });
    }
    throw new Error('MCP authorization completed, but the server did not become ready');
  }
  private authenticatePending(row: PendingAuthorization): Promise<Json> {
    if (row.run) return row.run;
    return row.run = this.track(async (): Promise<Json> => {
      const captured = await captureMcpOAuthCode(row.authorizationUrl, row.redirectUri, row.controller.signal, this.deps.openExternal, this.deps.authorizationTimeoutMs);
      const reply = await this.settle(row, captured); this.current(row.context);
      try {
        if (captured.kind === 'code' && reply.accepted === true) { await this.waitReady(row); return { status: 'authenticated' }; }
        return { status: 'declined', authorizationUrl: row.authorizationUrl };
      } finally { await this.deps.onStatusChanged(row.context.cwd); }
    }).finally(() => { this.authorizations.delete(key(row.context, row.requestId)); });
  }
  private reconnectAuthorization(context: McpRuntimeContext, name: string): Promise<Json> {
    const identity = key(context, name), existing = this.liveAuthorizations.get(identity); if (existing) return existing.promise;
    const controller = new AbortController();
    const promise = this.track(async (): Promise<Json> => {
      // Configuration reload preserves unchanged clients. Explicit reauthentication
      // must use the engine's reconnect operation, while replies bypass that wait.
      let terminal: { reply?: JsonObject; error?: unknown } | undefined;
      const completion = this.acknowledged('session/reconnectMcpServer', { sessionId: context.engineId!, serverName: name }, 'mcpRuntime')
        .then(reply => { terminal = { reply }; }, error => { terminal = { error }; });
      const deadline = Date.now() + (this.deps.authorizationTimeoutMs ?? 300_000);
      try {
        while (!terminal && !controller.signal.aborted && Date.now() < deadline) {
          this.current(context);
          const row = [...this.authorizations.values()].find(row => same(row.context, context) && row.name === name);
          if (row) return await this.authenticatePending(row);
          await new Promise<void>(resolve => setTimeout(resolve, 10));
        }
        if (controller.signal.aborted) return { status: 'declined' };
        if (!terminal) throw new Error('MCP server reconnect did not finish authorization');
        if (terminal.error !== undefined) throw terminal.error;
        const server = runtimeServers(terminal.reply!).find(row => row.name === name);
        if (server?.state === 'ready') return { status: 'authenticated' };
        throw new Error(string(server?.error) || string(server?.failureReason) || 'MCP server did not become ready');
      } finally {
        controller.abort();
        const rows = [...this.authorizations.values()].filter(row => same(row.context, context) && row.name === name);
        for (const row of rows) row.controller.abort();
        await Promise.allSettled(rows.map(row => this.settle(row, { kind: 'decline', reason: 'rust_mcp_oauth_cancelled' })));
        await completion;
        this.liveAuthorizations.delete(identity);
        if (terminal?.error !== undefined) throw terminal.error;
      }
    });
    this.liveAuthorizations.set(identity, { context, name, controller, promise }); return promise;
  }
  authenticate(payload: JsonObject): Promise<Json> {
    return this.track(async (): Promise<Json> => {
      const context = await this.deps.context(); this.current(context); const name = string(payload.name);
      const live = this.liveAuthorizations.get(key(context, name)); if (live) return live.promise;
      const row = [...this.authorizations.values()].find(row => row.name === name && same(row.context, context));
      if (row) return this.authenticatePending(row);
      if (context.engineId) {
        this.bound(context); const reply = await this.query('session/mcpAuthorizationStatus', { sessionId: context.engineId, serverName: name }, 'mcpAuthorizationStatus'); this.current(context);
        if (['oAuth', 'oauth', 'bearerToken'].includes(string(reply.authStatus))) {
          // The engine credential store says a token exists, yet the live runtime
          // row can still sit in needs-auth: credentials the server now rejects
          // (revoked PAT, expired token) keep the row parked there. Answering
          // not-needed in that state makes the page toast a success while the
          // row, the switch and the dot never move — surface the mismatch so the
          // click reports a failure instead of a silent no-op.
          const servers = await this.visibleRuntime(context).catch(() => undefined);
          const row = servers?.find(server => string(server.name) === name);
          if (row && string(row.state) === 'needs-auth') return { status: 'failed', error: 'rust_mcp_credentials_rejected' };
          return { status: 'not-needed' };
        }
        if (reply.authStatus === 'notLoggedIn') return this.reconnectAuthorization(context, name);
      }
      const config = await this.deps.configuration.oauthServerConfig(name, context.cwd, this.deps.extraRoots?.(context.rendererId) ?? []); this.current(context);
      if (!config) return { status: 'unsupported' };
      const id = Symbol('mcp-host-auth'); this.hostAuthorizations.set(id, { context, config });
      try { const result = await this.deps.oauth.authenticate(config); this.current(context); await this.deps.onStatusChanged(context.cwd); return result; }
      finally { this.hostAuthorizations.delete(id); }
    }).catch(error => ({ status: 'failed', error: errorMessage(error) }));
  }
  private async cancelAuthorizations(context: McpRuntimeContext, name?: string): Promise<void> {
    const live = [...this.liveAuthorizations.values()].filter(flow => same(flow.context, context) && (name === undefined || flow.name === name));
    for (const flow of live) flow.controller.abort();
    const rows = [...this.authorizations.values()].filter(row => same(row.context, context) && (name === undefined || row.name === name));
    for (const row of rows) row.controller.abort();
    await Promise.allSettled([...rows.map(row => this.settle(row, { kind: 'decline', reason: 'rust_mcp_oauth_cancelled' })),
      ...[...this.hostAuthorizations.values()].filter(row => same(row.context, context) && (name === undefined || row.config.name === name)).map(row => this.deps.oauth.cancel(row.config))]);
    await Promise.allSettled(rows.flatMap(row => row.run ? [row.run] : []));
    await Promise.allSettled(live.map(flow => flow.promise));
  }
  async retire(context: McpRuntimeContext): Promise<void> {
    const identity = contextKey(context); this.retired.add(identity); this.runtimeSnapshots.delete(identity); this.notifyStatus(context);
    try { await this.cancelAuthorizations(context); await Promise.allSettled([this.runtimeReads.get(identity)]); }
    finally { this.runtimeSnapshots.delete(identity); if (context.rendererId) this.prompts.delete(context.rendererId); this.retired.delete(identity); }
  }
  close(): Promise<void> {
    if (this.closing) return this.closing; this.closed = true;
    for (const waiters of this.statusWaiters.values()) for (const resolve of waiters) resolve();
    for (const flow of this.liveAuthorizations.values()) flow.controller.abort();
    const rows = [...this.authorizations.values()]; for (const row of rows) row.controller.abort();
    return this.closing = (async () => {
      await Promise.allSettled([this.deps.oauth.close(), ...rows.map(row => this.settle(row, { kind: 'decline', reason: 'rust_mcp_oauth_cancelled' }))]);
      await Promise.allSettled([...this.pending]); await this.mutations.run(async () => {}); this.prompts.clear(); this.runtimeSnapshots.clear(); this.statusWaiters.clear(); this.retired.clear();
    })();
  }
}
