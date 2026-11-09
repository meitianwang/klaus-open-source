import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, appendFile } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..'), frontend = join(desktop, 'frontend'), output = join(desktop, 'dist/plugin-update-ui-logs');
const args = new Map(); for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i], process.argv[i + 1]);
await mkdir(output, { recursive: true });
const logPath = join(output, 'plugin-update-ui.log');
await writeFile(logPath, `$ ${process.argv.map(value => JSON.stringify(value)).join(' ')}\n`);
let logging = Promise.resolve();
function log(name, value) { const text = `${name} ${typeof value === 'string' ? value : JSON.stringify(value)}\n`; process.stdout.write(text); logging = logging.then(() => appendFile(logPath, text)); }
const result = { command: process.argv, pageErrors: [], consoleErrors: [], cases: [], screenshots: [], passed: false };
let server, browser;
const model = 'model3d@klaus-official', diagram = 'digram@klaus-official';
try {
  await build({ entryPoints: [join(frontend, 'src/pages/plugins/plugin-update.fixture.tsx')], outfile: join(output, 'plugin-update.fixture.js'), bundle: true, format: 'esm', platform: 'browser', jsx: 'automatic', target: 'es2022', loader: { '.css': 'local-css' }, plugins: [{ name: 'raw-svg-assets', setup(build) {
    build.onResolve({ filter: /\.svg\?raw$/ }, async args => { const resolved = await build.resolve(args.path.slice(0, -4), { resolveDir: args.resolveDir, kind: args.kind }); if (resolved.errors.length) return { errors: resolved.errors }; return { path: resolved.path, namespace: 'raw-svg' }; });
    build.onLoad({ filter: /.*/, namespace: 'raw-svg' }, async args => ({ contents: await readFile(args.path, 'utf8'), loader: 'text' }));
  } }] });
  await writeFile(join(output, 'index.html'), '<!doctype html><html lang="zh"><meta charset="utf-8"><title>Plugin update interaction fixture</title><link rel="stylesheet" href="/css/styles.css"><link rel="stylesheet" href="/bundle/plugin-update.fixture.css"><style>html,body{min-height:100%;overflow:auto}#root{max-width:1060px;margin:24px auto;padding:0 28px}.sk-section{display:block}</style><aside style="display:none"><button id="btn-extensions">Extensions</button><button id="btn-plugins">Plugins</button></aside><main id="root"></main><script type="module" src="/bundle/plugin-update.fixture.js"></script></html>');
  server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
      if (pathname === '/favicon.ico') { response.writeHead(204); response.end(); return; }
      let path;
      if (pathname === '/') path = join(output, 'index.html');
      else if (pathname.startsWith('/bundle/')) path = resolve(output, pathname.slice('/bundle/'.length));
      else if (pathname.startsWith('/extension-logos/')) path = resolve(frontend, 'public', `.${pathname}`);
      else path = resolve(frontend, `.${pathname}`);
      if (![output, frontend].some(root => !relative(root, path).startsWith('..'))) throw new Error('Fixture path outside roots');
      response.setHeader('Content-Type', path.endsWith('.css') ? 'text/css' : path.endsWith('.js') ? 'text/javascript' : path.endsWith('.png') ? 'image/png' : path.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); response.end(await readFile(path));
    } catch (error) { response.writeHead(404); response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const module = args.get('--playwright-module'); if (!module) throw new Error('--playwright-module is required');
  const { chromium } = await import(pathToFileURL(resolve(module)).href);
  browser = await chromium.launch({ executablePath: args.get('--chrome') ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  page.on('pageerror', error => { result.pageErrors.push(error.stack ?? error.message); log('PAGE_ERROR', error.stack ?? error.message); });
  page.on('console', message => { if (message.type() === 'error') { result.consoleErrors.push(message.text()); log('CONSOLE_ERROR', message.text()); } });
  await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
  const card = id => page.locator(`[data-plugin-id="${id}"]`), update = id => page.locator(`[data-plugin-update="${id}"]`);
  const snapshot = () => page.evaluate(() => window.pluginUpdateFixture.snapshot());
  const pending = () => page.waitForFunction(() => window.pluginUpdateFixture.snapshot().pending !== null);
  const idle = () => page.waitForFunction(() => { const snapshot = window.pluginUpdateFixture.snapshot(); return snapshot.pending === null && !Object.values(snapshot.state.operations).some(operation => operation.phase === 'running' || operation.phase === 'queued'); });
  const capture = async name => { const path = join(output, `${name}.png`); await page.screenshot({ path, fullPage: true, animations: 'disabled' }); result.screenshots.push(path); return path; };
  const pass = (name, evidence) => { result.cases.push({ name, passed: true, evidence }); log('PASS_CASE', { name, evidence }); };

  const waitPending = id => page.waitForFunction(id => window.pluginUpdateFixture.snapshot().pending === id, id);
  const wrapper = id => card(id).locator('..');
  const reset = async () => { await page.reload({ waitUntil: 'networkidle' }); await update(model).waitFor({ state: 'visible' }); };
  await update(model).waitFor({ state: 'visible' });
  assert.match(await card(model).textContent(), /1\.0\.0\s*→\s*1\.1\.0/);
  assert.match(await card(model).textContent(), /UV/);
  assert.equal(await card(model).locator('.mcp-state-btn.is-off').count(), 1);
  assert.equal(await card(diagram).locator('.mcp-state-btn.is-on').count(), 1);
  assert.equal(await page.locator('#btn-plugins [data-plugin-update-count]').textContent(), '2');
  const navBadges = () => page.evaluate(() => {
    const group = document.querySelector('#btn-extensions [data-plugin-update-count]');
    const child = document.querySelector('#btn-plugins [data-plugin-update-count]');
    return { groupHidden: group?.hidden ?? null, groupText: group?.textContent ?? null, childHidden: child?.hidden ?? null, groupLabel: document.getElementById('btn-extensions')?.getAttribute('aria-label') ?? null };
  });
  let badges = await navBadges();
  assert.equal(badges.groupHidden, false);
  assert.equal(badges.groupText, '2');
  assert.equal(badges.childHidden, false);
  assert.match(badges.groupLabel, /可更新/);
  await page.evaluate(() => document.getElementById('btn-extensions').setAttribute('aria-expanded', 'true'));
  await page.waitForFunction(() => document.querySelector('#btn-extensions [data-plugin-update-count]').hidden === true);
  badges = await navBadges();
  assert.equal(badges.groupHidden, true);
  assert.equal(badges.childHidden, false);
  assert.ok(!/可更新/.test(badges.groupLabel), 'expanded group label drops the duplicate count');
  await page.evaluate(() => document.getElementById('btn-extensions').setAttribute('aria-expanded', 'false'));
  await page.waitForFunction(() => document.querySelector('#btn-extensions [data-plugin-update-count]').hidden === false);
  pass('the extensions group badge yields to the child row while the group is expanded', await navBadges());
  assert.equal(await page.locator('#btn-plugins').getAttribute('title'), null);
  await capture('market-update-available');
  pass('market exposes versioned updates and a quiet navigation count', await snapshot());

  await page.evaluate(id => { const button = document.querySelector('[data-plugin-update="' + id + '"]'); button.click(); button.click(); }, model);
  await waitPending(model);
  assert.equal((await snapshot()).calls.filter(call => call.method === 'update').length, 1);
  assert.equal(await update(model).count(), 0);
  const modelState = card(model).locator('.mcp-state-btn');
  assert.equal(await modelState.locator('.mcp-state-btn-spinner').count(), 1);
  assert.equal(await modelState.isDisabled(), true);
  assert.equal(await modelState.getAttribute('aria-label'), '更新中…');
  assert.equal(await update(diagram).isEnabled(), true);
  assert.equal(await page.locator('#pl-refresh').isEnabled(), true);
  await page.locator('[data-plugin-tab="installed"]').click();
  assert.equal(await card(diagram).locator('input[type="checkbox"]').isEnabled(), true);
  assert.equal(await card(diagram).locator('.mcp-icon-btn').isEnabled(), true);
  assert.equal(await card(model).locator('input[type="checkbox"]').isDisabled(), true);
  await update(diagram).click();
  assert.match(await update(diagram).textContent(), /排队中/);
  assert.equal((await snapshot()).calls.filter(call => call.method === 'update').length, 1);
  await capture('independent-update-queue');
  pass('an update locks only its item and accepts another item into the writer queue', await snapshot());

  await card(model).locator('[data-card-open]').click();
  const detail = () => page.locator('[data-plugin-detail]');
  assert.match(await detail().textContent(), /更新中/);
  assert.equal(await detail().locator('[data-detail-action="update"]').isDisabled(), true);
  assert.match(await detail().textContent(), /已安装版本/);
  await page.evaluate(() => window.pluginUpdateFixture.settle(false));
  await waitPending(diagram);
  await page.waitForFunction(() => (window.pluginUpdateFixture.dialog?.() || []).length >= 1);
  const dialogs = await page.evaluate(() => window.pluginUpdateFixture.dialog());
  assert.match(dialogs[0].title, /3D 工作室/);
  assert.match(dialogs[0].title, /更新失败/);
  assert.equal(dialogs[0].confirmText, '交给 Klaus 诊断');
  assert.equal(await page.locator('[data-plugin-error]').count(), 0);
  await page.waitForFunction(() => window.pluginUpdateFixture.snapshot().calls.some(call => call.method === 'submit'));
  const diagnoseQuery = (await snapshot()).calls.find(call => call.method === 'submit').options;
  assert.match(diagnoseQuery, /帮我诊断更新插件「3D 工作室」失败。/);
  assert.match(diagnoseQuery, /klaus-plugin-fixture-failure\.log/);
  await capture('detail-update-failure-dialog');
  await page.evaluate(() => window.pluginUpdateFixture.settle(true)); await idle();
  await detail().locator('[data-detail-action="update"]').click(); await waitPending(model);
  await page.evaluate(() => window.pluginUpdateFixture.settle(true)); await idle();
  assert.match(await detail().textContent(), /1\.1\.0/);
  assert.equal((await snapshot()).toasts.some(toast => /已更新/.test(toast) && /下一轮对话生效/.test(toast)), true);
  assert.equal(await detail().locator('[data-plugin-success]').count(), 0);
  assert.equal(await detail().locator('[data-detail-action="update"]').count(), 0);
  assert.equal(await detail().locator('input[type="checkbox"]').isChecked(), false);
  assert.equal(await page.getByRole('button', { name: /立即重启|现在重启|Restart/ }).count(), 0);
  assert.match(await detail().locator('.md').last().innerHTML(), /Create, edit and render/);
  assert.equal(await detail().getByText('Create, edit and render local models.', { exact: true }).isVisible(), true);
  log('DETAIL_DOCUMENT_LAYOUT', await detail().locator('.md').last().evaluate(element => ({ html: element.innerHTML, rect: element.getBoundingClientRect().toJSON(), color: getComputedStyle(element).color, opacity: getComputedStyle(element).opacity, ancestors: [...function* () { for (let node = element; node; node = node.parentElement) yield node; }()].map(node => ({ tag: node.tagName, className: node.className, overflow: getComputedStyle(node).overflow, opacity: getComputedStyle(node).opacity, height: node.getBoundingClientRect().height })) })));
  await detail().locator('.md').last().scrollIntoViewIfNeeded();
  await capture('detail-update-success');
  await page.locator('[data-plugin-back]').click();
  await page.waitForFunction(id => document.activeElement?.closest('[data-plugin-id]')?.getAttribute('data-plugin-id') === id, model);
  assert.equal(await card(diagram).locator('input[type="checkbox"]').isChecked(), true);
  assert.equal(await page.locator('#btn-plugins [data-plugin-update-count]').evaluate(badge => badge.hidden), true);
  pass('a failure raises one diagnose dialog carrying the failure log, retry succeeds with a toast, detail remains open and back restores focus', await snapshot());

  await reset();
  await update(model).click(); await waitPending(model);
  await page.evaluate(() => window.pluginUpdateFixture.remount());
  await card(model).locator('.mcp-state-btn-spinner').waitFor({ state: 'visible' });
  assert.equal(await update(model).count(), 0);
  assert.equal(await update(diagram).isEnabled(), true);
  await page.evaluate(() => window.pluginUpdateFixture.settle(true)); await idle();
  await update(model).waitFor({ state: 'detached' });
  assert.equal((await snapshot()).calls.filter(call => call.method === 'update').length, 1);
  pass('leaving and remounting the page preserves an accepted update without duplicate submission', await snapshot());

  await reset();
  await page.locator('[data-plugin-update-all]').click(); await waitPending(model);
  assert.equal(await update(diagram).count(), 0);
  const queuedState = card(diagram).locator('.mcp-state-btn');
  assert.equal(await queuedState.locator('.mcp-state-btn-spinner').count(), 1);
  assert.match(await queuedState.getAttribute('aria-label') || '', /排队中/);
  await page.evaluate(() => window.pluginUpdateFixture.settle(false)); await waitPending(diagram);
  await page.evaluate(() => window.pluginUpdateFixture.settle(true)); await idle();
  await page.waitForFunction(() => window.pluginUpdateFixture.snapshot().state.batch?.running === false);
  assert.match(await page.locator('[data-plugin-batch]').textContent(), /1.*失败/);
  assert.equal(await update(diagram).count(), 0);
  assert.equal(await update(model).count(), 1);
  await capture('batch-partial-failure');
  pass('batch completes remaining items after a failure and leaves only outstanding releases actionable', await snapshot());

  await reset();
  await page.evaluate(() => window.pluginUpdateFixture.failCheck(true));
  await page.locator('#pl-refresh').click();
  await page.locator('[data-plugin-check-error]').waitFor({ state: 'visible' });
  assert.equal(await update(model).isEnabled(), true);
  assert.equal(await update(diagram).isEnabled(), true);
  assert.match(await page.locator('[data-plugin-check-error]').textContent(), /已保留当前插件/);
  await page.evaluate(id => { window.pluginUpdateFixture.failCheck(false); window.pluginUpdateFixture.publish(id, '1.3.0'); }, model);
  await page.locator('#pl-refresh').click();
  await page.waitForFunction(() => !document.querySelector('[data-plugin-check-error]'));
  assert.match(await update(model).textContent(), /1\.3\.0/);
  pass('failed checks retain cached controls and later remote publication is discovered on refresh', await snapshot());

  await reset();
  await card(model).locator('[data-card-open]').click();
  await detail().locator('[data-detail-action="update"]').click(); await waitPending(model);
  await page.evaluate(() => { window.pluginUpdateFixture.failRead(true); window.pluginUpdateFixture.settle(true); }); await idle();
  assert.equal((await snapshot()).state.operations[model].phase, 'success');
  assert.match(await detail().textContent(), /1\.1\.0/);
  assert.equal(await detail().locator('[data-detail-action="update"]').count(), 0);
  assert.match(await page.textContent('body'), /变更已保存，但界面刷新失败/);
  pass('a follow-up read failure cannot turn a persisted update into a retryable mutation failure', await snapshot());

  await reset();
  await card(diagram).locator('[data-card-open]').click();
  await detail().locator('[data-detail-action="update"]').click(); await waitPending(diagram);
  await page.evaluate(() => window.pluginUpdateFixture.settle(true, 'endpoint_restart')); await idle();
  assert.equal((await snapshot()).toasts.some(toast => /重启 Klaus 后生效/.test(toast)), true);
  assert.equal(await detail().locator('[data-plugin-try]').isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: /立即重启|现在重启|Restart/ }).count(), 1);
  pass('restart is offered only for a restart-required result', await snapshot());

  await reset();
  await card(diagram).locator('[data-card-open]').click();
  await detail().locator('[data-plugin-try]').click();
  const mention = (await snapshot()).calls.find(call => call.method === 'mention');
  assert.equal(mention.options.id, diagram);
  assert.match(mention.options.value, /klaus:plugin\/digram%40klaus-official/);
  assert.equal((await snapshot()).calls.filter(call => call.method === 'newChat').length, 1);
  pass('Try prepares an identity-aware plugin mention in a new conversation', mention);

  await reset();
  const studio = 'prototype-studio@klaus-official';
  await page.evaluate(() => window.pluginUpdateFixture.gateInstall(true));
  await card(studio).locator('.mcp-state-btn.is-install').click();
  await page.waitForFunction(id => window.pluginUpdateFixture.operation(id)?.phase === 'running', studio);
  assert.equal(await page.locator('[data-plugin-progress]').count(), 0);
  const installButton = card(studio).locator('.mcp-state-btn.is-install');
  assert.equal(await installButton.isDisabled(), true);
  assert.equal(await installButton.locator('.mcp-state-btn-spinner').count(), 1);
  assert.equal(await installButton.getAttribute('aria-label'), '安装中…');
  await capture('install-busy-on-owning-control');
  await page.evaluate(() => window.pluginUpdateFixture.setDialogAnswer(false));
  await page.evaluate(() => window.pluginUpdateFixture.settleInstall(false));
  // The dismiss path can clear the error phase before a poll sees it, so the
  // dialog record is the stable observation of the failure.
  await page.waitForFunction(() => (window.pluginUpdateFixture.dialog?.() || []).length >= 1);
  assert.match((await page.evaluate(() => window.pluginUpdateFixture.dialog()))[0].title, /安装失败/);
  // Dismissing the dialog clears the failure without leaving any inline strip.
  await page.waitForFunction(id => window.pluginUpdateFixture.operation(id) === undefined, studio);
  assert.equal(await page.locator('[data-plugin-error]').count(), 0);
  await capture('install-failure-dialog-dismissed');
  await page.evaluate(() => window.pluginUpdateFixture.setDialogAnswer(true));
  await page.evaluate(() => window.pluginUpdateFixture.gateInstall(true));
  await card(studio).locator('.mcp-state-btn.is-install').click();
  await page.waitForFunction(id => window.pluginUpdateFixture.operation(id)?.phase === 'running', studio);
  await page.evaluate(() => window.pluginUpdateFixture.settleInstall(false));
  await page.waitForFunction(() => window.pluginUpdateFixture.snapshot().calls.some(call => call.method === 'submit'));
  const installQuery = (await snapshot()).calls.find(call => call.method === 'submit').options;
  assert.match(installQuery, /帮我诊断安装插件「界面原型设计」失败。/);
  assert.match(installQuery, /klaus-plugin-fixture-failure\.log/);
  await capture('install-failure-diagnose-query');
  await page.evaluate(() => window.pluginUpdateFixture.gateInstall(false));
  await card(studio).locator('.mcp-state-btn.is-install').click();
  await page.waitForFunction(id => window.pluginUpdateFixture.operation(id)?.phase === 'success', studio);
  assert.equal((await snapshot()).toasts.filter(toast => /已安装/.test(toast)).length, 1);
  assert.equal(await card(studio).locator('[data-plugin-success]').count(), 0);
  assert.equal(await card(studio).locator('.mcp-state-btn.is-on').count(), 1);
  pass('install spins on its control, a failure offers one Klaus diagnosis carrying the log, success is a toast', await snapshot());

  await reset();
  await page.evaluate(() => window.pluginUpdateFixture.language('en'));
  await page.locator('[data-plugin-update-all]').waitFor({ state: 'visible' });
  assert.match(await page.locator('[data-plugin-update-all]').textContent(), /Update all \(2\)/);
  assert.equal(await page.locator('[data-plugin-tab="updates"]').count(), 0);
  const tabRow = await page.evaluate(() => {
    const tab = document.querySelector('[data-plugin-tab="market"]').getBoundingClientRect();
    const button = document.querySelector('[data-plugin-update-all]').getBoundingClientRect();
    const bar = document.querySelector('[data-plugin-tab="market"]').closest('.sk-tabbar').getBoundingClientRect();
    return { tabCenter: (tab.top + tab.bottom) / 2, buttonCenter: (button.top + button.bottom) / 2, tabRight: tab.right, buttonLeft: button.left, buttonRight: button.right, barRight: bar.right, bodyText: document.body.textContent || '' };
  });
  assert.ok(Math.abs(tabRow.tabCenter - tabRow.buttonCenter) <= 6, 'update-all shares the tab row');
  assert.ok(tabRow.buttonLeft > tabRow.tabRight, 'update-all sits after the tabs');
  assert.ok(tabRow.buttonRight <= tabRow.barRight + 1, 'update-all stays inside the tab row');
  assert.ok(!/Last checked|上次检查/.test(tabRow.bodyText), 'no checked-at strip on the page');
  await page.evaluate(() => window.pluginUpdateFixture.language('zh'));
  await page.locator('[data-plugin-update-all]').waitFor({ state: 'visible' });
  assert.match(await page.locator('[data-plugin-update-all]').textContent(), /全部更新（2）/);
  for (const width of [620, 400]) {
    await page.setViewportSize({ width, height: 850 });
    const layout = await page.evaluate(() => [...document.querySelectorAll('[data-plugin-update]')].map(button => {
      const rect = button.getBoundingClientRect(), card = button.closest('[data-plugin-id]').getBoundingClientRect();
      return { text: button.textContent, width: rect.width, right: rect.right, cardRight: card.right, clipped: button.scrollWidth > button.clientWidth + 1, viewportWidth: window.innerWidth, documentWidth: document.documentElement.scrollWidth };
    }));
    for (const entry of layout) { assert.ok(entry.width > 60); assert.equal(entry.clipped, false); assert.ok(entry.right <= entry.cardRight + 1); assert.ok(entry.right <= entry.viewportWidth); assert.ok(entry.documentWidth <= entry.viewportWidth); }
    pass('responsive controls remain readable at width ' + width, layout);
  }
  await capture('market-update-narrow');
  assert.deepEqual(result.pageErrors, []); assert.deepEqual(result.consoleErrors, []);
  result.passed = true;
  log('PASS', { cases: result.cases.length, pageErrors: result.pageErrors, consoleErrors: result.consoleErrors, screenshots: result.screenshots });
} catch (error) {
  result.error = error.stack ?? String(error); log('FAIL', result.error); process.exitCode = 1;
} finally {
  if (browser) await browser.close(); if (server) await new Promise(resolve => server.close(resolve));
  await writeFile(join(output, 'plugin-update-ui-result.json'), JSON.stringify(result, null, 2)); await logging;
}
