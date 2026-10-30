import type { Json } from '../contract';
import { payload, requiredString } from '../arguments';
import { IpcHandlerError, type ChannelRegistry } from '../registry';
import type { ComposerPredictions } from '../../services/composer-predictions';

export function registerComposerPredictionHandlers(registry: ChannelRegistry, service: ComposerPredictions): void {
  registry.register('composer:prediction:source', async context => {
    const reply = await service.source(requiredString(payload(context), 'sessionId'), context.senderId);
    context.assertCurrent?.();
    return reply as unknown as Json;
  }, 'composer-predictions');
  registry.register('composer:prediction', async context => {
    const value = payload(context);
    if (value.trigger !== 'live' && value.trigger !== 'catch_up') throw new IpcHandlerError('BAD_REQUEST', 'A prediction trigger is required');
    const reply = await service.predict(requiredString(value, 'sessionId'), requiredString(value, 'turnId'), value.trigger, context.senderId);
    context.assertCurrent?.();
    return reply as unknown as Json;
  }, 'composer-predictions');
  registry.register('composer:prediction:cancel', async context => {
    await service.cancel(requiredString(payload(context), 'sessionId'), context.senderId);
    return { ok: true };
  }, 'composer-predictions');
  registry.register('composer:prediction:availability', async () => await service.availability() as unknown as Json, 'composer-predictions');
}
