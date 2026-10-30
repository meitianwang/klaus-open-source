import { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import type { ExternalAgentImportService } from '../../external-agent-import/service';

export const EXTERNAL_AGENT_IMPORT_CHANNELS = ['external-agent-import:detect', 'external-agent-import:import', 'external-agent-import:status'] as const;
export function registerExternalAgentImportHandlers(registry: ChannelRegistry, service: ExternalAgentImportService): void {
  registry.register('external-agent-import:detect', ctx => service.detect(object(ctx.args[0])), 'external-agent-import');
  registry.register('external-agent-import:import', ctx => service.import(object(ctx.args[0])), 'external-agent-import');
  registry.register('external-agent-import:status', () => service.status(), 'external-agent-import');
}
