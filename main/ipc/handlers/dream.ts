import type { ChannelRegistry } from '../registry';
import type { DreamService } from '../../services/dream';
import { object } from '../../services/service-types';

export function registerDreamHandlers(registry: ChannelRegistry, service: DreamService): void {
  registry.registerAll({
    'dream:config-get': () => service.configGet(), 'dream:config-set': context => service.configSet(object(context.args[0])),
    'dream:current': () => service.current(), 'dream:list': context => service.list(object(context.args[0])),
    'dream:detail': context => service.detail(object(context.args[0])), 'dream:stop': context => service.stop(object(context.args[0])),
    'dream:trigger-now': () => service.triggerNow(),
  }, 'dream');
}
