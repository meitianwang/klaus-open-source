import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { ChromeSetup } from '../main/browser/chrome-setup';
import { ChromeBrowserService } from '../main/browser/chrome-browser';
import { ChromeRelay, discoverChrome } from '../main/browser/chrome-relay';
import { navigationUrl } from '../main/browser/policy';
import { BrowserError, object, type BrowserObject } from '../main/browser/types';
import { BrowserOperations } from '../main/browser/operations';
import type { BrowserManager } from '../main/browser/manager';
import { assert, assertEqual, assertRejects, Harness, waitFor } from './harness';
import { registerAdvancedBrowserTests, serveAdvancedFixture } from './browser-advanced-cases';
import { slowDownloadCount } from './browser-download-cases';

const h = new Harness();
const warnings: string[] = []; process.on('warning', warning => warnings.push(warning.message));
const executable = process.env.KLAUS_CHROME_TEST_EXECUTABLE ?? join(__dirname, 'chrome-cache/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
const extensionRoot = resolve(__dirname, '../../resources/plugins-builtin/browser/chrome-extension');
const profile = mkdtempSync(join(__dirname, 'chrome-browser-profile-'));
const discoveryDirectory = mkdtempSync(join(process.platform === 'win32' ? process.env.TEMP || __dirname : '/tmp', 'kls-ext-'));
const log = createWriteStream(join(profile, 'chrome.log'));
const nativeExecutable = require('electron') as string;
const setup = new ChromeSetup({ configRoot: join(profile, 'klaus'), extensionRoot, browserDataRoots: [profile], browserExecutable: executable, executable: nativeExecutable, enabled: () => true, discoveryDirectory });
let denyUpload = false;
const uploadOrigins: string[] = [];
const service = new ChromeBrowserService({ enabled: () => true, discoveryDirectory, artifactDirectory: join(profile, 'artifacts'), authorize: async (sessionId, url, resource) => {
  if (sessionId === 'upload-origin' && resource === 'uploads') {
    uploadOrigins.push(new URL(url).origin);
    if (denyUpload) throw new BrowserError('refused_by_policy', 'Fixture upload denied.');
  }
}, assertNavigation: value => { const url = navigationUrl(value); if (url.endsWith('/forbidden')) throw new BrowserError('refused_by_policy', 'Fixture blocked this document.'); return url; } });
const directRelays: ChromeRelay[] = [];
let downloadSequence = 0; let forbiddenRequests = 0;
let slowDocumentRequests = 0; let slowDocumentOpen = false;
let flakySlowRequests = 0; let flakySlowOpen = false;
let delayedHeadersRequests = 0;
let manualSlowOpen = false;
let finishManualDocument: (() => void) | undefined;
let browser: ChildProcess | undefined; let browserId = ''; let tabA = 0; let tabB = 0; let base = '';
const stallDocument = (response: import('node:http').ServerResponse): void => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.write('<!doctype html><title>Stalled document</title><p>partial');
  const timer = setInterval(() => response.write('pending'), 100);
  response.once('close', () => { clearInterval(timer); });
};
const server = createServer((request, response) => {
  if (serveAdvancedFixture(request, response, base)) return;
  if (request.url === '/forbidden') { forbiddenRequests += 1; response.end('forbidden'); return; }
  if (request.url === '/redirect') { response.writeHead(302, { Location: `${base}/forbidden` }); response.end(); return; }
  if (request.url === '/download' || request.url === '/slow') {
    response.setHeader('Content-Type', 'application/octet-stream'); response.setHeader('Content-Disposition', 'attachment; filename="fixture.txt"');
    if (request.url === '/download') { response.end(`fixture-download-${++downloadSequence}`); return; }
    response.write('partial');
    const timer = setInterval(() => response.write('pending'), 100); response.once('close', () => clearInterval(timer)); return;
  }
  if (request.url === '/slow-document') {
    slowDocumentRequests += 1; slowDocumentOpen = true;
    response.setHeader('Cache-Control', 'no-store');
    response.once('close', () => { slowDocumentOpen = false; });
    stallDocument(response); return;
  }
  if (request.url === '/delayed-headers') {
    const visit = ++delayedHeadersRequests;
    response.setHeader('Cache-Control', 'no-store');
    const finish = (): void => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(`<title>Delayed ${visit}</title>`); };
    if (visit === 1) finish();
    else { const timer = setTimeout(finish, 1100); response.once('close', () => clearTimeout(timer)); }
    return;
  }
  if (request.url === '/manual-slow') {
    manualSlowOpen = true;
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.write('<!doctype html><title>Manual replacement</title><p>partial');
    finishManualDocument = () => response.end('<p id="manual-complete">finished</p>');
    response.once('close', () => { manualSlowOpen = false; }); return;
  }
  if (request.url === '/flaky-slow') {
    flakySlowRequests += 1;
    response.setHeader('Cache-Control', 'no-store');
    // The first request completes so the URL enters session history; later
    // requests (a reload or a back/forward revisit) stall until canceled.
    if (flakySlowRequests === 1) { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<title>Flaky slow</title><h1>Flaky slow</h1><script>addEventListener("beforeunload",()=>{})</script>'); return; }
    flakySlowOpen = true;
    response.once('close', () => { flakySlowOpen = false; });
    stallDocument(response); return;
  }
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (request.url === '/frame') { response.end('<title>Frame</title><p id="frame">owned iframe</p><input id="upload-origin-input" type="file">'); return; }
  if (request.url === '/second') { response.end('<title>Second</title><h1>Second page</h1>'); return; }
  response.end(`<title>External fixture</title><input id="text" value="before"><button id="inc" onclick="this.textContent=String(Number(this.textContent)+1)">0</button><iframe src="${base.replace('127.0.0.1', 'localhost')}/frame"></iframe>`);
});
const resultValue = (result: BrowserObject): unknown => object(result.structuredContent).value;
const call = (session: string, kind: string, fields: BrowserObject = {}) => service.execute(session, browserId, kind, fields, {});

