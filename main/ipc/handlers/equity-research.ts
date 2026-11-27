import type { Json } from '../contract';
import type { ChannelRegistry, HandlerContext } from '../registry';

/** Validates workspace ownership, window attribution, and isolated runtime payloads. */
export function registerEquityResearchHandlers(registry: ChannelRegistry, deps: {
  service: { invoke(context: HandlerContext): Promise<Json> | Json };
}): void {
  for (const channel of [
    'equity-research:list',
    'equity-research:open',
    'equity-research:open-result',
    'equity-research:panel-show',
    'equity-research:panel-set-bounds',
    'equity-research:panel-hide',
    'equity-research:panel-close',
    'equity-research:runtime-action',
  ]) {
    registry.register(channel, async context => {
      try {
        return await deps.service.invoke(context);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }, 'equity-research');
  }
}
