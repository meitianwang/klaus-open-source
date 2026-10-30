import type { Json } from '../contract';
import { ChannelRegistry } from '../registry';
import { CronStore } from '../../services/cron-store';
import { PowerSaveSettings } from '../../services/cron-power';
import { object, string } from '../../services/service-types';

export const CRON_STORE_CHANNELS = [
  'settings:cron:list', 'settings:cron:upsert', 'settings:cron:delete',
  'settings:cron:runs:list', 'settings:cron:runs:prune', 'settings:cron:keep-awake:get',
] as const;
export interface CronSettingsDeps {
  configRoot?: string;
  store?: CronStore;
  onChanged: () => void | Promise<void>;
  runtime?: { status(): Json | Promise<Json>; runNow(id: string): Json | Promise<Json> };
  powerSettings?: PowerSaveSettings;
}
/** Scheduler and power actions are registered only when the corresponding live owner exists. */
export function registerCronSettingsHandlers(registry: ChannelRegistry, deps: CronSettingsDeps): { store: CronStore } {
  const store = deps.store ?? new CronStore(deps.configRoot);
  registry.register('settings:cron:list', () => store.listTasks(), 'cron');
  registry.register('settings:cron:upsert', async ctx => { store.upsertTask(object(ctx.args[0])); await deps.onChanged(); return null; }, 'cron');
  registry.register('settings:cron:delete', async ctx => { const result = store.deleteTask(string(object(ctx.args[0]).id)); await deps.onChanged(); return result; }, 'cron');
  registry.register('settings:cron:runs:list', ctx => store.listRuns(object(ctx.args[0])), 'cron');
  registry.register('settings:cron:runs:prune', ctx => store.pruneRuns(object(ctx.args[0])), 'cron');
  registry.register('settings:cron:keep-awake:get', () => {
    return { enabled: (deps.powerSettings ?? new PowerSaveSettings(store.configRoot)).get().preventSleepWhileRunning };
  }, 'cron');
  if (deps.runtime) {
    registry.register('settings:cron:status', () => deps.runtime!.status(), 'cron');
    registry.register('settings:cron:run:now', ctx => deps.runtime!.runNow(string(object(ctx.args[0]).id)), 'cron');
  }
  if (deps.powerSettings) {
    registry.register('settings:cron:keep-awake:set', async ctx => {
      deps.powerSettings!.set('preventSleepWhileRunning', object(ctx.args[0]).enabled === true);
      await deps.onChanged();
      return { ok: true };
    }, 'cron');
  }
  return { store };
}
