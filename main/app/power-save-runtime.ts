import { BrowserWindow, powerMonitor, powerSaveBlocker, webContents } from 'electron';
import type { PowerSaveContext, PowerSaveSnapshot } from '../../contracts/power-save';
import { IpcHandlerError, type ChannelRegistry } from '../ipc/registry';
import { object } from '../services/service-types';
import type { Json } from '../ipc/contract';
import { PowerSaveController, PowerSaveSettings } from '../services/cron-power';

/** Trusted renderers own requests; host lifecycle sources supply current context. */
export function createPowerSaveRuntime(registry: ChannelRegistry, deps: {
  configRoot: string;
  context(): PowerSaveContext;
  emit(channel: string, value: Json): void;
  log(message: string): void;
}) {
  const settings = new PowerSaveSettings(deps.configRoot);
  const controller = new PowerSaveController(powerSaveBlocker, powerMonitor, error => deps.log(String(error)));
  const tracked = new Set<number>();
  let revision = 0, closed = false;
  const snapshot = (): PowerSaveSnapshot => ({ revision, preferences: settings.get(), context: deps.context(), platform: process.platform });
  const changed = (): void => {
    if (closed) return;
    revision++;
    try { deps.emit('power:context', { ...snapshot() } as unknown as Json); }
    catch (error) { deps.log(String(error)); }
  };
  const release = (id: number): void => { controller.release(id); };
  registry.register('power:snapshot', () => ({ ...snapshot() }) as unknown as Json, 'power');
  registry.register('settings:power:set', ctx => {
    const value = object(ctx.args[0]);
    if (value.key !== 'preventSleepWhileRunning' && value.key !== 'keepRemoteControlAwakeWhilePluggedIn' || typeof value.enabled !== 'boolean') {
      throw new IpcHandlerError('BAD_REQUEST', 'Expected a power preference and boolean value');
    }
    const preferences = settings.set(value.key, value.enabled);
    changed();
    deps.emit('app:preferences-changed', { key: 'power' });
    return { ok: true, ...preferences, revision };
  }, 'power');
  registry.register('power:request:set', ctx => {
    const value = object(ctx.args[0]);
    if (['shouldBlock', 'keepRemoteControlAwakeWhilePluggedIn', 'preventDisplaySleep'].some(key => typeof value[key] !== 'boolean')) {
      throw new IpcHandlerError('BAD_REQUEST', 'Expected boolean power request flags');
    }
    const contents = webContents.fromId(ctx.senderId);
    if (!contents || contents.isDestroyed() || !BrowserWindow.fromWebContents(contents)) throw new IpcHandlerError('WINDOW_CLOSED', 'Power request owner is unavailable');
    if (!tracked.has(contents.id)) {
      tracked.add(contents.id);
      contents.once('destroyed', () => { tracked.delete(contents.id); release(contents.id); });
      contents.on('render-process-gone', () => release(contents.id));
      contents.on('did-start-navigation', details => { if (details.isMainFrame && !details.isSameDocument) release(contents.id); });
    }
    controller.update(contents.id, { shouldBlock: value.shouldBlock as boolean,
      keepRemoteControlAwakeWhilePluggedIn: value.keepRemoteControlAwakeWhilePluggedIn as boolean, preventDisplaySleep: value.preventDisplaySleep as boolean });
    return { ok: true };
  }, 'power');
  return { settings, changed, release, close(): void { closed = true; controller.close(); } };
}