h.test('official Chrome loads the current extension and launches the isolated Node native host', async () => {
  assert(process.platform !== 'win32', 'This native messaging fixture needs a platform with per-profile manifests; Windows registration requires a separate isolated OS account.');
  assert(existsSync(executable), 'Set KLAUS_CHROME_TEST_EXECUTABLE to an official Chrome for Testing executable.');
  const installed = await setup.install(); assertEqual(installed.ok, true, 'native host installed in the fixture profile');
  const manifest = object(JSON.parse(readFileSync(String(installed.manifestPath), 'utf8')));
  assert(String(manifest.path).startsWith(profile), 'native launcher belongs to isolated profile');
  assert(String(installed.manifestPath).startsWith(profile), 'manifest belongs to isolated profile');
  await new Promise<void>(resolveServer => server.listen(0, '127.0.0.1', resolveServer));
  const address = server.address(); assert(address && typeof address !== 'string', 'HTTP fixture bound'); base = `http://127.0.0.1:${address.port}`;
  mkdirSync(join(profile, 'Default'), { recursive: true }); mkdirSync(join(profile, 'downloads'));
  writeFileSync(join(profile, 'Default/Preferences'), JSON.stringify({ download: { default_directory: join(profile, 'downloads'), prompt_for_download: false } }));
  // Ephemeral macOS cookies must not wait for access to the user's Keychain.
  const keychainArgs = process.platform === 'darwin' ? ['--use-mock-keychain'] : [];
  browser = spawn(executable, [`--user-data-dir=${profile}`, '--headless=new', '--site-per-process', '--host-resolver-rules=MAP fixture.test 127.0.0.1', '--no-first-run', '--no-default-browser-check', '--disable-sync', '--password-store=basic', ...keychainArgs, '--remote-debugging-port=0', `--load-extension=${extensionRoot}`, 'about:blank'], { stdio: ['ignore', 'pipe', 'pipe'] });
  browser.stdout?.pipe(log); browser.stderr?.pipe(log);
  browser.on('error', error => log.write(`${String(error)}\n`));
  const until = Date.now() + 20_000;
  for (;;) {
    const found = await discoverChrome(discoveryDirectory);
    if (found.browsers[0]) { browserId = found.browsers[0].id; break; }
    if (Date.now() > until) throw new Error(`Chrome extension did not connect:\n${readFileSync(join(profile, 'chrome.log'), 'utf8').slice(-12000)}`);
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
  }
  assert(browserId.startsWith('chrome:'), 'stable external browser id');
  assertEqual(object((await setup.diagnostics()).diagnostics).runtimeReachable, true, 'live extension diagnostics');
});

h.test('two tasks own separate background Chrome tabs and cannot use each other\'s handles', async () => {
  const a = object(resultValue(await call('A', 'new_tab', { url: base })));
  const b = object(resultValue(await call('B', 'new_tab', { url: base })));
  tabA = Number(a.tabId); tabB = Number(b.tabId);
  assert(tabA > 0 && tabB > 0 && tabA !== tabB, 'distinct Chrome tabs');
  await assertRejects(() => call('A', 'eval', { tabId: tabB, expression: 'location.href' }), 'foreign task handle refused');
  assertEqual(resultValue(await call('A', 'eval', { expression: 'document.querySelector("#text").value' })), 'before', 'task A page');
  assertEqual(resultValue(await call('A', 'eval', { expression: 'JSON.stringify([typeof require,typeof process,typeof module,typeof Buffer,typeof ipcRenderer,typeof window.klaus,typeof window.__KLAUS_DESKTOP__])' })), JSON.stringify(Array(7).fill('undefined')), 'external page has no host capabilities');
});

