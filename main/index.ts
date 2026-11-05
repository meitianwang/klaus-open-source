import './app/dev-bootstrap';
import { app, dialog } from 'electron';
import { join } from 'node:path';
import { userInfo } from 'node:os';
import { configRootFrom } from './services/config-root';
import { currentDesktopEdition } from './services/desktop-edition';
import { claimDesktopProfileEdition } from './services/desktop-profile';
import { nativeAddonPath } from './paths';
import { registerAppScheme } from './app/protocol';
import { describeStartupFailure } from './app/startup-failure';
import { createDesktopRuntime, type DesktopRuntime } from './app/runtime';
import { prepareWindowsProfile, type WindowsProfileResult } from './app/windows-profile';
import { ensureSettingsBackup } from './app/settings-backup';
import { instanceIdentity } from './app/instance-identity';
import { DesktopInstanceGuard, instanceActivation, type InstanceActivation } from './native/instance-guard';
import { notificationProbeRequested, runNotificationProbe } from './app/notifications';
import { developmentControl as connectDevelopmentControl, type DevelopmentControl } from './app/dev-control';

const edition = currentDesktopEdition();
claimDesktopProfileEdition(configRootFrom(), edition);
app.setName(edition.productName);
app.setAppUserModelId(edition.application);
app.setPath('userData', join(configRootFrom(), 'electron'));
app.commandLine.appendSwitch('native-browser-enabled');
app.commandLine.appendSwitch('native-browser-data-dir', join(app.getPath('userData'), 'native-browser'));
registerAppScheme();

let runtime: DesktopRuntime | undefined;
let quitReady = false;
let quitting = false;
let preparation: Promise<unknown> | undefined;
let startup: Promise<void> | undefined;
let ownershipFailure: Error | undefined;
let development: DevelopmentControl | undefined;
if (!app.isPackaged) {
  process.on('SIGINT', () => app.quit());
  process.on('SIGTERM', () => app.quit());
  development = connectDevelopmentControl({
    packaged: false,
    onCommand: message => {
      if (message.type === 'klaus:dev:quit') app.quit();
      if (message.type === 'klaus:dev:reload' && runtime && !quitting && !runtime.window.isDestroyed()) runtime.window.webContents.reload();
    },
    onDisconnect: () => app.quit(),
  });
}
const deepLinks = process.argv.filter(value => value.startsWith(edition.protocol + ':'));
app.on('open-url', (event, url) => {
  event.preventDefault();
  if (runtime) runtime.openDeepLink(url);
  else deepLinks.push(url);
});

function acquireInstance(): DesktopInstanceGuard | undefined {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  try {
    const acquired = DesktopInstanceGuard.acquireSync({
      identity: instanceIdentity({ packaged: app.isPackaged, application: edition.application, configRoot: configRootFrom(), defaultConfigRoot: join(userInfo().homedir, edition.configDirectory), env: process.env }),
      protocol: edition.protocol,
      argv: process.argv,
      addon: nativeAddonPath(),
    });
    if (acquired.acquired) return acquired.guard;
    if (!acquired.forwarded) dialog.showErrorBox('Klaus is already running', 'Quit the other Klaus application, including its background process, before starting this installation.');
    app.exit(acquired.forwarded ? 0 : 1);
  } catch (error) {
    dialog.showErrorBox('Klaus could not secure its data profile', error instanceof Error ? error.message : String(error));
    app.exit(1);
  }
  return undefined;
}

