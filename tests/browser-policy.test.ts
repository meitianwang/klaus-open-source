import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { browserBounds, checkRawCdp, navigationUrl, timeoutMs } from '../main/browser/policy';
import { BrowserOperations, browserFailure, browserTools, parseOperation } from '../main/browser/operations';
import type { ChromeBrowserService } from '../main/browser/chrome-browser';
import { ChromePageDebugger } from '../main/browser/chrome-cdp';
import type { ChromeRelay } from '../main/browser/chrome-relay';
import { BrowserError, object, type BrowserObject } from '../main/browser/types';
import { validateLocator } from '../main/browser/locator-policy';
import { integerTimestampMs } from '../main/browser/event-shapes';
import { performPageOperation, type PageOperationContext } from '../main/browser/page-operations';
import { navigateForRead, readUrls, type TemporaryPage } from '../main/browser/task-operations';
import { MAX_BROWSER_WAIT_MS, waitForPage } from '../main/browser/page-wait';
import { captureScreenshot } from '../main/browser/page-capture';
import { BROWSER_PANEL_OPEN_ACK_TIMEOUT_MS, browserOperationRequestsPanel } from '../main/browser/panel-contract';
import { BrowserPermissionDecisions, PendingBrowserPermissions } from '../main/browser/permission-requests';
import { permissionQueryShimSource, permissionQueryUpdateExpression, synthesizePermissionQueryPolicy } from '../main/browser/permission-query';
import type { BrowserManager } from '../main/browser/manager';
import { registerBrowserHandlers } from '../main/ipc/handlers/browser';
import { ChannelRegistry } from '../main/ipc/registry';
import { assert, assertDeepEqual, assertEqual, assertRejects, Harness, waitFor } from './harness';

const h = new Harness();

h.test('address bar accepts local previews and normal web URLs', () => {
  assertEqual(navigationUrl('localhost:3000/demo'), 'http://localhost:3000/demo', 'local preview');
  assertEqual(navigationUrl('example.com/a'), 'https://example.com/a', 'bare host');
  assertEqual(navigationUrl('about:blank'), 'about:blank', 'empty page');
});

h.test('navigation refuses privileged schemes before a browser target is created', () => {
  for (const url of ['file:///etc/passwd', 'klaus-app://app/index.html', 'javascript:alert(1)', 'data:text/html,hello', 'devtools://devtools', 'https://exa\nmple.com']) {
    let refused = false;
    try { navigationUrl(url); } catch (error) { refused = error instanceof BrowserError; }
    assert(refused, `${url} must be refused`);
  }
});

h.test('native bounds reject nonfinite or empty rectangles instead of passing them to Electron', () => {
  assertDeepEqual(browserBounds({ x: -2, y: 2.6, width: 100.2, height: 80.1 }), { x: 0, y: 3, width: 100, height: 80 }, 'rounded CSS coordinates');
  for (const width of [NaN, Infinity, 0, -1, '100']) {
    let refused = false;
    try { browserBounds({ x: 0, y: 0, width, height: 10 }); } catch { refused = true; }
    assert(refused, `width ${String(width)} must be refused`);
  }
});

h.test('raw CDP cannot create a target, read global cookies, upload files or bypass navigation policy', () => {
  for (const method of ['Target.createTarget', 'Browser.close', 'Network.getAllCookies', 'DOM.setFileInputFiles', 'Page.navigate', 'Security.setIgnoreCertificateErrors', 'Network.loadNetworkResource', 'DOM.getFileInfo']) {
    let refused = false;
    try { checkRawCdp(method); } catch { refused = true; }
    assert(refused, `${method} must be refused`);
  }
  checkRawCdp('Runtime.evaluate');
  checkRawCdp('DOM.getDocument');
});

h.test('named and facade requests keep their operation fields and task tab target', () => {
  const flat = parseOperation('navigate', { url: 'https://example.com/', target: { tabId: 2 } });
  assertEqual(flat.kind, 'navigate', 'named MCP operation');
  assertEqual(parseOperation('browser_for_url', { url: 'https://example.com/' }).kind, 'browser_for_url', 'a declared tool name keeps its browser prefix');
  assertEqual(parseOperation('browser_navigate', { url: 'https://example.com/' }).kind, 'navigate', 'engine prefix is removed for other named operations');
  assertEqual(flat.fields.tabId, 2, 'target handle');
  const enveloped = parseOperation('browser_tabs', { operation: { type: 'tabs', action: 'new', url: 'https://example.com/' }, target: { browserId: 'iab' } });
  assertEqual(enveloped.fields.action, 'new', 'tab action is not reduced to listing');
  assertEqual(enveloped.target.browserId, 'iab', 'explicit browser identity');
});

h.test('unfinished surfaces are declared unavailable and return a machine-readable failure', () => {
  for (const name of ['gif_creator', 'upload_image', 'shortcuts_list', 'shortcuts_execute']) {
    const tool = browserTools().find(entry => entry.name === name);
    assert(String(tool?.description).startsWith('NOT IMPLEMENTED'), `${name} stays explicitly unsupported`);
  }
  const error = browserFailure(new BrowserError('unavailable', 'Not implemented.'));
  assertEqual(error.isError, true, 'MCP error flag');
  assertDeepEqual(error.error, { code: 'unavailable', message: 'Not implemented.' }, 'engine error envelope');
});