h.test('the shared CDP input, refs and screenshot operate on the actual external page', async () => {
  await call('A', 'type', { selector: '#text', text: '人工 agent', clear: true });
  await call('A', 'click', { selector: '#inc' });
  assertEqual(resultValue(await call('A', 'eval', { expression: 'document.querySelector("#text").value+":"+document.querySelector("#inc").textContent' })), '人工 agent:1', 'real Chromium input reached page');
  const snapshot = object(resultValue(await call('A', 'snapshot')));
  const nodes = Array.isArray(snapshot.nodes) ? snapshot.nodes.map(object) : [];
  const button = nodes.find(node => node.tag === 'button'); assert(button && typeof button.ref === 'string', 'snapshot ref exists');
  await call('A', 'click', { ref: button.ref });
  assertEqual(resultValue(await call('A', 'eval', { expression: 'document.querySelector("#inc").textContent' })), '2', 'ref action reached the same page');
  const image = await call('A', 'screenshot', { fullPage: true });
  const content = Array.isArray(image.content) ? image.content.map(object) : [];
  assert(content.some(item => item.type === 'image' && typeof item.data === 'string' && item.data.length > 100), 'actual image bytes');
  const surface = object(object(image._meta)['klaus/toolSurface']);
  assertEqual(surface.kind, 'browserUse', 'wire-stable tool surface');
  assertEqual(object(surface.screenshot).tabId, String(tabA), 'screenshot belongs to this tab');
  assertEqual(surface.backend, 'chrome', 'external metadata'); assertEqual(surface.browserId, browserId, 'stable selected browser'); assertEqual(surface.tabId, String(tabA), 'actual Chrome tab id');
  assert(typeof surface.targetId === 'string' && surface.targetId.length > 10, 'real CDP target id');
});

h.test('external frame evaluation admits only an iframe of this task\'s page', async () => {
  const snapshot = object(resultValue(await call('A', 'snapshot')));
  assert(Array.isArray(snapshot.frameTargets) && typeof snapshot.frameTargets[0] === 'string', 'out-of-process iframe target reported');
  assertEqual(resultValue(await call('A', 'eval', { frameTargetId: snapshot.frameTargets[0], expression: 'document.querySelector("#frame").textContent' })), 'owned iframe', 'owned iframe can be evaluated');
  const other = await call('B', 'snapshot'); const sibling = object(object(other._meta)['klaus/toolSurface']).targetId;
  await assertRejects(() => call('A', 'eval', { frameTargetId: sibling ?? '', expression: 'location.href' }), 'sibling target refused');
  const instance = (await discoverChrome(discoveryDirectory)).browsers[0]; assert(instance, 'live native host');
  const relay = await ChromeRelay.connect(instance.endpoint); directRelays.push(relay);
  let childSession = '';
  relay.on('notification', (notification: BrowserObject) => {
    const event = object(notification.params);
    if (notification.method === 'onCDPEvent' && object(event.source).tabId === tabB && event.method === 'Target.attachedToTarget') childSession = String(object(event.params).sessionId ?? '');
  });
  await relay.request('attach', { session_id: 'B', turn_id: 'frame-boundary', tabId: tabB });
  await relay.request('executeCdp', { session_id: 'B', turn_id: 'frame-boundary', tabId: tabB, method: 'Target.setAutoAttach', commandParams: { autoAttach: true, waitForDebuggerOnStart: false, flatten: true } });
  await waitFor(() => Boolean(childSession), 1500, 'real child debugger session');
  await assertRejects(() => relay.request('executeCdp', { session_id: 'A', turn_id: 'foreign-frame', tabId: tabA, sessionId: childSession, method: 'Runtime.evaluate', commandParams: { expression: 'document.title' } }), 'extension rejects a frame session from another page');
  await assertRejects(() => relay.request('executeCdp', { session_id: 'A', turn_id: 'foreign-tab', tabId: tabB, sessionId: childSession, method: 'Runtime.evaluate', commandParams: { expression: 'document.title' } }), 'extension rejects another task even with the matching frame session');
  await relay.request('turnEnded', { session_id: 'B', turn_id: 'frame-boundary' });

});

h.test('Chrome navigation and history preserve page identity', async () => {
  await call('A', 'navigate', { url: `${base}/second` });
  assertEqual(resultValue(await call('A', 'eval', { expression: 'document.title' })), 'Second', 'new page loaded');
  await call('A', 'back');
  assertEqual(resultValue(await call('A', 'eval', { expression: 'document.title' })), 'External fixture', 'back reached prior page');
  await call('A', 'forward'); await call('A', 'reload');
  assertEqual(resultValue(await call('A', 'eval', { expression: 'document.title' })), 'Second', 'forward and reload complete');
});

h.test('canceling a slow navigation stops its own load and a later navigation recovers', async () => {
  const controller = new AbortController();
  const pending = service.execute('A', browserId, 'navigate', { url: `${base}/slow-document`, timeoutMs: 30000 }, {}, controller.signal);
  void pending.catch(() => {});
  await waitFor(() => slowDocumentRequests > 0 && slowDocumentOpen, 5000, 'the slow document request is open');
  controller.abort(new BrowserError('cancelled', 'Fixture navigation canceled.'));
  const error = object(await assertRejects(() => pending, 'the canceled navigation rejects'));
  assertEqual(error.code, 'cancelled', 'cancellation is reported as a canceled operation');
  await call('A', 'navigate', { url: `${base}/second` });
  assertEqual(resultValue(await call('A', 'eval', { expression: 'document.title' })), 'Second', 'a later navigation completes on the same page');
});

