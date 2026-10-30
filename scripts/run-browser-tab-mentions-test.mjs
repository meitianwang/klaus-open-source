import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(desktop, 'package.json'));
const output = join(desktop, 'dist', 'browser-tab-mentions-gui-logs');
const fixture = join(output, 'fixture');
mkdirSync(fixture, { recursive: true });
copyFileSync(join(desktop, 'frontend/css/styles.css'), join(fixture, 'shared.css'));
const esbuild = require('esbuild');
await esbuild.build({ entryPoints: [join(desktop, 'tests/fixtures/browser-tab-mentions-renderer.tsx')], outfile: join(fixture, 'browser.js'),
  bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', target: 'es2022', define: { 'process.env.NODE_ENV': '"production"' },
  loader: { '.module.css': 'local-css', '.svg': 'text' }, logLevel: 'warning' });
for (const [entry, name] of [['tests/browser-tab-mentions-gui.fixture.ts', 'fixture'], ['tests/fixtures/browser-tab-mentions-preload.ts', 'browser-tab-mentions-preload'],
  ['main/browser/dialog-preload.ts', 'dialog-preload'], ['main/browser/dialog-window-preload.ts', 'dialog-window-preload']]) {
  await esbuild.build({ entryPoints: [join(desktop, entry)], outfile: join(fixture, `${name}.js`), bundle: true, platform: 'node', format: 'cjs', target: 'node22', external: ['electron'], logLevel: 'warning' });
}
writeFileSync(join(fixture, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src data:"><link rel="stylesheet" href="shared.css"><link rel="stylesheet" href="browser.css"><style>
:root{--bg:#fff;--bg-elevated:#f7f7f8;--bg-hover:#eef2ff;--fg:#18181b;--fg-secondary:#707070;--fg-tertiary:#707070;--border:#ddd;--radius-sm:10px;--radius-xs:6px;--radius-xxs:3px;--text-small:13px;--text-body-sm:13px;--text-caption:12px;--weight-medium:500;--font:system-ui}*{box-sizing:border-box}html,body{margin:0;font-family:system-ui;color:var(--fg);background:var(--bg)}main{padding:30px;width:900px}textarea{width:850px;height:80px;font:16px system-ui}.hidden{display:none}#menu{position:static;width:850px;max-height:420px;overflow:auto;background:#fff;border:1px solid #ddd;border-radius:12px;padding:8px}button{font:inherit}#preview,#history{margin-top:20px}.slash-pill{display:inline-flex;align-items:center;gap:5px;border-radius:6px;background:#eef2ff;padding:4px 8px}img[hidden]{display:none}h1{font-size:20px}
</style></head><body><main><h1>Browser tab mention regression</h1><textarea id="composer" aria-label="Composer"></textarea><div id="menu" class="slash-menu kls-select-panel hidden"></div><div id="preview"></div><div id="history"></div></main><script src="browser.js"></script></body></html>`);
const log = join(output, 'run.log');
writeFileSync(log, `COMMAND: node apps/desktop/scripts/run-browser-tab-mentions-test.mjs${process.argv.includes('--build-only') ? ' --build-only' : ''}\n`);
if (process.argv.includes('--build-only')) {
  appendFileSync(log, 'Browser mention fixture bundled.\nEXIT: 0\n'); process.stdout.write('Browser mention fixture bundled.\n');
} else {
  const preflight = spawnSync(process.execPath, [join(desktop, 'scripts/electron-test-preflight.cjs')], { cwd: desktop, encoding: 'utf8', timeout: 40000 });
  appendFileSync(log, `$ node apps/desktop/scripts/electron-test-preflight.cjs\n${preflight.stdout || ''}${preflight.stderr || ''}\nEXIT: ${preflight.status}\n`);
  if (preflight.error || preflight.status !== 0) throw preflight.error || new Error(preflight.stderr || 'Electron preflight failed');
  const profile = mkdtempSync(join(output, 'profile-'));
  const command = [join(desktop, 'scripts/run-electron-test.mjs'), join(fixture, 'fixture.js')];
  appendFileSync(log, `COMMAND: ${JSON.stringify([process.execPath, ...command])}\nPROFILE: ${profile}\n`);
  const child = spawn(process.execPath, command, { cwd: desktop, env: { ...process.env, KLAUS_TAB_MENTION_TEST_ROOT: output, KLAUS_TAB_MENTION_TEST_PROFILE: profile }, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { appendFileSync(log, chunk); process.stdout.write(chunk); });
  const timer = setTimeout(() => child.kill('SIGTERM'), 90000);
  const code = await new Promise((resolveCode, reject) => { child.once('error', reject); child.once('close', resolveCode); });
  clearTimeout(timer); appendFileSync(log, `\nEXIT: ${code}\n`); process.exitCode = code === 0 ? 0 : 1;
}