h.test('typed locator requests preserve accessible criteria without an empty CSS selector', () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/browser-tool-contracts.json'), 'utf8')) as {
    typedLocators: Array<{ operation: BrowserObject; kind: string; criteria: BrowserObject }>;
  };
  for (const row of vector.typedLocators) {
    const decoded = parseOperation('browser_locator', { operation: row.operation });
    assertEqual(decoded.kind, row.kind, 'typed locator action');
    assertEqual(decoded.fields.selector, undefined, 'wire placeholder does not become a CSS selector');
    for (const [key, value] of Object.entries(row.criteria)) assertDeepEqual(decoded.fields[key], value, `criterion ${key}`);
    validateLocator(decoded.fields);
  }
  for (const args of [{ selector: '', role: 'button' }, { operation: { type: 'locator', selector: '', action: 'click', options: {} } }]) {
    let refused = false;
    try { validateLocator(parseOperation('browser_locator', args).fields); } catch { refused = true; }
    assert(refused, 'an explicit empty selector cannot silently widen a search');
  }
});

h.test('browser tools retain the committed per-operation discovery contract', () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/browser-tool-contracts.json'), 'utf8')) as {
    operationNames: string[]; mustDeclare: Record<string,string[]>; defaults: Record<string, unknown>; descriptionFragments: Record<string,string>;
    panelAutoOpen: { acknowledgementTimeoutMs: number; vectors: Array<{ kind: string; fields: BrowserObject; opens: boolean }> };
  };
  const tools = browserTools();
  assertDeepEqual(tools.map(tool => tool.name), vector.operationNames, 'declared tool names and their order');
  for (const [name, fields] of Object.entries(vector.mustDeclare)) {
    const tool = tools.find(entry => entry.name === name);
    const properties = (tool?.inputSchema as BrowserObject | undefined)?.properties as BrowserObject | undefined;
    assert(properties !== undefined, `${name} declares an object schema`);
    for (const field of fields) assert(field in (properties ?? {}), `${name} advertises ${field}`);
  }
  for (const [path, expected] of Object.entries(vector.defaults)) {
    const [name, field] = path.split('.');
    const tool = tools.find(entry => entry.name === name);
    const properties = (tool?.inputSchema as BrowserObject).properties as BrowserObject;
    assertEqual((properties[field!] as BrowserObject).default, expected, `${path} default`);
  }
  for (const [name, fragment] of Object.entries(vector.descriptionFragments)) {
    const description = String(tools.find(entry => entry.name === name)?.description ?? '');
    assert(description.includes(fragment), `${name} retains its routing guidance`);
  }
  assertEqual(BROWSER_PANEL_OPEN_ACK_TIMEOUT_MS, vector.panelAutoOpen.acknowledgementTimeoutMs, 'panel-open acknowledgement deadline');
  for (const row of vector.panelAutoOpen.vectors) {
    assertEqual(browserOperationRequestsPanel(row.kind, row.fields), row.opens, `${row.kind}:${String(row.fields.action ?? '')} panel-open contract`);
  }
  const declared = tools.reduce((count, tool) => count + Object.keys(((tool.inputSchema as BrowserObject).properties as BrowserObject) ?? {}).length, 0);
  assert(declared > 300, 'the operation-specific contract cannot collapse back to a generic schema');
});

h.test('historical browser field spellings normalize before execution', () => {
  const click = parseOperation('click', { targetId: 'frame-1', refId: 'e-1' });
  assertEqual(click.fields.frameTargetId, 'frame-1', 'targetId aliases frameTargetId');
  assertEqual(click.fields.ref, 'e-1', 'refId aliases ref');
  const selected = parseOperation('select_browser', { deviceId: 'chrome' });
  assertEqual(selected.fields.browserId, 'chrome', 'deviceId aliases browserId');
  const capabilities = parseOperation('capabilities', { id: 'chrome-stable' });
  assertEqual(capabilities.fields.browserId, 'chrome-stable', 'capabilities id aliases browserId');
  const visible = parseOperation('visibility', { visible: true });
  assertEqual(visible.fields.action, 'set', 'visible-only shape is a set');
  const scroll = parseOperation('computer', { action: 'scroll', direction: 'up' });
  assertEqual(scroll.fields.scrollDirection, 'up', 'computer direction aliases scrollDirection');
  const wait = parseOperation('wait_for', { durationMs: 0 });
  assertEqual(wait.fields.ms, 0, 'durationMs aliases the fixed wait');
  const navigate = parseOperation('navigate', { url: 'https://example.com', viewport: { width: 390, height: 844, isMobile: true } });
  assertEqual(navigate.fields.mobile, true, 'navigate viewport normalizes isMobile before load');
});

h.test('fixed waits retain the duration alias and the released 120 second ceiling', async () => {
  assertEqual(MAX_BROWSER_WAIT_MS, 120000, 'wait ceiling');
  assertDeepEqual(await waitForPage(undefined, { durationMs: 0 }), { waitedMs: 0 }, 'durationMs works without a page');
  const immediate = await waitForPage({ evaluate: async () => 'complete' } as unknown as PageOperationContext['cdp'], { loadState: 'load', timeoutMs: 999999 });
  assertEqual(immediate.loadState, 'load', 'large predicate timeouts clamp instead of rejecting');
});

