import type { PipService } from '../../services/pip';
import type { Json } from '../contract';
import { ChannelRegistry } from '../registry';
import { arg0 } from '../binary';

export function registerPipHandlers(registry: ChannelRegistry, service: PipService): void {
  registry.registerAll({
    'computer-use-pip:get-state': context => service.getState(context.senderId) as unknown as Json,
    'computer-use-pip:set-visibility': context => service.setVisibility(context.senderId, arg0(context.args)) as unknown as Json,
    'computer-use-pip:set-host-layout': context => service.setHostLayout(context.senderId, arg0(context.args)),
  }, 'computer-use-pip');
}
