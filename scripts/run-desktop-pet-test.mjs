import { build } from 'esbuild';
import { appendFileSync, copyFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logs = process.env.KLAUS_PET_TEST_LOGS || join(desktop, 'dist/pet-logs/gui');
mkdirSync(logs, { recursive: true });
const gate = join(logs, 'gate.log');
const execute = (args, timeout = 120_000) => {
  const result = spawnSync(process.execPath, args, { cwd: desktop, encoding: 'utf8', env: process.env, timeout, maxBuffer: 32 * 1024 * 1024 });
  appendFileSync(gate, `$ ${[process.execPath, ...args].join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}\nExit: ${result.status}\n`);
  process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`Command exited ${result.status}: ${args.join(' ')}`);
};
try {
  execute([join(desktop, 'scripts/electron-test-preflight.cjs')], 40_000);
  execute([join(desktop, 'scripts/derive-channel-contract.mjs')]);
  execute([join(desktop, 'node_modules/typescript/bin/tsc'), '--target', 'ES2023', '--module', 'CommonJS', '--moduleResolution', 'node', '--rootDir', '.', '--outDir', 'dist', '--strict', '--noUncheckedIndexedAccess', '--esModuleInterop', '--skipLibCheck', '--types', 'node',
    'main/app/desktop-pet.ts', 'main/app/windows.ts', 'main/ipc/handlers/desktop-pet.ts', 'main/ipc/binding.ts', 'main/ipc/router.ts', 'main/ipc/registry.ts', 'main/pets/activity.ts', 'main/pets/composer.ts', 'main/pets/voice.ts', 'contracts/desktop-pet-builtins.ts']);
  execute([join(desktop, 'scripts/build-preload.mjs')]);
  const options = { bundle: true, platform: 'browser', format: 'iife', target: 'chrome140', jsx: 'automatic', define: { 'import.meta.url': JSON.stringify('klaus-app://app/pet.js') }, loader: { '.module.css': 'local-css', '.svg': 'text', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, logLevel: 'warning' };
  await build({ ...options, entryPoints: [join(desktop, 'frontend/src/pets/main.tsx')], outfile: join(logs, 'pet.js') });
  await build({ ...options, format: 'esm', entryPoints: [join(desktop, 'frontend/src/pets/patch-summary.worker.ts')], outfile: join(logs, 'patch-summary.worker.ts') });
  await build({ ...options, entryPoints: [join(desktop, 'tests/desktop-pet-settings-dom-entry.tsx')], outfile: join(logs, 'settings.js') });
  cpSync(join(desktop, 'frontend/public/pets'), join(logs, 'pets'), { recursive: true });
  mkdirSync(join(logs, 'js'), { recursive: true });
  copyFileSync(join(desktop, 'frontend/public/js/voice-capture-worklet.js'), join(logs, 'js/voice-capture-worklet.js'));
  writeFileSync(join(logs, 'voice-fixture.js'), `(() => {
    const fixture = { streams: [], outputs: [], workers: [], amplitude: 0 };
    window.__petVoiceFixture = fixture;
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
      const context = new AudioContext(), oscillator = context.createOscillator(), gain = context.createGain(), destination = context.createMediaStreamDestination();
      gain.gain.value = fixture.amplitude; oscillator.frequency.value = 440; oscillator.connect(gain); gain.connect(destination); oscillator.start(); await context.resume();
      const stream = destination.stream, entry = { stream, context, gain, stopped: false }; fixture.streams.push(entry);
      for (const track of stream.getTracks()) { const stop = track.stop.bind(track); track.stop = () => { stop(); entry.stopped = true; oscillator.stop(); void context.close(); }; }
      return stream;
    } });
    const AudioElement = window.Audio;
    window.Audio = function (...args) { const element = new AudioElement(...args); fixture.outputs.push(element); return element; };
    window.Audio.prototype = AudioElement.prototype;
    const BackgroundWorker = window.Worker;
    window.Worker = class extends BackgroundWorker { constructor(...args) { super(...args); fixture.workers.push({ url: String(args[0]), messages: 0 }); const entry = fixture.workers.at(-1); this.addEventListener('message', () => { entry.messages++; }); } };
  })();`);
  copyFileSync(join(desktop, 'frontend/css/styles.css'), join(logs, 'global.css'));
  let html = readFileSync(join(desktop, 'frontend/pet.html'), 'utf8').replace('<script type="module" src="/src/pets/main.tsx"></script>', '<link rel="stylesheet" href="/pet.css"><script src="/voice-fixture.js"></script><script src="/pet.js"></script>');
  writeFileSync(join(logs, 'pet.html'), html);
  writeFileSync(join(logs, 'settings.html'), `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'self';style-src 'self' 'unsafe-inline';font-src 'self';img-src 'self' data: blob: klaus-pet:;connect-src 'self'"><link rel="stylesheet" href="/global.css"><link rel="stylesheet" href="/settings.css"><style>html,body{margin:0;background:var(--bg,#fff);color:var(--text,#1a1c1f);font-family:var(--font-ui,Arial,sans-serif)}#fixture-shell{display:flex;min-height:100vh}.fixture-nav{width:230px;flex:none;background:var(--bg-secondary,#f6f6f6);padding:40px 20px;box-sizing:border-box}.fixture-nav div{padding:10px 12px;margin:3px 0;font-size:13px}.fixture-nav .active{background:var(--hover-bg,#eaeaea);border-radius:8px}#fixture-root{flex:1;min-width:0;padding:38px 40px;max-width:1100px;margin:auto}@media(max-width:850px){.fixture-nav{width:145px;padding:30px 10px}#fixture-root{padding:24px 20px}}</style></head><body><div id="fixture-shell"><aside class="fixture-nav"><h3>Klaus</h3><div>Preferences</div><div>Keyboard shortcuts</div><div class="active">Mini &amp; Pets</div><div>Models</div><div>Permissions</div></aside><main id="fixture-root"></main></div><script src="/settings.js"></script></body></html>`);
  appendFileSync(gate, 'Built companion and settings renderers from production source.\n');
  if (!process.argv.includes('--build-only')) {
    if (process.platform === 'darwin') {
      const args = ['clang', join(desktop, 'tests/fixtures/recording-input.m'), '-framework', 'AppKit', '-framework', 'Carbon', '-o', join(logs, 'recording-input')];
      const result = spawnSync('xcrun', args, { cwd: desktop, encoding: 'utf8', timeout: 30_000 });
      appendFileSync(gate, `$ xcrun ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}\nExit: ${result.status}\n`);
      if (result.error) throw result.error;
      if (result.status !== 0) throw Error('Could not build the system input fixture');
      execute([join(desktop, 'scripts/run-electron-test.mjs'), join(desktop, 'tests/desktop-pet-main-input-electron.cjs'), logs], 40_000);
    }
    execute([join(desktop, 'scripts/run-electron-test.mjs'), join(desktop, 'tests/desktop-pet-electron.cjs'), logs], 150_000);
  }
} catch (error) {
  appendFileSync(gate, `${error?.stack ?? error}\n`); console.error(error); process.exitCode = 1;
}