h.test('type delay emits key events and pressEnter reaches the same page', async () => {
  const commands: Array<{ method: string; params: BrowserObject }> = [];
  const context = { cdp: {
    command: async (method: string, params: BrowserObject = {}) => { commands.push({ method, params }); return {}; },
    evaluate: async (expression: string) => expression === 'document.readyState' ? 'complete' : null,
  } } as unknown as PageOperationContext;
  await performPageOperation(context, 'type', { text: 'ab', delayMs: 1, pressEnter: true });
  const keys = commands.filter(entry => entry.method === 'Input.dispatchKeyEvent').map(entry => entry.params.key);
  assertDeepEqual(keys, ['a','a','b','b','Enter','Enter','Enter'], 'characters and Enter use real key down/char/up events');
  await performPageOperation(context, 'type', { text: '', key: 'Escape' });
  assertEqual(commands.at(-1)?.params.key, 'Escape', 'key-only locator press remains supported');
});

h.test('scroll uses a wheel event at the viewport center unless a point is supplied', async () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/browser-tool-contracts.json'), 'utf8')) as {
    computerScroll: { default: { method: string; params: BrowserObject }; explicit: BrowserObject };
  };
  const commands: Array<{ method: string; params: BrowserObject }> = [];
  const context = { cdp: {
    evaluate: async () => ({ x: 320, y: 240 }),
    command: async (method: string, params: BrowserObject = {}) => { commands.push({ method, params }); return {}; },
  } } as unknown as PageOperationContext;
  await performPageOperation(context, 'computer', { action: 'scroll', amount: 2, scrollDirection: 'down' });
  assertDeepEqual(commands[0], vector.computerScroll.default, 'default scroll targets content instead of the top-left corner without waiting for gesture completion');
  commands.length = 0;
  await performPageOperation(context, 'computer', { action: 'scroll', coordinate: [25, 75], scrollX: -45, scrollY: 0 });
  assertDeepEqual(commands[0]?.params, vector.computerScroll.explicit, 'explicit coordinates and signed deltas are preserved');
});

h.test('locator select_option keeps its value separate from action options', async () => {
  let script = '';
  const context = { cdp: {
    evaluate: async (expression: string) => { script = expression; return { ok: true, selected: ['choice'], labels: ['Choice'], value: 'choice' }; },
  } } as unknown as PageOperationContext;
  const parsed = parseOperation('locator', { action: 'select_option', value: ['choice'], options: { timeoutMs: 1000, force: true } });
  await performPageOperation(context, parsed.kind, parsed.fields);
  assert(script.includes('const wanted=["choice"]'), 'the option value reaches the select operation');
  assert(!script.includes('const wanted={"timeoutMs"'), 'locator action controls are not mistaken for option values');
});

h.test('cdp event reads preserve the historical cursor contract', async () => {
  const events = [
    { sequence: 4, method: 'Runtime.consoleAPICalled', params: {}, timestamp: 1, frameTargetId: null },
    { sequence: 5, method: 'Network.responseReceived', params: {}, timestamp: 2, frameTargetId: null },
  ];
  const context = { cdp: { events, evicted: { console: 0, network: 0, events: 3 }, onEvent: () => () => {} } } as unknown as PageOperationContext;
  const result = await performPageOperation(context, 'cdp', { action: 'events', afterSequence: 1, methods: ['Runtime.consoleAPICalled'], limit: 10 });
  const value = result.value as BrowserObject;
  assertEqual(value.cursor, 5, 'an unpaged filtered read advances to the newest buffered event');
  assertEqual(value.newest, 5, 'historical newest field is retained');
  assertEqual(value.truncated, true, 'an evicted cursor gap is explicit');
});

h.test('console and network reads are newest-first and preserve compatibility fields', async () => {
  const context = { cdp: {
    console: [{ timestamp: 10, level: 'verbose', text: 'old' }, { timestamp: 20.75, level: 'table', text: 'new', source: 'console', args: [{ value: 'new' }], lineNumber: 2, columnNumber: 4 }],
    network: [{ id: 'r1', timestamp: 10.75, resourceType: 'Fetch', headers: { Accept: 'application/json' }, url: 'https://EXAMPLE.test/A', method: 'GET', response: { status: 204, mimeType: 'text/plain', headers: { 'Content-Type': 'text/plain' } } }],
    events: [], evicted: { console: 0, network: 0, events: 0 }, command: async () => ({}),
  } } as unknown as PageOperationContext;
  const consoleResult = await performPageOperation(context, 'console', { limit: 2 });
  assertEqual((consoleResult.typed.entries as BrowserObject[])[0]?.text, 'new', 'console newest first');
  assertDeepEqual((consoleResult.typed.entries as BrowserObject[]).map(entry => entry.level), ['log','debug'], 'console levels fit the engine enum');
  assertEqual((consoleResult.typed.entries as BrowserObject[])[0]?.timestampMs, 20, 'console timestamp compatibility field');
  assertEqual((consoleResult.typed.entries as BrowserObject[])[0]?.timestamp, 20.75, 'raw timestamp retains source precision');
  assertEqual((consoleResult.typed.entries as BrowserObject[])[0]?.line, 2, 'console source line reaches the typed response');
  assertEqual((consoleResult.typed.entries as BrowserObject[])[0]?.column, 4, 'console source column reaches the typed response');
  const networkResult = await performPageOperation(context, 'network', { urlFilter: 'example.TEST' });
  const request = (networkResult.typed.requests as BrowserObject[])[0]!;
  assertEqual(request.requestId, 'r1', 'network requestId compatibility field');
  assertEqual(request.status, 204, 'network status is flattened');
  assertEqual(request.failed, false, 'network success is explicit');
  assertEqual(request.startedAtMs, 10, 'network start fits the integer timestamp contract');
  assertEqual(request.resourceType, 'Fetch', 'network resource type is preserved');
  assertDeepEqual(request.requestHeaders, { Accept: 'application/json' }, 'request headers reach the typed response');
  assertDeepEqual(request.responseHeaders, { 'Content-Type': 'text/plain' }, 'response headers reach the typed response');
});

