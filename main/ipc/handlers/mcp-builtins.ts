import type { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import type { McpBuiltinService } from '../../services/mcp/builtins';
import type { McpDiagnosticsService } from '../../services/mcp/diagnostics';

export function registerMcpBuiltinHandlers(registry: ChannelRegistry, builtins: McpBuiltinService, diagnostics: McpDiagnosticsService): void {
  registry.registerAll({
    'mcp:builtin:list': () => builtins.list(),
    'mcp:builtin:install': context => builtins.install(object(context.args[0])),
    'mcp:uv:check': () => builtins.uvCheck(),
    'mcp:diagnose:bundle': context => diagnostics.bundle(object(context.args[0])),
    // Project MCP pre-connection trust was retired; these legacy UI declarations
    // deliberately preserve their existing no-op contract and create no rule store.
    'mcp:trust:decide': () => ({ ok: true }),
    'mcp:trust:reset': () => ({ ok: true }),
  }, 'mcp-catalog');
}
