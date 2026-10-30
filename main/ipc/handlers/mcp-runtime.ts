import { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import { McpRuntimeService, type McpRuntimeDeps } from '../../services/mcp/runtime';

export const MCP_RUNTIME_CHANNELS = ['mcp:status', 'mcp:reconnect', 'mcp:revokeAuth', 'mcp:klaus:needs-auth', 'mcp:klaus:authenticate'] as const;
export function registerMcpRuntimeHandlers(registry: ChannelRegistry, deps: McpRuntimeDeps & { runtime?: McpRuntimeService }): McpRuntimeService {
  const runtime = deps.runtime ?? new McpRuntimeService(deps);
  registry.register('mcp:status', () => runtime.status(), 'mcp-runtime');
  registry.register('mcp:reconnect', () => runtime.reconnect(), 'mcp-runtime');
  registry.register('mcp:revokeAuth', context => runtime.revokeAuth(object(context.args[0])), 'mcp-runtime');
  registry.register('mcp:klaus:needs-auth', () => runtime.needsAuth(), 'mcp-runtime');
  registry.register('mcp:klaus:authenticate', context => runtime.authenticate(object(context.args[0])), 'mcp-runtime');
  return runtime;
}
