import strict from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness, waitFor } from './harness';
import { ComputerHistoryStore, COMPUTER_HISTORY_MAX_ENTRIES, COMPUTER_HISTORY_PRUNE_INTERVAL_MS, COMPUTER_HISTORY_RETENTION_MS, COMPUTER_HISTORY_SUBDIRECTORY } from '../main/services/computer-history/store';
import { COMPUTER_HISTORY_ENABLED_KEY, COMPUTER_HISTORY_MAX_POLICY_ENTRIES, COMPUTER_HISTORY_POLICY_KEY, PRIVATE_WINDOW_MARKERS,
  isPrivateWindowTitle, parseObservationPolicy, removeObservationEntry, serializeObservationPolicy, shouldObserve,
  upsertObservationEntry, validateObservationEntry } from '../main/services/computer-history/observation-policy';
import { ComputerHistoryService, COMPUTER_HISTORY_ORGANIZATION_BLOCKED, COMPUTER_HISTORY_UNAVAILABLE_PLATFORM } from '../main/services/computer-history/service';
import { COMPUTER_HISTORY_STARTED_MARKER } from '../main/services/computer-history/watcher';
import { withSettingsDb } from '../main/services/settings';
import type { ManagedPolicySnapshot } from '../main/services/computer-use/managed-policy';

const h = new Harness();
const temporary = mkdtempSync(join(tmpdir(), 'klaus-computer-history-'));
const roots: string[] = [];
const services: ComputerHistoryService[] = [];
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/computer-history-vectors.json'), 'utf8'));

function fakeHelper(root: string, options: { unavailable?: boolean; observePolicy?: boolean } = {}): { executable: string; args: string[]; env: Record<string, string> } {
  const script = join(root, 'history-helper.cjs');
  writeFileSync(script, `
let input = '';
process.stdin.on('data', chunk => {
  input += String(chunk);
  let newline;
  while ((newline = input.indexOf('\\n')) >= 0) {
    const line = input.slice(0, newline).trim(); input = input.slice(newline + 1);
    if (!line) continue;
    if (line.includes('"stop":true')) { console.log(JSON.stringify({ event: 'stopped' })); process.exit(0); }
    let request; try { request = JSON.parse(line); } catch { continue; }
    if (request.method !== 'watchHistory') { console.log(JSON.stringify({ event: 'stopped' })); process.exit(0); }
    // Mirrors the native protocol: a degraded watch never claims it started.
    if (${options.unavailable ? 'true' : 'false'}) {
      console.log(JSON.stringify({ event: 'unavailable', reason: 'macos-accessibility-permission-required' }));
      process.exit(0);
    }
    process.stderr.write(${JSON.stringify(COMPUTER_HISTORY_STARTED_MARKER + '\\n')});
    console.log(JSON.stringify({ event: 'appActivated', bundleId: 'test.fixture', name: 'Fixture', pid: 7, at: Date.now() }));
    console.log(JSON.stringify({ event: 'windowTitle', bundleId: 'test.fixture', title: 'Fixture — Incognito', at: Date.now() }));
    console.log(JSON.stringify({ event: 'windowTitle', bundleId: 'test.fixture', title: 'Plain Window', url: 'https://example.com/page', at: Date.now() }));
    console.log(JSON.stringify({ event: 'windowTitle', bundleId: 'other.fixture', title: 'Other Window', url: 'https://other.invalid/x', at: Date.now() }));
  }
});
setTimeout(() => process.exit(1), 60000).unref?.();
`);
  return { executable: process.execPath, args: [script], env: { ...process.env as Record<string, string>, ELECTRON_RUN_AS_NODE: '1' } };
}

