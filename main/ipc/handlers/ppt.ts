import type { Json } from '../contract';
import type { ChannelRegistry, HandlerContext } from '../registry';

/** The service checks presentation ownership before opening a view or transport. */
export function registerPptHandlers(registry: ChannelRegistry, deps: { service: { invoke(context: HandlerContext): Promise<Json> | Json } }): void {
  for (const channel of ['ppt:list', 'ppt:open', 'ppt:open-result', 'ppt:panel-show', 'ppt:panel-set-bounds', 'ppt:panel-hide', 'ppt:panel-close', 'ppt:transport-ready', 'ppt:chat-request', 'ppt:chat-result', 'ppt:save-file']) {
    registry.register(channel, async context => {
      try { return await deps.service.invoke(context); }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    }, 'ppt');
  }
}
