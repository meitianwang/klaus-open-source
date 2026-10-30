import type { Json } from '../contract';
import type { CollaborationFileScope } from '../../../contracts/team-collaboration';
import { ChannelRegistry, IpcHandlerError } from '../registry';
import { TeamCollaborationService } from '../../services/team-collaboration';
import type { DraftOptions, ExecuteOptions, IssueDraftOptions, TeamCollaborationDeps } from '../../services/team-collaboration/types';
import { id, record, validateRequest } from '../../services/team-collaboration/cloud';

export const TEAM_COLLABORATION_CHANNELS = [
  'collaboration:request', 'collaboration:local-binding', 'collaboration:set-local-binding',
  'collaboration:pick-local-folder', 'collaboration:draft-project', 'collaboration:cancel-draft',
  'collaboration:execute', 'collaboration:watch',
  'collaboration:download-file', 'collaboration:preview-file',
  'collaboration:local-agents', 'collaboration:draft-issue',
] as const;

export function registerTeamCollaborationHandlers(registry: ChannelRegistry, deps: TeamCollaborationDeps): TeamCollaborationService {
  const service = new TeamCollaborationService(deps);
  for (const channel of TEAM_COLLABORATION_CHANNELS) registry.register(channel, async context => {
    // External browser frames, mobile clients and generated canvas pages never own local execution.
    if (context.role !== 'main') throw new IpcHandlerError('FORBIDDEN_CHANNEL', 'Team collaboration is available only in the main desktop window');
    // Server-controlled rollout gate. The cloud refuses the same calls with
    // 403; this keeps the desktop surface honest even against a stale UI.
    if (!(deps.gateEnabled?.() ?? true)) throw new IpcHandlerError('FEATURE_UNAVAILABLE', 'Team collaboration is not available for this account yet');
    context.assertCurrent?.();
    const value = record(context.args[0]);
    let result: unknown;
    switch (channel) {
      case 'collaboration:request': result = await service.request(validateRequest(value)); break;
      case 'collaboration:local-binding': result = await service.localBinding(id(value.projectId, 'projectId')); break;
      case 'collaboration:set-local-binding':
        if (value.localFolder !== null && typeof value.localFolder !== 'string') throw new IpcHandlerError('BAD_REQUEST', 'localFolder must be a string or null');
        result = await service.setLocalBinding(id(value.projectId, 'projectId'), value.localFolder); break;
      case 'collaboration:pick-local-folder': result = await service.pickLocalFolder(id(value.projectId, 'projectId')); break;
      case 'collaboration:draft-project':
        result = await service.draftProject(value.prompt as string, value as unknown as DraftOptions, context.senderId); break;
      case 'collaboration:draft-issue':
        result = await service.draftIssue(value.prompt as string, value as unknown as IssueDraftOptions, context.senderId); break;
      case 'collaboration:cancel-draft': result = await service.cancelDraft(id(value.requestId, 'requestId'), context.senderId); break;
      case 'collaboration:execute': result = await service.execute(value as unknown as ExecuteOptions); break;
      case 'collaboration:local-agents': service.cloud.scope(); result = await service.agents.list(); break;
      case 'collaboration:download-file': result = await service.files.download(record(value.scope) as CollaborationFileScope, id(value.fileId, 'fileId')); break;
      case 'collaboration:preview-file': result = await service.files.preview(record(value.scope) as CollaborationFileScope, id(value.fileId, 'fileId')); break;
      case 'collaboration:watch':
        result = service.watch(value.projectId === null ? null : id(value.projectId, 'projectId')); break;
    }
    context.assertCurrent?.();
    return result as Json;
  }, 'team-collaboration');
  return service;
}
