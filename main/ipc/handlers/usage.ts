import type { ChannelRegistry } from '../registry';
import type { UsageService } from '../../services/usage';
import { object, string } from '../../services/service-types';

export function registerUsageHandlers(registry: ChannelRegistry, service: UsageService): void {
  registry.register('usage:subscriptions', ctx => {
    const arg = object(ctx.args[0]);
    const sessionId = string(arg.sessionId) || undefined;
    return arg.force === true ? service.query(sessionId, { force: true }) : service.query(sessionId);
  }, 'usage');
}
