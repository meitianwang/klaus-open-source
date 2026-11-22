import type { Json } from '../contract';
import type { ChannelRegistry, HandlerContext } from '../registry';

/** Validates workspace ownership, window attribution, and isolated runtime payloads. */
export function registerPhotoEditingHandlers(registry: ChannelRegistry, deps: {
  service: { invoke(context: HandlerContext): Promise<Json> | Json };
}): void {
  for (const channel of [
    'photo-editing:list',
    'photo-editing:open',
    'photo-editing:open-result',
    'photo-editing:panel-show',
    'photo-editing:panel-set-bounds',
    'photo-editing:panel-hide',
    'photo-editing:panel-close',
    'photo-editing:runtime-action',
  ]) {
    registry.register(channel, async context => {
      try {
        return await deps.service.invoke(context);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }, 'photo-editing');
  }
}
