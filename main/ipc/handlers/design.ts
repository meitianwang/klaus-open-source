import type { Json } from '../contract';
import type { ChannelRegistry, HandlerContext } from '../registry';

/** The service checks design canvas ownership before opening a view or transport. */
export function registerDesignHandlers(registry: ChannelRegistry, deps: { service: { invoke(context: HandlerContext): Promise<Json> | Json } }): void {
  for (const channel of ['design:list', 'design:open', 'design:open-result', 'design:panel-show', 'design:panel-set-bounds', 'design:panel-hide', 'design:panel-close', 'design:transport-ready', 'design:chat-request', 'design:chat-result', 'design:save-file']) {
    registry.register(channel, async context => {
      try { return await deps.service.invoke(context); }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }, 'design');
  }
}
