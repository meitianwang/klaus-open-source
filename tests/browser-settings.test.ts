import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BROWSER_DEFAULT_POLICY, browserAddress, browserEffectiveAccess, browserOriginPattern, browserPatternMatches, localBrowserUrl, type BrowserSettingsSnapshot } from '../contracts/browser-settings';
import { BrowserAccessController } from '../main/browser/access';
import { BrowserPreferences } from '../main/services/browser-preferences';
import { kvGet, kvSet } from '../main/services/settings';
import { vectorPath } from '../main/paths';
import { Harness } from './harness';

const h = new Harness(), root = mkdtempSync(join(tmpdir(), 'klaus-browser-settings-'));
const vectors = JSON.parse(readFileSync(vectorPath('browser-settings-vectors.json'), 'utf8'));
const preferences = (configRoot: string) => new BrowserPreferences({ configRoot, resourceDirs: [], request: async () => ({}), setPluginEnabled: async () => ({ ok: true }), changed: () => {} });

h.test('origin rules use label boundaries and explicit schemes and ports', () => {
  for (const row of vectors.patterns) assert.equal(browserPatternMatches(row.pattern, row.url), row.matches, JSON.stringify(row));
  for (const pattern of vectors.invalidPatterns) assert.equal(browserOriginPattern(pattern), undefined, pattern);
  assert.deepEqual(BROWSER_DEFAULT_POLICY, vectors.defaultPolicy);
});
h.test('local destinations cannot be selected by a hostname substring', () => {
  for (const url of vectors.localUrls) assert.equal(localBrowserUrl(url), true, url);
  for (const url of vectors.webUrls) assert.equal(localBrowserUrl(url), false, url);
});
h.test('compact address display preserves the complete editing URL', () => {
  assert.equal(browserAddress(vectors.address.url, false, false), vectors.address.compact);
  assert.equal(browserAddress(vectors.address.url, false, true), vectors.address.url);
  assert.equal(browserAddress(vectors.address.url, true, false), vectors.address.url);
  assert.equal(browserAddress('about:blank', true, true), '');
});
h.test('the most specific website override wins without changing other resources', () => {
  const snapshot = { defaultPolicy: BROWSER_DEFAULT_POLICY, allowedOrigins: [], deniedOrigins: [], originRules: [
    { pattern: '*', policy: { browsing: 'deny' } },
    { pattern: '*.example.com', policy: { browsing: 'ask' } },
    { pattern: 'https://app.example.com', policy: { browsing: 'allow' } },
  ] } as unknown as BrowserSettingsSnapshot;
  assert.equal(browserEffectiveAccess(snapshot, 'https://app.example.com/path', 'browsing'), 'allow');
  assert.equal(browserEffectiveAccess(snapshot, 'https://other.example.com', 'browsing'), 'ask');
  assert.equal(browserEffectiveAccess(snapshot, 'https://example.invalid', 'browsing'), 'deny');
  assert.equal(browserEffectiveAccess(snapshot, 'https://example.invalid', 'uploads'), 'allow');
});
h.test('preferences survive reopening and independent destinations remain separate', () => {
  const directory = join(root, 'roundtrip'), service = preferences(directory);
  service.mutate('set-preferences', { showFullUrl: true, promptForDownloads: true, webUrlTarget: 'system-default', localUrlTarget: 'in-app' });
  service.mutate('set-origin-policy', { pattern: '*.example.com', resource: 'uploads', setting: 'deny' });
  assert.throws(
    () => service.mutate('set-site-permission', { origin: 'https://example.com/path', permission: 'videoCapture', setting: 'denied' }),
    /retired/
  );
  const reopened = preferences(directory), snapshot = reopened.get();
  assert.equal(snapshot.showFullUrl, true); assert.equal(snapshot.webUrlTarget, 'system-default'); assert.equal(snapshot.localUrlTarget, 'in-app');
  assert.equal(reopened.access('https://app.example.com', 'uploads'), 'deny');
  assert.deepEqual(snapshot.sitePermissions, []);
});
h.test('an invalid preference batch cannot partially update destinations or flags', () => {
  const service = preferences(join(root, 'atomic'));
  assert.throws(() => service.mutate('set-preferences', { showFullUrl: true, webUrlTarget: 'system-default', localUrlTarget: 'invalid' }));
  assert.equal(service.get().showFullUrl, false); assert.equal(service.get().webUrlTarget, 'system-default');
  assert.throws(() => service.mutate('set-origin-policy', { pattern: 'javascript:invalid', resource: 'uploads', setting: 'allow' }));
});
h.test('legacy site permissions migrate only through native confirmation and never echo as current', () => {
  const directory = join(root, 'site-migration');
  kvSet('permission_profile.v2', JSON.stringify({ version: 2, retainedTopLevel: 'keep', browser: {
    approvalMode: 'neverAsk', showFullUrl: true,
    sitePermissions: [
      { origin: 'https://one.example.com/path', permission: 'geolocation', setting: 'granted' },
      { origin: 'https://two.example.com', permission: 'notifications', setting: 'denied' },
      { origin: 'https://three.example.com', permission: 'camera', setting: 'granted' },
    ],
  } }), directory);
  const service = preferences(directory);
  assert.deepEqual(service.get().sitePermissions, []);
  const seen: Array<{ origin: string; permission: string; setting: string }> = [];
  const result = service.migrateSitePermissions(row => {
    seen.push(row);
    if (row.permission === 'notifications') return false;
    if (row.permission === 'camera') throw new Error('native rejected this row');
    return true;
  });
  assert.deepEqual(result, { applied: 1, remaining: 2 });
  assert.deepEqual(seen.map(row => `${row.origin}:${row.permission}:${row.setting}`), [
    'https://one.example.com:geolocation:granted',
    'https://two.example.com:notifications:denied',
    'https://three.example.com:camera:granted',
  ]);
  const raw = JSON.parse(String(kvGet('permission_profile.v2', directory)));
  assert.equal(raw.retainedTopLevel, 'keep');
  assert.equal(raw.browser.approvalMode, 'neverAsk');
  assert.equal(raw.browser.showFullUrl, true);
  assert.deepEqual(raw.browser.sitePermissions, [
    { origin: 'https://two.example.com', permission: 'notifications', setting: 'denied' },
    { origin: 'https://three.example.com', permission: 'camera', setting: 'granted' },
  ]);
  assert.deepEqual(service.get().sitePermissions, []);
});

