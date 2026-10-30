import { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import type { PluginMarketplaceService } from '../../services/extensions/marketplaces';

export const PLUGIN_MARKETPLACE_CHANNELS = ['plugins:marketplace:add', 'plugins:refresh'] as const;
export function registerPluginMarketplaceHandlers(registry: ChannelRegistry, service: PluginMarketplaceService): void {
  registry.register('plugins:marketplace:add', ctx => service.add(object(ctx.args[0])), 'plugin-marketplaces');
  registry.register('plugins:refresh', ctx => service.refresh(object(ctx.args[0])), 'plugin-marketplaces');
}
