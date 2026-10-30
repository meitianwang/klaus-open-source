import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import test from 'node:test';

const extensionRoot = new URL('../resources/plugins-builtin/browser/chrome-extension/', import.meta.url);
const source = readFileSync(new URL('background.js', extensionRoot), 'utf8');
const manifest = JSON.parse(readFileSync(new URL('manifest.json', extensionRoot), 'utf8'));
const plain = value => JSON.parse(JSON.stringify(value));
const turn = (session = 'task-a', fields = {}) => ({ session_id: session, turn_id: 'turn-1', ...fields });
const humanTab = (fields = {}) => ({ id: 17, title: 'Inbox', url: 'https://mail.example.test/inbox',
  windowId: 8, index: 4, groupId: 77, active: false, lastAccessed: 100,
  favIconUrl: 'https://mail.example.test/favicon.ico', ...fields });

function event() {
  const listeners = new Set();
  return { addListener: listener => listeners.add(listener), removeListener: listener => listeners.delete(listener),
    emit: async (...args) => { await Promise.all([...listeners].map(listener => listener(...args))); } };
}

function browserState(tabs = [humanTab()]) {
  return { tabs: new Map(tabs.map(tab => [tab.id, { ...tab }])), groups: new Map([[77, { id: 77, title: 'Human work', color: 'green', collapsed: true }]]),
    local: new Map([['extensionInstanceId', 'fixture-profile']]), session: new Map(), effects: [], fetches: [],
    nextTab: 2000, nextGroup: 80, storageRead: undefined, favicon: () => ({ mime: 'image/png', bytes: Uint8Array.from([1, 2, 3, 4]) }) };
}

