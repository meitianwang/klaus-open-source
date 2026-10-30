import { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import { SkillService, type SkillDeps } from '../../services/extensions/skills';

export const SKILL_CHANNELS = ['skills:list', 'skills:toggle', 'skills:uninstall', 'skills:read-file', 'skills:open-window', 'skills:builtin'] as const;
export function registerSkillHandlers(registry: ChannelRegistry, deps: SkillDeps & { skills?: SkillService }): SkillService {
  const skills = deps.skills ?? new SkillService(deps);
  registry.register('skills:list', ctx => skills.list(object(ctx.args[0])), 'skills');
  registry.register('skills:toggle', ctx => skills.toggle(object(ctx.args[0])), 'skills');
  registry.register('skills:uninstall', ctx => skills.uninstall(object(ctx.args[0])), 'skills');
  registry.register('skills:read-file', ctx => skills.readFile(object(ctx.args[0])), 'skills');
  registry.register('skills:open-window', ctx => skills.openWindow(object(ctx.args[0])), 'skills');
  registry.register('skills:builtin', () => skills.builtin(), 'skills');
  return skills;
}