h.test('canceling a history reload stops its own load and the page recovers', async () => {
  await call('A', 'navigate', { url: `${base}/flaky-slow` });
  const controller = new AbortController();
  const pending = service.execute('A', browserId, 'reload', {}, {}, controller.signal);
  void pending.catch(() => {});
  await waitFor(() => flakySlowRequests >= 2 && flakySlowOpen, 5000, 'the reload request is open');
  controller.abort(new BrowserError('cancelled', 'Fixture history navigation canceled.'));
  const error = object(await assertRejects(() => pending, 'the canceled history navigation rejects'));
  assertEqual(error.code, 'cancelled', 'history cancellation is reported as a canceled operation');
  await call('A', 'navigate', { url: `${base}/second` });
  assertEqual(resultValue(await call('A', 'eval', { expression: 'document.title' })), 'Second', 'a later navigation still completes');
  // Restore the page that downstream cases expect task A to hold.
  await call('A', 'navigate', { url: `${base}/second` });
});

h.test('history waits for delayed main-frame response headers and handles same-document entries', async () => {
  await call('delayed-history', 'new_tab', { url: `${base}/delayed-headers` });
  const started = Date.now();
  const result = await call('delayed-history', 'reload');
  assert(Date.now() - started >= 1000, 'reload did not mistake the previous complete document for the delayed response');
  assertEqual(object(result.structuredContent).title, 'Delayed 2', 'the new document committed and completed');
  await call('delayed-history', 'eval', { expression: 'location.hash="first"' });
  await call('delayed-history', 'eval', { expression: 'location.hash="second"' });
  await call('delayed-history', 'back');
  assert(String(object((await call('delayed-history', 'eval', { expression: 'location.href' })).structuredContent).value).endsWith('#first'), 'same-document back waits for its actual history event');
  await call('delayed-history', 'forward');
  assert(String(resultValue(await call('delayed-history', 'eval', { expression: 'location.href' }))).endsWith('#second'), 'same-document forward completes');
  service.releaseSession('delayed-history');
});

h.test('canceling an old operation preserves a later navigation started outside the service', async () => {
  const opened = await call('navigation-takeover', 'new_tab', { url: base });
  const targetId = object(object(opened._meta)['klaus/toolSurface']).targetId;
  const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as BrowserObject[];
  const target = targets.find(row => row.id === targetId); assert(target, 'the same Chrome page has an independent fixture transport');
  const socket = new WebSocket(String(target.webSocketDebuggerUrl));
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  let sequence = 0;
  const outside = (method: string, params: BrowserObject = {}): Promise<BrowserObject> => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { socket.off('message', receive); reject(new Error('Fixture CDP timed out')); }, 5000);
    const receive = (bytes: WebSocket.RawData): void => {
      const response = object(JSON.parse(String(bytes)));
      if (response.id !== id) return;
      clearTimeout(timer); socket.off('message', receive);
      if (response.error) reject(new Error(JSON.stringify(response.error))); else resolve(object(response.result));
    };
    socket.on('message', receive); socket.send(JSON.stringify({ id, method, params }));
  });
  const controller = new AbortController();
  const requests = slowDocumentRequests;
  const pending = service.execute('navigation-takeover', browserId, 'navigate', { url: `${base}/slow-document` }, {}, controller.signal);
  void pending.catch(() => {});
  try {
    await waitFor(() => slowDocumentRequests > requests, 5000, 'the agent document started');
    // This transport starts navigation independently of the extension's task
    // turns, as an address-bar navigation would, while the same target is open.
    await outside('Page.navigate', { url: `${base}/manual-slow` });
    await waitFor(() => manualSlowOpen, 5000, 'the replacement document is still loading');
    controller.abort(new BrowserError('cancelled', 'Cancel only the earlier agent operation.'));
    await assertRejects(() => pending, 'the replaced operation does not report success');
    assert(manualSlowOpen, 'the earlier abort did not stop the replacement load');
    finishManualDocument?.();
    const loaded = await outside('Runtime.evaluate', { expression: 'new Promise(resolve=>{const done=()=>resolve(document.querySelector("#manual-complete")?.textContent);if(document.readyState==="complete")done();else addEventListener("load",done,{once:true})})', awaitPromise: true, returnByValue: true });
    assertEqual(object(loaded.result).value, 'finished', 'the replacement navigation completed normally');
  } finally {
    controller.abort(); finishManualDocument?.(); socket.close(); await pending.catch(() => {});
    service.releaseSession('navigation-takeover');
  }
});

h.test('canceling a newly created slow page removes it without closing an existing sibling', async () => {
  const sibling = object(resultValue(await call('slow-create', 'new_tab', { url: base })));
  const controller = new AbortController(); const requests = slowDocumentRequests;
  const pending = service.execute('slow-create', browserId, 'new_tab', { url: `${base}/slow-document` }, {}, controller.signal);
  void pending.catch(() => {});
  try {
    await waitFor(() => slowDocumentRequests > requests, 5000, 'the new page started loading');
    controller.abort(new BrowserError('cancelled', 'Fixture new-page loading canceled.'));
    await assertRejects(() => pending, 'new-page cancellation completed after cleanup');
    const remaining = resultValue(await call('slow-create', 'tabs'));
    assert(Array.isArray(remaining) && remaining.length === 1, 'exactly the previously owned page remains');
    assertEqual(object(remaining[0]).id, sibling.tabId, 'the existing page retains its handle');
  } finally { controller.abort(); await pending.catch(() => {}); service.releaseSession('slow-create'); }
});

