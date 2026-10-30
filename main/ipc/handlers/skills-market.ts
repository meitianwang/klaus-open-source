import { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import type { SkillMarketService } from '../../skills-market/service';

export const SKILL_MARKET_CHANNELS = ['skills:install', 'skills:install-from-source', 'skills:market', 'skills:update', 'skills:upload'] as const;
export function registerSkillMarketHandlers(registry: ChannelRegistry, service: SkillMarketService): void {
  registry.register('skills:install', ctx => service.install(object(ctx.args[0])), 'skills-market');
  registry.register('skills:install-from-source', ctx => service.installFromSource(object(ctx.args[0])), 'skills-market');
  registry.register('skills:market', ctx => service.market(object(ctx.args[0])), 'skills-market');
  registry.register('skills:update', ctx => service.update(object(ctx.args[0])), 'skills-market');
  registry.register('skills:upload', ctx => service.upload(object(ctx.args[0])), 'skills-market');
}
