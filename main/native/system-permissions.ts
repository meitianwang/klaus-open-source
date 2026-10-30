import type { NativeAddon } from './binding';
import type { SystemPermissionStatus } from '../services/system-permissions';

type Probe = () => Promise<SystemPermissionStatus>;

function passive(
  read: (() => Promise<string>) | undefined, platform: NodeJS.Platform,
): Probe {
  return () => {
    if (platform !== 'darwin' || !read) return Promise.resolve('unknown');
    return Promise.resolve().then(read).then(status => {
      if (status !== 'granted' && status !== 'denied' && status !== 'unknown') throw new Error('INVALID_PERMISSION_STATUS');
      return status;
    });
  };
}

/** Share simultaneous settings refreshes; the addon probes from the main process worker. */
export function nativeAutomationPermissionProbe(
  addon: Pick<NativeAddon, 'automationPermissionStatus'>, platform: NodeJS.Platform = process.platform,
): Probe {
  let pending: Promise<SystemPermissionStatus> | undefined;
  const read = passive(() => addon.automationPermissionStatus(), platform);
  return () => {
    pending ??= read().finally(() => { pending = undefined; });
    return pending;
  };
}

/** All passive TCC probes plus the explicit consent request, sharing one addon surface. */
export function nativeSystemPermissionProbes(
  addon: Pick<NativeAddon, 'automationPermissionStatus' | 'photosPermissionStatus' | 'locationPermissionStatus'
    | 'notificationPermissionStatus' | 'requestPermission'>,
  platform: NodeJS.Platform = process.platform,
): { automation: Probe; photosLibrary: Probe; location: Probe; notification: Probe; request(domain: string): Promise<SystemPermissionStatus> } {
  const wrap = (read: () => Promise<string>): Probe => {
    let pending: Promise<SystemPermissionStatus> | undefined;
    const probe = passive(read, platform);
    return () => {
      pending ??= probe().finally(() => { pending = undefined; });
      return pending;
    };
  };
  return {
    automation: wrap(() => addon.automationPermissionStatus()),
    photosLibrary: wrap(() => addon.photosPermissionStatus()),
    location: wrap(() => addon.locationPermissionStatus()),
    notification: wrap(() => addon.notificationPermissionStatus()),
    request: domain => {
      if (platform !== 'darwin') return Promise.resolve('unknown');
      return addon.requestPermission(domain).then(status => {
        if (status !== 'granted' && status !== 'denied' && status !== 'unknown') throw new Error('INVALID_PERMISSION_STATUS');
        return status;
      });
    },
  };
}
