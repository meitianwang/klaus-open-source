import { isWindowsSandboxSetupMode, type WindowsSandboxSetupStartParams } from '../../../contracts/windows-sandbox';
import { payload } from '../arguments';
import { ChannelRegistry, IpcHandlerError } from '../registry';
import type { WindowsSandboxSetup } from '../../services/windows-sandbox-setup';

export const RUNTIME_WINDOWS_SANDBOX_CHANNELS = [
  'settings:runtime:windows-sandbox-readiness', 'settings:runtime:windows-sandbox-setup-start',
] as const;

export function registerRuntimeWindowsSandboxHandlers(registry: ChannelRegistry, service: WindowsSandboxSetup): void {
  registry.register('settings:runtime:windows-sandbox-readiness', () => service.readiness(), 'runtime-windows-sandbox');
  registry.register('settings:runtime:windows-sandbox-setup-start', context => {
    const value = payload(context);
    if (!isWindowsSandboxSetupMode(value.mode)) throw new IpcHandlerError('BAD_REQUEST', 'Select a Windows sandbox setup mode');
    if (value.cwd !== undefined && value.cwd !== null && typeof value.cwd !== 'string') throw new IpcHandlerError('BAD_REQUEST', 'cwd must be a path or null');
    const params: WindowsSandboxSetupStartParams = { mode: value.mode,
      ...(value.cwd !== undefined ? { cwd: value.cwd as string | null } : {}) };
    return service.start(params);
  }, 'runtime-windows-sandbox');
}