h.test('a canceled late create acknowledgement closes only its newly created Chrome tab', async () => {
  const existing = object(resultValue(await call('late-create', 'new_tab', { url: base })));
  const original = ChromeRelay.prototype.request;
  let acknowledge!: () => void;
  let createdId: number | undefined;
  const gate = new Promise<void>(resolve => { acknowledge = resolve; });
  ChromeRelay.prototype.request = async function(method, params, timeout) {
    const value = await original.call(this, method, params, timeout);
    if (method === 'createTab' && params?.session_id === 'late-create') { createdId = Number(object(value).id); await gate; }
    return value;
  };
  const controller = new AbortController();
  let pending: Promise<BrowserObject> | undefined;
  try {
    pending = service.execute('late-create', browserId, 'new_tab', { url: `${base}/second` }, {}, controller.signal);
    void pending.catch(() => {});
    await waitFor(() => createdId !== undefined, 5000, 'Chrome created the page before its acknowledgement arrived');
    controller.abort(new BrowserError('cancelled', 'Fixture late creation canceled.'));
    acknowledge();
    await assertRejects(() => pending!, 'late creation cancellation is reported after scoped cleanup');
  } finally { acknowledge(); ChromeRelay.prototype.request = original; if (pending) await pending.catch(() => {}); }
  const remaining = resultValue(await call('late-create', 'tabs'));
  assert(Array.isArray(remaining), 'task inventory returned');
  assert(remaining.map(object).some(row => row.id === existing.tabId), 'an existing sibling remains owned and open');
  assert(!remaining.map(object).some(row => row.id === createdId), 'only the newly created page was discarded');
  const all = resultValue(await call('user-list', 'tabs', { action: 'user' }));
  assert(Array.isArray(all) && !all.map(object).some(row => row.id === createdId), 'the canceled page is closed in the browser');
  service.releaseSession('late-create');
});

h.test('an explicitly claimed user Chrome tab is released without closing it', async () => {
  const before = resultValue(await call('user-list', 'tabs', { action: 'user' }));
  assert(Array.isArray(before), 'existing user tabs'); const ids = new Set(before.map(row => object(row).id));
  const port = readFileSync(join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
  const response = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(`${base}/second`)}`, { method: 'PUT' });
  assert(response.ok, 'fixture created one independent user tab');
  let user: BrowserObject | undefined;
  await waitFor(async () => {
    const after = resultValue(await call('user-list', 'tabs', { action: 'user' }));
    user = Array.isArray(after) ? after.map(object).find(row => !ids.has(row.id) && row.title === 'Second' && row.url === `${base}/second`) : undefined;
    return !!user;
  }, 5000, 'independent user tab finished loading its snapshot');
  assert(user, 'new user tab identified');
  const userTab = user;
  const inventory = await service.mentionTabs(browserId, 'Second', 100);
  assert(inventory.some(tab => tab.id === userTab.id), 'mention inventory discovers the real user tab without claiming it');
  await assertRejects(() => call('stale-mention', 'claim_tab', { tabId: userTab.id ?? null, expectedTitle: 'Stale title', expectedUrl: userTab.url ?? '' }), 'renamed/reused mention is refused before claiming');
  await call('claimed', 'claim_tab', { tabId: userTab.id ?? null, expectedTitle: userTab.title ?? '', expectedUrl: userTab.url ?? '' });
  const relay = directRelays[0]; assert(relay, 'live native protocol client');
  await assertRejects(() => relay.request('discardCreatedTab', { session_id: 'claimed', turn_id: 'reject-human-discard', tabId: userTab.id! }), 'created-page cancellation cannot close a claimed user page');
  const during = await service.mentionTabs(browserId, '', 100, String(userTab.id));
  for (const field of ['windowId', 'index', 'groupId']) assertEqual(during[0]?.[field], userTab[field], `claim preserves the user's ${field}`);
  await assertRejects(() => call('foreign-claim', 'claim_tab', { tabId: userTab.id ?? null }), 'another task cannot borrow a leased human tab');
  assertEqual(resultValue(await call('claimed', 'eval', { expression: 'document.title' })), 'Second', 'claimed page is controlled directly');
  service.releaseSession('claimed');
  await new Promise(resolveWait => setTimeout(resolveWait, 150));
  const remaining = resultValue(await call('user-list', 'tabs', { action: 'user' }));
  assert(Array.isArray(remaining) && remaining.map(object).some(row => row.id === userTab.id), 'released user tab is still open');
  const returned = Array.isArray(remaining) ? remaining.map(object).find(row => row.id === userTab.id) : undefined;
  for (const field of ['windowId', 'index', 'groupId']) assertEqual(returned?.[field], userTab[field], `release preserves the user's ${field}`);
  await assertRejects(() => call('claimed-check', 'eval', { tabId: userTab.id ?? null, expression: 'document.title' }), 'unclaimed task cannot control it');
});

