import { ChannelRegistry } from '../registry';
import { GitService, type GitDeps } from '../../services/git';
import { object } from '../../services/service-types';

export const GIT_CHANNELS = [
  'git:branches', 'git:uncommitted', 'git:init', 'git:checkout', 'git:commit-paths', 'diff:summary', 'diff:hunks',
  'diff:open', 'diff:reveal', 'diff:commit', 'diff:generateCommitMessage', 'diff:apply-review-action',
] as const;
export function registerGitHandlers(registry: ChannelRegistry, deps: GitDeps & { git?: GitService }): GitService {
  const git = deps.git ?? new GitService(deps);
  registry.register('git:branches', ctx => git.branches(object(ctx.args[0])), 'git');
  registry.register('git:uncommitted', ctx => git.uncommitted(object(ctx.args[0])), 'git');
  registry.register('git:init', ctx => git.init(object(ctx.args[0])), 'git');
  registry.register('git:checkout', ctx => git.checkout(object(ctx.args[0])), 'git');
  registry.register('git:commit-paths', ctx => git.commitPaths(object(ctx.args[0])), 'git');
  registry.register('diff:summary', ctx => git.summary(object(ctx.args[0])), 'git');
  registry.register('diff:hunks', ctx => git.hunks(object(ctx.args[0])), 'git');
  registry.register('diff:open', ctx => git.open(object(ctx.args[0])), 'git');
  registry.register('diff:reveal', ctx => git.open(object(ctx.args[0]), true), 'git');
  registry.register('diff:commit', ctx => git.commit(object(ctx.args[0])), 'git');
  registry.register('diff:generateCommitMessage', ctx => git.generateCommitMessage(object(ctx.args[0])), 'git');
  registry.register('diff:apply-review-action', ctx => git.reviewAction(object(ctx.args[0])), 'git');
  return git;
}
