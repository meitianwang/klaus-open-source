import type { CanvasService } from '../../canvas/service';
import { message } from '../../visuals/data';
import type { ChannelRegistry, HandlerContext } from '../registry';

export function registerCanvasHandlers(registry: ChannelRegistry, deps: { service: CanvasService; serviceFor?(context: HandlerContext): CanvasService }): void {
  for (const channel of ['canvas:list','canvas:open','canvas:open-result','canvas:load','canvas:action','canvas:state-write','canvas:send-to-chat','canvas:panel-show','canvas:panel-set-bounds','canvas:panel-hide','canvas:panel-close']) {
    registry.register(channel, async context => {
      try { return await (deps.serviceFor?.(context) ?? deps.service).invoke(context); }
      catch (error) { return { ok: false, error: message(error) }; }
    }, 'canvas');
  }
}