h.test('Chrome completion retains bounded response bodies and frame identity alongside request timing', async () => {
  const captures: BrowserObject[] = [];
  const relay = { request: async (method: string, params: BrowserObject) => {
    if (method !== 'executeCdp' || params.method !== 'Network.getResponseBody') return {};
    captures.push(params);
    if (object(params.commandParams).requestId === 'unavailable') throw new Error('Response buffer unavailable');
    return params.sessionId ? { body: 'x'.repeat(4001), base64Encoded: true } : { body: 'observed response', base64Encoded: false };
  } } as unknown as ChromeRelay;
  const cdp = new ChromePageDebugger(relay, 'network-task', 7);
  const notify = (method: string, params: BrowserObject, sessionId?: string) => cdp.acceptNotification({ method: 'onCDPEvent', params: { source: { tabId: 7, ...(sessionId ? { sessionId } : {}) }, method, params } });
  notify('Target.attachedToTarget', { targetInfo: { targetId: 'child-target', type: 'iframe' }, sessionId: 'child-session' });
  for (const sessionId of [undefined, 'child-session']) {
    notify('Network.requestWillBeSent', { requestId: 'shared-id', request: { url: 'https://example.test/data', method: 'GET' }, type: 'Fetch' }, sessionId);
    notify('Network.loadingFinished', { requestId: 'shared-id' }, sessionId);
  }
  for (const requestId of ['failed', 'unavailable']) notify('Network.requestWillBeSent', { requestId, request: { url: 'https://example.test/' + requestId } });
  notify('Network.loadingFailed', { requestId: 'failed', errorText: 'net::ERR_ABORTED', canceled: true });
  notify('Network.loadingFinished', { requestId: 'unavailable' });
  await waitFor(() => cdp.network.filter(row => row.body !== undefined || row.bodyError !== undefined).length === 3, 1000, 'all response body captures finish');
  const main = cdp.network.find(row => row.id === 'shared-id' && row.frameTargetId === null)!;
  const child = cdp.network.find(row => row.id === 'shared-id' && row.frameTargetId === 'child-target')!;
  assertEqual(main.body, 'observed response', 'completed response is captured before detachment');
  assertEqual(main.bodyTruncated, false, 'short body is complete');
  assertEqual(child.body, 'x'.repeat(4000), 'child response stays within its body budget');
  assertEqual(child.bodyTruncated, true, 'body truncation is explicit');
  assertEqual(child.base64Encoded, true, 'body encoding survives capture');
  assert(cdp.network.every(row => Number.isSafeInteger(row.endedAtMs)), 'all terminal events record completion time');
  assertDeepEqual(captures.map(params => params.sessionId ?? null), [null, 'child-session', null], 'body reads use the exact request frame and exclude failed requests');
  assertEqual(cdp.network.find(row => row.id === 'failed')?.canceled, true, 'cancellation is preserved');
  assert(String(cdp.network.find(row => row.id === 'unavailable')?.bodyError).includes('Response buffer unavailable'), 'body retrieval failure remains observable');
  await cdp.dispose();
});

h.test('typed log timestamps retain valid integer milliseconds without inventing invalid times', () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/browser-tool-contracts.json'), 'utf8')) as {
    logTimestamps: Array<{ input: number; expected: number }>;
  };
  for (const row of vector.logTimestamps) assertEqual(integerTimestampMs(row.input), row.expected, 'timestamp projection');
  for (const invalid of [NaN, Infinity, -1, '12', Number.MAX_SAFE_INTEGER + 1]) assertEqual(integerTimestampMs(invalid), undefined, 'invalid timestamp stays unknown');
});

