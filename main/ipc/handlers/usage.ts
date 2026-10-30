import type { ChannelRegistry } from '../registry';
import type { UsageService } from '../../services/usage';
import { object, string } from '../../services/service-types';

export function registerUsageHandlers(registry: ChannelRegistry, service: UsageService): void {
  registry.register('usage:subscriptions', ctx => service.query(string(object(ctx.args[0]).sessionId) || undefined), 'usage');
}