function fixture(options: { managed?: ManagedPolicySnapshot; unavailable?: boolean; available?: boolean } = {}) {
  const root = mkdtempSync(join(temporary, 'profile-'));
  roots.push(root);
  withSettingsDb(root, db => db.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('seed', '1'));
  const command = fakeHelper(root, { unavailable: options.unavailable });
  const service = new ComputerHistoryService({ configRoot: root, command,
    available: () => options.available !== false,
    ...(options.managed ? { managedPolicy: () => options.managed! } : {}),
    log: () => {} });
  services.push(service);
  const ledger = () => {
    try { return readFileSync(join(root, COMPUTER_HISTORY_SUBDIRECTORY, 'events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)); }
    catch { return []; }
  };
  const stored = () => withSettingsDb(root, db => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(row => [row.key, row.value])));
  return { root, service, ledger, stored };
}

h.test('governance vectors pin the retention budget, storage layout and wording', () => {
  strict.equal(vector.retention.windowMs, COMPUTER_HISTORY_RETENTION_MS);
  strict.equal(vector.retention.maxEntries, COMPUTER_HISTORY_MAX_ENTRIES);
  strict.equal(vector.retention.pruneIntervalMs, COMPUTER_HISTORY_PRUNE_INTERVAL_MS);
  strict.equal(vector.storage.subdirectory, COMPUTER_HISTORY_SUBDIRECTORY);
  strict.equal(vector.storage.ledgerFile, 'events.jsonl');
  strict.equal(vector.frames.startedMarker, COMPUTER_HISTORY_STARTED_MARKER);
  strict.equal(vector.frames.unavailableReason, 'macos-accessibility-permission-required');
  strict.equal(vector.settingsKeys.enabled, COMPUTER_HISTORY_ENABLED_KEY);
  strict.equal(vector.settingsKeys.policy, COMPUTER_HISTORY_POLICY_KEY);
  strict.equal(vector.maxPolicyEntries, COMPUTER_HISTORY_MAX_POLICY_ENTRIES);
  strict.deepEqual(vector.privateWindowMarkers, [...PRIVATE_WINDOW_MARKERS]);
  strict.equal(vector.messages.organizationBlocked, COMPUTER_HISTORY_ORGANIZATION_BLOCKED);
  strict.equal(vector.messages.unavailablePlatform, COMPUTER_HISTORY_UNAVAILABLE_PLATFORM);
  strict.equal(vector.managedKey, 'computerHistoryEnabled');
});

h.test('observation policy decisions follow the pinned include/exclude table', () => {
  for (const item of vector.policyCases as Array<{ entries: unknown[]; frame: { bundleId?: string; url?: string }; observe: boolean }>) {
    const entries = item.entries.map(entry => validateObservationEntry(entry));
    strict.equal(shouldObserve(item.frame, entries), item.observe, JSON.stringify(item));
  }
});

h.test('observation policy entries validate strictly and upsert by scope and target', () => {
  strict.deepEqual(validateObservationEntry({ observe: 'exclude', scope: 'app', target: ' Com.Apple.Notes ' }), { observe: 'exclude', scope: 'app', target: 'com.apple.notes' });
  strict.deepEqual(validateObservationEntry({ observe: 'include', scope: 'url', target: 'Example.com' }), { observe: 'include', scope: 'url', target: 'example.com' });
  strict.throws(() => validateObservationEntry({ observe: 'maybe', scope: 'app', target: 'x' }), /include or exclude/);
  strict.throws(() => validateObservationEntry({ observe: 'exclude', scope: 'page', target: 'x' }), /app or url/);
  strict.throws(() => validateObservationEntry({ observe: 'exclude', scope: 'app', target: ' ' }), /non-empty/);
  strict.throws(() => validateObservationEntry({ observe: 'exclude', scope: 'app', target: 'not a bundle!' }), /bundle identifier/);
  strict.throws(() => validateObservationEntry({ observe: 'exclude', scope: 'url', target: 'single' }), /domain/);
  strict.throws(() => validateObservationEntry({ observe: 'exclude', scope: 'app', target: 'com.a.b', extra: 1 }), /Unknown observation field/);
  const base = [validateObservationEntry({ observe: 'exclude', scope: 'app', target: 'com.apple.notes' })];
  strict.deepEqual(upsertObservationEntry(base, validateObservationEntry({ observe: 'include', scope: 'app', target: 'com.apple.notes' })),
    [validateObservationEntry({ observe: 'include', scope: 'app', target: 'com.apple.notes' })]);
  strict.deepEqual(removeObservationEntry(base, 'app', 'com.apple.notes'), []);
  strict.throws(() => parseObservationPolicy('not-json'), /unreadable/);
  strict.throws(() => parseObservationPolicy('[{"observe":"nope"}]'), /include or exclude/);
  strict.deepEqual(parseObservationPolicy(undefined), []);
  strict.equal(serializeObservationPolicy(base), JSON.stringify(base));
});

h.test('private-browsing markers are recognized in titles and urls', () => {
  strict.equal(isPrivateWindowTitle('Example — Incognito', undefined), true);
  strict.equal(isPrivateWindowTitle('Fenêtre Privée — Private Browsing', undefined), true);
  strict.equal(isPrivateWindowTitle(' example — InPrivate ', undefined), true);
  strict.equal(isPrivateWindowTitle('Normal Window', 'https://example.com/private browsing'), true);
  strict.equal(isPrivateWindowTitle('Normal Window', 'https://example.com/'), false);
  strict.equal(isPrivateWindowTitle(undefined, undefined), false);
});

h.test('the store appends entries, skips corrupt lines and pages newest-last', () => {
  const root = mkdtempSync(join(temporary, 'store-')); roots.push(root);
  const now = 1_800_000_000_000;
  const store = new ComputerHistoryStore(root, () => now);
  strict.equal(store.append({ kind: 'app', at: now - 3000, bundleId: 'a.one', name: 'One' }), true);
  strict.equal(store.append({ kind: 'window', at: now - 2000, bundleId: 'a.one', title: 'T1', url: 'https://one.invalid/' }), true);
  strict.equal(store.append({ kind: 'bogus' as never, at: now } as never), false);
  writeFileSync(join(root, COMPUTER_HISTORY_SUBDIRECTORY, 'events.jsonl'), readFileSync(join(root, COMPUTER_HISTORY_SUBDIRECTORY, 'events.jsonl'), 'utf8') + 'corrupt-line\n{"kind":"app"}\n');
  const all = store.readAll();
  strict.equal(all.length, 2, 'corrupt and invalid lines are dropped');
  strict.deepEqual(store.entries(1), [all[1]]);
  strict.deepEqual(store.entries(10, all[1]!.at), [all[0]]);
  strict.equal(store.count(), 2);
});

h.test('pruning enforces the retention window and the entry cap, regenerating the digest', () => {
  const root = mkdtempSync(join(temporary, 'prune-')); roots.push(root);
  const now = 1_800_000_000_000;
  const store = new ComputerHistoryStore(root, () => now);
  store.append({ kind: 'app', at: now - COMPUTER_HISTORY_RETENTION_MS - 60_000, name: 'Ancient' });
  store.append({ kind: 'app', at: now - 60_000, name: 'Recent' });
  for (let index = 0; index < 30; index++) store.append({ kind: 'app', at: now - 50_000 + index, name: `App${index}` });
  strict.equal(store.prune().removed, 1);
  const kept = store.readAll();
  strict.equal(kept.some(entry => entry.name === 'Ancient'), false);
  strict.equal(kept.some(entry => entry.name === 'Recent'), true);
  const capRoot = mkdtempSync(join(temporary, 'cap-')); roots.push(capRoot);
  const capStore = new ComputerHistoryStore(capRoot, () => now);
  const lines: string[] = [];
  for (let index = 0; index < COMPUTER_HISTORY_MAX_ENTRIES + 5; index++) lines.push(JSON.stringify({ kind: 'app', at: now - 1000, name: `App${index}` }));
  mkdirSync(join(capRoot, COMPUTER_HISTORY_SUBDIRECTORY), { recursive: true });
  writeFileSync(join(capRoot, COMPUTER_HISTORY_SUBDIRECTORY, 'events.jsonl'), lines.join('\n') + '\n');
  const removed = capStore.prune().removed;
  strict.equal(removed, 5);
  strict.equal(capStore.readAll().length, COMPUTER_HISTORY_MAX_ENTRIES);
  const digest = store.exportDigest();
  strict.ok(digest && existsSync(digest));
  strict.match(readFileSync(digest!, 'utf8'), /# Computer History — \d{4}-\d{2}-\d{2}/);
  strict.match(readFileSync(digest!, 'utf8'), /Recent/);
});

h.test('clearing honors the pinned intervals', () => {
  const root = mkdtempSync(join(temporary, 'clear-')); roots.push(root);
  const now = 1_800_000_000_000;
  const store = new ComputerHistoryStore(root, () => now);
  store.append({ kind: 'app', at: now - 2 * 60 * 60 * 1000, name: 'TwoHoursAgo' });
  store.append({ kind: 'app', at: now - 30 * 60 * 1000, name: 'HalfHourAgo' });
  store.append({ kind: 'app', at: now - 1000, name: 'JustNow' });
  // "Clear the last hour" removes what happened inside that hour, keeping older entries.
  strict.equal(store.clear('last-hour').removed, 2);
  strict.deepEqual(store.readAll().map(entry => entry.name), ['TwoHoursAgo']);
  strict.equal(store.clear('last-day').removed, 1);
  strict.deepEqual(store.readAll(), []);
  strict.equal(store.clear('all').removed, 0);
  strict.throws(() => store.clear('forever' as never), /Unknown Computer History clear interval/);
  strict.deepEqual(vector.clearIntervals, ['all', 'last-day', 'last-hour']);
});

h.test('enabling records observed frames while private windows never reach the ledger', async () => {
  const f = fixture();
  const result = await f.service.setEnabled({ enabled: true });
  strict.equal(result.ok, true);
  strict.equal(result.status.state, 'running');
  strict.equal(f.stored()[COMPUTER_HISTORY_ENABLED_KEY], '1');
  await waitFor(() => f.ledger().length >= 3, 5000, 'frames are recorded');
  const entries = f.ledger();
  strict.equal(entries.some((entry: Record<string, unknown>) => entry.kind === 'app' && entry.name === 'Fixture'), true);
  strict.equal(entries.some((entry: Record<string, unknown>) => entry.title === 'Plain Window' && entry.url === 'https://example.com/page'), true);
  strict.equal(entries.some((entry: Record<string, unknown>) => entry.title === 'Other Window'), true);
  strict.equal(entries.some((entry: Record<string, unknown>) => String(entry.title ?? '').includes('Incognito')), false,
    'a private-browsing window is never stored');
  const snapshot = f.service.snapshot();
  strict.equal(snapshot.settings.enabled, true);
  strict.equal(snapshot.status.state, 'running');
  strict.ok(snapshot.status.entryCount >= 3);
  strict.equal(snapshot.status.retentionMs, COMPUTER_HISTORY_RETENTION_MS);
  await f.service.setEnabled({ enabled: false });
  strict.equal(f.service.status().state, 'stopped');
  strict.equal(f.stored()[COMPUTER_HISTORY_ENABLED_KEY], '0');
});

h.test('an unavailable observation child rolls the enable back durably', async () => {
  const f = fixture({ unavailable: true });
  const result = await f.service.setEnabled({ enabled: true });
  strict.equal(result.ok, false);
  strict.equal(f.service.status().state, 'stopped');
  strict.equal(f.service.status().unavailableReason, 'macos-accessibility-permission-required');
  await waitFor(() => f.stored()[COMPUTER_HISTORY_ENABLED_KEY] === '0', 5000, 'the preference rolls back');
  // A later enable attempt surfaces the reason again through the same path.
  const second = await f.service.setEnabled({ enabled: true });
  strict.equal(second.ok, false);
});

h.test('an organization policy blocks enabling and is visible in the snapshot', async () => {
  const managed: ManagedPolicySnapshot = { status: 'active', policy: { computerUseEnabled: true, computerHistoryEnabled: false, blockedApps: [] } };
  const f = fixture({ managed });
  const result = await f.service.setEnabled({ enabled: true });
  strict.equal(result.ok, false);
  strict.equal(result.error, COMPUTER_HISTORY_ORGANIZATION_BLOCKED);
  strict.equal(f.service.snapshot().settings.managedDisabled, true);
  strict.equal(f.service.snapshot().status.managedDisabled, true);
  strict.equal(f.stored()[COMPUTER_HISTORY_ENABLED_KEY], undefined, 'a refused enable never writes the preference');
  const unreadable = fixture({ managed: { status: 'unreadable', error: 'managed-broken' } });
  const attempt = await unreadable.service.setEnabled({ enabled: true });
  strict.equal(attempt.ok, false);
  strict.equal(attempt.error, 'managed-broken');
});

h.test('observation is refused where the platform does not provide it', async () => {
  const f = fixture({ available: false });
  const result = await f.service.setEnabled({ enabled: true });
  strict.equal(result.ok, false);
  strict.match(String(result.error), /unavailable/i);
});

h.test('pause and resume keep the durable preference and move the state', async () => {
  const f = fixture();
  await f.service.setEnabled({ enabled: true });
  await waitFor(() => f.ledger().length >= 3, 5000, 'observing');
  const paused = await f.service.pause();
  strict.equal(paused.ok, true);
  strict.equal(paused.status.state, 'paused');
  strict.equal(f.stored()[COMPUTER_HISTORY_ENABLED_KEY], '1', 'pause is not a disable');
  const resumed = await f.service.resume();
  strict.equal(resumed.ok, true);
  strict.equal(resumed.status.state, 'running');
  await f.service.setEnabled({ enabled: false });
});

h.test('observation policy entries persist and filter recorded frames', async () => {
  const f = fixture();
  const update = f.service.updateObservationPolicy({ observe: 'exclude', scope: 'url', target: 'example.com' });
  strict.deepEqual(update.policy, [{ observe: 'exclude', scope: 'url', target: 'example.com' }]);
  strict.equal(f.stored()[COMPUTER_HISTORY_POLICY_KEY], JSON.stringify(update.policy));
  f.service.updateObservationPolicy({ observe: 'exclude', scope: 'app', target: 'other.fixture' });
  strict.equal(f.service.updateObservationPolicy({ observe: 'include', scope: 'app', target: 'other.fixture' }).policy.length, 2);
  strict.deepEqual(f.service.removeObservationEntry({ scope: 'app', target: 'other.fixture' }).policy,
    [{ observe: 'exclude', scope: 'url', target: 'example.com' }]);
  strict.throws(() => f.service.updateObservationPolicy({ observe: 'exclude', scope: 'app', target: '!' }), /bundle identifier/);
  await f.service.setEnabled({ enabled: true });
  await waitFor(() => f.ledger().length >= 2, 5000, 'frames recorded');
  const entries = f.ledger();
  strict.equal(entries.some((entry: Record<string, unknown>) => entry.url === 'https://example.com/page'), false, 'the excluded domain is not stored');
  strict.equal(entries.some((entry: Record<string, unknown>) => entry.title === 'Other Window'), true);
  await f.service.setEnabled({ enabled: false });
  // The persisted policy survives a fresh service on the same profile.
  const reopened = new ComputerHistoryService({ configRoot: f.root, command: fakeHelper(f.root), available: () => true, log: () => {} });
  services.push(reopened);
  strict.deepEqual(reopened.getSettings().policy, [{ observe: 'exclude', scope: 'url', target: 'example.com' }]);
});

h.test('clearing history reports the removed count and empties the timeline', async () => {
  const f = fixture();
  await f.service.setEnabled({ enabled: true });
  await waitFor(() => f.ledger().length >= 3, 5000, 'frames recorded');
  await f.service.setEnabled({ enabled: false });
  const cleared = f.service.clearHistory({ interval: 'all' });
  strict.equal(cleared.ok, true);
  strict.ok(cleared.removed >= 3);
  strict.deepEqual(f.service.entries({}).entries, []);
  strict.deepEqual(f.ledger(), []);
  const digestDir = join(f.root, COMPUTER_HISTORY_SUBDIRECTORY, 'memory');
  strict.ok(existsSync(digestDir), 'the digest directory is regenerated');
});

h.test('autostart resumes the persisted enabled state and shutdown drains', async () => {
  const f = fixture();
  withSettingsDb(f.root, db => db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(COMPUTER_HISTORY_ENABLED_KEY, '1'));
  f.service.autostart();
  await waitFor(() => f.service.status().state === 'running', 5000, 'autostart observes again');
  await waitFor(() => f.ledger().length >= 3, 5000, 'frames recorded after autostart');
  const shutdown = await f.service.shutdown();
  strict.equal(shutdown.complete, true);
});

h.test('the service exposes the aligned lifecycle method surface', () => {
  const f = fixture();
  for (const method of vector.methods as string[]) {
    strict.equal(typeof (f.service as unknown as Record<string, unknown>)[method], 'function', `missing method ${method}`);
  }
  strict.deepEqual(vector.frames.events, ['appActivated', 'windowTitle', 'unavailable', 'stopped']);
});

void h.finish(join(__dirname, 'computer-history-results.json'), 'computer-history').then(async code => {
  for (const service of services) await service.shutdown().catch(() => {});
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  process.exitCode = code;
});
