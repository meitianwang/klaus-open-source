import { ChannelRegistry, IpcHandlerError } from '../registry';
import type { Json } from '../contract';
import { WorktreeService, type WorktreeDeps } from '../../services/worktrees';
import type { WorktreeStorageService } from '../../services/worktree-storage';
import type { WorktreeStorageSettingsPatch } from '../../../contracts/worktree-storage';
import { object } from '../../services/service-types';

export const WORKTREE_CHANNELS = ['worktree:create-from-workdir', 'worktree:status', 'worktree:remove', 'worktree:reveal', 'worktree:list', 'worktree:configure', 'worktree:storage-delete'] as const;
export function registerWorktreeHandlers(registry: ChannelRegistry, deps: WorktreeDeps & { worktrees?: WorktreeService; storage?: WorktreeStorageService }): WorktreeService {
  const worktrees = deps.worktrees ?? new WorktreeService(deps);
  const storage = () => { if (!deps.storage) throw new IpcHandlerError('UNAVAILABLE', 'Worktree storage is unavailable'); return deps.storage; };
  const schedule = () => { void deps.storage?.scheduleCleanup().catch(() => {}); };
  registry.register('worktree:create-from-workdir', async ctx => {
    const result = await worktrees.create(object(ctx.args[0]), ctx.assertCurrent);
    if (object(result).ok === true) schedule();
    return result;
  }, 'worktrees');
  registry.register('worktree:status', ctx => worktrees.status(object(ctx.args[0])), 'worktrees');
  registry.register('worktree:remove', ctx => worktrees.remove(object(ctx.args[0])), 'worktrees');
  registry.register('worktree:reveal', ctx => worktrees.reveal(object(ctx.args[0])), 'worktrees');
  registry.register('worktree:list', () => storage().list() as unknown as Promise<Json>, 'worktrees');
  registry.register('worktree:configure', async ctx => {
    ctx.assertCurrent?.();
    const result = await storage().configure(object(ctx.args[0]) as WorktreeStorageSettingsPatch);
    schedule(); return result as unknown as Json;
  }, 'worktrees');
  registry.register('worktree:storage-delete', async ctx => {
    const path = object(ctx.args[0]).path;
    if (typeof path !== 'string' || !path) throw new IpcHandlerError('BAD_REQUEST', 'Worktree path is required');
    ctx.assertCurrent?.();
    const result = await storage().deleteManaged(path);
    schedule(); return result;
  }, 'worktrees');
  return worktrees;
}
