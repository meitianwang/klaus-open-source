import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnElectronGui } from './electron-test-preflight.cjs';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(desktop, 'package.json'));
const root = join(desktop, 'dist', 'transcript-retention-logs');
mkdirSync(root, { recursive: true });
const output = mkdtempSync(join(root, 'run-'));
const fixture = join(output, 'fixture');
mkdirSync(fixture);
const dependencies = [
  'frontend/src/chat/transcript-retention-dom-entry.tsx', 'frontend/src/chat/transcript-scroll-controller.ts',
  'frontend/src/chat/transcript/TranscriptView.tsx', 'frontend/src/chat/transcript/virtual-transcript.tsx',
  'frontend/src/chat/transcript/virtual-turn-list.tsx', 'frontend/src/chat/transcript/virtual-turn-layout.ts',
  'frontend/src/chat/stream-store.ts', 'frontend/src/chat/saved-history-retention.ts',
  'frontend/src/chat/saved-transcript.ts', 'frontend/src/chat/transcript-pagination.ts', 'frontend/css/styles.css',
];
writeFileSync(join(output, 'sources.json'), JSON.stringify(Object.fromEntries(dependencies.map(path => [path,
  createHash('sha256').update(readFileSync(join(desktop, path))).digest('hex')])), null, 2));
await require('esbuild').build({
  entryPoints: [join(desktop, 'frontend/src/chat/transcript-retention-dom-entry.tsx')],
  outfile: join(fixture, 'browser.js'), bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic',
  loader: { '.module.css': 'local-css', '.svg': 'text' }, define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
});
await require('esbuild').build({
  entryPoints: [join(desktop, 'frontend/src/chat/markdown.worker.ts')],
  outfile: join(fixture, 'retention-markdown-worker.js'), bundle: true, format: 'esm', platform: 'browser',
  define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
});
const css = pathToFileURL(join(desktop, 'frontend/css/styles.css')).href;
writeFileSync(join(fixture, 'index.html'), `<!doctype html><html lang="en" data-theme="light"><head><meta charset="utf-8">
<link rel="stylesheet" href="${css}"><link rel="stylesheet" href="browser.css"><style>
html,body{margin:0;width:1200px;height:800px;overflow:hidden}
#messages,#secondary{position:absolute;top:0;height:760px;box-sizing:border-box;overflow:auto;--titlebar-height:0px;--thread-scroll-padding-bottom:16px}
#messages{display:block!important;left:0;width:1000px}#secondary{left:1000px;width:200px;display:none}
</style></head><body><main id="messages" tabindex="-1"></main><main id="secondary" tabindex="-1"></main><script src="browser.js"></script></body></html>`);
const executable = require('electron');
const args = [join(desktop, 'tests/transcript-retention-electron.cjs')];
const env = { ...process.env, KLAUS_RETENTION_TEST_ROOT: output };
delete env.ELECTRON_RUN_AS_NODE;
const log = [`Command: ${JSON.stringify([executable, ...args])}\n`];
let child, timer;
try {
  child = spawnElectronGui(executable, args, { cwd: desktop, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { log.push(String(chunk)); process.stdout.write(chunk); });
  timer = setTimeout(() => child.kill('SIGTERM'), 90000);
  const code = await new Promise((resolve, reject) => { child.once('close', resolve); child.once('error', reject); });
  clearTimeout(timer);
  log.push(`\nExit: ${code}\n`);
  process.exitCode = code === 0 ? 0 : 1;
} catch (error) {
  log.push(String(error.stack || error));
  console.error(error.stack || error);
  process.exitCode = 1;
} finally {
  if (timer) clearTimeout(timer);
  writeFileSync(join(output, 'native.log'), log.join(''));
  rmSync(join(output, 'profile'), { recursive: true, force: true });
  console.log(`Evidence: ${output}`);
}
