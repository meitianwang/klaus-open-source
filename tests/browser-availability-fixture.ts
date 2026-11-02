import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserManager } from '../main/browser/manager';
import { BrowserOperations } from '../main/browser/operations';
import { object, type BrowserObject } from '../main/browser/types';
import { Harness, assert, assertEqual, assertRejects, waitFor } from './harness';

const profile = process.env.KLAUS_BROWSER_AVAILABILITY_PROFILE;
if (!profile) throw new Error('This fixture requires an isolated KLAUS_BROWSER_AVAILABILITY_PROFILE.');
mkdirSync(profile, { recursive: true });
app.setPath('userData', profile);
app.commandLine.appendSwitch('site-per-process');
app.on('window-all-closed', () => {});

async function main(): Promise<number> {
  await app.whenReady();
  const h = new Harness();
  let submitted = false, queuedRequests = 0, resumedRequests = 0;
  const server = createServer(async (request, response) => {
    if (request.url === '/submit') {
      let body = '';
      for await (const chunk of request) body += String(chunk);
      submitted = body.includes('manual');
      response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<!doctype html><title>submitted</title>ok'); return;
    }
    if (request.url === '/download') {
      response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Disposition': 'attachment; filename="availability.txt"' }); response.end('availability download'); return;
    }
    if (request.url === '/queued') { queuedRequests += 1; response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('queued'); return; }
    if (request.url === '/resumed') { resumedRequests += 1; response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('resumed'); return; }
    if (request.url === '/slow-manual' || request.url === '/slow-click') {
      const filename = request.url === '/slow-manual' ? 'slow-manual.txt' : 'slow-click.txt';
      response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${filename}"` });
      let sent = 0;
      const timer = setInterval(() => {
        if (response.destroyed || sent >= 20) { clearInterval(timer); if (!response.destroyed) response.end(); return; }
        sent += 1; response.write('x'.repeat(1024));
      }, 50);
      response.once('close', () => clearInterval(timer));
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<!doctype html><title>${request.url}</title><input id="input" aria-label="input"><form id="form" method="post" action="/submit"><input name="payload" value="manual"><button id="submit">Submit</button></form><a id="download" href="/download">Download</a><a id="slow-manual" href="/slow-manual">Slow manual</a><a id="slow-click" href="/slow-click">Slow click</a>`);
  });
  let base = '';
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address !== 'string', 'fixture server has port');
  base = `http://127.0.0.1:${address.port}`;

  const window = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await window.loadURL('data:text/html,<h1>availability fixture</h1>');
  let agentEnabled = false;
  let available = true;
  const manager = new BrowserManager({
    window, configRoot: profile!, enabled: () => agentEnabled, available: () => available,
    requestPermission: async () => false, promptForUserDownloads: () => false,
    downloadDirectory: () => join(profile!, 'downloads'),
    emit: () => {},
  });
  const operations = new BrowserOperations(manager);

  const page = await manager.createTab('manual', `${base}/page`);
  await page.ready;

  h.test('agent off keeps the manual page and availability true', async () => {
    assertEqual(manager.isEnabled(), false, 'agent gate is off');
    assertEqual(manager.isAvailable(), true, 'manual browser is available');
    assertEqual(manager.state('manual').enabled, true, 'BrowserState.enabled reports manual availability');
    assert(manager.listPages('manual').length === 1, 'page remains alive');
    await manager.navigate(page, `${base}/page2`);
    assertEqual(page.view.webContents.getURL(), `${base}/page2`, 'manual navigation works');
    await page.cdp.evaluate("document.querySelector('#download').click(); true");
    await waitFor(() => (manager.downloadHistory({ query: 'availability.txt' }) as { items?: BrowserObject[] }).items?.some(row => row.state === 'completed') === true, 5000, 'manual download completes');
    await page.cdp.evaluate("document.querySelector('#input').value='manual'; document.querySelector('#form').requestSubmit(); true");
    await waitFor(() => submitted, 5000, 'manual form submitted');
    manager.history({ query: 'page' });
    manager.downloadHistory();
    await manager.clearData('cache');
    assert(manager.listPages('manual').length === 1, 'page survives manual management');
  });

  h.test('agent operations reject while the manual browser is available', async () => {
    const result = await operations.execute('manual', 'navigate', { url: `${base}/agent-denied` });
    assertEqual(result.isError, true, 'agent operation rejected');
    assertEqual(object(result.error).code, 'unavailable', 'explicit unavailable code');
  });

  h.test('disabling agent aborts an in-progress type without destroying the page', async () => {
    agentEnabled = true;
    const inputPage = await manager.createTab('manual', `${base}/page`);
    await inputPage.ready;
    const typedPage = inputPage;

    await typedPage.cdp.evaluate("document.querySelector('#input').focus(); true");
    const pending = operations.execute('manual', 'type', { selector: '#input', text: 'abcdef', delayMs: 250 });
    await waitFor(() => typedPage.cdp.evaluate("document.querySelector('#input').value.length > 0").then(value => value === true), 5000, 'typing started');
    agentEnabled = false;
    manager.refreshPermissions();
    const result = await pending;
    assertEqual(result.isError, true, 'in-progress agent type stops');
    const stoppedAt = Number(await typedPage.cdp.evaluate("document.querySelector('#input').value.length"));
    await new Promise(resolve => setTimeout(resolve, 600));
    const after = Number(await typedPage.cdp.evaluate("document.querySelector('#input').value.length"));
    assertEqual(after, stoppedAt, 'no later characters are typed');
    assert(manager.listPages('manual').some(entry => entry.handle === typedPage.handle), 'page is still alive');
  });

  h.test('re-enabling agent restores agent operations', async () => {
    agentEnabled = true;
    const result = await operations.execute('manual', 'type', { selector: '#input', text: 'Z', delayMs: 1 });
    assertEqual(result.isError, undefined, 'agent type succeeds after re-enable');
  });

  const downloadRow = (query: string): BrowserObject | undefined =>
    ((manager.downloadHistory({ query }) as { items?: BrowserObject[] }).items ?? [])[0];
  const waitForActiveDownload = async (query: string): Promise<void> => {
    await waitFor(() => {
      const row = downloadRow(query);
      return row?.state === 'in_progress' || row?.state === 'completed';
    }, 5000, `${query} download started`);
  };

  h.test('a queued agent call stays cancelled across off to on; a new call runs', async () => {
    agentEnabled = true;
    const queuedPage = await manager.createTab('manual', `${base}/page`);
    await queuedPage.ready;
    await queuedPage.cdp.evaluate("document.querySelector('#input').focus(); true");
    const occupying = operations.execute('manual', 'type', { selector: '#input', text: 'abcdef', delayMs: 220 });
    await waitFor(() => queuedPage.cdp.evaluate("document.querySelector('#input').value.length > 0").then(value => value === true), 5000, 'the queue is occupied');
    const queued = operations.execute('manual', 'navigate', { url: `${base}/queued` });
    agentEnabled = false;
    manager.refreshPermissions();
    agentEnabled = true;
    const [first, second] = await Promise.all([occupying, queued]);
    assertEqual(first.isError, true, 'the active operation was cancelled');
    assertEqual(object(second.error).code, 'cancelled', 'the old queued call remains cancelled');
    assertEqual(queuedRequests, 0, 'the cancelled queued navigation never reached the server');
    const resumed = await operations.execute('manual', 'navigate', { url: `${base}/resumed` });
    assertEqual(resumed.isError, undefined, 'a new call runs after re-enable');
    assertEqual(resumedRequests, 1, 'the new call reached the server');
  });

  h.test('manual download during an active agent wait survives agent disable', async () => {
    agentEnabled = true;
    const downloadPage = await manager.createTab('manual', `${base}/page`);
    await downloadPage.ready;
    const waiting = operations.execute('manual', 'wait_for', { ms: 1800 });
    await new Promise(resolve => setTimeout(resolve, 80));
    await downloadPage.cdp.evaluate("document.querySelector('#slow-manual').click(); true");
    await waitForActiveDownload('slow-manual.txt');
    agentEnabled = false;
    manager.refreshPermissions();
    const waitResult = await waiting;
    assertEqual(waitResult.isError, true, 'the agent wait was cancelled');
    await waitFor(() => downloadRow('slow-manual.txt')?.state === 'completed', 5000, 'the manual download was not tied to the agent signal');
    agentEnabled = true;
  });

  h.test('a download started by a finished agent click survives agent disable', async () => {
    agentEnabled = true;
    const clickPage = await manager.createTab('manual', `${base}/page`);
    await clickPage.ready;
    const clicked = await operations.execute('manual', 'click', { selector: '#slow-click' });
    assertEqual(clicked.isError, undefined, 'agent click completed');
    await waitForActiveDownload('slow-click.txt');
    agentEnabled = false;
    manager.refreshPermissions();
    await waitFor(() => downloadRow('slow-click.txt')?.state === 'completed', 5000, 'the finished click download was not tied to a later off');
    agentEnabled = true;
  });

  h.test('runtime unavailable disables manual availability and creation', async () => {
    available = false;
    assertEqual(manager.state('manual').enabled, false, 'state reports unavailable');
    await assertRejects(() => manager.createTab('manual', `${base}/unavailable`), 'unavailable');
  });

  const code = await h.finish(join(__dirname, 'browser-availability-fixture-result.json'), 'browser-availability-electron');
  window.destroy();
  server.close();
  return code;
}

void main().then(code => process.exit(code)).catch(error => { process.stderr.write(`${String(error)}\n`); process.exit(1); });
