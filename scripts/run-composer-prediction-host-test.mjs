import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const desktop = dirname(dirname(fileURLToPath(import.meta.url))), require = createRequire(import.meta.url);
const output = join(desktop, 'dist/prediction-logs');
mkdirSync(output, { recursive: true });
for (const suite of ['composer-predictions', 'prediction-query']) {
  const entry = join(output, `${suite}.test.cjs`);
  await require('esbuild').build({ entryPoints: [join(desktop, `tests/${suite}.test.ts`)], outfile: entry, platform: 'node', format: 'cjs', bundle: true, logLevel: 'silent' });
  const command = [require('electron'), entry];
  const result = spawnSync(command[0], command.slice(1), { cwd: desktop, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 60_000 });
  const log = `$ ELECTRON_RUN_AS_NODE=1 ${JSON.stringify(command)}\n${result.stdout || ''}${result.stderr || ''}\nexit_code=${result.status}\n`;
  writeFileSync(join(output, `${suite}-host.log`), log); process.stdout.write(log);
  if (result.error) throw result.error;
  if (result.status !== 0 || !result.stdout.includes(`${suite}: `) || !result.stdout.includes('0 failed')) process.exit(result.status || 1);
}
