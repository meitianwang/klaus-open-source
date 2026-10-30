import type { ChannelRegistry } from '../registry';
import { DiscordAccessService, type DiscordAccessDeps } from '../../services/channels/discord-access';
import { object } from '../../services/service-types';

export const DISCORD_ACCESS_CHANNELS = [
  'channels:discord:access', 'channels:discord:setDmPolicy', 'channels:discord:approvePending',
  'channels:discord:denyPending', 'channels:discord:addAllowFrom', 'channels:discord:removeAllowFrom',
  'channels:discord:upsertGroup', 'channels:discord:removeGroup', 'channels:discord:updateDelivery',
] as const;

export function registerDiscordAccessHandlers(registry: ChannelRegistry, deps: DiscordAccessDeps & { service?: DiscordAccessService }): DiscordAccessService {
  const service = deps.service ?? new DiscordAccessService(deps);
  registry.register('channels:discord:access', () => service.access(), 'discord-access');
  registry.register('channels:discord:setDmPolicy', context => service.setDmPolicy(object(context.args[0])), 'discord-access');
  registry.register('channels:discord:approvePending', context => service.approvePending(object(context.args[0])), 'discord-access');
  registry.register('channels:discord:denyPending', context => service.denyPending(object(context.args[0])), 'discord-access');
  registry.register('channels:discord:addAllowFrom', context => service.addAllowFrom(object(context.args[0])), 'discord-access');
  registry.register('channels:discord:removeAllowFrom', context => service.removeAllowFrom(object(context.args[0])), 'discord-access');
  registry.register('channels:discord:upsertGroup', context => service.upsertGroup(object(context.args[0])), 'discord-access');
  registry.register('channels:discord:removeGroup', context => service.removeGroup(object(context.args[0])), 'discord-access');
  registry.register('channels:discord:updateDelivery', context => service.updateDelivery(object(context.args[0])), 'discord-access');
  return service;
}
