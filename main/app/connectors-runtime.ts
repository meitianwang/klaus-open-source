import { isAbsolute } from 'node:path';
import type { Json } from '../ipc/contract';
import type { ChannelRegistry } from '../ipc/registry';
import { registerConnectorHandlers } from '../ipc/handlers/connectors';
import { MacOsConnectors } from '../services/macos-connectors/service';
import type { MacOsCommands } from '../native/macos-command';
import { CONNECTOR_CATALOG } from '../services/connectors/catalog';
import { HostMcpServer } from '../services/mcp/host-server';
import type { PermissionRules } from '../services/permission-rules';
import { isFailure, kvGet } from '../services/settings';

interface Owner { retiring: boolean; closing?: Promise<void> }

/** Native app tools use the same task-bound MCP transport and engine permission rules as other host tools. */
export function createConnectorsRuntime(registry: ChannelRegistry, deps: {
  configRoot: string; userHome: string; platform?: NodeJS.Platform; commands?: MacOsCommands;
  permissionRules(): Promise<PermissionRules>; runtimeActive(): Promise<boolean>; runtimeStatus(): Promise<unknown>;
  currentTurn(sessionId: string): string | undefined; directory(sessionId: string): Promise<string>;
  guardInteraction(sessionId: string, signal: AbortSignal): Promise<void>;
  /** A connector question died without a user answer; the card must close. */
  onElicitationCancelled?(sessionId: string, requestId: string): void;
  onChanged(): Promise<void>; log(kind: string, detail: string): void;
}) {
  let closed = false, shutdownFlight: Promise<void> | undefined;
  const macos = new MacOsConnectors(deps), owners = new Map<string, Owner>(), servers = new Map<string, HostMcpServer>();
  const setting = (key: string): string => { const value = kvGet(key, deps.configRoot); if (isFailure(value)) throw new Error(value.message); return value ?? ''; };
  const enabled = (id: string): boolean => !closed && setting('connector:' + id + ':enabled') === '1';
  const disabled = (id: string): Set<string> => new Set(setting('connector:' + id + ':disabled-tools').split(',').map(value => value.trim()).filter(Boolean));
  const tools = (id: string) => { const denied = disabled(id); return macos.tools(id).filter(tool => !denied.has(tool.name)); };
  for (const entry of CONNECTOR_CATALOG) {
    const id = entry.id;
    if (!macos.tools(id).length || entry.platform !== (deps.platform ?? process.platform)) continue;
    servers.set(id, new HostMcpServer({
      name: 'klaus-' + id, enabled: () => enabled(id), tools: () => tools(id), currentTurn: deps.currentTurn,
      onElicitationCancelled: (sessionId, requestId) => deps.onElicitationCancelled?.(sessionId, requestId),
      log: (event, detail) => deps.log('connector-mcp', JSON.stringify({ connector: id, event, ...detail })),
      call: async (name, args, context) => {
        const assertCurrent = (): void => {
          context.assertCurrent(); if (!enabled(id) || disabled(id).has(name)) throw new Error('This connector tool is disabled');
        };
        assertCurrent(); const directory = await deps.directory(context.sessionId); assertCurrent();
        return macos.call(id, name, args, { ...context, assertCurrent, ...(isAbsolute(directory) ? { workdir: directory } : {}) });
      },
    }));
  }
  const service = registerConnectorHandlers(registry, {
    ...deps, capability: id => macos.capability(id),
    onChanged: async () => { await refresh(); await deps.onChanged(); },
  });
  async function releaseSession(id: string): Promise<void> {
    const owner = owners.get(id); if (!owner) return;
    if (owner.closing) return owner.closing;
    owner.retiring = true;
    const task = (async () => {
      const results = await Promise.allSettled([...servers.values()].map(server => server.releaseSession(id)));
      const report = await macos.detachSession(id);
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
      if (!report.complete) errors.push(new Error('Native app operations did not finish closing'));
      if (errors.length) throw new AggregateError(errors, 'Connector conversation cleanup is incomplete');
      if (owners.get(id) === owner) owners.delete(id);
    })();
    owner.closing = task;
    void task.finally(() => { if (owner.closing === task) owner.closing = undefined; }).catch(() => {});
    return task;
  }
  async function refresh(): Promise<void> {
    const results = await Promise.allSettled([...servers].filter(([id]) => !enabled(id)).flatMap(([, server]) => [...owners.keys()].map(id => server.releaseSession(id))));
    if (![...servers.keys()].some(enabled)) await Promise.all([...owners.keys()].map(releaseSession));
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, 'Disabled connector operations did not finish closing');
  }
  return {
    service,
    async hostCapabilities(id: string): Promise<Record<string, Json>> {
      if (closed) throw new Error('The connector runtime is closed');
      const selected = (await service.enabledConnectors()).filter(entry => servers.has(entry.id));
      if (!selected.length) { await releaseSession(id); return { mcpServers: [], runtimeCapabilityRoots: [] }; }
      if (owners.get(id)?.retiring) await releaseSession(id);
      if (!owners.has(id)) { macos.attachSession(id); owners.set(id, { retiring: false }); }
      const owner = owners.get(id)!;
      const mcpServers: Json[] = [];
      try {
        for (const entry of selected) {
          if (!await macos.capability(entry.id)) throw new Error('The enabled connector is unavailable: ' + entry.id);
          const capabilities = await servers.get(entry.id)!.hostCapabilities(id);
          for (const server of capabilities.mcpServers as Record<string, Json>[]) mcpServers.push({ ...server, disabledTools: entry.disabledTools });
        }
        if (closed || owner.retiring || owners.get(id) !== owner) throw new Error('The connector conversation closed during startup');
        return { mcpServers, runtimeCapabilityRoots: [] };
      } catch (error) { await releaseSession(id).catch(failure => deps.log('connector-startup', String(failure))); throw error; }
    },
    releaseSession,
    async connectionLost(): Promise<void> { await Promise.all([...owners.keys()].map(releaseSession)); },
    shutdown(): Promise<void> {
      closed = true;
      return shutdownFlight ??= (async () => {
        const results = await Promise.allSettled([service.close(), ...[...servers.values()].map(server => server.shutdown()), ...[...owners.keys()].map(releaseSession)]);
        const native = await macos.close();
        const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
        if (!native.complete) errors.push(new Error('Native app connector resources did not finish closing'));
        if (errors.length) throw new AggregateError(errors, 'Connector shutdown is incomplete');
      })();
    },
    counts: () => ({ owners: owners.size, transports: [...servers.values()].map(server => server.counts()) }),
  };
}
