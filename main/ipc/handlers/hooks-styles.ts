import { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import { HookStyleService, type HookStyleDeps } from '../../services/extensions/hooks-styles';

export const HOOK_STYLE_CHANNELS = ['settings:hooks:get', 'settings:hooks:set', 'settings:hooks:trust', 'settings:hooks:enabled', 'klaus:hooks:get', 'klaus:hooks:set', 'settings:output-styles:list', 'settings:output-styles:set'] as const;
export function registerHookStyleHandlers(registry: ChannelRegistry, deps: HookStyleDeps & { hooksStyles?: HookStyleService }): HookStyleService {
  const service = deps.hooksStyles ?? new HookStyleService(deps);
  registry.register('settings:hooks:get', () => service.hooksGet({}, true), 'hooks-styles');
  registry.register('settings:hooks:set', ctx => service.hooksSet(object(ctx.args[0]), true), 'hooks-styles');
  registry.register('settings:hooks:trust', ctx => service.hooksTrustSet(object(ctx.args[0])), 'hooks-styles');
  registry.register('settings:hooks:enabled', ctx => service.hooksEnabledSet(object(ctx.args[0])), 'hooks-styles');
  registry.register('klaus:hooks:get', ctx => service.hooksGet(object(ctx.args[0])), 'hooks-styles');
  registry.register('klaus:hooks:set', ctx => service.hooksSet(object(ctx.args[0])), 'hooks-styles');
  registry.register('settings:output-styles:list', () => service.outputStylesList(), 'hooks-styles');
  registry.register('settings:output-styles:set', ctx => service.outputStylesSet(object(ctx.args[0])), 'hooks-styles');
  return service;
}