h.test('browser selection uses matching host evidence without opening or claiming a page', async () => {
  const familiar = base.replace('127.0.0.1', 'fixture.test');
  await call('familiar', 'new_tab', { url: familiar });
  const before = resultValue(await call('choice', 'tabs', { action: 'user' }));
  const choice = await service.chooseBrowser('choice', familiar);
  assertEqual(choice.browserId, browserId, 'known web host chooses the external browser');
  assertEqual((await service.chooseBrowser('choice', base)).browserId, 'iab', 'local development pages choose the built-in browser');
  const after = resultValue(await call('choice', 'tabs', { action: 'user' }));
  assertEqual(JSON.stringify(after), JSON.stringify(before), 'choosing does not navigate, create or claim tabs');
  service.releaseSession('familiar');
});

h.test('document redirects are blocked before the forbidden origin reaches the network', async () => {
  await call('policy', 'new_tab', { url: base });
  await assertRejects(() => call('policy', 'navigate', { url: `${base}/redirect` }), 'redirect into denied document rejected');
  assertEqual(forbiddenRequests, 0, 'Fetch policy stopped the denied document request');
  service.releaseSession('policy');
});

h.test('external page prompt is answered through a separate task-scoped dialog operation', async () => {
  const pending = call('A', 'eval', { expression: 'prompt("External prompt", "default")' });
  void pending.catch(() => {});
  let dialog: BrowserObject = {};
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    dialog = object(resultValue(await call('A', 'dialog'))); if (dialog.id) break;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  assert(typeof dialog.id === 'string', 'pending Chrome dialog observed');
  await assertRejects(() => call('B', 'dialog', { action: 'accept', tabId: tabA, dialogId: dialog.id ?? '' }), 'another task cannot answer it');
  await call('A', 'dialog', { action: 'accept', dialogId: dialog.id, promptText: 'answered' });
  assertEqual(resultValue(await pending), 'answered', 'synchronous Chrome prompt returned supplied value');
  await assertRejects(() => call('A', 'dialog', { action: 'accept', dialogId: dialog.id ?? '' }), 'old prompt answer rejected');
});

h.test('simultaneous downloads of one URL have distinct task-owned Chrome download ids', async () => {
  const [a, b] = await Promise.all([call('A', 'download', { url: `${base}/download` }), call('B', 'download', { url: `${base}/download` })]);
  const first = object(resultValue(a)); const second = object(resultValue(b));
  assert(typeof first.id === 'string' && typeof second.id === 'string' && first.id !== second.id, 'distinct Chrome download ids');
  assert(first.path !== second.path, 'concurrent filenames are unique');
  for (const item of [first, second]) {
    assert(String(item.path).startsWith(join(profile, 'downloads')), 'download stayed in fixture profile');
    assert(readFileSync(String(item.path), 'utf8').startsWith('fixture-download-'), 'completed bytes are present');
  }
  const instance = (await discoverChrome(discoveryDirectory)).browsers[0]; assert(instance, 'live native host');
  const relay = await ChromeRelay.connect(instance.endpoint); directRelays.push(relay);
  await assertRejects(() => relay.request('getDownload', { session_id: 'B', turn_id: 'foreign', id: first.id ?? null }), 'other task cannot read download details');
  await assertRejects(() => relay.request('cancelDownload', { session_id: 'B', turn_id: 'foreign', id: first.id ?? null }), 'other task cannot cancel download');
});

h.test('download cancel and task release reject stale native download handles', async () => {
  const relay = directRelays[0]; assert(relay, 'direct native protocol client');
  const started = object(await relay.request('download', { session_id: 'A', turn_id: 'cancel', tabId: tabA, url: `${base}/slow` }));
  const canceled = object(await relay.request('cancelDownload', { session_id: 'A', turn_id: 'cancel', id: started.id ?? null }));
  assertEqual(canceled.status, 'canceled', 'Chrome download actually canceled');
  const tab = object(resultValue(await call('closing-download', 'new_tab', { url: base })));
  const closing = object(await relay.request('download', { session_id: 'closing-download', turn_id: 'closing', tabId: tab.tabId ?? null, url: `${base}/slow` }));
  service.releaseSession('closing-download');
  const until = Date.now() + 5000;
  for (;;) {
    try { await relay.request('getDownload', { session_id: 'closing-download', turn_id: 'stale', id: closing.id ?? null }); }
    catch { break; }
    if (Date.now() > until) throw new Error('Released download handle remained accessible');
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  }
  await assertRejects(() => relay.request('download', { session_id: 'closing-download', turn_id: 'stale', tabId: tab.tabId ?? null, url: `${base}/download` }), 'released tab cannot start another download');
});

