import { build } from 'esbuild';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { assertElectronGuiAvailable } from './electron-test-preflight.cjs';
assertElectronGuiAvailable();
const desktop = fileURLToPath(new URL('..', import.meta.url)), logs = join(desktop, 'dist/voice-chat-logs/ui');
mkdirSync(logs, { recursive: true });
await build({ entryPoints: [join(desktop, 'tests/voice-chat-ui-entry.tsx')], outfile: join(logs, 'voice-chat.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', target: 'chrome140', loader: { '.svg': 'text', '.glsl': 'text', '.webp': 'dataurl' } });
await build({ entryPoints: [join(desktop, 'frontend/src/chat/voice-chat/overlay.tsx')], outfile: join(logs, 'voice-native.js'), bundle: true, platform: 'browser', format: 'iife', jsx: 'automatic', target: 'chrome140', loader: { '.svg': 'text', '.glsl': 'text', '.webp': 'dataurl' } });
writeFileSync(join(logs, 'voice-native.html'), '<!doctype html><html data-klaus-window="voice-chat"><head><meta charset="utf-8"><link rel="stylesheet" href="voice-native.css"></head><body><div id="root"></div><script src="voice-native.js"></script></body></html>');
writeFileSync(join(logs, 'voice-chat.html'), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="../../../frontend/css/styles.css"><link rel="stylesheet" href="voice-chat.css"><style>
body { margin:0; font:14px system-ui; background:#fff;color:#1a1c1f } #main { position:relative;height:100vh;display:flex;flex-direction:column } #messages { flex:1;padding:48px 160px } #input-wrapper { position:relative;width:700px;margin:0 auto;padding:0 16px 20px } #input-area { border:1px solid #ddd;border-radius:20px;padding:16px } #input { outline:none;min-height:44px } .input-row { display:flex;align-items:center;gap:6px } button { cursor:pointer } #voice-input-btn { border:0;background:transparent }
</style></head><body><main id="main"><div id="messages"><p>Existing conversation messages and tool results stay in the transcript.</p></div><div id="input-wrapper"><div id="input-area"><div id="previews"></div><div id="input" contenteditable="true" role="textbox"></div><div class="input-row"><button id="composer-plus-btn">+</button><span>Model</span><button id="ctx-usage-chip" hidden></button><button id="voice-input-btn">Mic</button><button id="send">↑</button></div></div></div></main><script src="voice-chat.js"></script></body></html>`);
const profile = mkdtempSync(join(logs, 'profile-'));
let result;
try {
  result = spawnSync(process.execPath, [join(desktop, 'scripts/run-electron-test.mjs'), join(desktop, 'tests/voice-chat-ui.cjs'), logs], {
    cwd: desktop, stdio: 'inherit', timeout: 60000, env: { ...process.env, KLAUS_VOICE_CHAT_TEST_PROFILE: profile },
  });
} finally { rmSync(profile, { recursive: true, force: true }); }
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
