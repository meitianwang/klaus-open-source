import type { ComputerUsePolicyService } from '../../services/computer-use/policy';
import type { Json } from '../contract';
import { ChannelRegistry } from '../registry';
import { arg0 } from '../binary';

export function registerComputerUseSettingsHandlers(registry: ChannelRegistry, service: ComputerUsePolicyService,
  listApps?: () => Promise<Json>, appDetails?: (app: string) => Promise<Json>): void {
  registry.registerAll({
    'settings:computer-use:get': () => service.get() as unknown as Json,
    'settings:computer-use:set-enabled': async context => await service.setEnabled(arg0(context.args)) as unknown as Json,
    'settings:computer-use:add-allowed-app': context => service.addAllowedApp(arg0(context.args)) as unknown as Json,
    'settings:computer-use:remove-allowed-app': context => service.removeAllowedApp(arg0(context.args)) as unknown as Json,
    'settings:computer-use:list-apps': async () => {
      if (!listApps) throw new Error('Application list is unavailable');
      const result = await listApps();
      return (result && typeof result === 'object' && !Array.isArray(result) ? result : { apps: [] }) as Json;
    },
    'settings:computer-use:app-details': async context => {
      const payload = arg0(context.args);
      const app = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.app : undefined;
      if (typeof app !== 'string' || !service.get().allowedApps.includes(app)) throw new Error('Unknown saved application');
      return appDetails ? appDetails(app) : { name: app };
    },
  }, 'computer-use-settings');
}
