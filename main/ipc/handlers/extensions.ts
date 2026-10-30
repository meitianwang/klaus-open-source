import { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import { FileExtensionService, type FileExtensionDeps } from '../../services/extensions/management';

export const FILE_EXTENSION_CHANNELS = ['commands:list', 'commands:save', 'commands:delete', 'engine:slashCommands', 'engine:refreshCommands', 'agents:definitions:list', 'agents:definitions:read', 'agents:definitions:save', 'agents:definitions:delete'] as const;
export function registerFileExtensionHandlers(registry: ChannelRegistry, deps: FileExtensionDeps & { extensions?: FileExtensionService }): FileExtensionService {
  const extensions = deps.extensions ?? new FileExtensionService(deps);
  registry.register('commands:list', ctx => extensions.commandsList(object(ctx.args[0])), 'file-extensions');
  registry.register('commands:save', ctx => extensions.commandsSave(object(ctx.args[0])), 'file-extensions');
  registry.register('commands:delete', ctx => extensions.commandsDelete(object(ctx.args[0])), 'file-extensions');
  registry.register('engine:slashCommands', ctx => extensions.slashCommands(object(ctx.args[0])), 'file-extensions');
  registry.register('engine:refreshCommands', () => extensions.refreshCommands(), 'file-extensions');
  registry.register('agents:definitions:list', () => extensions.agentsList(), 'file-extensions');
  registry.register('agents:definitions:read', ctx => extensions.agentsRead(object(ctx.args[0])), 'file-extensions');
  registry.register('agents:definitions:save', ctx => extensions.agentsSave(object(ctx.args[0])), 'file-extensions');
  registry.register('agents:definitions:delete', ctx => extensions.agentsDelete(object(ctx.args[0])), 'file-extensions');
  return extensions;
}
