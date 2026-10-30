import strict from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from './harness';
import { MacOsConnectors } from '../main/services/macos-connectors/service';
import { MACOS_TOOL_CONTRACTS } from '../main/services/macos-connectors/tool-contracts';
import { flattenBookmarks, safariUrl, truncatePage } from '../main/services/macos-connectors/safari';
import { MacOsCommandRunner, type MacOsCommand, type MacOsCommands } from '../main/native/macos-command';
import type { MacOsCallContext, Row } from '../main/services/macos-connectors/types';

const h = new Harness(), directory = mkdtempSync(join(tmpdir(), 'klaus-macos-safari-'));
const cleanups: Array<() => Promise<unknown>> = [];
const isReady = (request: MacOsCommand) => (request.args[1] ?? '').endsWith('to return version');
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }
function fixture(run?: MacOsCommands['run']) {
  const requests: MacOsCommand[] = []; let reply = 'ok';
  const service = new MacOsConnectors({ configRoot: directory, userHome: directory, platform: 'darwin', applicationAvailable: async () => true, commands: {
    available: async () => true, close: async () => ({ complete: true }), run: async (request, signal) => {
      requests.push(request); if (run) return run(request, signal);
      if (request.executable === '/usr/bin/open') return ''; if (isReady(request)) return '1.0'; return reply;
    },
  } });
  service.attachSession('fixture'); cleanups.push(() => service.close());
  const context: MacOsCallContext = { sessionId: 'fixture', turnId: 'turn', signal: new AbortController().signal, assertCurrent() {}, elicit: async () => ({ action: 'accept' }) };
  const call = async (tool: string, args: Row = {}) => (await service.call('macos-safari', tool, args, context)).content[0]!.text;
  return { service, requests, context, call, setReply(value: string) { reply = value; } };
}
const cases = [
  { tool: 'list_tabs', args: {}, reply: '[]' },
  { tool: 'get_active_tab', args: {}, reply: '{"url":"http://127.0.0.1/own","title":"Own","selection":""}' },
  { tool: 'read_tab', args: {}, reply: '["Own body"]' },
  { tool: 'read_tab', args: { window: 2, tab: 3, limit: 5 }, reply: '["Own body"]' },
  { tool: 'read_tab', args: { window: 2 }, reply: '["Own body"]' },
  { tool: 'open_url', args: { url: 'http://127.0.0.1/own' }, reply: 'ok' },
  { tool: 'open_url', args: { url: 'about:blank', current: true }, reply: 'ok' },
  { tool: 'switch_to_tab', args: { window: 2, tab: 1 }, reply: 'ok' },
  { tool: 'close_tab', args: { window: 2, tab: 1 }, reply: 'ok' },
];
h.test('Safari pins all eight contracts and exposes its installed capability without opening an app', async () => {
  strict.equal(createHash('sha256').update(JSON.stringify(MACOS_TOOL_CONTRACTS['macos-safari'])).digest('hex'), '17f9a8bad59a30a1914320677861cb3a900450ec257e67a125f286c29b378299');
  const { service, requests } = fixture(); strict.equal((await service.capability('macos-safari'))?.tools.length, 8); strict.equal(requests.length, 0);
});
h.test('Safari keeps multiline tab metadata and distinguishes a denied selection from empty text', async () => {
  const { call, setReply } = fixture(), rows = [{ window: 1, tab: 2, url: 'https://example.invalid/own', title: 'Own\tTitle\nLine' }];
  setReply(JSON.stringify(rows)); strict.deepEqual(JSON.parse(await call('list_tabs')), { count: 1, tabs: rows });
  const selected = { url: rows[0]!.url, title: rows[0]!.title, selection: 'Own\nselection' };
  setReply(JSON.stringify(selected)); strict.deepEqual(JSON.parse(await call('get_active_tab')), selected);
  const denied = { ...selected, selection: null, selectionError: 'JavaScript from Apple Events is disabled' };
  setReply(JSON.stringify(denied)); strict.deepEqual(JSON.parse(await call('get_active_tab')), denied);
  setReply('{"url":"x","title":"x","selection":null}'); await strict.rejects(call('get_active_tab'), /invalid/);
  setReply('[{"window":0,"tab":1,"url":"x","title":"x"}]'); await strict.rejects(call('list_tabs'), /invalid/);
});
h.test('page text retains whitespace, bounds UTF-16 output and never splits a surrogate pair', async () => {
  const { call, setReply, requests } = fixture(); setReply(JSON.stringify(['\nOwn body\n'])); strict.equal(await call('read_tab'), '\nOwn body\n');
  strict.equal(truncatePage('A😀Z', 2), 'A\n…(truncated, total 4 chars)');
  strict.equal(truncatePage('A😀Z', 3), 'A😀\n…(truncated, total 4 chars)');
  await call('read_tab', { window: 2 }); strict.match(requests.at(-1)!.args[1]!, /set window_ to window 2/); strict.match(requests.at(-1)!.args[1]!, /current tab of window_/);
  await call('read_tab', { tab: 3 }); strict.match(requests.at(-1)!.args[1]!, /set window_ to window 1/); strict.match(requests.at(-1)!.args[1]!, /set tab_ to tab 3/);
});
h.test('invalid target indices, nonboolean navigation and executable URL schemes fail before Safari opens', async () => {
  const { call, requests } = fixture();
  for (const index of [0, -1, 1.5, '1', Infinity]) await strict.rejects(call('close_tab', { window: index, tab: 1 }), /index/);
  await strict.rejects(call('switch_to_tab', { window: 1 }), /index/);
  for (const url of ['javascript:alert(1)', 'data:text/html,own', 'mailto:own@example.invalid', 'relative']) await strict.rejects(call('open_url', { url }), /URL/);
  await strict.rejects(call('open_url', { url: 'about:blank', current: 'false' }), /boolean/);
  await strict.rejects(call('read_tab', { limit: NaN }), /finite/); strict.equal(requests.length, 0);
  strict.equal(safariUrl('https://example.invalid/own'), 'https://example.invalid/own'); strict.equal(safariUrl('file:///tmp/owned.html'), 'file:///tmp/owned.html');
});
h.test('navigation supports no windows and never repeats an uncertain mutation', async () => {
  const { call, requests } = fixture(); await call('open_url', { url: 'about:blank' });
  strict.match(requests.at(-1)!.args[1]!, /if \(count of windows\) is 0 then\s+make new document/);
  let mutations = 0;
  const uncertain = fixture(async request => {
    if (request.executable === '/usr/bin/open') return ''; if (isReady(request)) return '1.0'; mutations++; throw new Error('(-600) after uncertain tab creation');
  });
  await strict.rejects(uncertain.call('open_url', { url: 'about:blank' }), /uncertain/); strict.equal(mutations, 1);
});
h.test('closing during readiness drains it before any navigation can start', async () => {
  const entered = deferred(), gate = deferred();
  const { call, service, requests } = fixture(async request => { if (request.executable === '/usr/bin/open') return ''; entered.resolve(); await gate.promise; return '1.0'; });
  const pending = call('open_url', { url: 'about:blank' }), rejected = strict.rejects(pending); await entered.promise;
  strict.deepEqual(await service.close(0), { complete: false }); gate.resolve(); await rejected; strict.deepEqual(await service.close(), { complete: true }); strict.equal(requests.length, 2);
});
h.test('bookmarks preserve folder paths and total counts while rejecting malformed or oversized trees', async () => {
  const tree = { Title: '', Children: [{ Title: 'Own\nFolder', Children: [
    { WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://example.invalid/one', URIDictionary: { title: 'One\tTitle' } },
    { Title: 'Nested', Children: [{ WebBookmarkType: 'WebBookmarkTypeLeaf', URLString: 'https://example.invalid/two' }] },
  ] }] };
  const rows = flattenBookmarks(tree, 100); strict.equal(rows[0]!.title, 'One\tTitle'); strict.equal(rows[1]!.folder, 'Own\nFolder / Nested');
  const { call, setReply } = fixture(); setReply(JSON.stringify(tree)); strict.deepEqual(JSON.parse(await call('list_bookmarks', { limit: 1 })), { count: 1, total: 2, bookmarks: [rows[0]] });
  strict.throws(() => flattenBookmarks({ Children: [null] }, 10), /invalid/);
  let deep: unknown = {}; for (let i = 0; i < 66; i++) deep = { Children: [deep] }; strict.throws(() => flattenBookmarks(deep, 100), /limit/);
});
h.test('database and plist permission failures remain explicit, with no fallback to an empty history', async () => {
  const missing = fixture(async () => { throw new Error('unable to open database file'); }); await strict.rejects(missing.call('list_history'), /Full Disk Access/);
  const denied = fixture(async () => { throw new Error('Operation not permitted'); }); await strict.rejects(denied.call('list_bookmarks'), /Full Disk Access/);
  const malformed = fixture(); malformed.setReply('[{"url":"x","title":null,"visit_time":"bad"}]'); await strict.rejects(malformed.call('list_history'), /invalid/);
});
if (process.platform === 'darwin') {
  h.test('every Safari action compiles against its installed dictionary without opening user tabs', async () => {
    const { call, setReply, requests } = fixture(); for (const item of cases) { setReply(item.reply); await call(item.tool, item.args); }
    for (const [i, request] of requests.filter(row => row.executable === '/usr/bin/osascript' && !isReady(row)).entries()) {
      const result = spawnSync('/usr/bin/osacompile', ['-o', join(directory, 'safari-' + i + '.scpt')], { input: request.args[1], encoding: 'utf8', timeout: 5000, maxBuffer: 1024 * 1024 });
      if (result.error) throw result.error; strict.equal(result.status, 0, result.stderr.trim() + '\n' + request.args[1]);
    }
  });
  h.test('real binary bookmarks with data/date and read-only Safari history preserve owned file bytes', async () => {
    const home = join(directory, 'owned-home'), safariRoot = join(home, 'Library', 'Safari'); mkdirSync(safariRoot, { recursive: true });
    const plist = join(safariRoot, 'Bookmarks.plist'), database = join(safariRoot, 'History.db');
    writeFileSync(plist, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Children</key><array><dict><key>Title</key><string>Own &lt;data&gt;</string><key>Children</key><array><dict><key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string><key>URLString</key><string>https://example.invalid/own</string><key>URIDictionary</key><dict><key>title</key><string>Own\nTitle</string></dict><key>blob</key><data>AQID</data><key>date</key><date>2026-09-08T00:00:00Z</date></dict></array></dict></array></dict></plist>');
    const binary = spawnSync('/usr/bin/plutil', ['-convert', 'binary1', plist], { encoding: 'utf8', timeout: 5000 }); if (binary.error) throw binary.error; strict.equal(binary.status, 0, binary.stderr);
    const db = spawnSync('/usr/bin/sqlite3', [database], { encoding: 'utf8', timeout: 5000, input: "CREATE TABLE history_items(id INTEGER,url TEXT); CREATE TABLE history_visits(history_item INTEGER,title TEXT,visit_time REAL); INSERT INTO history_items VALUES(1,'https://example.invalid/one'),(2,'https://example.invalid/two'); INSERT INTO history_visits VALUES(1,'Own title',0),(2,NULL,772000000.5);" });
    if (db.error) throw db.error; strict.equal(db.status, 0, db.stderr);
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex'), before = [hash(plist), hash(database)];
    const runner = new MacOsCommandRunner(), requests: MacOsCommand[] = [];
    const service = new MacOsConnectors({ configRoot: directory, userHome: home, commands: { available: files => runner.available(files), close: deadline => runner.close(deadline), run: (request, signal) => { requests.push(request); return runner.run(request, signal); } } });
    cleanups.push(() => service.close()); service.attachSession('owned');
    const context: MacOsCallContext = { sessionId: 'owned', turnId: 'read', signal: new AbortController().signal, assertCurrent() {}, elicit: async () => ({ action: 'accept' }) };
    const call = async (tool: string) => JSON.parse((await service.call('macos-safari', tool, {}, context)).content[0]!.text);
    const bookmarks = await call('list_bookmarks'); strict.equal(bookmarks.count, 1); strict.equal(bookmarks.bookmarks[0].folder, 'Own <data>'); strict.equal(bookmarks.bookmarks[0].title, 'Own\nTitle');
    strict.equal(requests.filter(row => row.executable === '/usr/bin/plutil').length, 3);
    const history = await call('list_history'); strict.equal(history.count, 2); strict.equal(history.history[0].visited, '2025-06-19T04:26:40.500Z'); strict.equal(history.history[0].title, null);
    strict.equal(history.history[1].visited, '2001-01-01T00:00:00.000Z'); strict.deepEqual(await service.close(), { complete: true }); strict.deepEqual([hash(plist), hash(database)], before);
  });
} else h.info('native Safari dictionary and owned file fixtures', 'Requires macOS; user bookmarks and history are never accessed.');
void h.finish(join(directory, 'result.json'), 'macos-safari').then(async code => {
  await Promise.all(cleanups.map(close => close())); rmSync(directory, { recursive: true, force: true }); process.exitCode = code;
}).catch(error => { console.error(error); process.exitCode = 1; });
