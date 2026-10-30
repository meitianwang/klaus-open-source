import { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import { PermissionRulesService, type PermissionRulesDeps } from '../../services/permission-rules';

export const PERMISSION_RULE_CHANNELS = ['permission:rules:list', 'permission:rules:add', 'permission:rules:delete'] as const;
export function registerPermissionRuleHandlers(registry: ChannelRegistry, deps: PermissionRulesDeps & { service?: PermissionRulesService }): PermissionRulesService {
  const service = deps.service ?? new PermissionRulesService(deps);
  registry.register('permission:rules:list', () => service.list(), 'permission-rules');
  registry.register('permission:rules:add', context => service.add(object(context.args[0])), 'permission-rules');
  registry.register('permission:rules:delete', context => service.remove(object(context.args[0])), 'permission-rules');
  return service;
}
