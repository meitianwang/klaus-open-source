import type { Json } from '../contract';
import { ChannelRegistry } from '../registry';
import type { UpdateService } from '../../updater/service';

export const UPDATER_CHANNELS = ['updater:status', 'updater:check', 'updater:install'] as const;
export function registerUpdaterHandlers(registry: ChannelRegistry, service: UpdateService): void {
  registry.register('updater:status', () => service.snapshot() as unknown as Json, 'updater');
  registry.register('updater:check', async () => await service.check() as unknown as Json, 'updater');
  registry.register('updater:install', async () => await service.install() as unknown as Json, 'updater');
}
