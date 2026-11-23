import type { Json } from '../contract';
import type { ChannelRegistry, HandlerContext } from '../registry';

/** Validates workspace ownership, window attribution, and isolated runtime payloads. */
export function registerMotionGraphicsHandlers(registry: ChannelRegistry, deps: {
  service: { invoke(context: HandlerContext): Promise<Json> | Json };
}): void {
  for (const channel of [
    'motion-graphics:list',
    'motion-graphics:open',
    'motion-graphics:open-result',
    'motion-graphics:panel-show',
    'motion-graphics:panel-set-bounds',
    'motion-graphics:panel-hide',
    'motion-graphics:panel-close',
    'motion-graphics:runtime-action',
  ]) {
    registry.register(channel, async context => {
      try {
        return await deps.service.invoke(context);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    }, 'motion-graphics');
  }
}
