import type { ComputerHistoryService } from '../../services/computer-history/service';
import type { Json } from '../contract';
import { ChannelRegistry } from '../registry';
import { arg0 } from '../binary';

/** Settings-window channels for the local environment-history surface. */
export function registerComputerHistorySettingsHandlers(registry: ChannelRegistry, service: ComputerHistoryService): void {
  registry.registerAll({
    'settings:computer-history:get': () => service.snapshot() as unknown as Json,
    'settings:computer-history:set-enabled': async context => await service.setEnabled(arg0(context.args)) as unknown as Json,
    'settings:computer-history:pause': async () => await service.pause() as unknown as Json,
    'settings:computer-history:resume': async () => await service.resume() as unknown as Json,
    'settings:computer-history:update-observation': context => service.updateObservationPolicy(arg0(context.args)) as unknown as Json,
    'settings:computer-history:remove-observation-entry': context => service.removeObservationEntry(arg0(context.args)) as unknown as Json,
    'settings:computer-history:clear-history': context => service.clearHistory(arg0(context.args)) as unknown as Json,
    'settings:computer-history:entries': context => service.entries(arg0(context.args)) as unknown as Json,
  }, 'computer-history-settings');
}
