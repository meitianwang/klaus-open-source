import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnElectronGui } from './electron-test-preflight.cjs';
const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(desktop, 'package.json'));
const output = join(desktop, 'dist/file-browser-logs');
const fixture = join(output, 'fixture');
mkdirSync(fixture, { recursive: true });
await require('esbuild').build({ entryPoints: [join(desktop, 'tests/workspace-file-browser-dom-entry.tsx')],
  outfile: join(fixture, 'browser.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  loader: { '.module.css': 'local-css', '.svg': 'text', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' }, logLevel: 'silent' });
const source = readFileSync(join(desktop, 'frontend/index.html'), 'utf8');
const tree = source.slice(source.indexOf('<div class="artifacts-section workspace-file-sidebar"'), source.indexOf('<!-- Artifacts:'));
const viewer = source.slice(source.indexOf('<div id="workspace-main-view"'), source.indexOf('<!-- Integrated terminal'));
cpSync(join(desktop, 'frontend/css/styles.css'), join(fixture, 'styles.css'));
writeFileSync(join(fixture, 'index.html'), `<!doctype html><html lang="zh" data-theme="light"><head><meta charset="utf-8"><link rel="stylesheet" href="styles.css"><link rel="stylesheet" href="browser.css"><style>
body{margin:0}#app{height:100vh}#artifacts-panel{position:fixed;z-index:2;right:0;top:0;height:100vh;width:620px;max-width:100vw;transform:none}#main{flex:1;background:var(--bg)}#main>p{margin:24px;color:var(--fg-tertiary)}.artifacts-body{flex:1}.workspace-file-empty{padding:24px}textarea.fixture-input{display:none}
</style></head><body class="artifacts-open"><div id="app"><main id="main"><p>工作区</p></main><aside id="artifacts-panel" class="artifacts-panel" data-mode="workspace"><div class="artifacts-body">${tree}${viewer}</div></aside></div><textarea class="fixture-input"></textarea><script src="browser.js"></script></body></html>`);
const binary = require('electron');
const args = [join(desktop, 'tests/workspace-file-browser-electron.cjs')];
const profile = mkdtempSync(join(output, 'profile-'));
const env = { ...process.env, KLAUS_FILE_BROWSER_TEST_ROOT: output, KLAUS_FILE_BROWSER_TEST_PROFILE: profile };
delete env.ELECTRON_RUN_AS_NODE;
const chunks = [`COMMAND: ${JSON.stringify([binary, ...args])}\n`];
const child = spawnElectronGui(binary, args, { cwd: desktop, env, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { chunks.push(String(chunk)); process.stdout.write(chunk); });
const timer = setTimeout(() => child.kill('SIGTERM'), 90000);
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
clearTimeout(timer);
rmSync(profile, { recursive: true, force: true });
chunks.push(`\nEXIT: ${code}\n`);
writeFileSync(join(output, 'native.log'), chunks.join(''));
process.exitCode = code === 0 ? 0 : 1;