/** Model Chrome API state and effects; every browser policy runs in the real service worker. */
async function worker(state) {
  const messages = [];
  const timers = new Set();
  const errors = [];
  const events = Object.fromEntries(['activated', 'created', 'updated', 'removed', 'replaced', 'attached', 'detached'].map(name => [name, event()]));
  const storage = map => ({
    get: async key => { await state.storageRead?.(map === state.session ? 'session' : 'local', key);
      return Object.fromEntries((key == null ? [...map.keys()] : typeof key === 'string' ? [key] : key).filter(name => map.has(name)).map(name => [name, plain(map.get(name))])); },
    set: async values => { for (const [key, value] of Object.entries(values)) map.set(key, plain(value)); },
    remove: async key => { for (const name of Array.isArray(key) ? key : [key]) map.delete(name); },
  });
  const getTab = id => { const tab = state.tabs.get(id); if (!tab) throw new Error(`No tab with id ${id}`); return { ...tab }; };
  const port = { onMessage: event(), onDisconnect: event(), postMessage: message => messages.push(plain(message)) };
  let startupComplete;
  const startup = new Promise(resolve => { startupComplete = resolve; });
  const chrome = {
    runtime: { id: 'fixture-extension', connectNative: () => port, getManifest: () => manifest,
      getURL: path => `chrome-extension://fixture-extension/${path}`, reload: () => state.effects.push(['reload']),
      onInstalled: event(), onMessage: event(), onUpdateAvailable: event(), onStartup: event() },
    storage: { local: storage(state.local), session: storage(state.session) },
    alarms: { onAlarm: event(), get: async () => undefined, create: async name => { if (name === 'client-heartbeat-alarm') startupComplete(); }, clear: async () => true },
    tabs: {
      onActivated: events.activated, onCreated: events.created, onUpdated: events.updated, onRemoved: events.removed,
      onReplaced: events.replaced, onAttached: events.attached, onDetached: events.detached,
      get: async id => getTab(id),
      query: async query => [...state.tabs.values()].filter(tab => Object.entries(query).every(([key, value]) => tab[key] === value)).map(tab => ({ ...tab })),
      getZoom: async () => 1, sendMessage: async () => ({ ok: true }),
      create: async fields => { const tab = humanTab({ id: state.nextTab++, windowId: fields.windowId ?? 8, groupId: -1, index: state.tabs.size, title: '', ...fields }); state.tabs.set(tab.id, tab); state.effects.push(['create', tab.id]); await events.created.emit({ ...tab }); return { ...tab }; },
      update: async (id, fields) => { const tab = state.tabs.get(id); if (!tab) throw new Error('No such tab'); Object.assign(tab, fields); state.effects.push(['update', id, plain(fields)]); return { ...tab }; },
      group: async ({ groupId, tabIds }) => { const ids = Array.isArray(tabIds) ? tabIds : [tabIds]; const id = groupId ?? state.nextGroup++; if (!state.groups.has(id)) state.groups.set(id, { id }); for (const tabId of ids) state.tabs.get(tabId).groupId = id; state.effects.push(['group', id, ids]); return id; },
      ungroup: async input => { const ids = Array.isArray(input) ? input : [input]; for (const id of ids) state.tabs.get(id).groupId = -1; state.effects.push(['ungroup', ids]); },
      remove: async input => { const ids = Array.isArray(input) ? input : [input]; for (const id of ids) { state.tabs.delete(id); state.effects.push(['remove', id]); await events.removed.emit(id, { windowId: 8, isWindowClosing: false }); } },
    },
    windows: { onCreated: event(), onRemoved: event(), onFocusChanged: event(),
      getAll: async () => [{ id: 8, type: 'normal', focused: true }], get: async id => ({ id, type: 'normal', focused: true, state: 'normal' }),
      update: async (id, fields) => { state.effects.push(['window-update', id, plain(fields)]); return { id, ...fields }; } },
    tabGroups: { onCreated: event(), onUpdated: event(), onRemoved: event(),
      get: async id => { const group = state.groups.get(id); if (!group) throw new Error('No such group'); return { ...group }; },
      update: async (id, fields) => { Object.assign(state.groups.get(id), fields); state.effects.push(['group-update', id, plain(fields)]); return { ...state.groups.get(id) }; } },
    debugger: { onEvent: event(), onDetach: event(), getTargets: async () => [],
      attach: async target => { state.effects.push(['debugger-attach', plain(target)]); },
      detach: async target => { state.effects.push(['debugger-detach', plain(target)]); },
      sendCommand: async () => ({}) },
    downloads: { onCreated: event(), onChanged: event(), cancel: async id => { state.effects.push(['cancel-download', id]); } },
    scripting: { executeScript: async () => [{ result: true }] },
  };
  const context = createContext({ chrome, URL, URLSearchParams, AbortController, AbortSignal, Uint8Array,
    crypto: { randomUUID }, btoa: value => Buffer.from(value, 'binary').toString('base64'),
    console: { error: (...args) => errors.push(args.join(' ')), warn: (...args) => errors.push(args.join(' ')) },
    setTimeout: (callback, ms) => { const id = setTimeout(() => { timers.delete(id); callback(); }, ms); timers.add(id); return id; },
    clearTimeout: id => { timers.delete(id); clearTimeout(id); },
    fetch: async address => { state.fetches.push(String(address)); const parsed = new URL(address);
      assert.equal(parsed.origin, 'null'); assert.equal(parsed.protocol, 'chrome-extension:'); assert.equal(parsed.hostname, 'fixture-extension');
      assert.equal(parsed.pathname, '/_favicon/'); assert.equal(parsed.searchParams.get('size'), '16');
      const value = state.favicon(parsed.searchParams.get('pageUrl'));
      return { ok: true, headers: { get: () => value.mime }, arrayBuffer: async () => value.bytes.buffer };
    },
  });
  runInContext(source, context, { filename: fileURLToPath(new URL('background.js', extensionRoot)) });
  let startupTimeout;
  try {
    await Promise.race([startup, new Promise((_, reject) => {
      startupTimeout = setTimeout(() => reject(new Error(`Service worker did not finish startup: ${errors.join('\n')}`)), 1000);
    })]);
  } finally { clearTimeout(startupTimeout); }
  await Promise.resolve();
  assert.deepEqual(errors, [], 'the unmodified service worker starts successfully');
  return {
    messages, events,
    dispatch: async (method, fields = {}) => plain(await context.dispatch(method, turn('task-a', fields))),
    forTask: async (session, method, fields = {}) => plain(await context.dispatch(method, turn(session, fields))),
    dispose: () => { for (const id of timers) clearTimeout(id); },
  };
}

test('inventory filters every query term before the cap and preserves recent tab identities', async t => {
  const irrelevant = Array.from({ length: 1100 }, (_, index) => humanTab({ id: index + 1, title: 'Recent unrelated', url: 'https://other.test/', groupId: -1, lastAccessed: 10_000 + index }));
  const matches = [humanTab({ id: 1201, title: 'Release dashboard', url: 'https://project.test/klaus', lastAccessed: 10 }),
    humanTab({ id: 1202, title: 'Release dashboard', url: 'https://project.test/klaus', lastAccessed: 20 })];
  const state = browserState([...irrelevant, ...matches, humanTab({ id: 1203, title: 'Release only', url: 'https://other.test/', lastAccessed: 30 })]);
  const instance = await worker(state); t.after(instance.dispose);
  const found = await instance.dispatch('getUserTabs', { query: 'RELEASE klaus', limit: 1, includeFavicons: true });
  assert.deepEqual(found.map(tab => tab.id), [1202]);
  const both = await instance.dispatch('getUserTabs', { query: 'release klaus', limit: 100, includeFavicons: true });
  assert.deepEqual(both.map(tab => tab.id), [1202, 1201], 'equal URLs must not collapse distinct tab identities');
  assert.equal((await instance.dispatch('getUserTabs', { query: 'release missing', limit: 100 })).length, 0);
  assert.equal(state.effects.length, 0, 'discovery changes no tabs, groups, windows, or ownership');
});

