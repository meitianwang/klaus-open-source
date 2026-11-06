import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Json } from '../main/ipc/contract';
import type { BrowserManager, BrowserPage } from '../main/browser/manager';
import { chromeBundleIconPath, chromeCandidatePaths, icnsIconDataUrl, launchSiteProcess, SITE_OPEN_TARGET_SETTING, SiteOpener, siteUrl } from '../main/browser/site-open';
import { object } from '../main/browser/types';
import { ChannelRegistry } from '../main/ipc/registry';
import { registerBrowserHandlers } from '../main/ipc/handlers/browser';
import { vectorPath } from '../main/paths';
import { kvGet, kvSet } from '../main/services/settings';
import { Harness } from './harness';

const h = new Harness();
const root = mkdtempSync(join(tmpdir(), 'klaus-site-open-'));
const vectors = JSON.parse(readFileSync(vectorPath('site-open-vectors.json'), 'utf8')) as {
  targets: string[]; defaultPreference: string; setting: string;
  validUrls: Array<{ input: string; expected: string }>; invalidUrls: string[];
  credentialUrls: Array<{url: string;username: string;password?: string}>;
};
let fixtureId = 0;
function fixture() {
  const configRoot = join(root, String(++fixtureId));
  const calls: unknown[][] = [];
  let installed = true, panelOpened = true, failChrome = false, failExternal = false;
  const page = { owner: 'saved-session', id: 'iab-1' } as BrowserPage;
  const browser = {
    windowId: 9, isEnabled: () => true,
    setConversation: (sessionId: string) => { calls.push(['conversation', sessionId]); return {}; },
    ensurePage: async (sessionId: string) => { calls.push(['page', sessionId]); return page; },
    navigate: async (_page: BrowserPage, url: string) => { calls.push(['navigate', url]); },
    requestPanel: async (sessionId: string, _page: BrowserPage) => { calls.push(['panel', sessionId]); return panelOpened; },
  } as unknown as BrowserManager;
  const sites = new SiteOpener(configRoot, browser, {
    findChrome: () => installed ? '/installed/google-chrome' : null,
    chromeDefault: async () => true,
    chromeIcon: async () => 'data:image/png;base64,AQID',
    systemDefaultIcon: async () => 'data:image/png;base64,BAMD',
    openChrome: async (path, url) => { calls.push(['chrome', path, url]); if (failChrome) throw new Error('Chrome launch refused'); },
    openExternal: async url => { calls.push(['external', url]); if (failExternal) throw new Error('OS open refused'); },
  });
  return { configRoot, calls, browser, sites, installed: (value: boolean) => { installed = value; }, panel: (value: boolean) => { panelOpened = value; },
    failChrome: () => { failChrome = true; }, failExternal: () => { failExternal = true; } };
}

function credentialUrl(row: {url: string;username: string;password?: string}): string {
  const url = new URL(row.url); url.username = row.username; url.password = row.password ?? ''; return url.href;
}

h.test('committed URL vectors validate website protocols and credential refusal', () => {
  for (const vector of vectors.validUrls) assert.equal(siteUrl(vector.input), vector.expected);
  for (const input of vectors.invalidUrls) assert.throws(() => siteUrl(input));
  for (const row of vectors.credentialUrls) assert.throws(() => siteUrl(credentialUrl(row)));
  assert.equal(SITE_OPEN_TARGET_SETTING, vectors.setting);
});

h.test('installed targets include application icons, OS default markers and a persisted preference', async () => {
  const f = fixture();
  let listed = await f.sites.targets();
  assert.deepEqual(listed.targets.map(target => target.id), vectors.targets);
  assert.equal(listed.preferredTarget, vectors.defaultPreference);
  assert.equal(listed.targets.find(target => target.id === 'chrome')?.iconDataUrl, 'data:image/png;base64,AQID');
  assert.equal(listed.targets.find(target => target.id === 'chrome')?.isDefault, true);
  assert.equal(listed.targets.find(target => target.id === 'system-default')?.iconDataUrl, 'data:image/png;base64,BAMD');
  await f.sites.open({ sessionId: 'saved-session', url: 'https://example.com', target: 'chrome' });
  listed = await f.sites.targets(); assert.equal(listed.preferredTarget, 'chrome');
  const other = new SiteOpener(f.configRoot, f.browser, { findChrome: () => null });
  assert.equal((await other.targets()).preferredTarget, 'system-default');
  assert.equal(kvGet(SITE_OPEN_TARGET_SETTING, f.configRoot), 'chrome');
});

