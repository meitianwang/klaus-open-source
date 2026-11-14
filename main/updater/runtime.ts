import type { App, AutoUpdater } from 'electron';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import type { DesktopEdition } from '../../shared/desktop-edition';
import { currentDesktopEdition } from '../services/desktop-edition';
import { productionPolicy } from './policy';
import { PlatformUpdateInstaller, verifyPlatformSignature, type PlatformIdentity } from './platform';
import { UpdateService, type UpdateStatus } from './service';
import { parseInstalledUpdateConfiguration } from './configuration';
import { CUSTOM_PROFILE_UPDATE_MESSAGE, systemRelaunchPreservesProfile } from './relaunch-profile';

/** No environment variable or renderer argument can replace the shipping trust root. */
export async function createDesktopUpdater(options: {
  app: Pick<App, 'getVersion' | 'isPackaged' | 'getPath' | 'quit' | 'once'>;
  autoUpdater: AutoUpdater;
  resourcesRoot: string;
  configRoot: string;
  edition?: DesktopEdition;
  emit: (status: UpdateStatus) => void;
  autoDownload?: () => boolean;
  log: (message: string) => void;
  prepareToQuit: () => Promise<void>;
  installationFailedAfterPrepare: (error: unknown, staged: boolean) => void;
}): Promise<UpdateService> {
  const currentVersion = options.app.getVersion();
  const edition = options.edition ?? currentDesktopEdition();
  let unavailableReason: string | undefined;
  const unsupported = () => new UpdateService({ currentVersion, cacheRoot: join(options.configRoot, 'electron/updates'), unavailableReason, emit: options.emit, autoDownload: options.autoDownload, installer: { install: async () => { throw new Error('updates_unavailable'); }, dispose: async () => {} } });
  if (!options.app.isPackaged || !['darwin', 'win32'].includes(process.platform)) return unsupported();
  try {
    let text: string;
    try { text = await readFile(join(options.resourcesRoot, 'electron-update.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return unsupported(); throw error; }
    if (text.length > 32 * 1024) throw new Error('Installed update configuration is too large');
    if (!systemRelaunchPreservesProfile(options.configRoot, join(userInfo().homedir, edition.configDirectory))) {
      unavailableReason = CUSTOM_PROFILE_UPDATE_MESSAGE;
      options.log(unavailableReason);
      return unsupported();
    }
    const config = parseInstalledUpdateConfiguration(JSON.parse(text), { platform: process.platform, arch: process.arch, version: currentVersion, application: edition.application });
    const policy = productionPolicy({ platform: config.platform, arch: config.arch, currentVersion, channel: config.channel, feedUrl: config.feedUrl, application: edition.application });
    const identity: PlatformIdentity = { platform: config.platform, application: edition.application, executable: options.app.getPath('exe'), teamId: config.teamId, publisher: config.publisher, windowsAuthenticode: config.windowsAuthenticode };
    await verifyPlatformSignature(config.platform === 'darwin' ? resolve(identity.executable, '../../..') : identity.executable, identity);
    return new UpdateService({ currentVersion, cacheRoot: join(options.configRoot, 'electron/updates'), policy, emit: options.emit, autoDownload: options.autoDownload, installer: new PlatformUpdateInstaller({ identity, app: options.app, autoUpdater: options.autoUpdater, log: options.log,
      prepareToQuit: options.prepareToQuit, installationFailedAfterPrepare: options.installationFailedAfterPrepare }) });
  } catch (error) {
    unavailableReason = error instanceof Error ? error.message : String(error);
    options.log(`Electron update configuration rejected: ${unavailableReason}`);
    return unsupported();
  }
}
