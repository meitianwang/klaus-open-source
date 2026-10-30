import type { ChannelRegistry } from '../registry';
import { payload } from '../arguments';
import { AgentTaskService } from '../../services/agent-tasks';
import { string } from '../../services/service-types';

export function registerAgentTaskHandlers(registry: ChannelRegistry, tasks: AgentTaskService): void {
  registry.registerAll({
    'agents:load-tasks': context => tasks.load(string(payload(context).sessionId)),
    'agents:save-tasks': context => { const value = payload(context); return tasks.save(string(value.sessionId), value.tasks); },
    'agents:snapshot': context => tasks.snapshot(string(payload(context).sessionId)),
  }, 'agent-tasks');
}
