import { ChannelRegistry } from '../registry';
import { object } from '../../services/service-types';
import { PluginService, type PluginDeps } from '../../services/extensions/plugins';
import { RuntimeViewService, type RuntimeViewDeps } from '../../services/extensions/runtime-view';

export const PLUGIN_CHANNELS = ['plugins:market', 'plugins:list', 'plugins:runtime', 'plugins:install', 'plugins:update', 'plugins:toggle', 'plugins:uninstall'] as const;
export const RUNTIME_VIEW_CHANNELS = ['runtime:capabilities', 'runtime:extensions'] as const;
export function registerPluginHandlers(registry: ChannelRegistry, deps: PluginDeps & { plugins?: PluginService }): PluginService {
  const plugins = deps.plugins ?? new PluginService(deps);
  registry.register('plugins:market', () => plugins.market(), 'plugins');
  registry.register('plugins:list', ctx => plugins.list(object(ctx.args[0])), 'plugins');
  registry.register('plugins:runtime', ctx => plugins.runtimeView(object(ctx.args[0])), 'plugins');
  registry.register('plugins:install', ctx => plugins.install(object(ctx.args[0])), 'plugins');
  registry.register('plugins:update', ctx => plugins.update(object(ctx.args[0])), 'plugins');
  registry.register('plugins:toggle', ctx => plugins.toggle(object(ctx.args[0])), 'plugins');
  registry.register('plugins:uninstall', ctx => plugins.uninstall(object(ctx.args[0])), 'plugins');
  return plugins;
}
export function registerRuntimeViewHandlers(registry: ChannelRegistry, deps: RuntimeViewDeps & { runtime?: RuntimeViewService }): RuntimeViewService {
  const runtime = deps.runtime ?? new RuntimeViewService(deps);
  for (const channel of RUNTIME_VIEW_CHANNELS) registry.register(channel, ctx => runtime.activeView(object(ctx.args[0])), 'runtime-view');
  return runtime;
}
