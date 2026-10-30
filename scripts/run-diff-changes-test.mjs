import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnElectronGui } from './electron-test-preflight.cjs';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(desktop, 'package.json'));
const shell = process.argv.includes('--shell');
const output = join(desktop, 'dist', shell ? 'changes-navigation-logs' : 'changes-review-logs');
const fixture = join(output, 'fixture');
mkdirSync(fixture, { recursive: true });
copyFileSync(join(desktop, 'frontend/css/styles.css'), join(fixture, 'shared.css'));
await require('esbuild').build({
  entryPoints: [join(desktop, 'frontend/src/pages/diff', shell ? 'diff-changes-shell-dom-entry.ts' : 'diff-changes-dom-entry.tsx')],
  outfile: join(fixture, 'browser.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  loader: { '.module.css': 'local-css', '.svg': 'text' }, logLevel: 'silent',
});
if (shell) {
  const html = readFileSync(join(desktop, 'frontend/index.html'), 'utf8')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace('</head>', `<link rel="stylesheet" href="shared.css"><link rel="stylesheet" href="browser.css">
<style>.boot-screen{display:none!important}#changes-capsule-fixture{position:fixed;bottom:32px;left:40%;z-index:1000}#changes-entry-fixture{display:none}</style></head>`)
    .replace('</body>', '<div id="changes-capsule-fixture"></div><div id="changes-entry-fixture"></div><script src="browser.js"></script></body>');
  writeFileSync(join(fixture, 'index.html'), html);
} else writeFileSync(join(fixture, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="shared.css"><link rel="stylesheet" href="browser.css"><style>
:root{--bg:#fff;--fg:#18181b;--fg-secondary:#52525b;--fg-tertiary:#71717a;--fg-quaternary:#a1a1aa;--bg-hover:#f4f4f5;--border:#dedee2;--border-subtle:#e4e4e7;--radius-xs:6px;--text-title:18px;--text-small:12px;--text-body-sm:13px;--text-caption:11px;--weight-semibold:600;--weight-medium:500;--font:system-ui;--font-mono:ui-monospace,SFMono-Regular,monospace;--code-font-size:12px;--theme-diff-added:#16883f;--theme-diff-removed:#d43135;--theme-diff-added-bg:#e9f8ef;--theme-diff-removed-bg:#fceced}
:root[data-theme=dark]{--bg:#1b1b1d;--fg:#e4e4e7;--fg-secondary:#d4d4d8;--fg-tertiary:#a1a1aa;--fg-quaternary:#71717a;--bg-hover:#27272a;--border:#3f3f46;--border-subtle:#303036;--theme-diff-added:#64ce88;--theme-diff-removed:#f08084;--theme-diff-added-bg:#183727;--theme-diff-removed-bg:#3e2326;color-scheme:dark}
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;font-family:var(--font);background:var(--bg);color:var(--fg)}button,input,select{font:inherit}#diff-view{container-name:diff-view;container-type:inline-size;height:100%;overflow:hidden;display:flex;padding:0}#diff-view-content{min-width:0;width:100%;height:100%;display:flex}html:not([data-surface=capsule]) #changes-capsule-fixture{display:none}#changes-capsule-fixture{position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:20}#changes-entry-fixture{display:none}html[data-surface=entry] #diff-view,html[data-surface=entry] #changes-capsule-fixture{display:none}html[data-surface=entry] #changes-entry-fixture{display:block;width:360px;padding:20px}

</style></head><body><section id="diff-view" class="active"><div id="diff-view-content"></div></section><div id="changes-capsule-fixture"></div><div id="changes-entry-fixture"></div><script src="browser.js"></script></body></html>`);
if (process.argv.includes('--build-only')) {
  const message = 'Changes renderer fixture bundled successfully.\n';
  writeFileSync(join(output, 'build.log'), `COMMAND: node apps/desktop/scripts/run-diff-changes-test.mjs${shell ? ' --shell' : ''} --build-only\n${message}EXIT: 0\n`);
  process.stdout.write(message);
} else {
  const binary = require('electron');
  const args = [join(desktop, 'tests', shell ? 'diff-changes-shell-electron.cjs' : 'diff-changes-electron.cjs')];
  const env = { ...process.env, KLAUS_DIFF_TEST_ROOT: output };
  delete env.ELECTRON_RUN_AS_NODE;
  const chunks = ['COMMAND: ' + JSON.stringify([binary, ...args]) + '\n'];
  let child;
  try { child = spawnElectronGui(binary, args, { cwd: desktop, env, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (error) { chunks.push(error.stack + '\nEXIT: 1\n'); writeFileSync(join(output, 'native.log'), chunks.join('')); throw error; }
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { chunks.push(String(chunk)); process.stdout.write(chunk); });
  const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  clearTimeout(timer);
  chunks.push('\nEXIT: ' + code + '\n');
  writeFileSync(join(output, 'native.log'), chunks.join(''));
  process.exitCode = code === 0 ? 0 : 1;
}