const notificationProbe = notificationProbeRequested();
const guard = notificationProbe ? undefined : acquireInstance();
if (notificationProbe) {
  void app.whenReady().then(async () => { app.exit((await runNotificationProbe()) ? 0 : 1); })
    .catch(error => { process.stderr.write(`notification probe failed: ${String(error)}\n`); app.exit(1); });
} else if (guard) {
  let windowsProfile: WindowsProfileResult | undefined;
  if (process.platform === 'win32') {
    try { windowsProfile = prepareWindowsProfile({ configRoot: configRootFrom(), appData: app.getPath('appData'), legacyUserDataDir: process.env.KLAUS_USER_DATA_DIR, legacyMigration: edition.legacyIdentity }); }
    catch (error) {
      try { guard.closeSync(); } catch (closeError) { console.error('Klaus instance startup cleanup:', closeError); }
      dialog.showErrorBox('Klaus could not prepare its profile', error instanceof Error ? error.message : String(error));
      app.exit(1);
    }
  }
  const activate = (activation: InstanceActivation): void => {
    if (quitting) return;
    guard.assertHeld();
    runtime?.show();
    if (activation.deepLink) {
      if (runtime) runtime.openDeepLink(activation.deepLink);
      else deepLinks.push(activation.deepLink);
    }
  };
  app.on('second-instance', (_event, argv) => {
    try { activate(instanceActivation(argv, edition.protocol)); } catch (error) { console.error('Klaus instance activation:', error); }
  });
  app.on('activate', () => runtime?.show());
  app.on('window-all-closed', () => { /* Closing a window keeps background work and the tray alive. */ });
  app.on('before-quit', event => {
    if (quitReady) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void (async () => {
      let failed = false;
      try {
        await preparation;
        if (app.isReady()) await startup;
        if (!ownershipFailure) {
          try { await runtime?.prototype.prepareToClose(); }
          catch (error) {
            if (ownershipFailure) throw error;
            runtime?.prototype.abortClosePreparation();
            runtime?.videoEditing.abortClosePreparation();
            quitting = false;
            console.error('Klaus design save:', error);
            runtime?.show();
            dialog.showErrorBox('Klaus could not save the interface design', error instanceof Error ? error.message : String(error));
            return;
          }
          try { await runtime?.videoEditing.prepareToClose(); }
          catch (error) {
            if (ownershipFailure) throw error;
            runtime?.prototype.abortClosePreparation();
            runtime?.videoEditing.abortClosePreparation();
            quitting = false;
            console.error('Klaus video save:', error);
            runtime?.show();
            dialog.showErrorBox('Klaus could not close the video editor', error instanceof Error ? error.message : String(error));
            return;
          }
        }
        await runtime?.shutdown();
      }
      catch (error) { failed = true; console.error('Klaus shutdown:', error); }
      // A failed data-owner shutdown retains the native lock until process exit.
      if (!failed) {
        try { await guard.close(); } catch (error) { failed = true; console.error('Klaus instance shutdown:', error); }
      }
      await development?.send({ type: 'klaus:dev:closed', exitCode: failed || ownershipFailure ? 1 : 0,
        engineCount: runtime?.engine.liveProcessCount() ?? 0, native: runtime?.nativeCounts() });
      quitReady = true;
      if (failed || ownershipFailure) app.exit(1); else app.quit();
    })();
  });
  try {
    guard.listen({ onActivation: activate, onLost: error => {
      ownershipFailure = error;
      console.error('Klaus lost exclusive ownership of its data profile:', error);
      app.quit();
    } });
    guard.assertHeld();
    preparation = ensureSettingsBackup(configRootFrom());
  } catch (error) { preparation = Promise.reject(error); }
  startup = preparation.then(async () => {
    if (quitting) return;
    await app.whenReady();
    if (quitting) return;
    guard.assertHeld();
    // Reclaim only this edition's protocol so another installation cannot
    // receive its friend invitations or session activation links.
    if (app.isPackaged) app.setAsDefaultProtocolClient(edition.protocol);
    runtime = await createDesktopRuntime(app, { windowsProfile });
    if (!quitting) for (const url of deepLinks.splice(0)) runtime.openDeepLink(url);
    if (!quitting) await development?.send({ type: 'klaus:dev:ready', engines: runtime.engine.inspect().map(({ pid, generation }) => ({ pid, generation })) });
  }).catch(error => {
    dialog.showErrorBox('Klaus could not start', describeStartupFailure(error));
    app.quit();
  });
}