test('recent discovery excludes internal pages before requested default and search limits', async t => {
  const tabs = Array.from({ length: 120 }, (_, index) => humanTab({ id: index + 1, groupId: -1, lastAccessed: index }));
  tabs.push(...Array.from({ length: 4 }, (_, index) => humanTab({ id: 200 + index, url: 'chrome://settings/', lastAccessed: 1000 + index })));
  const instance = await worker(browserState(tabs)); t.after(instance.dispose);
  assert((await instance.dispatch('getInfo')).metadata.capabilities.includes('tab_mentions_v1'), 'inventory advertises the preserving tab mention contract');
  assert.deepEqual((await instance.dispatch('getUserTabs', { limit: 3, includeFavicons: true })).map(tab => tab.id), [120, 119, 118]);
  assert.equal((await instance.dispatch('getUserTabs', { query: 'Inbox', limit: 100, includeFavicons: true })).length, 100);
  assert.deepEqual((await instance.dispatch('getUserTabs', { tabId: 1, limit: 3 })).map(tab => tab.id), [1], 'exact resolver lookup is independent of recency');
});

test('favicons use only Chromium local cache, reuse cached bytes and reject oversized or active content', async t => {
  assert(manifest.permissions.includes('favicon'));
  const state = browserState([humanTab(), humanTab({ id: 18, url: 'https://large.test/' }), humanTab({ id: 19, url: 'https://svg.test/' })]);
  state.favicon = url => url.includes('large') ? { mime: 'image/png', bytes: new Uint8Array(65_537) }
    : url.includes('svg') ? { mime: 'image/svg+xml', bytes: Uint8Array.from([1, 2, 3]) }
      : { mime: 'image/png', bytes: Uint8Array.from([1, 2, 3, 4]) };
  const instance = await worker(state); t.after(instance.dispose);
  const rows = await instance.dispatch('getUserTabs', { includeFavicons: true, limit: 100 });
  assert.equal(rows.find(tab => tab.id === 17).faviconUrl, 'data:image/png;base64,AQIDBA==');
  assert.equal(rows.find(tab => tab.id === 18).faviconUrl, null);
  assert.equal(rows.find(tab => tab.id === 19).faviconUrl, null);
  const fetched = state.fetches.length;
  await instance.dispatch('getUserTabs', { includeFavicons: true, tabId: 17 });
  assert.equal(state.fetches.length, fetched, 'a cached favicon does not refetch');
  assert(state.fetches.every(address => address.startsWith('chrome-extension://fixture-extension/_favicon/')));
});

test('borrowing preserves the human tab and rejects stale snapshots without acquiring ownership', async t => {
  const state = browserState(); const original = { ...state.tabs.get(17) };
  const instance = await worker(state); t.after(instance.dispose);
  await assert.rejects(instance.forTask('stale', 'claimUserTab', { tabId: 17, expectedTitle: 'Old inbox', expectedUrl: original.url }), /changed/);
  assert.deepEqual(await instance.forTask('stale', 'getTabs'), []);
  await instance.dispatch('claimUserTab', { tabId: 17, expectedTitle: original.title, expectedUrl: original.url });
  assert.deepEqual(state.tabs.get(17), original);
  assert.deepEqual(state.effects, [], 'borrowing neither focuses nor moves or groups the tab');
  assert.deepEqual((await instance.dispatch('getTabs')).map(tab => tab.id), [17]);
  assert.deepEqual(await instance.forTask('task-b', 'getTabs'), []);
  await assert.rejects(instance.forTask('task-b', 'claimUserTab', { tabId: 17 }), /already part of browser session task-a/);
});

test('concurrent claims give exactly one task the borrowed tab', async t => {
  const state = browserState(); const instance = await worker(state); t.after(instance.dispose);
  const outcomes = await Promise.allSettled(['one', 'two'].map(session => instance.forTask(session, 'claimUserTab', { tabId: 17 })));
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(result => result.status === 'rejected').length, 1);
  const winner = outcomes[0].status === 'fulfilled' ? 'one' : 'two';
  assert.deepEqual((await instance.forTask(winner, 'getTabs')).map(tab => tab.id), [17]);
  assert.deepEqual(await instance.forTask(winner === 'one' ? 'two' : 'one', 'getTabs'), []);
  assert.equal(state.effects.length, 0);
});

