import { userInfo } from 'node:os';
import { join } from 'node:path';
import { canonicalProfilePath } from '../services/config-root';

/** ShipIt and NSIS's desktop Shell relaunch do not preserve the original process environment. */
export function systemRelaunchPreservesProfile(configRoot: string, defaultRoot = join(userInfo().homedir, '.klaus')): boolean {
  return canonicalProfilePath(configRoot) === canonicalProfilePath(defaultRoot);
}

export const CUSTOM_PROFILE_UPDATE_MESSAGE = 'Automatic installation is unavailable for this custom data profile. Quit Klaus and replace the application manually, then start it with the same profile configuration.';
