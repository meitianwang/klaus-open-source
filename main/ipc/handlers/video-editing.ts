import type { Json } from '../contract';
import type { ChannelRegistry, HandlerContext } from '../registry';

export function registerVideoEditingHandlers(registry: ChannelRegistry, deps: {
  service: { invoke(context: HandlerContext): Promise<Json> | Json };
}): void {
  for (const channel of [
    'video-editing:list', 'video-editing:open', 'video-editing:open-result',
    'video-editing:panel-show', 'video-editing:panel-set-bounds',
    'video-editing:panel-hide', 'video-editing:panel-close', 'video-editing:runtime-action',
  ]) registry.register(channel, async context => {
    // Runtime callbacks must reject failed operations so the live editor cannot acknowledge a failed save.
    if (channel === 'video-editing:runtime-action') return deps.service.invoke(context);
    try { return await deps.service.invoke(context); }
    catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
  }, 'video-editing');
}
