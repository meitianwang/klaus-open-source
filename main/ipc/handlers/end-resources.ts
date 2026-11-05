import { ChannelRegistry, IpcHandlerError } from '../registry';
import type { EndResourceOpener } from '../../services/end-resource-open';
import { object } from '../../services/service-types';

export const END_RESOURCE_CHANNELS = [
  'end-resources:targets', 'end-resources:open', 'end-resources:reveal', 'end-resources:download-copy', 'end-resources:page-meta', 'end-resources:existing',
] as const;

/** Turn-end resource actions are explicit clicks in the main transcript. */
export function registerEndResourceHandlers(registry: ChannelRegistry, opener: EndResourceOpener): void {
  const owner = (role: string) => {
    if (role !== 'main') throw new IpcHandlerError('FORBIDDEN', 'Only the main transcript opens turn resources');
  };
  registry.register('end-resources:targets', ctx => { owner(ctx.role); return opener.targets(object(ctx.args[0])); }, 'end-resources');
  registry.register('end-resources:open', ctx => { owner(ctx.role); return opener.open(object(ctx.args[0])); }, 'end-resources');
  registry.register('end-resources:reveal', ctx => { owner(ctx.role); return opener.reveal(object(ctx.args[0])); }, 'end-resources');
  registry.register('end-resources:download-copy', ctx => { owner(ctx.role); return opener.downloadCopy(object(ctx.args[0])); }, 'end-resources');
  registry.register('end-resources:existing', ctx => { owner(ctx.role); return opener.existing(object(ctx.args[0])); }, 'end-resources');
  registry.register('end-resources:page-meta', ctx => { owner(ctx.role); return opener.pageMeta(object(ctx.args[0])); }, 'end-resources');
}