h.test('capability queries describe the requested browser without changing the selected browser', async () => {
  const manager = { isEnabled: () => true, beginOperation: () => () => {}, surface: (sessionId: string) => ({ kind: 'browserUse', backend: 'iab', browserId: 'iab', sessionId }) } as unknown as BrowserManager;
  const chrome = { select: async () => {} } as unknown as ChromeBrowserService;
  const operations = new BrowserOperations(manager, chrome);
  const query = async (browserId: string) => {
    const result = await operations.execute('capability-task', 'capabilities', { browserId });
    assert(result.isError !== true, 'capability query succeeds');
    assertEqual(object(object(result._meta)['klaus/toolSurface']).browserId, browserId, 'metadata describes the queried browser');
    return object(object(result.structuredContent).value);
  };
  const builtIn = await query('iab'), external = await query('chrome:fixture');
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/browser-tool-contracts.json'), 'utf8')) as {
    capabilityQueries: { unavailable: string[]; externalOnly: string[] };
  };
  for (const result of [builtIn, external]) {
    assertEqual(result.selectedBrowserId, 'iab', 'query never changes selection');
    for (const name of vector.capabilityQueries.unavailable) {
      assert((result.unavailable as string[]).includes(name), 'unfinished operations stay unavailable');
      assert(!(result.supported as string[]).includes(name), 'unfinished operations cannot be advertised as supported');
    }
  }
  for (const name of vector.capabilityQueries.externalOnly) {
    assert((external.supported as string[]).includes(name), 'external operation is available');
    assert((builtIn.unavailable as string[]).includes(name), 'built-in operation is unavailable');
  }
  const error = await operations.execute('capability-task', 'tabs', { action: 'user' });
  assert(String(object(error.error).message).includes('select_browser'), 'backend-specific error gives the exact recovery operation');
});

h.test('browser-targeted operation schemas expose the browser selection field', () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/browser-tool-contracts.json'), 'utf8')) as { browserTargetedOperations: string[] };
  for (const name of vector.browserTargetedOperations) {
    const tool = browserTools().find(tool => tool.name === name);
    assert(object(object(tool?.inputSchema).properties).browserId !== undefined, `${name} advertises its browser target`);
  }
});

h.test('a failed browser batch exposes completed results and its failure together', async () => {
  const manager = { isEnabled: () => true, beginOperation: () => () => {}, surface: () => ({ kind: 'browserUse', backend: 'iab' }) } as unknown as BrowserManager;
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/browser-tool-contracts.json'), 'utf8')).batchFailure as {
    operations: BrowserObject[]; isError: boolean; partial: boolean; errorCode: string; completed: number; failedStep: number; stepErrorCode: string;
  };
  const result = await new BrowserOperations(manager).execute('batch-task', 'batch', { operations: vector.operations });
  assertEqual(result.isError, vector.isError, 'the MCP result is a failure');
  const response = object(result.structuredContent), value = object(response.value);
  assertEqual(response.partial, vector.partial, 'partial response is explicit');
  assertEqual(object(response.error).code, vector.errorCode, 'typed failure code');
  assertEqual(value.asked, vector.operations.length, 'requested operation count');
  assertEqual(value.completed, vector.completed, 'completed operation count survives');
  assertEqual((value.results as BrowserObject[]).length, vector.completed, 'completed results survive');
  assertEqual(object(value.stopped).step, vector.failedStep, 'the failed step survives');
  assertEqual(object(value.stopped).code, vector.stepErrorCode, 'the original failure classification survives');
});

h.test('read_urls keeps redirect identity and returns partial content on navigation timeout', async () => {
  const cdp = { evaluate: async () => ({ url: 'https://example.com/final', title: 'Final', text: 'partial', truncated: false }) } as any;
  let closed = false;
  const result = await readUrls({
    create: async () => ({ id: 1, cdp }),
    navigate: async () => { throw new BrowserError('timeout', 'still loading'); },
    close: async () => { closed = true; }, tabs: async () => closed ? [] : [1], selected: () => 7, restore: () => {},
  }, { urls: ['https://example.com/start'] });
  const page = (result.pages as BrowserObject[])[0]!;
  assertEqual(page.requestedUrl, 'https://example.com/start', 'requested URL retained');
  assertEqual(page.url, 'https://example.com/final', 'resolved URL retained');
  assertEqual(page.timedOut, true, 'partial timeout is visible but successful');
  assertEqual(page.ok, true, 'partial content is returned rather than discarded');
});

h.test('navigation rejects non-finite timeout budgets before starting a page request', async () => {
  let navigated = false;
  const cdp = { onEvent: () => () => {}, command: async () => { navigated = true; return {}; } } as unknown as PageOperationContext['cdp'];
  let refused = false;
  try { await navigateForRead(cdp, 'https://example.com/', { timeoutMs: Infinity }); } catch (error) { refused = error instanceof BrowserError && error.code === 'invalid_request'; }
  assert(refused, 'non-finite navigation timeout is refused');
  assertEqual(navigated, false, 'invalid timeout does not start navigation');
});

h.test('cancelling while a temporary page is created closes its late handle without navigating', async () => {
  const controller = new AbortController();
  let created!: (page: TemporaryPage) => void, navigated = false, closed = false;
  const pending = readUrls({
    create: () => new Promise(resolve => { created = resolve; }),
    navigate: async () => { navigated = true; }, close: async () => { closed = true; },
    tabs: async () => { throw new Error('Cancellation must not wait for another tab listing.'); },
    selected: () => 7, restore: () => {},
  }, { urls: ['https://example.com/'] }, controller.signal);
  controller.abort();
  created({ id: 2, cdp: {} as TemporaryPage['cdp'] });
  await assertRejects(() => pending, 'cancelled creation rejects');
  assertEqual(closed, true, 'late temporary page closed');
  assertEqual(navigated, false, 'cancelled read does not navigate');
});

