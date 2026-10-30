import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnElectronGui } from './electron-test-preflight.cjs';
const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(join(desktop, 'package.json'));
const output = join(desktop, 'dist/site-reference-logs');
const fixture = join(output, 'fixture');
mkdirSync(fixture, { recursive: true });
await require('esbuild').build({ entryPoints: [join(desktop, 'frontend/src/chat/transcript/site-reference-dom-entry.tsx')],
  outfile: join(fixture, 'browser.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic',
  loader: { '.module.css': 'local-css', '.svg': 'text' }, logLevel: 'silent' });
writeFileSync(join(fixture, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="browser.css"><style>
:root{--bg:#fff;--bg-elevated:#f7f7f8;--fg:#18181b;--fg-secondary:#737373;--fg-tertiary:#737373;--border:#e5e5e5;--accent:#18181b;--radius-sm:10px;--radius-xxs:3px;--text-small:13px;--weight-medium:500}
*{box-sizing:border-box}body{margin:0;font:14px system-ui;color:var(--fg);background:var(--bg)}button{font:inherit}.kls-icon-host{display:contents}svg{flex:none}#scroll{width:calc(100% - 240px);height:100vh;overflow-y:auto}#scroll>[data-klaus-transcript-turn]{padding:20px 65px}.msg-group.user{margin-bottom:20px}.msg.user{margin-left:100px;padding:15px;background:#eaf3ff;border-radius:14px}.msg.assistant{line-height:1.7}.msg-actions{margin-top:12px;color:#777;font-size:12px}#artifacts{position:fixed;right:0;top:0;width:240px;padding:16px;border-left:1px solid var(--border);height:100vh}#rail{position:fixed;right:248px;top:30px;width:40px}#rail-list button{display:block;height:20px}#nav-preview{position:fixed;right:280px;top:50px;background:#fff;border:1px solid #ddd}.turn-navigation-line{display:block;width:10px;height:2px;background:#aaa}
@media(max-width:600px){#scroll{width:100%}#scroll>[data-klaus-transcript-turn]{padding:15px}#artifacts,#rail{display:none}.msg.user{margin-left:20px}}
</style></head><body><div id="scroll"><div data-klaus-transcript-turn><div class="msg-group user" data-nav-turn="true"><div class="msg user">预览页面先给我看</div></div><div id="message"></div></div><div data-klaus-transcript-turn><div class="msg-group user" data-nav-turn="true"><div class="msg user">下一步</div></div><div class="msg assistant">后续回复</div></div></div><aside id="artifacts"><section id="monitor-section-artifacts"><b>产物</b><span id="monitor-artifacts-count"></span><div id="monitor-artifacts-body"></div></section></aside><div id="rail"><div id="rail-list"></div></div><div id="nav-preview" hidden></div><script src="browser.js"></script></body></html>`);
cpSync(join(desktop, 'frontend/public/logo.png'), join(fixture, 'logo.png'));
const binary = require('electron');
const args = [join(desktop, 'tests/site-reference-electron.cjs')];
const env = { ...process.env, KLAUS_SITE_TEST_ROOT: output };
delete env.ELECTRON_RUN_AS_NODE;
const chunks = [`COMMAND: ${JSON.stringify([binary, ...args])}\n`];
const child = spawnElectronGui(binary, args, { cwd: desktop, env, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { chunks.push(String(chunk)); process.stdout.write(chunk); });
const timer = setTimeout(() => child.kill('SIGTERM'), 60000);
const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
clearTimeout(timer);
chunks.push(`\nEXIT: ${code}\n`);
writeFileSync(join(output, 'native.log'), chunks.join(''));
process.exitCode = code === 0 ? 0 : 1;