h.test('target discovery refreshes installation state without writing settings', async () => {
  const f = fixture();
  await f.sites.targets(); f.installed(false);
  assert.deepEqual((await f.sites.targets()).targets.map(target => target.id), ['in-app', 'system-default']);
  assert.equal(kvGet(SITE_OPEN_TARGET_SETTING, f.configRoot), null);
});

h.test('a user click opens a saved session page and persists after the panel is actually shown', async () => {
  const f = fixture();
  assert.deepEqual(await f.sites.open({ sessionId: 'saved-session', url: 'https://example.com', target: 'in-app' }), { ok: true, target: 'in-app' });
  assert.deepEqual(f.calls, [['conversation', 'saved-session'], ['page', 'saved-session'], ['navigate', 'https://example.com/'], ['panel', 'saved-session']]);
  assert.equal(kvGet(SITE_OPEN_TARGET_SETTING, f.configRoot), 'in-app');
});

h.test('failed panel presentation preserves the last successful preference', async () => {
  const f = fixture(); kvSet(SITE_OPEN_TARGET_SETTING, 'system-default', f.configRoot); f.panel(false);
  await assert.rejects(f.sites.open({ sessionId: 'saved-session', url: 'https://example.com', target: 'in-app' }), /panel could not/);
  assert.equal(kvGet(SITE_OPEN_TARGET_SETTING, f.configRoot), 'system-default');
});

h.test('omitting a target uses the persisted choice and unavailable Chrome falls back to the system browser', async () => {
  const f = fixture(); kvSet(SITE_OPEN_TARGET_SETTING, 'system-default', f.configRoot);
  assert.equal((await f.sites.open({ sessionId: 'saved-session', url: 'https://example.com' })).target, 'system-default');
  assert.deepEqual(f.calls, [['external', 'https://example.com/']]);
  kvSet(SITE_OPEN_TARGET_SETTING, 'chrome', f.configRoot); f.installed(false);
  assert.equal((await f.sites.open({ sessionId: 'saved-session', url: 'https://example.com' })).target, 'system-default');
});

h.test('OS and named-browser failures never persist a failed choice', async () => {
  const f = fixture(); kvSet(SITE_OPEN_TARGET_SETTING, 'in-app', f.configRoot);
  f.failChrome();
  await assert.rejects(f.sites.open({ sessionId: 'saved-session', url: 'https://example.com', target: 'chrome' }), /Chrome launch refused/);
  f.failExternal();
  await assert.rejects(f.sites.open({ sessionId: 'saved-session', url: 'https://example.com', target: 'system-default' }), /OS open refused/);
  f.installed(false);
  await assert.rejects(f.sites.open({ sessionId: 'saved-session', url: 'https://example.com', target: 'chrome' }), /not installed/);
  assert.equal(kvGet(SITE_OPEN_TARGET_SETTING, f.configRoot), 'in-app');
});

h.test('invalid URLs and unsupported targets do not launch or alter preference', async () => {
  const f = fixture();
  await assert.rejects(f.sites.open({ sessionId: 'saved-session', url: credentialUrl(vectors.credentialUrls[0]!), target: 'chrome' }));
  await assert.rejects(f.sites.open({ sessionId: 'saved-session', url: 'https://example.com/', target: 'other-browser' }));
  await assert.rejects(f.sites.open({ sessionId: '', url: 'https://example.com/', target: 'in-app' }));
  assert.deepEqual(f.calls, []); assert.equal(kvGet(SITE_OPEN_TARGET_SETTING, f.configRoot), null);
});