h.test('upload permissions use the actual cross-origin input document before file delivery', async () => {
  await call('upload-origin', 'new_tab', { url: base });
  const path = join(profile, 'upload-origin.txt'); writeFileSync(path, 'synthetic upload');
  const located = object(resultValue(await call('upload-origin', 'locator', { selector: '#upload-origin-input', timeoutMs: 3000 })));
  const target = object((located.elements as BrowserObject[])[0]);
  assert(typeof target.frameTargetId === 'string', 'the input belongs to an owned cross-process frame');
  denyUpload = true;
  try {
    await assertRejects(() => call('upload-origin', 'file_upload', { ref: target.ref!, frameTargetId: target.frameTargetId!, path }), 'denied input document cannot receive files');
    assertEqual(resultValue(await call('upload-origin', 'eval', { frameTargetId: target.frameTargetId!, expression: 'document.getElementById("upload-origin-input").files.length' })), 0, 'denial happens before file delivery');
  } finally { denyUpload = false; }
  await call('upload-origin', 'file_upload', { selector: '#upload-origin-input', path });
  assertEqual(uploadOrigins.length, 2, 'each file delivery checks one initiating document');
  assert(uploadOrigins.every(origin => origin === base.replace('127.0.0.1', 'localhost')), 'the child document origin is authorized instead of the top-level origin');
  service.releaseSession('upload-origin');
});

h.test('operation cancellation stops its owned Chrome download without releasing the page', async () => {
  const relay = directRelays[0]; assert(relay, 'direct native protocol client');
  const before = object(await relay.request('listDownloads', { session_id: 'A', turn_id: 'before-abort', tabId: tabA }));
  const known = new Set((Array.isArray(before.downloads) ? before.downloads : []).map(row => object(row).id));
  const controller = new AbortController();
  const pending = service.execute('A', browserId, 'download', { url: `${base}/slow`, timeoutMs: 10000 }, {}, controller.signal);
  void pending.catch(() => {});
  let id: string | undefined;
  await waitFor(async () => {
    const result = object(await relay.request('listDownloads', { session_id: 'A', turn_id: 'observe-abort', tabId: tabA }));
    const entry = (Array.isArray(result.downloads) ? result.downloads : []).map(object).find(row => !known.has(row.id) && row.status === 'in_progress');
    id = typeof entry?.id === 'string' ? entry.id : undefined;
    return !!id;
  }, 5000, 'the operation owns one active download');
  controller.abort(new BrowserError('cancelled', 'Fixture operation canceled.'));
  await assertRejects(() => pending, 'the canceled operation rejects');
  await waitFor(async () => object(await relay.request('getDownload', { session_id: 'A', turn_id: 'after-abort', id: id! })).status === 'canceled', 5000, 'the owned download is canceled');
  assertEqual(resultValue(await call('A', 'eval', { expression: 'document.title' })), 'Second', 'canceling a transfer retains the task page');
});

h.test('disconnecting a selected Chrome instance fails explicitly without opening an IAB tab', async () => {
  await assertRejects(() => service.select('chrome:does-not-exist'), 'missing browser id refused');
  const list = await service.list(); assertEqual(list.length, 1, 'one actual external browser remains');
});

h.test('many tabs share one event consumer without listener warnings or task contamination', async () => {
  for (let index = 0; index < 12; index += 1) await call('many-tabs', 'new_tab');
  const tabs = resultValue(await call('many-tabs', 'tabs')); assert(Array.isArray(tabs) && tabs.length === 12, 'twelve task-owned pages');
  await call('many-tabs', 'close');
  const empty = await call('many-tabs', 'tabs');
  assertEqual(object(object(empty._meta)['klaus/toolSurface']).sessionEnded, true, 'closing all tabs produces the established empty surface');
  assertEqual(warnings.length, 0, 'no MaxListeners or other Node runtime warnings');
});

// Shared browser cases exercise the public MCP result contract; backend-specific
// cases above retain the raw service's rejection contract.
const advancedOperations = new BrowserOperations({
  isEnabled: () => true, beginOperation: () => () => {}, assertNavigation: navigationUrl,
} as unknown as BrowserManager, service);
registerAdvancedBrowserTests(h, { call: (kind, fields) => advancedOperations.execute('advanced', kind, { ...fields, browserId }), base: () => base, directory: profile, clipboard: true });

