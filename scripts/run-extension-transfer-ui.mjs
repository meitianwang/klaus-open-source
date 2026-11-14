import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const frontend = join(desktop, 'frontend');
const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
const output = resolve(args.get('--out') ?? join(desktop, 'dist/extension-transfer-ui-logs'));
await mkdir(output, { recursive: true });

const result = { pageErrors: [], consoleErrors: [], cases: [], screenshots: [], passed: false };
let server, browser;

try {
  await build({
    entryPoints: [join(frontend, 'src/components/extension-transfer.fixture.tsx')],
    outfile: join(output, 'extension-transfer.fixture.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    jsx: 'automatic',
    target: 'es2022',
    loader: { '.css': 'local-css' },
    plugins: [{
      name: 'raw-svg-assets',
      setup(b) {
        b.onResolve({ filter: /\.svg\?raw$/ }, async a => {
          const r = await b.resolve(a.path.slice(0, -4), { resolveDir: a.resolveDir, kind: a.kind });
          return r.errors.length ? { errors: r.errors } : { path: r.path, namespace: 'raw-svg' };
        });
        b.onLoad({ filter: /.*/, namespace: 'raw-svg' }, async a => ({ contents: await readFile(a.path, 'utf8'), loader: 'text' }));
      },
    }],
  });

  await writeFile(
    join(output, 'index.html'),
    '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Skills & Agents transfer fixture</title><link rel="stylesheet" href="/css/styles.css"><link rel="stylesheet" href="/bundle/extension-transfer.fixture.css"><style>html,body{min-height:100%;overflow:auto}#root{max-width:1060px;margin:24px auto;padding:0 28px}.sk-section{display:block}</style><aside style="display:none"><button id="btn-extensions" aria-expanded="false">Extensions</button><button id="btn-plugins">Plugins</button><button id="btn-skills">Skills</button><button id="btn-agents">Agents</button></aside><main id="root"></main><script type="module" src="/bundle/extension-transfer.fixture.js"></script></html>',
  );

  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      let p;
      if (pathname === '/') p = join(output, 'index.html');
      else if (pathname.startsWith('/bundle/')) p = resolve(output, pathname.slice('/bundle/'.length));
      else if (pathname.startsWith('/extension-logos/') || pathname.startsWith('/skill-logos/')) p = resolve(frontend, 'public', `.${pathname}`);
      else p = resolve(frontend, `.${pathname}`);
      if (![output, frontend].some(root => !relative(root, p).startsWith('..'))) throw new Error('Outside root');
      response.setHeader('Content-Type', p.endsWith('.css') ? 'text/css' : p.endsWith('.js') ? 'text/javascript' : p.endsWith('.png') ? 'image/png' : p.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
      response.end(await readFile(p));
    } catch (error) { response.writeHead(404); response.end(String(error)); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));

  const pwModule = args.get('--playwright-module');
  if (!pwModule) throw new Error('--playwright-module is required');
  const { chromium } = await import(pathToFileURL(resolve(pwModule)).href);
  browser = await chromium.launch({
    executablePath: args.get('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.on('pageerror', err => result.pageErrors.push(err.stack ?? err.message));
  page.on('console', msg => { if (msg.type() === 'error') result.consoleErrors.push(msg.text()); });

  const capture = async name => {
    const path = join(output, `${name}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    result.screenshots.push(path);
    return path;
  };

  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
  await page.locator('[data-skill-update-all]').waitFor({ state: 'visible' });
  assert.match(await page.locator('[data-skill-update-all]').textContent(), /全部更新（2）/);
  const snap1 = await page.evaluate(() => window.extTransferFixture.snapshot());
  assert.equal(snap1.nav.skillsCount, '2');
  assert.equal(snap1.nav.groupCount, '2');

  // 1. Skill update progress on Market card + Installed row
  await page.locator('[data-skill-update="product-feature-video"]').click();
  await page.waitForFunction(() => window.extTransferFixture.snapshot().pendingSkill === 'product-feature-video');
  await page.evaluate(() => window.extTransferFixture.emitSkillProgress({
    id: 'product-feature-video',
    action: 'update',
    stage: 'downloading',
    percent: 45,
    transferred: 14 * 1024 * 1024,
    total: 25 * 1024 * 1024,
    bytesPerSecond: 2.5 * 1024 * 1024,
    cancellable: true,
  }));
  await page.locator('[data-skill-transfer-meta="product-feature-video"]').waitFor({ state: 'visible' });
  assert.match(await page.locator('[data-skill-transfer-meta="product-feature-video"]').textContent(), /45%.*14 MB \/ 25 MB.*2\.5 MB\/s/);
  assert.equal(await page.locator('[data-skill-inline-bar="downloading"]').count(), 1);
  await capture('skills-market-updating');

  // Switch to Installed tab: the installed row itself shows the live progress & cancel control!
  await page.locator('[data-skill-tab="installed"]').click();
  await page.locator('.sk-row [data-skill-transfer-meta="product-feature-video"]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-skill-transfer-banner]').count(), 0, 'no duplicate banner when row is visible');
  await capture('skills-installed-row-updating');

  // Cancel the active skill update cleanly
  await page.locator('[data-skill-cancel="product-feature-video"]').click();
  await page.waitForFunction(() => window.extTransferFixture.snapshot().pendingSkill === null);
  assert.equal((await page.evaluate(() => window.extTransferFixture.snapshot())).toasts.some(t => /已取消/.test(t)), true);
  result.cases.push('skills update progress on market card & installed row + clean cancellation');

  // 2. Installing an uninstalled skill & switching to Installed tab surfaces the cross-tab banner
  await page.locator('[data-skill-tab="market"]').click();
  await page.locator('[data-skill-install="lab-explainer"]').waitFor({ state: 'visible' });
  await page.locator('[data-skill-install="lab-explainer"]').click();
  await page.waitForFunction(() => window.extTransferFixture.snapshot().pendingSkill === 'lab-explainer');
  await page.evaluate(() => window.extTransferFixture.emitSkillProgress({
    id: 'lab-explainer',
    action: 'install',
    stage: 'downloading',
    percent: 62,
    transferred: 18 * 1024 * 1024,
    total: 24 * 1024 * 1024,
    bytesPerSecond: 3 * 1024 * 1024,
    cancellable: true,
  }));
  await page.locator('[data-skill-tab="installed"]').click();
  await page.locator('[data-skill-transfer-banner="lab-explainer"]').waitFor({ state: 'visible' });
  await capture('skills-transfer-banner-across-tabs');
  await page.evaluate(() => window.extTransferFixture.settleSkill(true));
  await page.waitForFunction(() => window.extTransferFixture.snapshot().pendingSkill === null);
  result.cases.push('skills cross-tab transfer banner while installing a new skill');

  // 3. Switch to Sub-agents page: Market card, Installed card, Banner & Cancel
  await page.evaluate(() => window.extTransferFixture.setSurface('agents'));
  await page.locator('[data-agent-update-all]').waitFor({ state: 'visible' });
  assert.match(await page.locator('[data-agent-update-all]').textContent(), /全部更新（1）/);
  const snap2 = await page.evaluate(() => window.extTransferFixture.snapshot());
  assert.equal(snap2.nav.agentsCount, '1');

  // Check Installed view has update button & version transition right on the agent card
  await page.locator('[data-agent-view-tab="installed"]').click();
  await page.locator('[data-agent-update="frontend-studio"]').waitFor({ state: 'visible' });
  assert.match(await page.locator('[data-agent-name="frontend-studio"]').textContent(), /1\.0\.0\s*→\s*1\.1\.0/);
  await page.locator('[data-agent-update="frontend-studio"]').click();
  await page.waitForFunction(() => window.extTransferFixture.snapshot().pendingAgent === 'frontend-studio');
  await page.evaluate(() => window.extTransferFixture.emitAgentProgress({
    id: 'frontend-studio',
    action: 'update',
    stage: 'downloading',
    percent: 52,
    transferred: 24 * 1024,
    total: 38 * 1024,
    bytesPerSecond: 96 * 1024,
    cancellable: true,
  }));
  await page.locator('[data-agent-transfer-meta="frontend-studio"]').waitFor({ state: 'visible' });
  assert.equal(await page.locator('[data-agent-inline-bar="downloading"]').count(), 1);
  await capture('agents-installed-card-updating');

  // Cancel active agent update cleanly
  await page.locator('[data-agent-cancel="frontend-studio"]').click();
  await page.waitForFunction(() => window.extTransferFixture.snapshot().pendingAgent === null);
  assert.equal((await page.evaluate(() => window.extTransferFixture.snapshot())).toasts.some(t => /已取消.*前端工作室/.test(t)), true);
  result.cases.push('agents update progress on installed & market cards + clean cancellation');

  assert.deepEqual(result.pageErrors, []);
  assert.deepEqual(result.consoleErrors, []);
  result.passed = true;
  console.log('PASS', JSON.stringify({ cases: result.cases, screenshots: result.screenshots }));
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(r => server.close(r));
  await writeFile(join(output, 'extension-transfer-ui-result.json'), JSON.stringify(result, null, 2));
}
