import { isAbsolute } from 'node:path';
import type { BrowserWindow } from 'electron';
import type { ClientEvent } from '../engine/protocol';
import { requestAcknowledged } from '../engine/acknowledged';
import { object } from '../ipc/arguments';
import type { Json } from '../ipc/contract';
import { IpcHandlerError, type ChannelRegistry } from '../ipc/registry';
import { registerMcpRuntimeHandlers } from '../ipc/handlers/mcp-runtime';
import type { NativeSubscriptionCredentials } from '../native/credentials';
import type { HostState } from '../services/host-state';
import type { WorkspaceStore } from '../services/workspaces';
import type { McpConfigurationService } from '../services/mcp/configuration';
import { McpOAuthService } from '../services/mcp/oauth';
import type { McpRuntimeContext } from '../services/mcp/runtime';
import { kvGet } from '../services/settings';
import type { SessionService } from '../sessions/service';
import { isTrustedAppUrl } from './trusted-origin';

export function createMcpRuntime(window: BrowserWindow, registry: ChannelRegistry, deps: {
  configRoot: string; sessions: SessionService; state: HostState; workspaces: WorkspaceStore;
  configuration: McpConfigurationService; credentials: NativeSubscriptionCredentials;
  openExternal(url: string): Promise<void>; emit(channel: string, payload: Json): void;
  log(kind: string, message: string): void;
}) {
  const { sessions, state, workspaces } = deps;
  const retiring = new Map<string, number>(), pending = new Set<Promise<unknown>>();
  const ownerKey = (engineId: string, generation: number): string => JSON.stringify([generation, engineId]);
  const bindingContext = (rendererId: string, engineId: string, generation: number): McpRuntimeContext => ({
    rendererId, engineId, generation, cwd: state.resourceRoots(rendererId)[0] ?? workspaces.resolveSessionDirectory(rendererId),
  });
  const isCurrent = (context: McpRuntimeContext): boolean => {
    const engine = sessions.engine();
    if (context.engineId) return !!engine && !engine.client.isClosed() && engine.generation === context.generation
      && !!context.rendererId && state.liveSession(context.rendererId) === context.engineId
      && bindingContext(context.rendererId, context.engineId, engine.generation).cwd === context.cwd;
    return !context.rendererId || !state.liveSession(context.rendererId);
  };
  const context = async (): Promise<McpRuntimeContext> => {
    if (window.isDestroyed() || !isTrustedAppUrl(window.webContents.getURL())) throw new IpcHandlerError('WINDOW_UNAVAILABLE', 'The application window is unavailable');
    const id: unknown = await window.webContents.executeJavaScript('window.currentSessionId ?? null');
    const rendererId = typeof id === 'string' && id.length > 0 && id.length <= 4096 ? id : undefined;
    const engineId = rendererId && state.liveSession(rendererId), generation = sessions.engine()?.generation;
    if (rendererId && engineId && generation !== undefined) return bindingContext(rendererId, engineId, generation);
    const active = kvGet('workspace.active_root', deps.configRoot);
    return { ...(rendererId ? { rendererId } : {}), cwd: rendererId ? workspaces.resolveSessionDirectory(rendererId)
      : typeof active === 'string' && isAbsolute(active) ? active : deps.configRoot };
  };
  const service = registerMcpRuntimeHandlers(registry, {
    configuration: deps.configuration,
    oauth: new McpOAuthService({ credentials: deps.credentials, openExternal: deps.openExternal }),
    context, isCurrent,
    reloadServers: async captured => {
      if (!captured.rendererId || !captured.engineId || captured.generation === undefined || !isCurrent(captured)) throw new IpcHandlerError('STALE_SESSION', 'The MCP conversation binding changed');
      return sessions.reloadMcpRuntime(captured.rendererId, captured.engineId, captured.generation);
    },
    request: (method, params) => sessions.request(method, object(params) ?? {}, 60_000),
    // Authorization replies must enter the engine while a reload owns the session gate.
    requestAcknowledged: async (method, params, field) => requestAcknowledged(await sessions.client(), method, params, field, 60_000),
    openExternal: deps.openExternal,
    extraRoots: id => (id ? workspaces.extraRoots(id) : []),
    onStatusChanged: cwd => { deps.emit('mcp:status:updated', { cwd: cwd ?? null }); },
  });
  const report = (action: Promise<unknown>): void => {
    pending.add(action);
    void action.catch(() => { deps.log('mcp-authorization', 'An authorization owner could not finish its lifecycle operation'); }).finally(() => { pending.delete(action); });
  };
  return {
    service,
    retire: (id: string, engineId: string, generation: number) => service.retire(bindingContext(id, engineId, generation)),
    async beginClosing(id: string, engineId: string, generation: number): Promise<() => void> {
      const key = ownerKey(engineId, generation);
      retiring.set(key, (retiring.get(key) ?? 0) + 1);
      const release = (): void => { const count = retiring.get(key) ?? 0; if (count <= 1) retiring.delete(key); else retiring.set(key, count - 1); };
      try { await service.retire(bindingContext(id, engineId, generation)); return release; }
      catch (error) { release(); throw error; }
    },
    receive(event: ClientEvent, generation: number): void {
      if (sessions.engine()?.generation !== generation) return;
      if (event.type === 'streamClosed') {
        for (const binding of state.bindings()) report(service.retire(bindingContext(binding.rendererId, binding.engineId, generation)));
        return;
      }
      if (event.type !== 'rawSessionEvent' && event.type !== 'engineEvent') return;
      const params = object(event.params), envelope = object(params?.event) ?? params, auth = object(envelope?.mcpAuthorization);
      if (!auth || typeof auth.requestId !== 'string' || !auth.requestId) return;
      const engineId = typeof params?.sessionId === 'string' ? params.sessionId : undefined;
      const binding = engineId && state.bindings().find(row => row.engineId === engineId);
      if (binding && !retiring.has(ownerKey(binding.engineId, generation))) report(service.receiveAuthorization(auth, bindingContext(binding.rendererId, binding.engineId, generation)));
      else if (engineId) report((async () => requestAcknowledged(await sessions.client(), 'session/resolveMcpAuthorization', {
        sessionId: engineId, requestId: auth.requestId!, response: {kind:'decline',reason:'desktop_session_unavailable'},
      }, 'mcpAuthorizationResolved', 15_000))());
    },
    async close(): Promise<void> { await service.close(); while (pending.size) await Promise.allSettled([...pending]); retiring.clear(); },
  };
}