h.test('releasing a claimed Chrome page cancels media readers while leaving the real user page open',async()=>{
  await waitFor(()=>slowDownloadCount()===0,2000,'prior timed out HTTP streams closed');
  const port=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];
  const userUrl = `${base}/advanced-download-page#claimed-media-fixture`;
  const opened=object(await (await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(userUrl)}`,{method:'PUT'})).json());
  let user: BrowserObject | undefined;
  await waitFor(async () => {
    const users = resultValue(await call('user-list', 'tabs', { action: 'user' }));
    user = Array.isArray(users) ? users.map(object).find(row => row.url === userUrl) : undefined;
    return !!user;
  }, 5000, 'the independent user page completed its own navigation');
  assert(user, 'independent user page exists');
  const userId = user.id!;
  await call('media-claimed','claim_tab',{tabId:userId});
  const pending=call('media-claimed','download',{selector:'#slow',timeoutMs:10000});void pending.catch(()=>{});
  await waitFor(()=>slowDownloadCount()>0,3000,'claimed page HTTP reader started');
  service.releaseSession('media-claimed');await assertRejects(()=>pending,'released media operation fails');
  await waitFor(()=>slowDownloadCount()===0,3000,'claimed page HTTP reader aborted');
  const tabs=await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as BrowserObject[];assert(tabs.some(tab=>tab.id===opened.id),'user-owned page remains open');
  await waitFor(async()=>{const rows=resultValue(await call('user-list','tabs',{action:'user'}));return Array.isArray(rows)&&rows.map(object).some(row=>row.id===userId);},3000,'claimed page returned to user');
  await call('media-reclaimed','claim_tab',{tabId:userId});
  assertEqual(resultValue(await call('media-reclaimed','eval',{expression:'Object.keys(window).filter(key=>key.startsWith("__klausDownload_")).length'})),0,'old transfer objects removed before a new task claims the page');
  service.releaseSession('media-reclaimed');
});

h.test('named Chrome permissions apply real profile settings and reject unknown permission names', async () => {
  const grant = object(resultValue(await call('advanced', 'permission', { action: 'grant', origin: base, permissions: ['geolocation'] })));
  assertEqual(grant.scope, 'chrome-profile', 'profile scope is explicit');
  assertEqual(object(object((grant.applied as BrowserObject[])[0]).current).setting, 'allow', 'contentSettings readback: ' + JSON.stringify(grant));
  const observed = object((grant.observed as BrowserObject[])[0]);
  assertEqual(observed.state, resultValue(await call('advanced', 'eval', { expression: 'navigator.permissions.query({name:"geolocation"}).then(p=>p.state)' })), 'returned page permission matches the actual browser, including platform prompt state');
  assertEqual(String(object((grant.applied as BrowserObject[])[0]).pattern), base + '/*', 'permission pattern keeps the explicit origin port');
  await call('advanced', 'permission', { action: 'set', origin: base, permission: 'geolocation', setting: 'denied' });
  assertEqual(resultValue(await call('advanced', 'eval', { expression: 'navigator.permissions.query({name:"geolocation"}).then(p=>p.state)' })), 'denied', 'actual Chrome permission denied');
  await assertRejects(() => call('advanced', 'permission', { action: 'grant', origin: base, permissions: ['unknown-permission'] }), 'unknown permissions fail explicitly');
  await call('advanced', 'permission', { action: 'reset' });
});

h.test('mark_tab applies dispositions on close without confusing them with the group name', async () => {
  const deliverable = object(resultValue(await call('marking', 'new_tab', { url: base })));
  const handoff = object(resultValue(await call('marking', 'new_tab', { url: base })));
  const discarded = object(resultValue(await call('marking', 'new_tab', { url: base })));
  await call('marking', 'tabs', { action: 'name_session', name: 'Fixture task' });
  const marked = object(resultValue(await call('marking', 'mark_tab', { tabId: deliverable.tabId!, status: 'deliverable' })));
  assertEqual(marked.appliedOn, 'close', 'mark is recorded, not prematurely finalized');
  await call('marking', 'mark_tab', { tabId: handoff.tabId!, status: 'handoff' });
  await assertRejects(() => call('other-marking', 'mark_tab', { tabId: deliverable.tabId!, status: 'deliverable' }), 'another task cannot mark this tab');
  await call('marking', 'close');
  const owned = resultValue(await call('marking', 'tabs')); assert(Array.isArray(owned) && owned.length === 1 && object(owned[0]).id === handoff.tabId, 'handoff remains task-owned');
  const users = resultValue(await call('user-list', 'tabs_content')); assert(Array.isArray(users), 'user tab inventory');
  assert(users.map(object).some(row => row.id === deliverable.tabId), 'deliverable remains open and released');
  assert(!users.map(object).some(row => row.id === discarded.tabId), 'unmarked agent page is closed');
});

h.test('task cleanup releases only its own tabs and application shutdown leaves Chrome alive', async () => {
  service.releaseSession('A');
  await waitFor(async () => {
    const list = resultValue(await call('A-check', 'tabs', { action: 'user' }));
    return Array.isArray(list) && !list.map(object).some(row => row.id === tabA);
  }, 5000, 'task A agent tab closed');
  assertEqual(resultValue(await call('B', 'eval', { expression: 'document.title' })), 'External fixture', 'task B remains');
  await service.shutdown();
  assert(browser && browser.exitCode === null, 'Klaus shutdown does not kill external Chrome');
  const found = await discoverChrome(discoveryDirectory); assertEqual(found.browsers.length, 1, 'browser-owned native host remains');
});

void h.finish(join(__dirname, 'chrome-browser-result.json'), 'chrome-browser').then(async code => {
  await service.shutdown();
  for (const relay of directRelays) relay.close();
  if (browser?.exitCode === null) {
    const closed = new Promise<void>(resolveClose => browser?.once('close', () => resolveClose()));
    browser.kill('SIGTERM'); await closed;
  }
  await new Promise<void>(resolveClose => server.close(() => resolveClose()));
  log.end();
  if (code !== 0) process.stderr.write(`${readFileSync(join(profile, 'chrome.log'), 'utf8').slice(-12000)}\n`);
  rmSync(profile, { recursive: true, force: true });
  const cleanup = join(__dirname, `cleanup-${basename(discoveryDirectory)}`); renameSync(discoveryDirectory, cleanup); rmSync(cleanup, { recursive: true, force: true });
  process.exit(code);
});
