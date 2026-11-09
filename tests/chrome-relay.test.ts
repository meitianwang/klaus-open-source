import { PassThrough } from 'node:stream';
import { createConnection } from 'node:net';
import { mkdtempSync, renameSync, rmSync, lstatSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { ChromeNativeHost } from '../main/browser/chrome-native-host';
import { ChromeBrowserService } from '../main/browser/chrome-browser';
import { ChromePageDebugger } from '../main/browser/chrome-cdp';
import { ChromeRelay, discoverChrome } from '../main/browser/chrome-relay';
import { ChromeFrameDecoder, chromeFrame, MAX_CHROME_FRAME } from '../main/browser/chrome-wire';
import { object, type BrowserObject } from '../main/browser/types';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness, waitFor } from './harness';

const h = new Harness();
// macOS's default temporary directory is too long for a Unix socket pathname.
const directory = mkdtempSync(join(process.platform === 'win32' ? process.env.TEMP || __dirname : '/tmp', 'kls-chr-'));
const hosts: ChromeNativeHost[] = [];
const relays: ChromeRelay[] = [];
const watchDirs: string[] = [];
async function fixture(id: string, transport: 'unix' | 'tcp' = process.platform === 'win32' ? 'tcp' : 'unix', options: { capabilities?: string[]; info?: () => BrowserObject; tabs?: BrowserObject[]; cdp?: (method: string, params: BrowserObject) => BrowserObject } = {}) {
  const input = new PassThrough(); const output = new PassThrough();
  const received: BrowserObject[] = [];
  const decoder = new ChromeFrameDecoder(true);
  const host = new ChromeNativeHost({ directory, input, output, transport, parentExecutable: '/fixture/Chrome' });
  hosts.push(host);
  output.on('data', (chunk: Buffer) => {
    for (const request of decoder.push(chunk)) {
      received.push(request);
      if (request.method === 'getInfo') input.write(chromeFrame({ jsonrpc: '2.0', id: request.id ?? null, result: options.info?.() ?? { name: 'Chrome', version: 'fixture', metadata: { extensionInstanceId: id, capabilities: options.capabilities ?? [] } } }, true));
      if (request.method === 'getUserTabs') input.write(chromeFrame({ jsonrpc: '2.0', id: request.id ?? null, result: options.tabs ?? [] }, true));
      if (options.cdp && request.method === 'attach') input.write(chromeFrame({ jsonrpc: '2.0', id: request.id ?? null, result: {} }, true));
      if (options.cdp && request.method === 'executeCdp') {
        const params = object(request.params);
        try { input.write(chromeFrame({ jsonrpc: '2.0', id: request.id ?? null, result: options.cdp(String(params.method), object(params.commandParams)) }, true)); }
        catch (error) { input.write(chromeFrame({ jsonrpc: '2.0', id: request.id ?? null, error: { message: String(error) } }, true)); }
      }
    }
  });
  await host.start();
  const relay = await ChromeRelay.connect(host.endpoint); relays.push(relay);
  return { input, output, received, host, relay };
}

h.test('native messaging decodes fragmented Unicode frames and rejects an excessive declared size', () => {
  const expected = { jsonrpc: '2.0', id: 1, result: '人工与 agent' };
  const bytes = chromeFrame(expected, true);
  const decoder = new ChromeFrameDecoder(true);
  const output: BrowserObject[] = [];
  for (const byte of bytes) output.push(...decoder.push(Buffer.from([byte])));
  assertDeepEqual(output, [expected], 'native byte length and Unicode payload');
  const oversized = Buffer.alloc(4); oversized.writeUInt32LE(MAX_CHROME_FRAME + 1);
  let rejected = false; try { new ChromeFrameDecoder().push(oversized); } catch { rejected = true; }
  assert(rejected, 'oversized frame refused before allocating its claimed body');
});

h.test('two clients can use the same local request id and receive only their own out-of-order reply', async () => {
  const test = await fixture('multi');
  const second = await ChromeRelay.connect(test.host.endpoint); relays.push(second);
  const a = test.relay.request('executeCdp', { session_id: 'A', turn_id: 'a' });
  const b = second.request('executeCdp', { session_id: 'B', turn_id: 'b' });
  await waitFor(() => test.received.length === 2, 1000, 'both requests forwarded');
  assert(test.received[0]?.id !== test.received[1]?.id, 'native ids are unique');
  for (const request of [...test.received].reverse()) test.input.write(chromeFrame({ jsonrpc: '2.0', id: request.id ?? null, result: object(request.params).session_id ?? null }, true));
  assertEqual(await a, 'A', 'first client response'); assertEqual(await b, 'B', 'second client response');
  test.host.close();
});