h.test('legacy origin denials and configured approval modes retain their meaning', () => {
  const directory = join(root, 'legacy');
  kvSet('permission_profile.v2', JSON.stringify({ version: 2, browser: { approvalMode: 'alwaysAsk', deniedOrigins: ['https://blocked.example.com'] } }), directory);
  const service = preferences(directory);
  assert.equal(service.access('https://example.com', 'browsing'), 'ask');
  assert.equal(service.access('https://blocked.example.com', 'browsing'), 'deny');
  service.mutate('set-approval-mode', { mode: 'neverAsk' });
  assert.equal(service.access('https://example.com', 'browsing'), 'allow');
  assert.equal(service.access('https://blocked.example.com', 'browsing'), 'deny');
});
h.test('asking shares an in-flight question and grants only its origin and chat', async () => {
  let questions = 0, settle!: (value: boolean) => void;
  const access = new BrowserAccessController({ access: () => 'ask', request: () => { questions++; return new Promise(resolve => { settle = resolve; }); } });
  const first = access.authorize('A', 'https://example.com/one'), second = access.authorize('A', 'https://example.com/two');
  assert.equal(questions, 1); settle(true); await Promise.all([first, second]);
  await access.authorize('A', 'https://example.com/three'); assert.equal(questions, 1);
  const other = access.authorize('B', 'https://example.com/'); assert.equal(questions, 2); settle(false);
  await assert.rejects(other, /not approved/);
});
h.test('revocation defeats a late allow and unrelated chat release preserves pending access', async () => {
  let settle!: (value: boolean) => void;
  const access = new BrowserAccessController({ access: () => 'ask', request: () => new Promise(resolve => { settle = resolve; }) });
  const stale = access.authorize('A', 'https://example.com'); access.invalidate(); settle(true);
  await assert.rejects(stale, /not approved/);
  const valid = access.authorize('B', 'https://example.com'); access.release('A'); settle(true); await valid;
});
h.test('cancelled access cannot become a remembered allow', async () => {
  let settle!: (value: boolean) => void, calls = 0;
  const access = new BrowserAccessController({ access: () => 'ask', request: () => { calls++; return new Promise(resolve => { settle = resolve; }); } });
  const controller = new AbortController(), aborted = access.authorize('A', 'https://example.com', 'browsing', controller.signal);
  controller.abort(new Error('cancelled by test')); await assert.rejects(aborted, /cancelled/); settle(true);
  await Promise.resolve(); await Promise.resolve();
  const retry = access.authorize('A', 'https://example.com'); assert.equal(calls, 2); settle(false); await assert.rejects(retry);
});

void h.finish(join(__dirname, 'browser-settings-result.json'), 'browser-settings').then(code => { rmSync(root, { recursive: true, force: true }); process.exitCode = code; });