h.test('cancelling a stalled navigation closes its temporary page without waiting for the response', async () => {
  const controller = new AbortController();
  let navigating = false, closed = false;
  const pending = readUrls({
    create: async () => ({ id: 2, cdp: {} as TemporaryPage['cdp'] }),
    navigate: () => { navigating = true; return new Promise(() => {}); },
    close: async () => { closed = true; },
    tabs: async () => { throw new Error('Cancellation must not wait for another tab listing.'); },
    selected: () => 7, restore: () => {},
  }, { urls: ['https://example.com/'] }, controller.signal);
  await waitFor(() => navigating, 1000, 'navigation started');
  controller.abort();
  await assertRejects(() => pending, 'cancelled navigation rejects');
  assertEqual(closed, true, 'in-flight temporary page closed');
});

h.test('untrusted timeouts cannot create an unbounded request', () => {
  assertEqual(timeoutMs(25), 25, 'bounded request');
  for (const input of [0, -1, Infinity, 100_000, '100']) {
    let refused = false;
    try { timeoutMs(input); } catch { refused = true; }
    assert(refused, 'invalid timeout refused');
  }
});

h.test('a failed drag releases its pressed pointer and empty modifier lists preserve plain clicks', async () => {
  const events: BrowserObject[] = [];
  const context = { cdp: { command: async (_method: string, params: BrowserObject) => {
    events.push(params);
    if (params.type === 'mouseMoved' && params.buttons === 1) throw new BrowserError('stale_target', 'Fixture frame detached during drag.');
    return {};
  } } } as unknown as PageOperationContext;
  let failed = false;
  try { await performPageOperation(context, 'computer', { action:'drag', path:[[10,10],[90,10]], keys:['shift'] }); } catch { failed = true; }
  assert(failed, 'drag reports the original interrupted operation');
  assertEqual(events.at(-1)?.type, 'mouseReleased', 'pressed pointer was released');
  assertEqual(events.at(-1)?.buttons, 0, 'no held mouse button remains');
  events.length = 0;
  await performPageOperation(context, 'computer', { action:'left_click', coordinate:[10,10], keys:[] });
  assert(events.every(event => event.modifiers === 0), 'empty engine modifier list stays a plain click');
});

h.test('parked browser permission questions settle exactly once, on answer, timeout or shutdown', async () => {
  const pending = new PendingBrowserPermissions(40);
  const prompt = { sessionId: 'task', permission: 'geolocation', origin: 'https://console.example.com', pageUrl: 'https://console.example.com/' };

  const answered = pending.request(prompt);
  const first = pending.request(prompt);
  assertEqual(pending.size(), 2, 'both questions stay open until settled');
  assertEqual(pending.answer(answered.requestId, true), true, 'the renderer answer settles its question');
  assertEqual(await answered.answered, true, 'an explicit allow grants');
  assertEqual(pending.answer(answered.requestId, false), false, 'a settled question cannot be answered twice');

  const timedOut = pending.request(prompt);
  await timedOut.answered;
  assertEqual(await timedOut.answered, false, 'an unanswered question expires into a denial');

  const open = pending.request(prompt);
  pending.clear();
  assertEqual(await open.answered, false, 'shutdown rejects what is still open instead of hanging the caller');
  assertEqual(pending.size(), 0, 'nothing stays parked');
  assertEqual(pending.answer(first.requestId, true), false, 'a question cleared at shutdown cannot be granted afterwards');
});

h.test('the permission answer channel settles only the owning window and never grants on a missing id', async () => {
  const pending = new PendingBrowserPermissions();
  const registry = new ChannelRegistry();
  const manager = { windowId: 7 } as unknown as BrowserManager;
  registerBrowserHandlers(registry, { manager, permissions: pending });
  const answer = registry.lookup('browser-use:permission-answer');
  assert(answer, 'the answer channel is registered');

  const parked = pending.request({ sessionId: 'task', permission: 'notifications', origin: 'https://example.com', pageUrl: 'https://example.com/' });
  const otherWindow = object(await answer({ role: 'main', senderId: 8, channel: 'browser-use:permission-answer', args: [{ requestId: parked.requestId, allowed: true }] }));
  assertEqual(otherWindow.ok, false, 'a window that does not own the browser surface cannot answer for it');
  assertEqual(pending.size(), 1, 'the refused answer left the question open');

  const wrongId = object(await answer({ role: 'main', senderId: 7, channel: 'browser-use:permission-answer', args: [{ requestId: 'bp-unknown', allowed: true }] }));
  assertEqual(wrongId.ok, true, 'an unknown id is a settled no-op, not a channel failure');
  assertEqual(wrongId.settled, false, 'and it reports that nothing was settled');
  assertEqual(pending.size(), 1, 'the unknown id left the real question open');

  const granted = object(await answer({ role: 'main', senderId: 7, channel: 'browser-use:permission-answer', args: [{ requestId: parked.requestId, allowed: true }] }));
  assertEqual(granted.settled, true, 'the owning window settles its own question');
  assertEqual(await parked.answered, true, 'the parked caller sees the allow');
});

