import { isAbsolute, join, relative, resolve } from 'node:path';
import { requireTarget } from './resources.mjs';
import { DEFAULT_DESKTOP_EDITION, desktopEdition } from './desktop-edition.mjs';

/** Public @electron/osx-sign options; constructing this plan never signs a file. */
export function macSigningOptions({ app, arch, identity, electronVersion, edition: id = DEFAULT_DESKTOP_EDITION }) {
  const edition = desktopEdition(id);
  const target = requireTarget('darwin', arch);
  if (!isAbsolute(app) || !app.endsWith('.app')) throw new Error('Signing requires an absolute macOS application bundle');
  if (typeof identity !== 'string' || !identity.trim() || identity.trim() === '-') throw new Error('Supply an explicit Developer ID signing identity');
  if (!/^\d+\.\d+\.\d+$/.test(electronVersion ?? '')) throw new Error('Signing requires the exact packaged Electron version');
  const bundle = resolve(app), resources = join(bundle, 'Contents/Resources');
  const speech = join(resources, 'speech', target, 'klaus-speech-helper');
  const recording = join(resources, 'recording', target, 'klaus-recording-helper');
  const pip = join(resources, 'pip', target, 'klaus-pip-producer');
  const computerUse = join(resources, 'computer-use', target, 'klaus-computer-use-helper');
  const engine = join(resources, 'bin', target, 'klaus-agent-stdio');
  const native = join(resources, 'native', `klaus-native-${target}.node`);
  return {
    app: bundle, platform: 'darwin', identity, identityValidation: true, version: electronVersion,
    binaries: [engine, native, speech, recording, pip, computerUse],
    optionsForFile(file) {
      const path = resolve(file), inside = relative(bundle, path);
      if (inside.startsWith('..') || isAbsolute(inside)) throw new Error('Signing options cannot target a file outside the application');
      if (path === bundle || path === join(bundle, `Contents/MacOS/${edition.executableName}`)) return {
        hardenedRuntime: true,
        entitlements: ['com.apple.security.cs.allow-jit', 'com.apple.security.device.audio-input', 'com.apple.security.device.camera',
          'com.apple.security.personal-information.photos-library'],
      };
      if (path === speech) return { hardenedRuntime: true, entitlements: ['com.apple.security.device.audio-input'] };
      // The engine embeds V8 for locale sorting. Its executable pages require
      // JIT permission under hardened runtime, independently of Electron's V8.
      if (path === engine) return { hardenedRuntime: true, entitlements: ['com.apple.security.cs.allow-jit'] };
      if (path === native || path === recording || path === pip || path === computerUse) return { hardenedRuntime: true, entitlements: [] };
      // Electron's framework and renderer/GPU helpers retain osx-sign defaults.
      return { hardenedRuntime: true };
    },
  };
}
