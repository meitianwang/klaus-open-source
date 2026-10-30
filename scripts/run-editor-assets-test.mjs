import { build } from 'vite';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertElectronGuiAvailable, spawnElectronGui } from './electron-test-preflight.cjs';
import { gateEnvironment } from './gate-runner.mjs';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const logs = join(desktop, 'dist/editor-assets-logs');
const output = join(logs, 'production');
mkdirSync(logs, { recursive: true });
assertElectronGuiAvailable();
const result = await build({
  configFile: join(desktop, 'vite.config.mts'),
  build: { outDir: output, rollupOptions: { input: join(desktop, 'tests/editor-assets-dom-entry.tsx') } },
});
if (!result || !('output' in result)) throw new Error('The editor dependency fixture did not emit a bundle');
const entry = result.output.find(file => file.type === 'chunk' && file.isEntry);
if (!entry) throw new Error('The editor dependency fixture has no entry chunk');
const policy = readFileSync(join(desktop, 'frontend/index.html'), 'utf8')
  .match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
if (!policy) throw new Error('The production content policy is missing');
const styles = result.output.filter(file => file.type === 'asset' && file.fileName.endsWith('.css'));
writeFileSync(join(output, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}">${styles.map(file => `<link rel="stylesheet" href="./${file.fileName}">`).join('')}</head><body><script type="module" src="./${entry.fileName}"></script></body></html>`);
writeFileSync(join(logs, 'assets.json'), JSON.stringify(result.output.map(file => ({
  fileName: file.fileName, type: file.type,
  bytes: Buffer.byteLength(file.type === 'chunk' ? file.code : file.source),
})), null, 2));
const profile = mkdtempSync(join(logs, 'profile-'));
const executable = createRequire(import.meta.url)('electron');
const args = [join(desktop, 'tests/editor-assets-electron.cjs'), output, logs, profile];
const env = gateEnvironment();
delete env.ELECTRON_RUN_AS_NODE;
const chunks = [`COMMAND: ${JSON.stringify([executable, ...args])}\n`];
let code;
try {
  const child = spawnElectronGui(executable, args, { cwd: desktop, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', data => { chunks.push(String(data)); process.stdout.write(data); });
  const timeout = setTimeout(() => child.kill('SIGTERM'), 120_000);
  try { code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }); }
  finally { clearTimeout(timeout); }
} finally {
  rmSync(profile, { recursive: true, force: true });
  chunks.push(`\nEXIT: ${code ?? 'error'}\n`);
  writeFileSync(join(logs, 'native.log'), chunks.join(''));
}
process.exitCode = code === 0 ? 0 : 1;
