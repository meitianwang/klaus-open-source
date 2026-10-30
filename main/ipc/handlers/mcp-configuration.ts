import { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import { McpConfigurationService, type McpConfigurationDeps } from '../../services/mcp/configuration';

export const MCP_CONFIGURATION_CHANNELS = [
  'mcp:list', 'mcp:create', 'mcp:update', 'mcp:toggle', 'mcp:setToolEnabled', 'mcp:remove', 'mcp:import', 'mcp:session:status',
  'mcp:project:list', 'mcp:project:create', 'mcp:project:update', 'mcp:project:toggle', 'mcp:project:remove',
  'mcp:local:list', 'mcp:local:create', 'mcp:local:update', 'mcp:local:toggle', 'mcp:local:remove',
] as const;
export function registerMcpConfigurationHandlers(registry: ChannelRegistry, deps: McpConfigurationDeps & { mcp?: McpConfigurationService }): McpConfigurationService {
  const mcp = deps.mcp ?? new McpConfigurationService(deps);
  registry.register('mcp:list', () => mcp.list(), 'mcp-config');
  for (const method of ['create', 'update', 'toggle', 'setToolEnabled', 'remove'] as const) registry.register('mcp:' + method, ctx => mcp[method](object(ctx.args[0])), 'mcp-config');
  registry.register('mcp:import', ctx => mcp.importJson(object(ctx.args[0])), 'mcp-config');
  registry.register('mcp:session:status', ctx => mcp.sessionStatus(object(ctx.args[0])), 'mcp-config');
  for (const scope of ['project', 'local'] as const) {
    registry.register('mcp:' + scope + ':list', ctx => mcp.scopeList(scope, object(ctx.args[0])), 'mcp-config');
    for (const mutation of ['create', 'update', 'toggle', 'remove'] as const) registry.register('mcp:' + scope + ':' + mutation, ctx => mcp.scopeMutate(scope, mutation, object(ctx.args[0])), 'mcp-config');
  }
  return mcp;
}