h.test('bundled icns containers yield official artwork and bundle icon paths resolve from the executable', () => {
  const bundle = join(root, 'Sample.app');
  const resources = join(bundle, 'Contents', 'Resources');
  mkdirSync(resources, { recursive: true });
  const png = (width: number, tag: number) => Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.from([0, 0, 0, 0x0d]), Buffer.from('IHDR', 'ascii'),
    Buffer.from([0, 0, 0, width, 0, 0, 0, width, 8, 6, 0, 0, 0]),
    Buffer.from([tag, tag, tag]),
  ]);
  const entry = (type: string, payload: Buffer) => Buffer.concat([Buffer.from(type, 'ascii'), (() => { const b = Buffer.alloc(4); b.writeUInt32BE(payload.length + 8); return b; })(), payload]);
  const header = Buffer.alloc(8); header.write('icns', 0, 'ascii'); header.writeUInt32BE(0, 4);
  const body = Buffer.concat([entry('ic07', png(128, 7)), entry('ic09', png(512, 9))]);
  header.writeUInt32BE(header.length + body.length, 4);
  writeFileSync(join(resources, 'app.icns'), Buffer.concat([header, body]));
  assert.equal(chromeBundleIconPath(join(bundle, 'Contents', 'MacOS', 'Sample'), 'darwin'), join(resources, 'app.icns'));
  assert.equal(chromeBundleIconPath('/usr/bin/google-chrome', 'linux'), null);
  const dataUrl = icnsIconDataUrl(join(resources, 'app.icns'));
  assert(dataUrl?.startsWith('data:image/png;base64,'));
  assert.equal(Buffer.from(dataUrl!.slice('data:image/png;base64,'.length), 'base64').readUInt32BE(16), 128);
  assert.equal(icnsIconDataUrl(join(resources, 'missing.icns')), undefined);
});

h.test('installation candidates support platform locations and exclude unrelated browser executables', () => {
  assert.equal(chromeCandidatePaths('darwin', {}, '/home/user').length, 2);
  assert.equal(chromeCandidatePaths('win32', { LOCALAPPDATA: '/local', PROGRAMFILES: '/program', 'PROGRAMFILES(X86)': '/x86' }, '/home').length, 3);
  const linux = chromeCandidatePaths('linux', { PATH: '/custom/bin' }, '/home');
  assert(linux.includes('/custom/bin/google-chrome'));
  assert(linux.every(path => !/chromium|edge|firefox/i.test(path)));
});

h.test('real launcher errors and unsuccessful immediate exits are observed before success', async () => {
  await assert.rejects(launchSiteProcess(join(root, 'missing-executable'), []), /ENOENT/);
  await assert.rejects(launchSiteProcess(process.execPath, ['-e', 'process.exit(17)'], true), /17/);
  await launchSiteProcess(process.execPath, ['-e', 'process.exit(0)'], true);
});

h.test('website IPC enforces the window boundary and returns structured failures', async () => {
  const f = fixture(), registry = new ChannelRegistry(); registerBrowserHandlers(registry, { manager: f.browser, sites: f.sites });
  const invoke = (channel: string, payload: Json, senderId = 9) => {
    const handler = registry.lookup(channel); assert(handler);
    return handler({ role: 'main', senderId, channel, args: [payload] });
  };
  assert.equal(object(await invoke('site-references:open-targets', {})).preferredTarget, 'system-default');
  assert.equal(object(await invoke('site-references:open', { sessionId: 'saved-session', url: 'https://example.com', target: 'chrome' })).ok, true);
  assert.equal(object(await invoke('site-references:open', { sessionId: 'saved-session', url: credentialUrl(vectors.credentialUrls[1]!), target: 'chrome' })).code, 'invalid_request');
  assert.equal(object(await invoke('site-references:open-targets', {}, 10)).code, 'FORBIDDEN_CHANNEL');
  assert.equal(object(await invoke('site-references:open', { sessionId: 'saved-session', url: 'https://example.com', target: 'chrome' }, 10)).code, 'FORBIDDEN_CHANNEL');
});

void h.finish(join(__dirname, 'site-open-result.json'), 'site-open').then(code => { process.exitCode = code; }).finally(() => rmSync(root, { recursive: true, force: true }));
