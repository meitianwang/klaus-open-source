import { ChannelRegistry } from '../registry';
import { ComposerService, type ComposerDeps } from '../../services/composer';
import { object, string } from '../../services/service-types';

export const COMPOSER_CHANNELS = [
  'session:get-main-model', 'session:set-main-model', 'session:get-thinking-level', 'session:set-thinking-level',
  'session:get-ultra-mode', 'session:set-ultra-mode',
  'session:get-fast-mode', 'session:set-fast-mode',
  'session:get-permission-mode', 'session:set-permission-mode',
  'session:get-custom-main-model-options', 'session:get-main-model-options',
] as const;

export function registerComposerHandlers(registry: ChannelRegistry, deps: ComposerDeps): ComposerService {
  const service = new ComposerService(deps);
  registry.register('session:get-main-model', ctx => {
    const payload = object(ctx.args[0]);
    return service.getModel(string(payload.sessionId), payload.resolve !== false, payload.previewSource as string | undefined);
  }, 'composer');
  registry.register('session:set-main-model', ctx => service.setModel(object(ctx.args[0]), ctx.assertCurrent), 'composer');
  registry.register('session:get-thinking-level', ctx => service.getThinking(string(object(ctx.args[0]).sessionId)), 'composer');
  registry.register('session:set-thinking-level', ctx => service.setThinking(object(ctx.args[0]), ctx.assertCurrent), 'composer');
  registry.register('session:get-ultra-mode', ctx => service.getUltraMode(string(object(ctx.args[0]).sessionId)), 'composer');
  registry.register('session:set-ultra-mode', ctx => service.setUltraMode(object(ctx.args[0]), ctx.assertCurrent), 'composer');
  registry.register('session:get-fast-mode', ctx => service.getFastMode(string(object(ctx.args[0]).sessionId)), 'composer');
  registry.register('session:set-fast-mode', ctx => service.setFastMode(object(ctx.args[0]), ctx.assertCurrent), 'composer');
  registry.register('session:get-permission-mode', ctx => service.getPermission(string(object(ctx.args[0]).sessionId)), 'composer');
  registry.register('session:set-permission-mode', ctx => service.setPermission(object(ctx.args[0])), 'composer');
  registry.register('session:get-custom-main-model-options', async () => ({ options: await service.options('custom') }), 'composer');
  registry.register('session:get-main-model-options', async ctx => {
    const source = string(object(ctx.args[0]).source);
    return { options: await service.options(source || undefined) };
  }, 'composer');
  return service;
}
