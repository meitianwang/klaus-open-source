import { createRequire } from 'node:module';
import { dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { assertElectronGuiAvailable, spawnElectronGui } from './electron-test-preflight.cjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const logs = resolve(desktop, 'dist/design-editor-logs');
assertElectronGuiAvailable();
mkdirSync(logs, { recursive: true });

for (const script of ['build-preload.mjs']) {
  const result = spawnSync(process.execPath, [resolve(desktop, 'scripts', script)], { cwd: desktop, stdio: 'inherit' });
  if (result.status !== 0) throw Error(`Design Canvas preparation failed: ${script}`);
}
for (const [entry, output] of [['main/design/service.ts', 'design-service.cjs'], ['main/app/protocol.ts', 'design-protocol.cjs']]) {
  buildSync({ entryPoints: [resolve(desktop, entry)], outfile: resolve(logs, output), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawnElectronGui(createRequire(import.meta.url)('electron'), [resolve(desktop, 'tests/design-ui-fixture.cjs')], { env, cwd: desktop, stdio: 'inherit' });
const forward = signal => child.kill(signal);
const interrupt = () => forward('SIGINT');
const terminate = () => forward('SIGTERM');
process.on('SIGINT', interrupt);
process.on('SIGTERM', terminate);
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('close', (code, signal) => {
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', terminate);
  try {
    const metadata = resolve(logs, 'ui-profile.json');
    if (existsSync(metadata)) {
      const profile = resolve(JSON.parse(readFileSync(metadata, 'utf8')).profile);
      if (dirname(profile) !== resolve(tmpdir()) || !basename(profile).startsWith('klaus-design-ui-')) {
        throw Error('The Design Canvas fixture profile is outside its temporary directory.');
      }
      rmSync(profile, { recursive: true, force: true });
      if (existsSync(profile)) throw Error('The Design Canvas fixture profile was not removed.');
      console.log('Design Canvas fixture temporary profile removed after Electron exit.');
    }
    if (signal) console.error(`Design Canvas fixture terminated by ${signal}`);
    process.exitCode = code ?? 1;
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
});
