import { posix, win32 } from 'node:path';

export interface DesktopPathContext {
  appRoot: string;
  packaged: boolean;
  resourcesPath?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

/** A packaged app never searches the checkout or the current working directory. */
export function resolveDesktopPaths(context: DesktopPathContext) {
  const platform = context.platform ?? process.platform;
  const arch = context.arch ?? process.arch;
  const path = platform === 'win32' ? win32 : posix;
  if (!path.isAbsolute(context.appRoot)) throw new Error('The desktop app root must be absolute');
  if (context.packaged && (!context.resourcesPath || !path.isAbsolute(context.resourcesPath))) {
    throw new Error('A packaged desktop requires an absolute Electron resourcesPath');
  }
  const resourcesRoot = context.packaged ? context.resourcesPath! : path.join(context.appRoot, 'resources');
  const platformKey = `${platform}-${arch}`;
  return {
    appRoot: context.appRoot,
    resourcesRoot,
    manualPath: path.join(resourcesRoot, 'manual', 'klaus-manual.md'),
    frontendRoot: context.packaged ? path.join(resourcesRoot, 'frontend') : path.join(context.appRoot, 'frontend-dist'),
    contractsRoot: path.join(context.appRoot, 'contracts'),
    engineBinDir: path.join(resourcesRoot, 'bin', platformKey),
    nativeAddonPath: context.packaged
      ? path.join(resourcesRoot, 'native', `klaus-native-${platformKey}.node`)
      : path.join(context.appRoot, 'native', 'artifacts', `klaus-native-${platformKey}.node`),
    chromeHostScript: path.join(context.appRoot, 'dist', 'main', 'browser', 'chrome-native-host.js'),
    chromeExtensionRoot: path.join(resourcesRoot, 'plugins-builtin', 'browser', 'chrome-extension'),
    speechHelperPath: platform === 'darwin' ? path.join(resourcesRoot, 'speech', platformKey, 'klaus-speech-helper') : undefined,
    recordingHelperPath: platform === 'darwin' ? path.join(resourcesRoot, 'recording', platformKey, 'klaus-recording-helper') : undefined,
    pipProducerPath: platform === 'darwin' ? path.join(resourcesRoot, 'pip', platformKey, 'klaus-pip-producer') : undefined,
    computerUseHelperPath: platform === 'darwin' || platform === 'win32'
      ? path.join(resourcesRoot, 'computer-use', platformKey, 'klaus-computer-use-helper' + (platform === 'win32' ? '.exe' : '')) : undefined,
  };
}
