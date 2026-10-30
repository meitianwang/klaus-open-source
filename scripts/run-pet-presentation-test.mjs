import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { appendFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertElectronGuiAvailable } from './electron-test-preflight.cjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const directory = resolve(process.argv[2] || join(desktop, 'dist/pet-presentation-logs'));
mkdirSync(directory, { recursive: true });
const logs = mkdtempSync(join(directory, 'run-'));
const gate = join(logs, 'gate.log');
function run(command, args) {
  appendFileSync(gate, `COMMAND ${JSON.stringify([command, ...args])}\n`);
  const result = spawnSync(command, args, { cwd: desktop, encoding: 'utf8', timeout: 90_000, maxBuffer: 8 * 1024 * 1024 });
  appendFileSync(gate, `${result.stdout || ''}${result.stderr || ''}\nEXIT ${result.status}\n`);
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
  if (result.error || result.status !== 0) throw result.error || Error(`Command failed: ${command}`);
}
try {
  assertElectronGuiAvailable();
  run(process.execPath, [join(desktop, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.build.json']);
  run(process.execPath, ['scripts/build-preload.mjs']);
  await build({
    bundle: true, platform: 'browser', format: 'iife', target: 'chrome140', jsx: 'automatic',
    entryPoints: [join(desktop, 'frontend/src/pets/main.tsx')], outfile: join(logs, 'pet.js'),
    define: { 'import.meta.url': JSON.stringify('klaus-app://app/pet.js') },
    loader: { '.module.css': 'local-css', '.svg': 'text', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
  });
  cpSync(join(desktop, 'frontend/public/pets'), join(logs, 'pets'), { recursive: true });
  writeFileSync(join(logs, 'pet.html'), readFileSync(join(desktop, 'frontend/pet.html'), 'utf8').replace(
    '<script type="module" src="/src/pets/main.tsx"></script>',
    '<link rel="stylesheet" href="/pet.css"><script src="/pet.js"></script>',
  ));
  const helper = join(logs, 'pet-window-input');
  run('/usr/bin/xcrun', ['clang', '-O2', '-fobjc-arc', '-fblocks', '-Wall', '-Wextra', '-Werror', 'tests/fixtures/pet-window-input.m', '-framework', 'AppKit', '-framework', 'Carbon', '-o', helper]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', helper]);
  run(process.execPath, ['scripts/run-electron-test.mjs', 'tests/desktop-pet-presentation-electron.cjs', logs]);
} catch (error) {
  appendFileSync(gate, `${error.stack || error}\n`); console.error(error); process.exitCode = 1;
} finally { console.log(`Companion presentation evidence: ${logs}`); }
