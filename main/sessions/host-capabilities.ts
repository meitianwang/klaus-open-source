import type { Json } from '../ipc/contract';
import { object } from '../ipc/arguments';
import { IpcHandlerError } from '../ipc/registry';

/** Configured servers and task-bound host servers must share one unambiguous namespace. */
export function combineHostCapabilities(declarations: Json[], managed: Json[]): Record<string, Json> {
  const names = new Set<string>(), roots = new Set<string>();
  const mcpServers: Json[] = [], runtimeCapabilityRoots: Json[] = [];
  for (const capability of [{ mcpServers: declarations }, ...managed]) {
    const value = object(capability);
    if (!value || !Array.isArray(value.mcpServers)) throw new IpcHandlerError('INVALID_HOST_CAPABILITY', 'Invalid MCP capability declaration');
    for (const server of value.mcpServers) {
      const name = object(server)?.name;
      if (typeof name !== 'string' || !name) throw new IpcHandlerError('INVALID_HOST_CAPABILITY', 'An MCP server requires a name');
      if (names.has(name)) throw new IpcHandlerError('MCP_NAME_CONFLICT', 'Configured MCP server conflicts with another capability: ' + name);
      names.add(name); mcpServers.push(server);
    }
    for (const root of Array.isArray(value.runtimeCapabilityRoots) ? value.runtimeCapabilityRoots : []) {
      const id = object(root)?.id;
      if (typeof id !== 'string' || !id || roots.has(id)) throw new IpcHandlerError('INVALID_HOST_CAPABILITY', 'Invalid or duplicate runtime capability root');
      roots.add(id); runtimeCapabilityRoots.push(root);
    }
  }
  return { mcpServers, runtimeCapabilityRoots };
}

export interface HostCapabilityBinding {
  rendererId: string;
  stale: boolean;
}

export interface HostCapabilityRefreshOutcome {
  rendererId: string;
  status: 'reloaded' | 'deferred' | 'failed';
  error?: unknown;
}

/**
 * Refresh idle bindings without redefining a durable settings write as failed.
 * A running or stale task keeps its current capability snapshot; a new task will
 * start from the saved configuration.
 */
export async function refreshIdleHostCapabilities(
  bindings: HostCapabilityBinding[],
  isWorking: (rendererId: string) => boolean,
  reload: (rendererId: string) => Promise<boolean>,
): Promise<HostCapabilityRefreshOutcome[]> {
  return Promise.all(bindings.map(async binding => {
    if (binding.stale || isWorking(binding.rendererId)) {
      return { rendererId: binding.rendererId, status: 'deferred' as const };
    }
    try {
      const reloaded = await reload(binding.rendererId);
      return { rendererId: binding.rendererId, status: reloaded ? 'reloaded' as const : 'deferred' as const };
    } catch (error) {
      return { rendererId: binding.rendererId, status: 'failed' as const, error };
    }
  }));
}
