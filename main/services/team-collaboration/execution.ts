import type { CollaborationMessage } from '../../../contracts/team-collaboration';
import { IpcHandlerError } from '../../ipc/registry';
import type { AccountScope, CollaborationCloud } from './cloud';
import type { ExecuteOptions } from './types';

export async function executionContext(cloud: CollaborationCloud, input: ExecuteOptions, scope: AccountScope) {
  const [project, issue, discussion, members] = await Promise.all([
    input.projectId ? cloud.request({ type: 'projects.get', projectId: input.projectId }, scope) : null,
    input.projectId && input.issueId ? cloud.request({ type: 'issues.get', projectId: input.projectId, issueId: input.issueId }, scope) : null,
    input.discussionId ? cloud.request({ type: 'discussions.get', projectId: input.projectId, discussionId: input.discussionId }, scope) : null,
    input.discussionId ? cloud.request({ type: 'discussion-members.list', projectId: input.projectId, discussionId: input.discussionId }, scope)
      : cloud.request({ type: 'project-members.list', projectId: input.projectId! }, scope),
  ]);
  scope.current();
  if (project?.archivedAt || issue?.archivedAt || discussion?.archivedAt || issue && issue.projectId !== project?.id
    || discussion && discussion.projectId !== (input.projectId ?? null)) {
    throw new IpcHandlerError('PROJECT_UNAVAILABLE', 'Restore and reload the collaboration resource before running an agent');
  }
  if (issue && issue.version !== input.issueVersion || discussion && input.discussionVersion !== undefined && discussion.version !== input.discussionVersion) {
    throw new IpcHandlerError('CONFLICT', 'The collaboration context changed. Review it before running an agent');
  }
  const member = members.find(item => item.agentId === input.agentId && item.agent?.ownerId === scope.account.id && item.userId === scope.account.id);
  if (!member?.agent) throw new IpcHandlerError('AGENT_NOT_OWNED', 'Only your own agent in this collaboration can run on this device');
  let message: CollaborationMessage | undefined;
  if (discussion) {
    let cursor: string | undefined;
    for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
      const page = await cloud.request({ type: 'discussion-messages.list', projectId: input.projectId, discussionId: discussion.id, limit: 100, ...(cursor ? { cursor } : {}) }, scope);
      message = page.items.find(item => item.id === input.messageId);
      if (message || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    const memberId = 'memberId' in member ? member.memberId : member.id;
    if (!message || message.authorId !== scope.account.id || message.source !== 'human' || !message.mentionMemberIds.includes(memberId)
      || input.prompt !== undefined && input.prompt !== message.content) {
      throw new IpcHandlerError('INVALID_AGENT_MENTION', 'Choose your own message that mentions your agent in this discussion');
    }
  }
  const prompt = [
    project ? `Project: ${project.name} (${project.identifier})` : '',
    issue ? `Issue: ${issue.identifier} — ${issue.title}\n\n${issue.description}` : '',
    discussion ? `Discussion: ${discussion.title}\n\n${discussion.description}` : '',
    message?.content ?? input.prompt ?? '',
    'Return a useful final response to share with the collaboration. Do not include credentials, local absolute paths, tool transcripts, or hidden reasoning in that response.',
  ].filter(Boolean).join('\n\n');
  return { project, issue, discussion, member, prompt, title: issue ? `${issue.identifier}: ${issue.title}` : discussion!.title };
}

export function publicResponse(response: string | null, privateValues: string[]): string {
  if (!response?.trim()) throw new IpcHandlerError('EMPTY_AGENT_RESPONSE', 'The agent returned no final response to share');
  let result = response;
  for (const value of privateValues.filter(Boolean).sort((a, b) => b.length - a.length)) result = result.split(value).join('[private value]');
  result = result
    .replace(/<(?:think|thinking|analysis|reasoning)>[\s\S]*?(?:<\/(?:think|thinking|analysis|reasoning)>|$)/gi, '')
    .replace(/-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?(?:-----END \1-----|$)/g, '[private key redacted]')
    .replace(/https?:\/\/[^\s<>"'`]+/gi, value => {
      try {
        const url = new URL(value);
        url.username = ''; url.password = ''; url.search = ''; url.hash = '';
        return url.href;
      } catch { return '[private URL removed]'; }
    })
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\b(?:(?:sk|rk|pk)[-_]|ghp_|github_pat_|xox[abprs]-|xapp-)[A-Za-z0-9_-]{12,}/g, '[credential redacted]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[credential redacted]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[credential redacted]')
    .replace(/\b((?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|token|password|secret|credential|signature|access[_-]?key)(?:[_-][A-Za-z0-9]+)*)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[A-Za-z0-9._~+/-]+)/gi, '$1=[redacted]')
    .replace(/file:\/\/[^\s<>"'`)]*/gi, '[local path]')
    .replace(/(?<![\w/:])\/(?!\/)[^\s<>"'`)]*/g, '[local path]')
    .replace(/~\/[^\s<>"'`)]*/g, '[local path]')
    .replace(/\\\\[^\\\s]+\\[^\s<>"'`)]*/g, '[local path]')
    .replace(/\b[A-Za-z]:[\\/][^\s<>"'`)]*/g, '[local path]');
  result = result.trim();
  if (!result) throw new IpcHandlerError('EMPTY_AGENT_RESPONSE', 'The agent returned no public final response');
  return result.slice(0, 32_000);
}
