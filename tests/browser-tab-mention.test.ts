import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserTabMentionLink, browserTabMentionUri, browserTabReferencesIn, filterBrowserTabMentions, parseBrowserTabMention, type BrowserTabMention } from '../shared/browser-tab-mention';
import { BrowserTabMentionService } from '../main/browser/tab-mentions';
import { BrowserOperations } from '../main/browser/operations';
import type { BrowserManager, BrowserPage } from '../main/browser/manager';
import type { ChromeBrowserService } from '../main/browser/chrome-browser';
import { navigationUrl } from '../main/browser/policy';
import { BrowserError, object } from '../main/browser/types';
import { vectorPath } from '../main/paths';
import { Harness } from './harness';
import { chromeBrowserName } from '../main/browser/chrome-relay';
import { boundedTabFavicon, cachedTabFaviconScript } from '../main/browser/tab-favicon';
import { runInNewContext } from 'node:vm';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerBrowserHandlers } from '../main/ipc/handlers/browser';
import type { Json } from '../main/ipc/contract';

const h = new Harness();
const vectors = JSON.parse(readFileSync(vectorPath('browser-tab-mention-vectors.json'), 'utf8')) as { valid: BrowserTabMention[]; invalid: string[] };
const row = (overrides: Partial<BrowserTabMention> = {}): BrowserTabMention => {
  const value = { source: 'extension' as const, browserId: 'chrome:profile-a', tabId: '17', title: 'Inbox', url: 'https://mail.example.com/inbox', browserName: 'Chrome', lastOpened: 1, ...overrides };
  return { ...value, mention: browserTabMentionUri(value) };
};
let enabled = true;
let pageUrl = 'https://example.com/docs';
let pageTitle = 'Docs';
const page = { handle: 3, owner: 'session-A', lastOpened: 5, view: { webContents: { getURL: () => pageUrl, getTitle: () => pageTitle } } } as unknown as BrowserPage;
const manager = {
  isEnabled: () => enabled, assertNavigation: navigationUrl,
  listPages: (session: string) => session === 'session-A' ? [page] : [],
  page: (session: string, id: number) => { if (session !== 'session-A' || id !== 3) throw new BrowserError('stale_tab', 'No such owned tab'); return page; },
  beginOperation: () => () => {}, surface: () => ({}),
} as unknown as BrowserManager;

h.test('committed canonical URI vectors round-trip and reject ambiguity', () => {
  for (const vector of vectors.valid) {
    assert.equal(browserTabMentionUri(vector), vector.mention);
    const parsed = parseBrowserTabMention(vector.mention);
    assert(parsed); assert.equal(parsed.browserId, vector.browserId); assert.equal(parsed.tabId, vector.tabId);
  }
  for (const value of vectors.invalid) assert.equal(parseBrowserTabMention(value), null);
  const reference = row({ title: 'A [bracket] \\ name\nnext' });
  assert.equal(browserTabReferencesIn(browserTabMentionLink(reference))[0]?.title, reference.title);
  assert.equal(browserTabReferencesIn(`${reference.mention} ${reference.mention}`).length, 1);
});

