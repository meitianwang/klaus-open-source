import { resolveDesktopPaths } from '../main/app/paths';
import { computerUseHelperPath } from '../main/paths';
import { equal as assertEqual } from 'node:assert/strict';
import { join } from 'node:path';
import { assertRejects, Harness } from './harness';

const h = new Harness();
void (async () => {
  await h.test('development resolves the single frontend and shared resources', () => {
    const value = resolveDesktopPaths({ appRoot: '/checkout', packaged: false, platform: 'darwin', arch: 'arm64' });
    assertEqual(value.frontendRoot, '/checkout/frontend-dist');
    assertEqual(value.engineBinDir, '/checkout/resources/bin/darwin-arm64');
    assertEqual(value.manualPath, '/checkout/resources/manual/klaus-manual.md');
    assertEqual(value.nativeAddonPath, '/checkout/native/artifacts/klaus-native-darwin-arm64.node');
    assertEqual(value.speechHelperPath, '/checkout/resources/speech/darwin-arm64/klaus-speech-helper');
    assertEqual(value.recordingHelperPath, '/checkout/resources/recording/darwin-arm64/klaus-recording-helper');
    assertEqual(value.pipProducerPath, '/checkout/resources/pip/darwin-arm64/klaus-pip-producer');
    assertEqual(value.computerUseHelperPath, '/checkout/resources/computer-use/darwin-arm64/klaus-computer-use-helper');
  });
  await h.test('a relocated macOS package uses only its resource tree', () => {
    const root = '/Volumes/Review App/Klaus.app/Contents/Resources';
    const value = resolveDesktopPaths({ appRoot: `${root}/app.asar`, resourcesPath: root, packaged: true, platform: 'darwin', arch: 'x64' });
    assertEqual(value.frontendRoot, `${root}/frontend`);
    assertEqual(value.manualPath, `${root}/manual/klaus-manual.md`);
    assertEqual(value.engineBinDir, `${root}/bin/darwin-x64`);
    assertEqual(value.nativeAddonPath, `${root}/native/klaus-native-darwin-x64.node`);
    assertEqual(value.chromeHostScript, `${root}/app.asar/dist/main/browser/chrome-native-host.js`);
    assertEqual(value.chromeExtensionRoot, `${root}/plugins-builtin/browser/chrome-extension`);
    assertEqual(value.speechHelperPath, `${root}/speech/darwin-x64/klaus-speech-helper`);
    assertEqual(value.recordingHelperPath, `${root}/recording/darwin-x64/klaus-recording-helper`);
    assertEqual(value.pipProducerPath, `${root}/pip/darwin-x64/klaus-pip-producer`);
    assertEqual(value.computerUseHelperPath, `${root}/computer-use/darwin-x64/klaus-computer-use-helper`);
  });
  await h.test('Windows resources stay on their installed drive with spaces', () => {
    const root = 'D:\\Programs\\Klaus Preview\\resources';
    const value = resolveDesktopPaths({ appRoot: `${root}\\app.asar`, resourcesPath: root, packaged: true, platform: 'win32', arch: 'x64' });
    assertEqual(value.engineBinDir, `${root}\\bin\\win32-x64`);
    assertEqual(value.manualPath, `${root}\\manual\\klaus-manual.md`);
    assertEqual(value.frontendRoot, `${root}\\frontend`);
    assertEqual(value.speechHelperPath, undefined);
    assertEqual(value.recordingHelperPath, undefined);
    assertEqual(value.pipProducerPath, undefined);
    assertEqual(value.computerUseHelperPath, `${root}\\computer-use\\win32-x64\\klaus-computer-use-helper.exe`);
  });
  await h.test('a package with a missing resource root fails without checkout fallback', async () => {
    await assertRejects(() => Promise.resolve(resolveDesktopPaths({ appRoot: '/app/app.asar', packaged: true })), 'missing resource root');
  });
  await h.test('the runtime helper accessor resolves Windows Computer Use instead of disabling it', () => {
    const value = computerUseHelperPath('win32', 'x64');
    assertEqual(typeof value, 'string');
    assertEqual(value!.replaceAll('\\', '/').endsWith('/computer-use/win32-x64/klaus-computer-use-helper.exe'), true);
    assertEqual(computerUseHelperPath('linux', 'x64'), undefined);
  });
  process.exitCode = await h.finish(join(__dirname, 'desktop-paths.result.json'), 'desktop-paths');
})();
