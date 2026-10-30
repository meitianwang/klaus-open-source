// Run after the production frontend/main builds:
// node apps/desktop/scripts/run-electron-test.mjs apps/desktop/tests/markdown-production-worker.cjs
// The launcher performs the required native GUI preflight before starting Electron.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { build } = require('esbuild');
const { registerAppScheme, serveFrontend, appUrl } = require('../dist/main/app/protocol.js');
const { frontendDist } = require('../dist/main/paths.js');

const desktopRoot = resolve(__dirname, '..');
const logs = resolve(process.argv[2] || join(desktopRoot, 'dist/performance-fix-logs/markdown-production-worker'));
const profile = mkdtempSync(join(tmpdir(), 'klaus-markdown-worker-'));
const created = [];
const messages = [];
let window;
let frontend;
let report;
let exitCode = 1;
mkdirSync(logs, { recursive: true });
registerAppScheme();
app.setPath('userData', profile);
app.on('window-all-closed', () => {});

function temporary(path, content) {
  writeFileSync(path, content, { flag: 'wx' });
  created.push(path);
}

async function main() {
  const root = frontendDist();
  const index = readFileSync(join(root, 'index.html'), 'utf8');
  const csp = index.match(/<meta\b[^>]*http-equiv\s*=\s*["']Content-Security-Policy["'][^>]*>/i)?.[0];
  assert(csp, 'The built index must declare its production CSP');
  const assets = readdirSync(join(root, 'assets')).filter(name => /^markdown\.worker-[^/]+\.js$/.test(name));
  assert.equal(assets.length, 1, 'Exactly one production Markdown worker must be emitted');
  const workerPath = `/assets/${assets[0]}`;
  const pipeline = join(desktopRoot, 'frontend/src/chat/markdown-pipeline.ts');
  assert(existsSync(pipeline), 'The production Markdown pipeline source must be available');
  // This separate synchronous reference imports only the parser, never the worker client or hooks.
  const reference = await build({
    stdin: {
      contents: `import { createMarkdownPipeline } from ${JSON.stringify(pipeline)};\nexport const renderReference = createMarkdownPipeline('production-worker-smoke', { resolveImageSrc: href => href, fileIconSvg: () => '' });`,
      resolveDir: desktopRoot,
      loader: 'ts',
    },
    bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent',
  });
  temporary(join(root, 'worker-probe-reference.js'), reference.outputFiles[0].text);
  const source = [
    '# Worker smoke', '',
    '```javascript', 'const answer = 42;', 'console.log(answer);', '```', '',
    'Inline math $x^2 + y^2$ and a table:', '',
    '| Name | Value |', '| --- | --- |', '| answer | 42 |', '',
    '<script>globalThis.__workerProbePwned = true</script>',
    '<img src="invalid" onerror="globalThis.__workerProbePwned = true">',
  ].join('\n');
  const pageScript = `import { renderReference } from './worker-probe-reference.js';
const source = ${JSON.stringify(source)};
const workerPath = ${JSON.stringify(workerPath)};
const sessionId = 'production-worker-smoke';
const violations = [];
window.addEventListener('securitypolicyviolation', event => violations.push({ directive: event.violatedDirective, blocked: event.blockedURI }));
window.__markdownWorkerProbe = { done: false };
const check = (value, message) => { if (!value) throw new Error(message); };
let worker;
let sequence = 0;
const waiting = new Map();
let retirement = null;
function request(source, streamId, settled) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ id, source, sessionId, streamId, settled });
  });
}
(async () => {
  check(location.origin === 'klaus-app://app', 'The probe must run on the real app origin');
  check(typeof window.require === 'undefined' && typeof window.process === 'undefined', 'The renderer must have no Node bridge');
  // Load the emitted asset directly. No factory injection, blob URL, or alternate CSP is used.
  worker = new Worker(new URL(workerPath, location.href), { type: 'module' });
  worker.onerror = event => {
    const error = new Error('Production worker failed to load or execute: ' + event.message);
    for (const pending of waiting.values()) pending.reject(error);
    waiting.clear();
    retirement?.reject(error);
  };
  worker.onmessage = ({ data }) => {
    if (data.type === 'retired') { retirement?.resolve(data); retirement = null; return; }
    const pending = waiting.get(data.id);
    if (!pending) return;
    waiting.delete(data.id);
    if (data.error) pending.reject(new Error(data.error)); else pending.resolve(data);
  };
  worker.postMessage({ type: 'initialize', icons: {} });
  const rendered = await request(source, 'complete', true);
  check(rendered.html === renderReference(source), 'Production worker HTML must equal the synchronous pipeline output');
  check(rendered.html.includes('hljs-keyword'), 'The production worker must highlight code');
  check(rendered.html.includes('class="katex"'), 'The production worker must render math');
  check(rendered.html.includes('<table>'), 'The production worker must render GFM tables');
  check(rendered.html.includes('&lt;script&gt;') && !rendered.html.includes('<script>'), 'Raw script markup must remain escaped');
  const parsed = document.createElement('template');
  parsed.innerHTML = rendered.html;
  check(!parsed.content.querySelector('script, img[onerror]'), 'Untrusted raw HTML must not create executable elements');
  const prefixSource = 'A complete stable paragraph.\\n\\nA live tail.';
  const prefix = await request(prefixSource, 'retained-prefix', false);
  check(prefix.html === renderReference(prefixSource), 'The live prefix must preserve the full HTML');
  check(prefix.stats.entries > 0 && prefix.stats.bytes > 0, 'The live render must retain a prefix before retirement');
  const nextSource = prefixSource + ' More text.';
  const next = await request(nextSource, 'retained-prefix', false);
  check(next.html === renderReference(nextSource), 'An appended live tail must preserve the full HTML');
  check(next.stats.reusedChars > prefix.stats.reusedChars, 'The appended live render must reuse its retained stable prefix');
  const retired = await new Promise((resolve, reject) => {
    retirement = { resolve, reject };
    worker.postMessage({ type: 'retire', sessionId });
  });
  check(retired.stats.entries === 0 && retired.stats.bytes === 0, 'Retirement must release the production worker prefix cache');
  check(violations.length === 0, 'The unchanged production CSP must admit the module worker without violations');
  window.__markdownWorkerProbe = { done: true, ok: true, origin: location.origin, workerPath, htmlLength: rendered.html.length, prefixBeforeRetirement: next.stats, retired: retired.stats, violations, csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content };
})().catch(error => {
  window.__markdownWorkerProbe = { done: true, ok: false, workerPath, error: String(error?.stack || error), violations };
}).finally(() => { worker?.terminate(); });
`;
  temporary(join(root, 'worker-probe.js'), pageScript);
  temporary(join(root, 'worker-probe.html'), `<!doctype html><html><head>${csp}<meta charset="utf-8"></head><body><script type="module" src="./worker-probe.js"></script></body></html>`);
  frontend = serveFrontend();
  assert.equal(frontend.missing, false, 'The built frontend directory must exist');
  assert.equal(resolve(frontend.root), resolve(root), 'The real frontend protocol must serve the production output');
  window = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, backgroundThrottling: false,
  } });
  window.webContents.on('console-message', (_event, level, message) => { messages.push({ level, message }); });
  window.webContents.on('render-process-gone', (_event, details) => { messages.push({ rendererGone: details }); });
  await window.loadURL(appUrl('worker-probe.html'));
  const deadline = Date.now() + 30_000;
  do {
    report = await window.webContents.executeJavaScript('window.__markdownWorkerProbe || null');
    if (report?.done) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  } while (Date.now() < deadline);
  assert(report?.done, `The production worker probe timed out: ${JSON.stringify(messages)}`);
  assert.equal(report.ok, true, report.error || 'Production worker probe failed');
  console.log('Production Markdown worker: app origin, unchanged CSP, sandboxed renderer, exact highlighted/math/table/escaped HTML, prefix reuse and retirement passed.');
  console.log(JSON.stringify(report, null, 2));
}

app.whenReady().then(main).then(() => { exitCode = 0; }).catch(error => {
  report = { ...(report || {}), ok: false, error: String(error?.stack || error) };
  console.error(error);
}).finally(() => {
  const cleanupErrors = [];
  for (const cleanup of [
    () => window?.destroy(),
    () => frontend?.close(),
    ...created.reverse().map(path => () => rmSync(path, { force: true })),
    () => rmSync(profile, { recursive: true, force: true }),
  ]) {
    try { cleanup(); } catch (error) { cleanupErrors.push(String(error?.stack || error)); }
  }
  if (cleanupErrors.length) { exitCode = 1; console.error(cleanupErrors.join('\n')); }
  try {
    writeFileSync(join(logs, 'result.json'), JSON.stringify({ ...report, messages, cleanupErrors, temporaryFilesRemoved: created.every(path => !existsSync(path)), exitCode }, null, 2) + '\n');
  } catch (error) { exitCode = 1; console.error(error); }
  finally { app.exit(exitCode); }
});
