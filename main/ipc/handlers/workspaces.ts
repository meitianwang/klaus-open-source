import { ChannelRegistry } from '../registry';
import { WorkspaceStore, type WorkspaceDeps } from '../../services/workspaces';
import { object } from '../../services/service-types';

export const WORKSPACE_CHANNELS = [
  'session:get-workdir', 'session:get-resolved-workdir', 'session:set-workdir', 'session:clear-workdir',
  'session:set-workspace', 'session:pick-workdir', 'session:pick-workdirs', 'workspaces:list', 'workspaces:save', 'workspaces:delete',
  'projects:list', 'projects:add', 'projects:remove', 'projects:set-active', 'projects:resolve-root',
  'projects:reorder',
] as const;

export function registerWorkspaceHandlers(registry: ChannelRegistry, deps: WorkspaceDeps & { workspaces?: WorkspaceStore; onProjectOrderChanged?: () => void | Promise<void> }): WorkspaceStore {
  const store = deps.workspaces ?? new WorkspaceStore(deps);
  registry.register('session:get-workdir', ctx => store.getWorkdir(object(ctx.args[0])), 'workspaces');
  registry.register('session:get-resolved-workdir', ctx => store.getResolvedWorkdir(object(ctx.args[0])), 'workspaces');
  registry.register('session:set-workdir', ctx => store.setWorkdir(object(ctx.args[0]), ctx.assertCurrent), 'workspaces');
  registry.register('session:clear-workdir', ctx => store.clearWorkdir(object(ctx.args[0])), 'workspaces');
  registry.register('session:set-workspace', ctx => store.setWorkspace(object(ctx.args[0])), 'workspaces');
  registry.register('session:pick-workdir', () => store.pickWorkdir(), 'workspaces');
  registry.register('session:pick-workdirs', () => store.pickWorkdirs(), 'workspaces');
  registry.register('workspaces:list', () => store.list(), 'workspaces');
  registry.register('workspaces:save', ctx => store.save(object(ctx.args[0])), 'workspaces');
  registry.register('workspaces:delete', async ctx => {
    const result = object(await store.delete(object(ctx.args[0])));
    const ids = (Array.isArray(result.deletedSessions) ? result.deletedSessions : []).filter((id): id is string => typeof id === 'string');
    if (ids.length) await deps.onDeleteWorkspaceSessions?.(ids);
    return result;
  }, 'workspaces');
  registry.register('projects:list', () => store.projectsList(), 'workspaces');
  registry.register('projects:add', ctx => store.projectsAdd(object(ctx.args[0])), 'workspaces');
  registry.register('projects:remove', ctx => store.projectsRemove(object(ctx.args[0])), 'workspaces');
  registry.register('projects:set-active', ctx => store.projectsSetActive(object(ctx.args[0])), 'workspaces');
  registry.register('projects:resolve-root', ctx => store.projectsResolveRoot(object(ctx.args[0])), 'workspaces');
  registry.register('projects:reorder', async ctx => {
    const result = object(store.projectsReorder(object(ctx.args[0])));
    // A rejected order is an error envelope, not a throw, so the caller can roll
    // back. Only a stored order is worth telling the other windows about.
    if (!result.error) await deps.onProjectOrderChanged?.();
    return result;
  }, 'workspaces');
  return store;
}