h.test('one persistent connection observes a CDP event once while another request is pending', async () => {
  const test = await fixture('events'); const events: BrowserObject[] = [];
  test.relay.on('notification', value => events.push(value));
  const response = test.relay.request('executeCdp', { session_id: 'A', turn_id: 'one' });
  await waitFor(() => test.received.length === 1, 1000, 'request sent');
  const event = { jsonrpc: '2.0', method: 'onCDPEvent', params: { source: { tabId: 12 }, method: 'Runtime.consoleAPICalled', params: { type: 'log' } } };
  test.input.write(chromeFrame(event, true));
  test.input.write(chromeFrame({ jsonrpc: '2.0', id: test.received[0]!.id ?? null, result: {} }, true));
  await response; assertDeepEqual(events, [event], 'no collector/request duplication');
  test.host.close();
});

h.test('successful viewport and touch settings survive debugger reattachment while failed requests and reset cannot corrupt them', async () => {
  let rejectMetrics = false;
  const test = await fixture('viewport', undefined, { cdp: (method): BrowserObject => {
    if (method === 'Target.getTargetInfo') return { targetInfo: { targetId: 'viewport-target' } };
    if (method === 'Emulation.setDeviceMetricsOverride' && rejectMetrics) throw new Error('Invalid metrics');
    return {};
  } });
  const page = new ChromePageDebugger(test.relay, 'task-a', 17);
  const metrics = { width: 640, height: 480, deviceScaleFactor: 1, mobile: true };
  await page.command('Emulation.setDeviceMetricsOverride', metrics);
  await page.command('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 });
  rejectMetrics = true;
  await assertRejects(() => page.command('Emulation.setDeviceMetricsOverride', { ...metrics, width: 999 }), 'failed metrics cannot replace successful task state');
  rejectMetrics = false;
  await page.detached();
  let start = test.received.length;
  await page.command('Runtime.evaluate', { expression: 'innerWidth' });
  const commands = test.received.slice(start).filter(row => row.method === 'executeCdp').map(row => object(row.params));
  assertDeepEqual(object(commands.find(row => row.method === 'Emulation.setDeviceMetricsOverride')?.commandParams), metrics, 'the next attachment restores the successful viewport');
  assertDeepEqual(object(commands.find(row => row.method === 'Emulation.setTouchEmulationEnabled')?.commandParams), { enabled: true, maxTouchPoints: 1 }, 'mobile touch state follows the same attachment');
  await page.command('Emulation.clearDeviceMetricsOverride');
  await page.command('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 1 });
  await page.detached(); start = test.received.length;
  await page.command('Runtime.evaluate', { expression: 'innerWidth' });
  assert(!test.received.slice(start).some(row => String(object(row.params).method).startsWith('Emulation.')), 'reset removes both persistent overrides');
  await page.dispose();
  await assertRejects(() => page.command('Runtime.evaluate', { expression: 'innerWidth' }), 'released task state cannot be reused');
  test.host.close();
});

h.test('TCP discovery authenticates the initial token without dropping the following request', async () => {
  const test = await fixture('tcp', 'tcp');
  assertEqual(object(await test.relay.request('getInfo')).name, 'Chrome', 'authenticated request succeeds');
  const endpoint = object(JSON.parse(readFileSync(test.host.endpoint, 'utf8')));
  const port = Number(String(endpoint.addr).split(':')[1]);
  const wrong = createConnection({ host: '127.0.0.1', port });
  const done = new Promise<void>(resolve => wrong.once('close', () => resolve()));
  wrong.once('connect', () => wrong.write(chromeFrame({ klausToken: 'wrong' })));
  await done;
  assert(wrong.destroyed, 'unauthenticated client was closed');
  test.host.close();
});

h.test('discovery returns stable browser instance ids and private endpoint metadata', async () => {
  const a = await fixture('alpha'); const b = await fixture('beta');
  const found = await discoverChrome(directory);
  assertDeepEqual(found.browsers.map(browser => browser.id).sort(), ['chrome:alpha', 'chrome:beta'], 'both browser instances are explicit');
  assert(found.browsers.every(browser => browser.executable === '/fixture/Chrome'), 'browser label comes from its host');
  if (process.platform !== 'win32') assertEqual(lstatSync(a.host.endpoint).mode & 0o777, 0o600, 'private socket permissions');
  a.host.close(); b.host.close();
});

h.test('legacy extensions are listed as unavailable instead of ignoring task frame routing', async () => {
  const test = await fixture('legacy');
  const service = new ChromeBrowserService({ enabled: () => true, discoveryDirectory: directory });
  assertEqual((await service.list())[0]?.available, false, 'missing frame/download capabilities require extension reload');
  await assertRejects(() => service.select('chrome:legacy'), 'legacy capabilities cannot silently fall back or route a child frame to the page');
  await service.shutdown(); test.host.close();
});

h.test('management requires the extension announcement and never reaches an unannouncing extension', async () => {
  const plain = await fixture('no-mgmt', undefined, { capabilities: ['task_downloads', 'flat_cdp_sessions', 'tab_mentions_v1'] });
  const announced = await fixture('with-mgmt', undefined, { capabilities: ['task_downloads', 'flat_cdp_sessions', 'browser_management'] });
  const service = new ChromeBrowserService({ enabled: () => true, discoveryDirectory: directory });
  await service.select('chrome:no-mgmt');
  assertEqual(service.managementSupported('chrome:no-mgmt'), false, 'an extension without the announcement does not support management');
  const error = await assertRejects(() => service.execute('mgmt-session', 'chrome:no-mgmt', 'management', { action: 'call', namespace: 'tabs', method: 'query', args: [{}] }, {}), 'management refuses the unannouncing extension');
  assert(String(error).includes('Update the Klaus extension'), `the refusal names the extension recovery path: ${String(error)}`);
  assert(!plain.received.some(request => request.method === 'managementCall'), 'no management request reaches an unannouncing extension');
  await service.select('chrome:with-mgmt');
  assertEqual(service.managementSupported('chrome:with-mgmt'), true, 'the announcing extension supports management');
  await service.shutdown(); plain.host.close(); announced.host.close();
});

h.test('tab inventory keeps one exact browser connection and immediately publishes extension changes', async () => {
  const test = await fixture('mentions', undefined, { capabilities: ['task_downloads', 'flat_cdp_sessions', 'tab_mentions_v1'], tabs: [{ id: 17, title: 'Inbox', url: 'https://example.com/inbox' }] });
  let changes = 0;
  const service = new ChromeBrowserService({ enabled: () => true, discoveryDirectory: directory, onTabsChanged: () => { changes++; } });
  const tabs = await service.mentionTabs('chrome:mentions', 'Inbox', 100);
  assertEqual(tabs[0]?.id, 17, 'inventory returns the external handle');
  const inventory = test.received.find(request => request.method === 'getUserTabs');
  assertDeepEqual(object(inventory?.params), { session_id: 'klaus-tab-mention-inventory', turn_id: 'inventory', query: 'Inbox', limit: 100, includeFavicons: true }, 'bounded read-only inventory fields');
  test.input.write(chromeFrame({ jsonrpc: '2.0', method: 'onTabsChanged', params: { tabId: 17, reason: 'updated' } }, true));
  await waitFor(() => changes === 1, 1000, 'live tab event reaches picker invalidation');
  assert(!test.received.some(request => ['claimUserTab', 'focusTab', 'createTab', 'executeCdp'].includes(String(request.method))), 'discovery performs no user-tab side effects');
  await service.shutdown(); test.host.close();
});

h.test('tab mentions require the preserving extension version and reject profile changes during connection', async () => {
  const old = await fixture('old-mentions', undefined, { capabilities: ['task_downloads', 'flat_cdp_sessions'] });
  const service = new ChromeBrowserService({ enabled: () => true, discoveryDirectory: directory });
  const error = await assertRejects(() => service.mentionTabs('chrome:old-mentions'), 'old extension cannot simplify borrowing');
  assert(String(error).includes('original window and group'), 'reload notice describes the required capability');
  assert(!old.received.some(request => request.method === 'getUserTabs'), 'incompatible inventory is not silently used');
  await service.shutdown(); old.host.close();
  let reads = 0;
  const changed = await fixture('profile', undefined, { info: () => ({ name: 'Chrome', metadata: { extensionInstanceId: ++reads === 1 ? 'profile' : 'replacement', capabilities: ['task_downloads', 'flat_cdp_sessions', 'tab_mentions_v1'] } }) });
  const exact = new ChromeBrowserService({ enabled: () => true, discoveryDirectory: directory });
  const refusal = await assertRejects(() => exact.mentionTabs('chrome:profile'), 'replacement profile is rejected');
  assert(String(refusal).includes('profile changed'), 'identity is checked on the persistent connection');
  await exact.shutdown(); changed.host.close();
});

h.test('oversized native commands fail explicitly without corrupting the Chrome stream', async () => {
  const test = await fixture('size');
  await assertRejects(() => test.relay.request('executeCdp', { large: 'x'.repeat(1024 * 1024) }), 'Chrome outbound 1MB limit');
  assertEqual(test.received.length, 0, 'oversized payload never enters native stdout');
  assertEqual(object(await test.relay.request('getInfo')).name, 'Chrome', 'connection remains usable');
  test.host.close();
});

h.test('native disconnect rejects pending requests and removes only its own endpoint', async () => {
  const a = await fixture('closing'); const b = await fixture('sibling');
  const pending = a.relay.request('unanswered');
  const failure = assertRejects(() => pending, 'pending request rejects when Chrome exits');
  await waitFor(() => a.received.length === 1, 1000, 'request pending');
  a.input.end(); await failure;
  assert(!existsSync(a.host.endpoint), 'closed endpoint removed');
  assert(existsSync(b.host.endpoint), 'sibling endpoint retained');
  b.host.close();
});

// A relay published into a temporary directory outlives the file that makes it
// discoverable: the operating system can remove the socket while the browser
// keeps its stdio side open. The browser then believes it is still connected
// and never reconnects, so the host has to notice the loss itself and exit.
// Each case keeps the simulated browser pipe open, so an observed close can
// only come from the endpoint watch rather than from a normal end of input.
function watchFixture(): { host: ChromeNativeHost; input: PassThrough; closed: Array<Error | undefined>; dir: string } {
  const dir = mkdtempSync(join(process.platform === 'win32' ? process.env.TEMP || __dirname : '/tmp', 'kls-watch-'));
  watchDirs.push(dir);
  const input = new PassThrough(); const output = new PassThrough();
  const closed: Array<Error | undefined> = [];
  const host = new ChromeNativeHost({ directory: dir, input, output, endpointWatchMs: 20, onClosed: error => closed.push(error) });
  hosts.push(host);
  return { host, input, closed, dir };
}

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

h.test('a relay exits when its endpoint file is deleted so the browser reconnects', async () => {
  const test = watchFixture();
  await test.host.start();
  const endpoint = test.host.endpoint;
  assert(existsSync(endpoint), 'endpoint published');
  rmSync(endpoint);
  await waitFor(() => test.closed.length === 1, 2000, 'host notices its endpoint is gone');
  assert(/removed from its discovery directory/.test(String(test.closed[0]?.message)), 'close carries the endpoint-loss reason');
  assert(!test.input.destroyed, 'the browser pipe was still open, so this was not a normal EOF exit');
  test.input.end();
});

h.test('a relay exits when its whole discovery directory is removed', async () => {
  const test = watchFixture();
  await test.host.start();
  rmSync(test.dir, { recursive: true, force: true });
  await waitFor(() => test.closed.length === 1, 2000, 'host notices the missing directory');
  assert(/removed from its discovery directory/.test(String(test.closed[0]?.message)), 'a missing directory reports as a removed endpoint');
  test.input.end();
});

h.test('a relay exits when its endpoint is replaced and never unlinks the successor', async () => {
  const test = watchFixture();
  await test.host.start();
  const endpoint = test.host.endpoint;
  const replacement = `${endpoint}.replacement`;
  // A different inode at the same path: another host or an unrelated file now
  // occupies it. Deleting it would destroy something this relay does not own.
  // The rename replaces atomically, so the watch can never observe a gap that
  // would look like removal instead of replacement.
  writeFileSync(replacement, 'not a klaus endpoint');
  renameSync(replacement, endpoint);
  await waitFor(() => test.closed.length === 1, 2000, 'host notices the endpoint changed identity');
  assert(/replaced by another file/.test(String(test.closed[0]?.message)), 'close names replacement distinctly from removal');
  assert(existsSync(endpoint), 'the successor file was left untouched');
  assertEqual(readFileSync(endpoint, 'utf8'), 'not a klaus endpoint', 'successor content intact');
  rmSync(endpoint);
  test.input.end();
});

h.test('an idle relay with an intact endpoint never exits on its own', async () => {
  const test = watchFixture();
  await test.host.start();
  const endpoint = test.host.endpoint;
  await wait(150);
  assertEqual(test.closed.length, 0, 'no close while the endpoint is healthy');
  assert(existsSync(endpoint), 'endpoint still published');
  test.host.close();
  assert(!existsSync(endpoint), 'an owned endpoint is still removed on close');
  test.input.end();
});

h.test('a closed relay stops watching and reports a second close only once', async () => {
  const test = watchFixture();
  await test.host.start();
  test.host.close();
  assertEqual(test.closed.length, 1, 'first close reported');
  rmSync(test.host.endpoint, { force: true });
  await wait(120);
  assertEqual(test.closed.length, 1, 'watch stopped, no further close callback');
  test.input.end();
});

void h.finish(join(__dirname, 'chrome-relay-result.json'), 'chrome-relay').then(code => {
  for (const relay of relays) relay.close();
  for (const host of hosts) host.close();
  const cleanup = join(__dirname, `cleanup-${basename(directory)}`);
  renameSync(directory, cleanup); rmSync(cleanup, { recursive: true, force: true });
  for (const dir of watchDirs) rmSync(dir, { recursive: true, force: true });
  process.exit(code);
});