h.test('noninteractive permissions settle silently and other permissions retain their decisions', async () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/browser-tool-contracts.json'), 'utf8')) as {
    permissionDefaults: { vectors: Array<{ permission: string; granted: boolean; prompts?: number }> };
  };
  for (const row of vector.permissionDefaults.vectors) {
    const decisions = new BrowserPermissionDecisions();
    const keys = [JSON.stringify(['task', 'https://console.example.com', row.permission])];
    let asked = 0;
    const ask = () => { asked += 1; return Promise.resolve(false); };
    assertEqual(decisions.granted(keys, row.permission), row.granted, `${row.permission} check uses its default`);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      assertEqual(await decisions.resolve(keys, ask, () => true, row.permission), row.granted, `${row.permission} request ${attempt}`);
    }
    const prompts = row.prompts ?? (row.granted ? 0 : 1);
    assertEqual(asked, prompts, `${row.permission} prompt count`);
    assertEqual(decisions.granted([], row.permission), false, 'an unidentified page is never granted');
    decisions.set(keys, 'denied');
    assertEqual(decisions.granted(keys, row.permission), false, 'explicit denial overrides the default');
    assertEqual(await decisions.resolve(keys, ask, () => true, row.permission), false, 'an explicitly denied request stays silent');
    assertEqual(asked, prompts, 'explicit denial does not open another question');
    decisions.clear();
    assertEqual(decisions.granted(keys, row.permission), row.granted, 'clearing decisions restores the default');
  }
});

h.test('storage persistence defaults remain undecided and preserve explicit scoped grants', async () => {
  const decisions = new BrowserPermissionDecisions();
  const keys = [JSON.stringify(['task', 'https://storage.example.com', 'persistent-storage'])];
  const other = [JSON.stringify(['other-task', 'https://storage.example.com', 'persistent-storage'])];
  const ask = (): Promise<boolean> => { throw new Error('Storage persistence must never open a consent dialog'); };
  for (let attempt = 0; attempt < 10; attempt += 1) {
    assertEqual(await decisions.resolve(keys, ask, () => true, 'persistent-storage'), false, 'no implicit storage guarantee');
  }
  assertEqual(decisions.denied(keys), false, 'an automatic result is not a user refusal');
  decisions.set(keys, 'granted');
  assertEqual(await decisions.resolve(keys, ask, () => true, 'persistent-storage'), true, 'an explicit grant remains effective');
  assertEqual(await decisions.resolve(other, ask, () => true, 'persistent-storage'), false, 'the grant does not cross tasks');
  decisions.set(keys, 'denied');
  assertEqual(await decisions.resolve(keys, ask, () => true, 'persistent-storage'), false, 'explicit denial remains effective');
  decisions.set(keys, 'prompt');
  assertEqual(decisions.denied(keys), false, 'reset removes the explicit denial');
  assertEqual(await decisions.resolve(keys, ask, () => true, 'persistent-storage'), false, 'reset restores silent handling');
  const reopened = new BrowserPermissionDecisions();
  assertEqual(await reopened.resolve(keys, ask, () => true, 'persistent-storage'), false, 'fresh state does not open a question');
  assertEqual(reopened.denied(keys), false, 'fresh state remains undecided');
});

h.test('the permission query policy projects explicit denials and keeps undecided origins asking', () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/browser-permission-query-vectors.json'), 'utf8')) as {
    permissionQueryPolicy: { vectors: Array<{ name: string; askNames: string[]; store: Record<string, string[]>; task: Record<string, string[]>; expected: Record<string, { denied: string[] }> }> };
    shimSource: { vectors: Array<{ name: string; policy: Record<string, { denied: string[] }>; expectedIncludes: string[]; expectedExcludes?: string[] }> };
    decisionOrigins: { vectors: Array<{ name: string; decisions: Array<{ key: string[]; setting: string }>; permission: string; expected: string[] }> };
  };
  for (const row of vector.permissionQueryPolicy.vectors) {
    const policy = synthesizePermissionQueryPolicy(row.askNames, name => row.store[name] ?? [], name => row.task[name] ?? []);
    assertDeepEqual(policy, row.expected, row.name);
  }
  for (const row of vector.shimSource.vectors) {
    const source = permissionQueryShimSource(row.policy);
    for (const fragment of row.expectedIncludes) assert(source.includes(fragment), `${row.name}: source includes ${fragment}`);
    for (const fragment of row.expectedExcludes ?? []) assert(!source.includes(fragment), `${row.name}: source excludes ${fragment}`);
    assert(permissionQueryUpdateExpression(row.policy).includes('__klausPermissionPolicyUpdate'), 'the update seam reaches an open document');
  }
  for (const row of vector.decisionOrigins.vectors) {
    const decisions = new BrowserPermissionDecisions();
    for (const decision of row.decisions) decisions.set([JSON.stringify(decision.key)], decision.setting);
    assertDeepEqual([...decisions.deniedOrigins(row.permission)].sort(), row.expected, row.name);
  }
});