test('a navigation during asynchronous ownership lookup refuses the snapshot', async t => {
  const state = browserState(); const instance = await worker(state); t.after(instance.dispose);
  // Chrome may navigate while a claim awaits its persisted ownership lookup.
  state.storageRead = async (area, key) => {
    if (area === 'session' && key === 'KLAUS_BORROWED_TABS') state.tabs.get(17).url = 'https://mail.example.test/other';
  };
  await assert.rejects(instance.dispatch('claimUserTab', { tabId: 17, expectedTitle: 'Inbox', expectedUrl: 'https://mail.example.test/inbox' }), /changed/);
  assert.deepEqual(await instance.dispatch('getTabs'), []);
});

test('borrowed ownership survives worker suspension and finalization returns the exact human tab', async t => {
  const state = browserState(); const original = { ...state.tabs.get(17) };
  const first = await worker(state); t.after(first.dispose);
  await first.dispatch('claimUserTab', { tabId: 17 }); first.dispose();
  const resumed = await worker(state); t.after(resumed.dispose);
  assert.deepEqual((await resumed.dispatch('getTabs')).map(tab => tab.id), [17]);
  await assert.rejects(resumed.forTask('task-b', 'claimUserTab', { tabId: 17 }), /already part/);
  await resumed.dispatch('finalizeTabs', { keep: [] });
  assert.deepEqual(state.tabs.get(17), original);
  assert(!state.effects.some(effect => ['remove', 'group', 'ungroup', 'update', 'window-update'].includes(effect[0])));
  assert.deepEqual(await resumed.dispatch('getTabs'), []);
  await resumed.forTask('task-b', 'claimUserTab', { tabId: 17 });
  assert.deepEqual((await resumed.forTask('task-b', 'getTabs')).map(tab => tab.id), [17]);
});

test('finalizing a mixed task closes agent tabs while preserving the human group', async t => {
  const state = browserState(); const original = { ...state.tabs.get(17) };
  const instance = await worker(state); t.after(instance.dispose);
  const created = await instance.dispatch('createTab');
  await instance.dispatch('claimUserTab', { tabId: 17 });
  await instance.dispatch('attach', { tabId: 17 });
  await instance.dispatch('finalizeTabs', { keep: [] });
  assert(!state.tabs.has(created.id)); assert.deepEqual(state.tabs.get(17), original);
  assert(state.effects.some(effect => effect[0] === 'remove' && effect[1] === created.id));
  assert(state.effects.some(effect => effect[0] === 'debugger-detach' && effect[1].tabId === 17));
  assert(!state.effects.some(effect => effect[0] === 'ungroup' && effect[1].includes(17)));
});

test('external tab changes invalidate inventory and closing a borrowed tab clears its lease', async t => {
  const state = browserState(); const instance = await worker(state); t.after(instance.dispose);
  await instance.dispatch('claimUserTab', { tabId: 17 });
  for (const [name, args] of [
    ['created', [humanTab({ id: 18 })]], ['updated', [17, { title: 'Renamed', url: 'https://mail.example.test/renamed' }, humanTab()]],
    ['updated', [17, { favIconUrl: 'https://mail.example.test/new.ico' }, humanTab()]],
    ['updated', [17, { status: 'complete' }, humanTab()]], ['replaced', [19, 18]],
    ['activated', [{ tabId: 17, windowId: 8 }]], ['removed', [17, { windowId: 8, isWindowClosing: false }]],
  ]) {
    const before = instance.messages.filter(message => message.method === 'onTabsChanged').length;
    if (name === 'created') state.tabs.set(18, { ...args[0] });
    if (name === 'updated') Object.assign(state.tabs.get(17), args[1]);
    if (name === 'replaced') { state.tabs.delete(18); state.tabs.set(19, humanTab({ id: 19 })); }
    if (name === 'removed') state.tabs.delete(17);
    await instance.events[name].emit(...args);
    const changes = instance.messages.filter(message => message.method === 'onTabsChanged');
    assert(changes.length > before, `${name} invalidates browser-tab mentions`);
    const tabId = name === 'created' ? args[0].id : name === 'activated' ? args[0].tabId : args[0];
    assert.deepEqual(changes.at(-1).params, { reason: name, tabId });
    if (name === 'updated') assert.equal((await instance.dispatch('getUserTabs', { query: 'Renamed', includeFavicons: true }))[0].id, 17);
  }
  const count = instance.messages.filter(message => message.method === 'onTabsChanged').length;
  await instance.events.updated.emit(19, { audible: true }, humanTab({ id: 19 }));
  assert.equal(instance.messages.filter(message => message.method === 'onTabsChanged').length, count, 'an unrelated tab property does not invalidate snapshots');
  assert.deepEqual(await instance.dispatch('getTabs'), []);
  assert.deepEqual(await instance.dispatch('getUserTabs', { tabId: 17 }), []);
  assert.equal(state.session.get('KLAUS_BORROWED_TABS')?.['17'], undefined);
});
