import { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import { ConnectorService, type ConnectorServiceDeps } from '../../services/connectors/service';

export const CONNECTOR_CHANNELS = ['connectors:list', 'connectors:toggle', 'connectors:setToolEnabled', 'connectors:status', 'connectors:preflight'] as const;
export function registerConnectorHandlers(registry: ChannelRegistry, deps: ConnectorServiceDeps & { service?: ConnectorService }): ConnectorService {
  const service = deps.service ?? new ConnectorService(deps);
  registry.register('connectors:list', () => service.list(), 'connectors');
  registry.register('connectors:status', () => service.status(), 'connectors');
  registry.register('connectors:toggle', context => service.toggle(object(context.args[0])), 'connectors');
  registry.register('connectors:setToolEnabled', context => service.setToolEnabled(object(context.args[0])), 'connectors');
  registry.register('connectors:preflight', context => service.preflight(object(context.args[0])), 'connectors');
  return service;
}
