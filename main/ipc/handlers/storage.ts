import { ChannelRegistry, IpcHandlerError } from '../registry';
import type { Json } from '../contract';
import { object } from '../../services/service-types';
import type { DeviceStorageService, StorageCleanupSelection, StorageReviewRow } from '../../services/device-storage';

export const STORAGE_CHANNELS = ['storage:usage', 'storage:refresh', 'storage:review', 'storage:cleanup'] as const;

export function registerStorageHandlers(registry: ChannelRegistry, storage: DeviceStorageService): void {
  registry.register('storage:usage', () => storage.read() as unknown as Promise<Json>, 'storage');
  registry.register('storage:refresh', () => storage.refresh() as unknown as Promise<Json>, 'storage');
  registry.register('storage:review', async (): Promise<Json> => {
    const { reviewId, inventory, sessionBytes, subagentCounts } = await storage.reviewInventory();
    const rows: StorageReviewRow[] = inventory.map(meta => ({
      id: meta.id,
      archived: meta.archived,
      running: meta.running,
      pinned: meta.pinned,
      updatedAt: meta.updatedAt,
      workdir: meta.workdir ?? null,
      bytes: sessionBytes[meta.id] ?? 0,
      subagents: subagentCounts[meta.id] ?? 0,
      row: meta.row,
    }));
    return { reviewId, inventory: rows } as unknown as Json;
  }, 'storage');
  registry.register('storage:cleanup', ctx => {
    const payload = object(ctx.args[0]);
    if (!Array.isArray(payload.selection)) throw new IpcHandlerError('BAD_REQUEST', 'selection must be an array');
    const selection: StorageCleanupSelection[] = (payload.selection as unknown[]).map(entry => {
      const item = object(entry);
      if (typeof item.id !== 'string' || !item.id) throw new IpcHandlerError('BAD_REQUEST', 'selection entries need an id');
      if (typeof item.updatedAt !== 'number' || !Number.isFinite(item.updatedAt)) throw new IpcHandlerError('BAD_REQUEST', 'selection entries need updatedAt');
      return { id: item.id, updatedAt: item.updatedAt };
    });
    if (typeof payload.reviewId !== 'string' || !payload.reviewId || typeof payload.cutoffMs !== 'number'
      || !Number.isSafeInteger(payload.cutoffMs) || typeof payload.archivedOnly !== 'boolean') {
      throw new IpcHandlerError('BAD_REQUEST', 'A review, cutoff and archive filter are required');
    }
    ctx.assertCurrent?.();
    return storage.cleanup(selection, { reviewId: payload.reviewId, cutoffMs: payload.cutoffMs, archivedOnly: payload.archivedOnly });
  }, 'storage');
}
