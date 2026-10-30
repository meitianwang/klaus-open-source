import { ChannelRegistry, IpcHandlerError } from '../registry';
import { FileService, type FileDeps } from '../../services/files';
import { object } from '../../services/service-types';

export const FILE_CHANNELS = [
  'workspace:list', 'workspace:search', 'workspace:open', 'workspace:reveal', 'workspace:rename', 'workspace:delete',
  'workspace:write', 'workspace:get-excludes', 'workspace:set-excludes', 'artifacts:read',
  'artifacts:authorize-preview', 'artifacts:file-url', 'artifacts:widget-url', 'artifacts:reveal', 'artifacts:open-workspace', 'artifacts:open-window', 'artifacts:save-copy', 'session:file-changes',
] as const;

export function registerFileHandlers(registry: ChannelRegistry, deps: FileDeps & { files?: FileService }): FileService {
  const files = deps.files ?? new FileService(deps);
  registry.register('workspace:list', ctx => files.list(object(ctx.args[0])), 'files');
  registry.register('workspace:search', ctx => files.search(object(ctx.args[0])), 'files');
  registry.register('workspace:open', ctx => files.open(object(ctx.args[0])), 'files');
  registry.register('workspace:reveal', ctx => files.open(object(ctx.args[0]), true), 'files');
  registry.register('workspace:rename', ctx => files.rename(object(ctx.args[0])), 'files');
  registry.register('workspace:delete', ctx => files.delete(object(ctx.args[0])), 'files');
  registry.register('workspace:write', ctx => files.write(object(ctx.args[0])), 'files');
  registry.register('workspace:get-excludes', () => files.getExcludes(), 'files');
  registry.register('workspace:set-excludes', ctx => files.setExcludes(object(ctx.args[0])), 'files');
  registry.register('artifacts:read', ctx => files.readArtifact(object(ctx.args[0])), 'files');
  registry.register('artifacts:authorize-preview', ctx => {
    if (ctx.role !== 'main') throw new IpcHandlerError('FORBIDDEN', 'Only the main file viewer can authorize a preview');
    return files.authorizeArtifactPreview(object(ctx.args[0]));
  }, 'files');
  registry.register('artifacts:file-url', ctx => files.artifactFileUrl(object(ctx.args[0])), 'files');
  registry.register('artifacts:widget-url', ctx => files.widgetUrl(object(ctx.args[0])), 'files');
  registry.register('artifacts:reveal', ctx => files.revealArtifact(object(ctx.args[0])), 'files');
  registry.register('artifacts:open-workspace', ctx => files.openWorkspace(object(ctx.args[0])), 'files');
  registry.register('artifacts:open-window', ctx => files.openArtifactWindow(object(ctx.args[0])), 'files');
  registry.register('artifacts:save-copy', ctx => files.saveArtifactCopy(object(ctx.args[0]), ctx.senderId), 'files');
  registry.register('session:file-changes', ctx => files.fileChanges(object(ctx.args[0])), 'files');
  return files;
}
