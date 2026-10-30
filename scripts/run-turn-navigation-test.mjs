import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnElectronGui } from './electron-test-preflight.cjs';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(desktop, 'package.json'));
const output = join(desktop, 'dist', 'turn-navigation-logs');
const fixture = join(output, 'fixture');
mkdirSync(fixture, { recursive: true });
await require('esbuild').build({
  entryPoints: [join(desktop, 'frontend/src/chat/turn-navigation-dom-entry.ts')],
  outfile: join(fixture, 'browser.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  loader: { '.module.css': 'local-css', '.svg': 'text' }, logLevel: 'silent',
});
const source = readFileSync(join(desktop, 'frontend/css/styles.css'), 'utf8');
const start = source.indexOf('.turn-navigation[hidden]');
const finish = source.indexOf('.turn-navigation-tooltip[hidden]', start);
writeFileSync(join(fixture, 'layout.css'), source.slice(start, source.indexOf('}', finish) + 1));
writeFileSync(join(fixture, 'index.html'), `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="layout.css"><link rel="stylesheet" href="browser.css"><style>
:root{--fg:#18181b;--fg-secondary:#707070;--fg-tertiary:#707070;--bg-elevated:#f7f7f8;--border:#dddddf;--radius-sm:10px;--radius-xxs:3px;--text-small:13px;--weight-medium:500;--accent:#6366f1}
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;font-family:system-ui}#host{position:relative;width:100%;height:100%}#scroll{width:100%;height:100%;overflow-y:scroll;overflow-anchor:none;--fixture-gutter:80px}
.msg-group.user{margin-left:var(--fixture-gutter);width:calc(100% - 160px);height:64px}.assistant-row{margin-left:80px;height:184px}.msg.user{padding:12px;border:1px solid #ddd;border-radius:10px}.msg.assistant{padding:12px}.msg-actions{font-size:10px}.sent-user-stack{display:block}
</style></head><body><div id="host"><div id="scroll" tabindex="-1"></div></div><script src="browser.js"></script></body></html>`);
const binary = require('electron');
const args = [join(desktop, 'tests/turn-navigation-electron.cjs')];
const env = { ...process.env, KLAUS_NAV_TEST_ROOT: output };
delete env.ELECTRON_RUN_AS_NODE;
const chunks = ['COMMAND: ' + JSON.stringify([binary, ...args]) + '\n'];
const child = spawnElectronGui(binary, args, { cwd: desktop, env, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { chunks.push(String(chunk)); process.stdout.write(chunk); });
const timer = setTimeout(() => child.kill('SIGTERM'), 120000);
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
clearTimeout(timer);
chunks.push('\nEXIT: ' + code + '\n');
writeFileSync(join(output, 'native.log'), chunks.join(''));
process.exitCode = code === 0 ? 0 : 1;