h.test('remembered permission decisions stop a page that re-asks from reopening the dialog', async () => {
  const decisions = new BrowserPermissionDecisions();
  const keys = [JSON.stringify(['task', 'https://bpms.example.com', 'screen-wake-lock'])];
  let asked = 0;
  const refuse = () => { asked += 1; return Promise.resolve(false); };

  assertEqual(await decisions.resolve(keys, refuse, () => true), false, 'a refused question denies');
  assertEqual(await decisions.resolve(keys, refuse, () => true), false, 'the same question settles silently the second time');
  assertEqual(asked, 1, 'a remembered denial never opens the dialog again');
  assertEqual(decisions.granted(keys), false, 'a denial is not a grant');
  assertEqual(decisions.denied(keys), true, 'and it reads back as denied');

  const moved = [JSON.stringify(['task', 'https://moved.example.com', 'geolocation'])];
  let moves = 0;
  assertEqual(await decisions.resolve(moved, () => { moves += 1; return Promise.resolve(true); }, () => false), false, 'an allow answered after the page moved away grants nothing');
  assertEqual(decisions.denied(moved), false, 'the stale allow is not remembered as a denial');
  assertEqual(await decisions.resolve(moved, () => { moves += 1; return Promise.resolve(true); }, () => true), true, 'a later allow on a settled page grants');
  assertEqual(moves, 2, 'the undecided state asked again before the grant');
  assertEqual(await decisions.resolve(moved, () => { throw new Error('a remembered grant must settle without asking'); }, () => true), true, 'a remembered grant settles silently');
});

h.test('concurrent permission requests for the same keys share one question', async () => {
  const decisions = new BrowserPermissionDecisions();
  const keys = [JSON.stringify(['task', 'https://media.example.com', 'audioCapture']), JSON.stringify(['task', 'https://media.example.com', 'videoCapture'])];
  let asked = 0;
  let release!: (allowed: boolean) => void;
  const ask = () => { asked += 1; return new Promise<boolean>(done => { release = done; }); };
  const first = decisions.resolve(keys, ask, () => true);
  const joined = decisions.resolve([...keys].reverse(), ask, () => true);
  assertEqual(asked, 1, 'the second request joins the open question instead of opening another dialog');
  release(true);
  assertEqual(await first, true, 'the first caller sees the allow');
  assertEqual(await joined, true, 'the joined caller settles with the same answer');
  assertEqual(asked, 1, 'one question served both requests');

  decisions.set(keys, 'denied');
  assertEqual(decisions.denied(keys), true, 'an explicit setting overrides the remembered grant');
  decisions.forget(key => (JSON.parse(key) as string[])[0] === 'task');
  assertEqual(decisions.denied(keys), false, 'forgetting the conversation clears its decisions');
  decisions.set(keys, 'denied');
  decisions.clear();
  assertEqual(decisions.denied(keys), false, 'clearing drops every remembered decision');
});

h.test('screenshot results report the image-pixel-per-CSS-pixel scale', async () => {
  const metrics = { width: 800, height: 600, x: 0, y: 0, dpr: 2 };
  const cdp = {
    evaluate: async () => metrics,
    command: async (method: string) => (method === 'Page.captureScreenshot' ? { data: 'aGk=' } : {}),
  } as unknown as Parameters<typeof captureScreenshot>[0];
  const plain = await captureScreenshot(cdp, {});
  assertEqual(plain.scale, 2, 'a device-scale capture reports its scale');
  const zoomed = await captureScreenshot(cdp, { clip: { x: 0, y: 0, width: 100, height: 50, scale: 2 } });
  assertEqual(zoomed.scale, 4, 'an explicit clip scale multiplies into the reported scale');
});

h.test('youtube transcript export renders caption lines with timestamps', async () => {
  const payload = {
    ok: true, url: 'https://www.youtube.com/watch?v=example', title: 'Demo Video',
    language: 'en', trackName: 'English', generated: false,
    lines: [{ startMs: 0, durationMs: 1500, text: 'Hello world' }, { startMs: 65000, durationMs: 2000, text: 'Second line' }],
  };
  const context = { cdp: { evaluate: async () => payload } } as unknown as PageOperationContext;
  const { value, typed } = await performPageOperation(context, 'content_export', { format: 'youtube_transcript' });
  const exported = object(value);
  assertEqual(exported.format, 'youtube_transcript', 'the export names its format');
  assertEqual(exported.lineCount, 2, 'both caption lines render');
  const content = String(exported.content);
  assert(content.includes('[00:00] Hello world'), `timestamped first line: ${content}`);
  assert(content.includes('[01:05] Second line'), `minute rollover: ${content}`);
  assert(String(object(typed).text).includes('Hello world'), 'the transcript reaches the typed text channel');
});

h.test('youtube transcript export reports missing captions as a page problem', async () => {
  const context = { cdp: { evaluate: async () => ({ ok: false, reason: 'no_captions', url: 'https://example.com/' }) } } as unknown as PageOperationContext;
  const error = await assertRejects(() => performPageOperation(context, 'content_export', { format: 'youtube_transcript' }), 'a page without captions is refused');
  assertEqual((error as BrowserError).code, 'not_found', 'missing captions are a not-found page state');
  assert(String((error as BrowserError).message).includes('caption tracks'), 'the message names the gap');
});

void h.finish(join(__dirname, 'browser-policy-result.json'), 'browser-policy').then(code => process.exit(code));
