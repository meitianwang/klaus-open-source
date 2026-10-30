import type { RecorderPanel } from '../../app/recorder-panel';
import type { Json } from '../contract';
import { ChannelRegistry } from '../registry';

export function registerRecordingHandlers(registry: ChannelRegistry, panel: RecorderPanel): void {
  registry.registerAll({
    'computer-use:record:status': context => panel.status(context.senderId) as Json,
    'computer-use:record:stop': async context => await panel.stop(context.senderId, 'stop') as unknown as Json,
    'computer-use:record:discard': async context => await panel.stop(context.senderId, 'discard') as unknown as Json,
  }, 'recording');
}
