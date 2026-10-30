import type { Json } from '../contract';
import type { ChannelRegistry, HandlerContext } from '../registry';

/** The service validates document ownership and runtime action payloads. */
export function registerPrototypeHandlers(registry: ChannelRegistry, deps: {
  service: { invoke(context: HandlerContext): Promise<Json> | Json };
}): void {
  for (const channel of [
    'prototype:list', 'prototype:open', 'prototype:open-result',
    'prototype:panel-show', 'prototype:panel-set-bounds',
    'prototype:panel-hide', 'prototype:panel-close', 'prototype:runtime-action',
  ]) {
    registry.register(channel, async context => {
      try { return await deps.service.invoke(context); }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }, 'prototype');
  }
}