h.test('browser labels use the actual connected browser executable and cached favicons never fetch a page', async () => {
  assert.equal(chromeBrowserName({ executable: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', info: { name: 'Chrome' } }), 'Edge');
  assert.equal(chromeBrowserName({ executable: null, info: { name: 'Chromium' } }), 'Chromium');
  const requests: unknown[] = [];
  const value = await runInNewContext(cachedTabFaviconScript('https://example.com/favicon.ico'), {
    fetch: async (url: string, init: { cache: string; mode: string }) => { requests.push([url, init.cache, init.mode]); return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }); },
    AbortSignal, Uint8Array, btoa,
  });
  assert.deepEqual(requests, [['https://example.com/favicon.ico', 'only-if-cached', 'same-origin']]);
  assert.equal(boundedTabFavicon(value), 'data:image/png;base64,AQID');
  assert.equal(boundedTabFavicon('https://example.com/favicon.ico'), undefined);
  assert.equal(boundedTabFavicon('data:image/svg+xml;base64,PHN2Zz4='), undefined);
  const oversized = await runInNewContext(cachedTabFaviconScript('https://example.com/favicon.ico'), { fetch: async () => new Response(new Uint8Array(12001), { headers: { 'content-type': 'image/png' } }), AbortSignal, Uint8Array, btoa });
  assert.equal(oversized, null);
});

h.test('search finds every word across titles and URLs, caps after filtering, and never deduplicates different tabs by URL', () => {
  const tabs = Array.from({ length: 120 }, (_, index) => row({ tabId: String(index + 1), lastOpened: index }));
  assert.equal(filterBrowserTabMentions(tabs, '').length, 3);
  assert.equal(filterBrowserTabMentions(tabs, 'Inbox mail.example').length, 100);
  assert.equal(filterBrowserTabMentions(tabs, 'Inbox missing').length, 0);
  assert.equal(filterBrowserTabMentions(tabs, '')[0]?.tabId, '120');
  assert.equal(filterBrowserTabMentions([row(), row(), row({ browserId: 'chrome:profile-b' })], '').length, 2);
  assert.throws(() => browserTabReferencesIn(tabs.map(tab => tab.mention).join(' ')), /at most 100/);
});

h.test('discovery scopes IAB to the requesting conversation and retains healthy rows when another browser fails', async () => {
  const chrome = {
    isEnabled: () => true,
    discover: async () => ({ browsers: [{ id: 'chrome:profile-a', info: { name: 'Chrome' } }, { id: 'chrome:profile-b', info: { name: 'Edge' } }], failures: [] }),
    mentionTabs: async (id: string) => { if (id.endsWith('b')) throw new Error('Edge disconnected'); return [{ id: 17, title: 'Inbox', url: 'https://mail.example.com/inbox', lastOpened: new Date(10).toISOString() }]; },
  } as unknown as ChromeBrowserService;
  const mentions = new BrowserTabMentionService(manager, chrome);
  const listed = await mentions.list('session-A', '');
  assert.equal(listed.tabs.length, 2); assert.equal(listed.errors[0]?.message, 'Edge disconnected');
  assert.equal(listed.tabs.find(tab => tab.source === 'iab')?.browserId, 'session-A');
  assert.equal((await mentions.list('session-B', '')).tabs.some(tab => tab.source === 'iab'), false);
  assert.match(await mentions.context([row({ source: 'iab', browserId: 'session-A', tabId: '3', title: 'Docs', url: pageUrl })], 'session-B'), /unavailable/);
});

h.test('the actual mention IPC accepts the empty picker query and enforces the window boundary', async () => {
  const registry = new ChannelRegistry();
  registerBrowserHandlers(registry, { manager: { ...manager, windowId: 7 } as unknown as BrowserManager });
  const handler = registry.lookup('browser-use:mention-tabs'); assert(handler);
  const invoke = (args: Json, senderId = 7) => handler({ role: 'main', senderId, channel: 'browser-use:mention-tabs', args: [args] });
  const listed = object(await invoke({ sessionId: 'session-A', query: '' }));
  assert.equal(listed.ok, true); assert.equal((listed.tabs as Json[]).length, 1);
  assert.equal(object(await invoke({ sessionId: null, query: '' })).ok, true);
  assert.equal(object(await invoke({ sessionId: 'session-A', query: 5 })).code, 'invalid_request');
  assert.equal(object(await invoke({ sessionId: 'session-A', query: '' }, 8)).code, 'FORBIDDEN_CHANNEL');
  assert.equal(object(await invoke({ sessionId: 'session-A', query: 'x'.repeat(4097) })).code, 'invalid_request');
});

h.test('disabled external access retains healthy IAB candidates and explains the missing external source', async () => {
  const chrome = { isEnabled: () => false, discover: () => { throw new Error('Disabled source must not be queried'); } } as unknown as ChromeBrowserService;
  const listed = await new BrowserTabMentionService(manager, chrome).list('session-A', '');
  assert.equal(listed.tabs.length, 1);
  assert.equal(listed.tabs[0]?.source, 'iab');
  assert.equal(listed.errors[0]?.code, 'external_browser_disabled');
});

h.test('enabled Chrome that discovered no browser explains itself instead of vanishing from the picker', async () => {
  // The relay endpoint can disappear while Chrome keeps its side of the pipe,
  // which reads as "zero browsers, zero failures". Without an explicit error
  // the group renders nothing at all, indistinguishable from a broken feature.
  const chrome = {
    isEnabled: () => true,
    discover: async () => ({ browsers: [], candidatePipeCount: 0, failures: [] }),
    mentionTabs: () => { throw new Error('No discovered browser may be queried'); },
  } as unknown as ChromeBrowserService;
  const listed = await new BrowserTabMentionService(manager, chrome).list('session-A', '');
  assert.equal(listed.errors.length, 1);
  assert.equal(listed.errors[0]?.code, 'external_browser_unavailable');
  assert.equal(listed.errors[0]?.browserId, 'chrome');
  assert.match(String(listed.errors[0]?.message), /No Chrome instance is connected/);
  assert.equal(listed.tabs.length, 1, 'healthy built-in candidates survive the notice');
  assert.equal(listed.tabs[0]?.source, 'iab');
});

h.test('specific discovery failures are not diluted by a generic disconnected notice', async () => {
  const chrome = {
    isEnabled: () => true,
    discover: async () => ({ browsers: [], candidatePipeCount: 1, failures: ['klaus-stale.sock: connect ECONNREFUSED'] }),
    mentionTabs: () => { throw new Error('No discovered browser may be queried'); },
  } as unknown as ChromeBrowserService;
  const listed = await new BrowserTabMentionService(manager, chrome).list('session-A', '');
  assert.equal(listed.errors.length, 1, 'the underlying failure already explains the state');
  assert.equal(listed.errors[0]?.message, 'klaus-stale.sock: connect ECONNREFUSED');
});

h.test('a connected Chrome with no matching tab is an empty result, not a connection failure', async () => {
  const chrome = {
    isEnabled: () => true,
    discover: async () => ({ browsers: [{ id: 'chrome:profile-a', info: { name: 'Chrome' } }], candidatePipeCount: 1, failures: [] }),
    mentionTabs: async () => [],
  } as unknown as ChromeBrowserService;
  const listed = await new BrowserTabMentionService(manager, chrome).list('session-A', '');
  assert.equal(listed.errors.length, 0);
  assert.equal(listed.tabs.length, 1);
  assert.equal(listed.tabs[0]?.source, 'iab');
});

h.test('the executable resolver refuses foreign, navigated, renamed, closed and disabled tabs without making replacements', async () => {
  const operations = new BrowserOperations(manager);
  const reference = row({ source: 'iab', browserId: 'session-A', tabId: '3', title: 'Docs', url: pageUrl });
  assert.deepEqual(object(object((await operations.execute('session-A', 'resolve_tab', { mention: reference.mention })).structuredContent).value), { browserId: 'iab', tabId: 3, title: 'Docs', url: pageUrl });
  assert.equal((await operations.execute('session-B', 'resolve_tab', { mention: reference.mention })).isError, true);
  pageTitle = 'New title'; assert.equal((await operations.execute('session-A', 'resolve_tab', { mention: reference.mention })).isError, true); pageTitle = 'Docs';
  pageUrl += '/next'; assert.equal((await operations.execute('session-A', 'resolve_tab', { mention: reference.mention })).isError, true); pageUrl = reference.url;
  assert.equal((await operations.execute('session-A', 'resolve_tab', { mention: row({ ...reference, tabId: '4' }).mention })).isError, true);
  enabled = false; assert.equal((await operations.execute('session-A', 'resolve_tab', { mention: reference.mention })).isError, true); enabled = true;
});

h.test('external resolution forwards the exact profile and snapshot to the existing claim policy', async () => {
  const calls: unknown[] = [];
  const chrome = { execute: async (...args: unknown[]) => { calls.push(args); return {}; } } as unknown as ChromeBrowserService;
  const operations = new BrowserOperations(manager, chrome);
  const reference = row();
  const result = await operations.execute('session-A', 'resolve_tab', { mention: reference.mention });
  assert.equal(result.isError, undefined);
  assert.deepEqual(calls[0], ['session-A', reference.browserId, 'claim_tab', { tabId: 17, expectedTitle: reference.title, expectedUrl: reference.url }, {}, undefined]);
});

void h.finish(join(__dirname, 'browser-tab-mention-result.json'), 'browser-tab-mention').then(code => { process.exitCode = code; });
