import type { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import type { McpDeviceService } from '../../services/mcp/device';

export const MCP_DEVICE_CHANNELS = ['mcp:device:client-id', 'mcp:device:start', 'mcp:device:wait', 'mcp:device:cancel'] as const;

export function registerMcpDeviceHandlers(registry: ChannelRegistry, service: McpDeviceService): void {
  registry.register('mcp:device:client-id', ctx => service.clientId(object(ctx.args[0])), 'mcp-device');
  registry.register('mcp:device:start', ctx => service.start(object(ctx.args[0])), 'mcp-device');
  registry.register('mcp:device:wait', ctx => service.wait(object(ctx.args[0])), 'mcp-device');
  registry.register('mcp:device:cancel', ctx => service.cancel(object(ctx.args[0])), 'mcp-device');
}
