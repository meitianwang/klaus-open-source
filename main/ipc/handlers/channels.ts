import type { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import { ChannelService, type ChannelServiceDeps } from '../../services/channels/service';

export const CHANNEL_SERVICE_CHANNELS = ['channels:list', 'channels:connect', 'channels:disconnect'] as const;
export function registerChannelHandlers(registry: ChannelRegistry, deps: ChannelServiceDeps & { service?: ChannelService }): ChannelService {
  const service = deps.service ?? new ChannelService(deps);
  registry.register('channels:list', () => service.list(), 'channels');
  registry.register('channels:connect', context => service.connect(object(context.args[0]), context.signal), 'channels');
  registry.register('channels:disconnect', context => service.disconnect(object(context.args[0])), 'channels');
  return service;
}
