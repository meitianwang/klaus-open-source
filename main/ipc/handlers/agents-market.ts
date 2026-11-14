import { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import type { AgentMarketService } from '../../agents-market/service';

/**
 * The sub-agent plaza's two channels. Uninstall is deliberately absent: an
 * installed agent is an ordinary user file, so the existing
 * `agents:definitions:delete` remains the only removal path and there is one
 * trash behaviour to reason about rather than two.
 */
export const AGENT_MARKET_CHANNELS = ['agents:market', 'agents:install', 'agents:cancel'] as const;

export function registerAgentMarketHandlers(registry: ChannelRegistry, service: AgentMarketService): void {
  registry.register('agents:market', ctx => service.market(object(ctx.args[0])), 'agents-market');
  registry.register('agents:install', ctx => service.install(object(ctx.args[0])), 'agents-market');
  registry.register('agents:cancel', ctx => service.cancel(object(ctx.args[0])), 'agents-market');
}
