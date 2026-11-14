import type { Json } from '../contract';
import { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import type { UpdateService } from '../../updater/service';

export const UPDATER_CHANNELS = ['updater:status', 'updater:check', 'updater:install'] as const;
export function registerUpdaterHandlers(registry: ChannelRegistry, service: UpdateService): void {
  registry.register('updater:status', () => service.snapshot() as unknown as Json, 'updater');
  // A person asking for a check is the only attempt allowed to produce a visible
  // result notice; the background cadence calls the service without the flag.
  registry.register('updater:check', async context => {
    const args = object(context.args[0]);
    return await service.check({
      explicit: args.explicit === true,
      download: args.download === true,
    }) as unknown as Json;
  }, 'updater');
  registry.register('updater:install', async () => await service.install() as unknown as Json, 'updater');
}