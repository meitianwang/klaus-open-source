import { createRequire } from 'node:module';
import { dirname, resolve, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildSync } from 'esbuild';
import { assertElectronGuiAvailable, spawnElectronGui } from './electron-test-preflight.cjs';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repository = desktop;
const logs = resolve(desktop, 'dist/ppt-editor-logs');
assertElectronGuiAvailable();
mkdirSync(logs, { recursive: true });
for (const script of ['build-preload.mjs']) {
  const result = spawnSync(process.execPath, [resolve(desktop, 'scripts', script)], { cwd: repository, stdio: 'inherit' });
  if (result.status !== 0) throw Error(`PPT preparation failed: ${script}`);
}
for (const [entry, output] of [['main/ppt/service.ts', 'ppt-service.cjs'], ['main/app/protocol.ts', 'ppt-protocol.cjs']]) {
  buildSync({ entryPoints: [resolve(desktop, entry)], outfile: resolve(logs, output), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
}
const env = { ...process.env, PPT_EXTENDED: '1', PPT_CAPTURE: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawnElectronGui(createRequire(import.meta.url)('electron'), [resolve(desktop, 'tests/ppt-ui-fixture.cjs')], { env, cwd: repository, stdio: 'inherit' });
const forward = signal => child.kill(signal);
const interrupt = () => forward('SIGINT');
const terminate = () => forward('SIGTERM');
process.on('SIGINT', interrupt); process.on('SIGTERM', terminate);
child.once('error', error => { console.error(error); process.exitCode = 1; });
child.once('close', (code, signal) => {
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate);
  try {
    const metadata = resolve(logs, 'ui-profile.json');
    if (existsSync(metadata)) {
      const profile = resolve(JSON.parse(readFileSync(metadata, 'utf8')).profile);
      if (dirname(profile) !== resolve(tmpdir()) || !basename(profile).startsWith('klaus-ppt-ui-')) throw Error('The PPT fixture profile is outside its temporary directory.');
      // Chromium can recreate storage during shutdown, after the fixture's own cleanup.
      rmSync(profile, { recursive: true, force: true });
      if (existsSync(profile)) throw Error('The PPT fixture profile was not removed.');
      console.log('PPT fixture temporary profile removed after Electron exit.');
    }
    if (signal) console.error(`PPT fixture terminated by ${signal}`);
    process.exitCode = code ?? 1;
  } catch (error) { console.error(error); process.exitCode = 1; }
});
