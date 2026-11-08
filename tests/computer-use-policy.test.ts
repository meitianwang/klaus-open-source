import strict from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness, waitFor } from './harness';
import { withSettingsDb } from '../main/services/settings';
import { ComputerUsePolicyService, DEFAULT_COMPUTER_USE_ALLOWED_APP, COMPUTER_USE_SAFETY_FORBIDDEN_BUNDLE_IDS, COMPUTER_USE_GOVERNANCE_MESSAGES, computerUseAppMatches, computerUseSelfAppMatches, computerUseTaskAppMatches, type ComputerUseTaskScope, type ComputerUsePolicyDependencies,
  type ComputerUseApprovalContext, type ComputerUseApp } from '../main/services/computer-use/policy';
import { MANAGED_COMPUTER_USE_UNREADABLE, type ManagedPolicySnapshot } from '../main/services/computer-use/managed-policy';
import { registerComputerUseSettingsHandlers } from '../main/ipc/handlers/computer-use';
import { ChannelRegistry } from '../main/ipc/registry';
import { IpcRouter } from '../main/ipc/router';
import { RoleTable } from '../main/ipc/contract';
import { ComputerUseAppDetails } from '../main/services/computer-use/app-details';

const h = new Harness();
const fixtures: Array<{ root: string; service: ComputerUsePolicyService }> = [];
const notes: ComputerUseApp = { input: 'Notes', name: 'Notes', bundleId: 'com.apple.Notes', path: '/Applications/Notes.app', pid: 42 };
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve };
}
function fixture(overrides: Partial<ComputerUsePolicyDependencies> = {}, seedUnrestricted = true) {
  const root = mkdtempSync(join(tmpdir(), 'klaus-computer-policy-'));
  const changes: boolean[] = [], prompts: unknown[] = [];
  const service = new ComputerUsePolicyService({ configRoot: root, availability: () => ({ available: true }),
    enabledChanged: async enabled => { changes.push(enabled); }, ...overrides });
  service.attachSession('a'); service.attachSession('b');
  const put = (key: string, value: string) => withSettingsDb(root, db => {
    db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
  });
  const stored = () => withSettingsDb(root, db => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(row => [row.key, row.value])));
  const context = (sessionId = 'a', elicit?: ComputerUseApprovalContext['elicit']): ComputerUseApprovalContext => ({
    sessionId, signal: new AbortController().signal,
    elicit: elicit ?? (async request => { prompts.push(request); return { action: 'accept' }; }),
  });
  if (seedUnrestricted) put('computer_use.allowed_apps', '[]');
  const result = { root, service, changes, prompts, put, stored, context }; fixtures.push(result); return result;
}

h.test('existing committed settings vectors keep the same keys, projection and mutations', async () => {
  const base = join(__dirname, '../../contracts/vectors');
  const input = JSON.parse(readFileSync(join(base, 'host-settings-fixtures.json'), 'utf8')).computerUse;
  const expected = JSON.parse(readFileSync(join(base, 'host-settings-vectors.json'), 'utf8')).computerUse;
  for (const [index, seed] of input.stores.entries()) {
    const f = fixture({}, false); for (const [key, value] of Object.entries(seed)) f.put(key, value as string);
    strict.deepEqual(f.service.get(), expected.settings[index]);
  }
  for (const [index, operation] of input.mutations.entries()) {
    const f = fixture({}, false);
    const result = operation.op === 'setEnabled' ? await f.service.setEnabled({ enabled: operation.value })
      : await f.service.setAppPolicy({ restricted_to_apps: operation.payload.allowedApps, blocked_apps: operation.payload.deniedApps });
    strict.equal(result.ok, true); strict.deepEqual(result.settings, expected.mutations[index].settings);
    strict.deepEqual(f.stored(), expected.mutations[index].kv);
  }
});
h.test('a fresh policy makes every local app available through approval without seeding a restriction', async () => {
  const f = fixture({}, false);
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/computer-use-saved-apps.json'), 'utf8'));
  strict.deepEqual(f.service.get().allowedApps, vector.freshSavedApps);
  const lease = await f.service.approve(notes, f.context()); f.service.release(lease);
  strict.equal(f.prompts.length, 1);
  strict.equal((await f.service.setEnabled({ enabled: true })).ok, true);
  strict.equal(f.stored()['computer_use.allowed_apps'], undefined);
  await f.service.setAppPolicy({ blocked_apps: ['Notes'] });
  await strict.rejects(f.service.approve(notes, f.context()), /blocked/);
});
h.test('self-app rule checks the canonical installed location on macOS and Windows', () => {
  const mac = { input: 'Klaus', name: 'Klaus', bundleId: 'ai.klaus.desktop', path: '/Applications/Klaus.app' };
  const macExe = '/Applications/Klaus.app/Contents/MacOS/Klaus';
  strict.equal(computerUseSelfAppMatches(mac, macExe, 'darwin'), true);
  strict.equal(computerUseSelfAppMatches({ ...mac, path: '/Applications/Other/Klaus.app' }, macExe, 'darwin'), false);
  strict.equal(computerUseSelfAppMatches({ ...mac, bundleId: 'ai.klaus.desktop.helper' }, macExe, 'darwin'), false);
  const windows = { input: 'Klaus', name: 'Klaus', path: '\\\\?\\C:\\Users\\k\\AppData\\Local\\Klaus\\Klaus.exe' };
  const winExe = 'C:\\Users\\k\\AppData\\Local\\Klaus\\Klaus.exe';
  strict.equal(computerUseSelfAppMatches(windows, winExe, 'win32'), true);
  strict.equal(computerUseSelfAppMatches({ ...windows, path: 'C:\\Other\\Klaus.exe' }, winExe, 'win32'), false);
  strict.equal(computerUseSelfAppMatches({ ...windows, name: 'Other' }, winExe, 'win32'), false);
});
h.test('an explicit empty or custom allowlist stays unchanged when enabled', async () => {
  const unrestricted = fixture({}, false); unrestricted.put('computer_use.allowed_apps', '[]');
  await unrestricted.service.setEnabled({ enabled: true }); strict.deepEqual(unrestricted.service.get().allowedApps, []);
  const custom = fixture({}, false); custom.put('computer_use.allowed_apps', '["LM Studio"]');
  await custom.service.setEnabled({ enabled: true }); strict.deepEqual(custom.service.get().allowedApps, ['LM Studio']);
  const prior = fixture({}, false); prior.put('computer_use.enabled', '0');
  await prior.service.setEnabled({ enabled: true }); strict.deepEqual(prior.service.get().allowedApps, []);
});
h.test('allow-card append deduplicates without replacing existing restrictions or denied apps', async () => {
  const f = fixture(); await f.service.setAppPolicy({ restricted_to_apps: ['Notes'], blocked_apps: ['Terminal'] });
  f.service.addAllowedApp({ app: ' Safari ' }); f.service.addAllowedApp({ app: 'Safari' });
  strict.deepEqual(f.service.get().allowedApps, ['Notes', 'Safari']); strict.deepEqual(f.service.get().deniedApps, ['Terminal']);
  strict.throws(() => f.service.addAllowedApp({ app: ' ' }), /non-empty/);
});
h.test('two-list writes are atomic when the actual SQLite write fails', async () => {
  const f = fixture(); await f.service.setAppPolicy({ restricted_to_apps: ['Notes'], blocked_apps: ['Terminal'] });
  const before = f.stored();
  withSettingsDb(f.root, db => db.exec("CREATE TRIGGER fail_allowed BEFORE UPDATE ON settings WHEN NEW.key = 'computer_use.allowed_apps' BEGIN SELECT RAISE(ABORT, 'fixture-write-failed'); END"));
  await strict.rejects(f.service.setAppPolicy({ blocked_apps: ['Mail'], restricted_to_apps: ['Safari'] }), /fixture-write-failed/);
  strict.deepEqual(f.stored(), before);
});
h.test('unreadable stored policy refuses access instead of treating a failure as empty lists', async () => {
  const f = fixture(); f.put('computer_use.denied_apps', 'not-json');
  strict.throws(() => f.service.get(), /unreadable/);
  await strict.rejects(f.service.approve(notes, f.context()), /unreadable/); strict.equal(f.prompts.length, 0);
  f.put('computer_use.denied_apps', '["Mail", 3]');
  strict.throws(() => f.service.guardInput('a', 'Notes'), /unreadable/);
});
h.test('real backend unavailability is visible and prevents approval', async () => {
  const f = fixture({ availability: () => ({ available: false, error: 'fixture-native-backend-missing' }) });
  strict.equal(f.service.get().availableOnThisPlatform, false);
  await strict.rejects(f.service.approve(notes, f.context()), /fixture-native-backend-missing/); strict.equal(f.prompts.length, 0);
});
h.test('blocked policy wins over allowed aliases before any approval is requested', async () => {
  const f = fixture(); await f.service.setAppPolicy({ restricted_to_apps: ['com.apple.Notes'], blocked_apps: ['notes'] });
  await strict.rejects(f.service.approve(notes, f.context()), /blocked/); strict.equal(f.prompts.length, 0);
  strict.throws(() => f.service.guardInput('a', '/Applications/Notes.app/'), /blocked/);
});
h.test('substring, case and path aliases preserve policy matching without empty wildcard tokens', async () => {
  strict.equal(computerUseAppMatches({ input: 'iTerm2 Terminal' }, ['terminal']), true);
  strict.equal(computerUseAppMatches({ input: 'C:\\Apps\\Notes\\' }, ['c:\\apps\\notes']), true);
  strict.equal(computerUseAppMatches(notes, ['/']), false);
  const f = fixture(); await f.service.setAppPolicy({ restricted_to_apps: ['COM.APPLE.NOTES/'] });
  const lease = await f.service.approve(notes, f.context()); strict.equal(f.prompts.length, 0); f.service.release(lease);
  const safari = await f.service.approve({ input: 'Safari', bundleId: 'com.apple.Safari' }, f.context());
  strict.equal(f.prompts.length, 1); f.service.release(safari);
});
h.test('approvals are scoped to the trusted session and canonical resolved app identity', async () => {
  const f = fixture();
  const first = await f.service.approve(notes, f.context()); f.service.release(first);
  const alias = await f.service.approve({ ...notes, input: '/Applications/Notes.app/' }, f.context()); f.service.release(alias);
  strict.equal(f.prompts.length, 1);
  const other = await f.service.approve(notes, f.context('b')); strict.equal(f.prompts.length, 2);
  strict.throws(() => f.service.assertCurrent({ ...other }), /unavailable/);
  strict.notEqual(first.resourceId, other.resourceId); strict.notEqual(first.operationId, other.operationId);
  f.service.release(other);
});
h.test('a delayed approval cannot bypass a newly blocked app', async () => {
  const f = fixture(), reply = deferred<unknown>(); let entered = false;
  const pending = f.service.approve(notes, f.context('a', async () => { entered = true; return reply.promise; }));
  const rejected = strict.rejects(pending, /blocked/);
  await waitFor(() => entered, 1000, 'approval entered'); await f.service.setAppPolicy({ blocked_apps: ['Notes'] });
  reply.resolve({ action: 'accept' }); await rejected;
  await f.service.setAppPolicy({ blocked_apps: [] }); const next = await f.service.approve(notes, f.context());
  strict.equal(f.prompts.length, 1); f.service.release(next);
});
h.test('the always-allow card can persist its choice before resolving the pending approval', async () => {
  const f = fixture();
  const lease = await f.service.approve(notes, f.context('a', async () => {
    f.service.addAllowedApp({ app: 'Notes' }); return { action: 'accept' };
  }));
  f.service.assertCurrent(lease); strict.deepEqual(f.service.get().allowedApps, ['Notes']); f.service.release(lease);
});
h.test('local policy changes abort active leases and external writes are checked before the next action', async () => {
  const f = fixture(); const lease = await f.service.approve(notes, f.context());
  await f.service.setAppPolicy({ blocked_apps: ['Mail'] }); strict.equal(lease.signal.aborted, true);
  strict.throws(() => f.service.assertCurrent(lease), /unavailable/); f.service.release(lease);
  const next = await f.service.approve(notes, f.context()); f.put('computer_use.denied_apps', '["Notes"]');
  strict.throws(() => f.service.assertCurrent(next), /blocked/); f.service.release(next);
});
h.test('detach waits for entered elicitation and rejects a late acceptance', async () => {
  const f = fixture(), reply = deferred<unknown>(); let entered = false, aborted = false;
  const pending = f.service.approve(notes, f.context('a', async (_request, signal) => {
    entered = true; signal.addEventListener('abort', () => { aborted = true; }); return reply.promise;
  }));
  const rejected = strict.rejects(pending, /cancelled|unavailable/);
  await waitFor(() => entered, 1000, 'approval entered'); strict.deepEqual(await f.service.detachSession('a', 5), { complete: false });
  strict.equal(aborted, true); strict.throws(() => f.service.attachSession('a'), /detaching/);
  reply.resolve({ action: 'accept' }); await rejected; strict.deepEqual(await f.service.detachSession('a'), { complete: true });
  f.service.attachSession('a'); const lease = await f.service.approve(notes, f.context()); f.service.release(lease);
});
h.test('an entered native lease must be released before owner replacement can complete', async () => {
  const f = fixture(); const old = await f.service.approve(notes, f.context());
  strict.deepEqual(await f.service.detachSession('a', 0), { complete: false }); strict.equal(old.signal.aborted, true);
  f.service.release(old); f.service.release(old); strict.deepEqual(await f.service.detachSession('a'), { complete: true });
  f.service.attachSession('a'); const next = await f.service.approve(notes, f.context());
  strict.notEqual(next.generation, old.generation); strict.notEqual(next.resourceId, old.resourceId);
  strict.equal(f.prompts.length, 2); f.service.release(next);
});
h.test('declined or already-cancelled calls never acquire an approval cache entry', async () => {
  const f = fixture();
  await strict.rejects(f.service.approve(notes, f.context('a', async () => ({ action: 'decline' }))), /decline/);
  const context = f.context(), cancelled = new AbortController(); cancelled.abort();
  await strict.rejects(f.service.approve(notes, { ...context, signal: cancelled.signal }), /cancelled/);
  const lease = await f.service.approve(notes, f.context()); strict.equal(f.prompts.length, 1); f.service.release(lease);
});
h.test('enabled reconciliation is serialized and disable takes effect before runtime acknowledgement', async () => {
  const first = deferred(), seen: boolean[] = [];
  const f = fixture({ enabledChanged: async enabled => { seen.push(enabled); if (!enabled) await first.promise; } });
  const disable = f.service.setEnabled({ enabled: false }), enable = f.service.setEnabled({ enabled: true });
  await waitFor(() => seen.length === 1, 1000, 'disable entered'); strict.equal(f.service.get().enabled, false);
  await strict.rejects(f.service.approve(notes, f.context()), /disabled/); strict.deepEqual(seen, [false]);
  first.resolve(); strict.equal((await disable).ok, true); strict.equal((await enable).ok, true);
  strict.deepEqual(seen, [false, true]); strict.equal(f.service.get().enabled, true);
});
h.test('failed runtime reconciliation reports the persisted state without claiming success', async () => {
  const f = fixture({ enabledChanged: async () => { throw new Error('fixture-reconcile-failed'); } });
  const result = await f.service.setEnabled({ enabled: false });
  strict.equal(result.ok, false); strict.equal(result.settings.enabled, false); strict.match(result.error!, /was saved.*fixture-reconcile-failed/);
  strict.equal(f.service.get().enabled, false);
});
h.test('close waits for an entered runtime callback and cancels queued mutations', async () => {
  const gate = deferred(); let entered = false, aborted = false;
  const f = fixture({ enabledChanged: async (_enabled, signal) => { entered = true; signal.addEventListener('abort', () => { aborted = true; }); await gate.promise; } });
  const first = f.service.setEnabled({ enabled: false }), queued = f.service.setEnabled({ enabled: true });
  const rejected = strict.rejects(queued, /closed/); await waitFor(() => entered, 1000, 'runtime callback entered');
  strict.deepEqual(await f.service.close(5), { complete: false }); strict.equal(aborted, true);
  gate.resolve(); strict.equal((await first).ok, false); await rejected;
  strict.deepEqual(await f.service.close(), { complete: true }); strict.equal(f.service.get().enabled, false);
});
h.test('unavailable auto-unlock and malformed lists leave every requested policy field unchanged', async () => {
  const f = fixture(); f.put('computer_use.auto_unlock', '1'); const before = f.stored();
  for (const payload of [{ blocked_apps: 'Notes' }, { restricted_to_apps: [1] }, { blocked_apps: ['Notes'], auto_unlock: true }, { auto_unlock: false }]) {
    strict.throws(() => f.service.setAppPolicy(payload)); strict.deepEqual(f.stored(), before);
  }
  strict.match(await f.service.describePolicy(), /unavailable on this platform/);
});
h.test('auto-unlock uses existing keychain presence and disarms before an entered deletion completes', async () => {
  let present = true, prompts = 0, removed = false; const deletion = deferred();
  const f = fixture({ loginPassword: { available: () => true, hasPassword: async () => present,
    prompt: async () => { prompts++; throw new Error('existing password must not prompt'); },
    remove: async () => { removed = true; await deletion.promise; present = false; } } });
  await f.service.setAppPolicy({ auto_unlock: true }); strict.equal(f.service.autoUnlockEnabled(), true); strict.equal(prompts, 0);
  strict.match(await f.service.describePolicy(), /armed, login password stored in the keychain/);
  const disable = f.service.setAppPolicy({ auto_unlock: false });
  await waitFor(() => removed, 1000, 'native deletion entered'); strict.equal(f.service.autoUnlockEnabled(), false);
  deletion.resolve(); strict.match((await disable).notes.join(' '), /deleted/); strict.equal(present, false);
  strict.match(await f.service.describePolicy(), /auto-unlock: off/);
});
h.test('password dialog cancellation preserves auto-unlock intent and applies the requested app lists', async () => {
  let prompts = 0, deleted = 0;
  const f = fixture({ loginPassword: { available: () => true, hasPassword: async () => false,
    prompt: async () => { prompts++; return { cancelled: true, created: false, discard: async () => { deleted++; } }; },
    remove: async () => { deleted++; } } });
  const result = await f.service.setAppPolicy({ auto_unlock: true, blocked_apps: ['Mail'] });
  strict.equal(f.service.autoUnlockEnabled(), false); strict.deepEqual(result.settings.deniedApps, ['Mail']);
  strict.match(result.notes.join(' '), /cancelled.*unchanged/); strict.equal(prompts, 1); strict.equal(deleted, 0);
});
h.test('a cancelled late prompt result cannot arm auto-unlock and discards only its new credential', async () => {
  const reply = deferred<{ cancelled: boolean; created: boolean; discard(): Promise<void> }>();
  let entered = false, discarded = 0; const abort = new AbortController();
  const f = fixture({ loginPassword: { available: () => true, hasPassword: async () => false,
    prompt: async () => { entered = true; return reply.promise; }, remove: async () => { strict.fail('must not delete the fixed account without ownership'); } } });
  const task = f.service.setAppPolicy({ auto_unlock: true }, abort.signal), rejected = strict.rejects(task, /cancelled/);
  await waitFor(() => entered, 1000, 'native prompt entered'); abort.abort(new Error('turn cancelled'));
  reply.resolve({ cancelled: false, created: true, discard: async () => { discarded++; } });
  await rejected; strict.equal(f.service.autoUnlockEnabled(), false); strict.equal(discarded, 1);
});
h.test('disarm cancels an in-flight prompt before the serialized policy can be armed', async () => {
  const entered = deferred(), reply = deferred<{ cancelled: boolean; created: boolean; discard(): Promise<void> }>();
  let nativeAborted = false, deleted = 0, discarded = 0;
  const f = fixture({ loginPassword: { available: () => true, hasPassword: async () => false,
    prompt: async signal => { signal.addEventListener('abort', () => { nativeAborted = true; }); entered.resolve(); return reply.promise; },
    remove: async () => { deleted++; } } });
  const enable = f.service.setAppPolicy({ auto_unlock: true }), rejected = strict.rejects(enable, /disarmed/); await entered.promise;
  const disable = f.service.setAppPolicy({ auto_unlock: false }); strict.equal(nativeAborted, true);
  reply.resolve({ cancelled: false, created: true, discard: async () => { discarded++; } });
  await rejected; await disable; strict.equal(discarded, 1); strict.equal(deleted, 1); strict.equal(f.service.autoUnlockEnabled(), false);
});
h.test('disarm supersedes a queued enable before it can display a late password prompt', async () => {
  let prompts = 0, deleted = 0;
  const f = fixture({ loginPassword: { available: () => true, hasPassword: async () => false,
    prompt: async () => { prompts++; throw new Error('superseded enable must not prompt'); }, remove: async () => { deleted++; } } });
  const enable = f.service.setAppPolicy({ auto_unlock: true }), rejected = strict.rejects(enable, /superseded/);
  const disable = f.service.setAppPolicy({ auto_unlock: false }); await rejected; await disable;
  strict.equal(prompts, 0); strict.equal(deleted, 1); strict.equal(f.service.autoUnlockEnabled(), false);
});
h.test('an already-cancelled update cannot supersede another task pending password choice', async () => {
  const entered = deferred(), reply = deferred<{ cancelled: boolean; created: boolean; discard(): Promise<void> }>();
  let aborted = false;
  const f = fixture({ loginPassword: { available: () => true, hasPassword: async () => false,
    prompt: async signal => { signal.addEventListener('abort', () => { aborted = true; }); entered.resolve(); return reply.promise; },
    remove: async () => { strict.fail('cancelled update must not delete a credential'); } } });
  const enable = f.service.setAppPolicy({ auto_unlock: true }); await entered.promise;
  const cancelled = new AbortController(); cancelled.abort(new Error('already cancelled'));
  strict.throws(() => f.service.setAppPolicy({ auto_unlock: false }, cancelled.signal), /already cancelled/);
  strict.equal(aborted, false);
  reply.resolve({ cancelled: false, created: true, discard: async () => { strict.fail('current choice must not be discarded'); } });
  await enable; strict.equal(f.service.autoUnlockEnabled(), true);
});
h.test('a failed durable enable removes only the new credential and never an existing password', async () => {
  for (const existing of [false, true]) {
    let discarded = 0, prompted = 0;
    const f = fixture({ loginPassword: { available: () => true, hasPassword: async () => existing,
      prompt: async () => { prompted++; return { cancelled: false, created: true, discard: async () => { discarded++; } }; },
      remove: async () => { strict.fail('an enable failure cannot delete a preexisting credential'); } } });
    withSettingsDb(f.root, db => db.exec("CREATE TRIGGER fail_enable BEFORE INSERT ON settings WHEN NEW.key = 'computer_use.auto_unlock' BEGIN SELECT RAISE(ABORT, 'fixture-enable-failed'); END"));
    await strict.rejects(f.service.setAppPolicy({ auto_unlock: true }), /fixture-enable-failed/);
    strict.equal(f.service.autoUnlockEnabled(), false); strict.equal(prompted, existing ? 0 : 1); strict.equal(discarded, existing ? 0 : 1);
  }
});
h.test('shutdown waits for the password prompt cleanup and rejects its late success', async () => {
  const entered = deferred(), reply = deferred<{ cancelled: boolean; created: boolean; discard(): Promise<void> }>();
  let cancelled = false, discarded = false;
  const f = fixture({ loginPassword: { available: () => true, hasPassword: async () => false,
    prompt: async signal => { signal.addEventListener('abort', () => { cancelled = true; }); entered.resolve(); return reply.promise; }, remove: async () => {} } });
  const task = f.service.setAppPolicy({ auto_unlock: true }), rejected = strict.rejects(task, /closed/); await entered.promise;
  strict.deepEqual(await f.service.close(5), { complete: false }); strict.equal(cancelled, true);
  reply.resolve({ cancelled: false, created: true, discard: async () => { discarded = true; } });
  await rejected; strict.equal(discarded, true); strict.equal(f.service.autoUnlockEnabled(), false);
  strict.deepEqual(await f.service.close(), { complete: true });
});
h.test('a failed password deletion keeps auto-unlock disarmed and reports the failure', async () => {
  const f = fixture({ loginPassword: { available: () => true, hasPassword: async () => true,
    prompt: async () => { throw new Error('unexpected prompt'); }, remove: async () => { throw new Error('fixture-keychain-denied'); } } });
  f.put('computer_use.auto_unlock', '1');
  await strict.rejects(f.service.setAppPolicy({ auto_unlock: false }), /fixture-keychain-denied/);
  strict.equal(f.service.autoUnlockEnabled(), false);
});
h.test('saved approval settings channels are limited to the main renderer', async () => {
  const f = fixture(), registry = new ChannelRegistry(); registerComputerUseSettingsHandlers(registry, f.service);
  strict.equal(registry.size(), 6); const router = new IpcRouter({ registry, roles: RoleTable.load() });
  strict.equal((await router.route({ role: 'main', senderId: 10, senderFrameIsTop: true }, 'settings:computer-use:get', [])).ok, true);
  for (const role of ['canvas', 'recorder', 'quick-input']) {
    strict.equal((await router.route({ role, senderId: 10, senderFrameIsTop: true }, 'settings:computer-use:set-enabled', [{ enabled: false }])).ok, false);
    strict.equal((await router.route({ role, senderId: 10, senderFrameIsTop: true }, 'settings:computer-use:remove-allowed-app', [{ app: 'Notes' }])).ok, false);
    strict.equal((await router.route({ role, senderId: 10, senderFrameIsTop: true }, 'settings:computer-use:app-details', [{ app: 'Notes' }])).ok, false);
    strict.equal((await router.route({ role, senderId: 10, senderFrameIsTop: true }, 'settings:computer-use:list-apps', [])).ok, false);
  }
  strict.equal(f.service.get().enabled, true);
});

h.test('legacy saved apps waive questions without excluding other applications', async () => {
  const f = fixture(); f.put('computer_use.allowed_apps', '["LM Studio","Shadowrocket"]');
  const before = f.stored();
  const saved = await f.service.approve({ input: 'LM Studio', name: 'LM Studio' }, f.context()); f.service.release(saved);
  strict.equal(f.prompts.length, 0);
  const other = await f.service.approve(notes, f.context()); f.service.release(other);
  strict.equal(f.prompts.length, 1); strict.deepEqual(f.stored(), before);
});
h.test('removal revokes session approvals and leases, preserves other settings and survives a reload', async () => {
  const f = fixture();
  await f.service.setAppPolicy({ always_allowed_apps: ['Notes', 'Safari'], blocked_apps: ['Terminal'] });
  f.put('computer_use.auto_unlock', '1');
  const lease = await f.service.approve(notes, f.context());
  strict.equal(f.prompts.length, 0);
  const removed = f.service.removeAllowedApp({ app: 'Notes' });
  strict.deepEqual(removed.settings.allowedApps, ['Safari']);
  strict.equal(lease.signal.aborted, true); f.service.release(lease);
  const next = await f.service.approve(notes, f.context()); f.service.release(next);
  strict.equal(f.prompts.length, 1);
  f.service.removeAllowedApp({ app: 'Safari' });
  strict.deepEqual(f.service.removeAllowedApp({ app: 'Safari' }).settings.allowedApps, []);
  strict.deepEqual(f.service.get().deniedApps, ['Terminal']);
  strict.equal(f.service.autoUnlockEnabled(), true);
  const reopened = new ComputerUsePolicyService({ configRoot: f.root, availability: () => ({ available: true }), enabledChanged: async () => {} });
  strict.deepEqual(reopened.get().allowedApps, []); await reopened.close();
});
h.test('a failed removal leaves the saved approval and active lease intact', async () => {
  const f = fixture(); f.service.addAllowedApp({ app: 'Notes' });
  const lease = await f.service.approve(notes, f.context());
  withSettingsDb(f.root, db => db.exec("CREATE TRIGGER fail_remove BEFORE UPDATE ON settings WHEN NEW.key = 'computer_use.allowed_apps' BEGIN SELECT RAISE(ABORT, 'fixture-delete-failed'); END"));
  strict.throws(() => f.service.removeAllowedApp({ app: 'Notes' }), /fixture-delete-failed/);
  strict.deepEqual(f.service.get().allowedApps, ['Notes']); f.service.assertCurrent(lease); f.service.release(lease);
});
h.test('app metadata deduplicates requests and bounds cache and pending work', async () => {
  let calls = 0;
  const gate = deferred<{ name: string }>();
  const details = new ComputerUseAppDetails(async selector => { calls++; if (selector === 'slow') return gate.promise; return { name: selector }; });
  const first = details.get('slow'), duplicate = details.get('slow');
  strict.equal(first, duplicate); gate.resolve({ name: 'Slow' }); await first;
  strict.deepEqual(await details.get('slow'), { name: 'Slow' }); strict.equal(calls, 1);
  for (let index = 0; index < 129; index++) await details.get(`app-${index}`);
  await details.get('slow'); strict.equal(calls, 131);
  const held = deferred<{ name: string }>();
  const limited = new ComputerUseAppDetails(async () => held.promise);
  const pending = ['a', 'b', 'c', 'd'].map(app => limited.get(app));
  await strict.rejects(limited.get('e'), /busy/);
  held.resolve({ name: 'Done' }); await Promise.all(pending);
});


h.test('a friend task grant overrides global disable and allow choices without mutating either setting', async () => {
  const scope = { active: true, apps: ['bundle:com.apple.Notes'] };
  const f = fixture({ taskScope: id => id === 'a' ? scope : undefined });
  await f.service.setEnabled({ enabled: false });
  await f.service.setAppPolicy({ restricted_to_apps: ['Mail'] });
  strict.equal(f.service.get().enabled, false);
  strict.deepEqual(f.service.get().allowedApps, ['Mail']);
  strict.deepEqual(f.service.sessionSettings('a').allowedApps, scope.apps);
  const lease = await f.service.approve(notes, f.context());
  strict.equal(f.prompts.length, 0); f.service.assertCurrent(lease); f.service.release(lease);
  await strict.rejects(f.service.approve(notes, f.context('b')), /disabled/);
  await strict.rejects(f.service.approve({ input: 'Mail', bundleId: 'com.apple.Mail', path: '/Applications/Mail.app' }, f.context()), /only allowed/);
  await f.service.setAppPolicy({ blocked_apps: ['Notes'] });
  await strict.rejects(f.service.approve(notes, f.context()), /blocked/);
});
h.test('friend task scope ignores corrupt global allow data but still fails closed on corrupt deny policy', async () => {
  const f = fixture({ taskScope: () => ({ active: true, apps: ['bundle:com.apple.Notes'] }) });
  f.put('computer_use.allowed_apps', 'corrupt');
  const lease = await f.service.approve(notes, f.context()); f.service.release(lease);
  f.put('computer_use.denied_apps', 'corrupt');
  strict.throws(() => f.service.guardInput('a', 'Notes'), /unreadable/);
});
h.test('task selectors reject names, self-app inheritance and substring matches', async () => {
  let scope: ComputerUseTaskScope | undefined = { active: true, apps: ['bundle:com.apple.Notes'] };
  const f = fixture({ taskScope: () => scope }, false);
  strict.equal(computerUseTaskAppMatches(notes, ['Notes', 'app:self', 'bundle:com.apple']), false);
  strict.equal(computerUseTaskAppMatches({ ...notes, bundleId: 'com.apple.Notes.helper' }, scope!.apps), false);
  scope = { active: true, apps: ['app:self'] };
  strict.throws(() => f.service.guardInput('a', 'Klaus'), /exact bundle or path/);
  scope = { active: true, apps: [] };
  strict.throws(() => f.service.guardInput('a', 'Notes'), /inactive|no approved/);
  scope = { active: false, apps: ['bundle:com.apple.Notes'] };
  strict.throws(() => f.service.guardInput('a', 'Notes'), /inactive/);
  scope = undefined;
  strict.throws(() => f.service.guardInput('a', 'Notes'), /inactive/);
});
h.test('exact path selectors do not expand to child paths or similarly named apps', () => {
  const f = fixture(), path = join(f.root, 'Selected.app'); mkdirSync(path);
  const canonical = realpathSync.native(path), app = { input: 'Selected', path: canonical };
  strict.equal(computerUseTaskAppMatches(app, ['path:' + canonical]), true);
  strict.equal(computerUseTaskAppMatches({ ...app, path: canonical + '.impostor' }, ['path:' + canonical]), false);
  strict.equal(computerUseTaskAppMatches({ ...app, path: join(canonical, 'Child.app') }, ['path:' + canonical]), false);
  strict.equal(computerUseAppMatches(app, ['path:' + canonical]), true);
});
h.test('revoking a task aborts its old lease permanently and restored scope requires a fresh lease', async () => {
  let scope: ComputerUseTaskScope | undefined = { active: true, apps: ['bundle:com.apple.Notes'] };
  const f = fixture({ taskScope: () => scope });
  const lease = await f.service.approve(notes, f.context());
  scope = { active: false, apps: [] };
  strict.throws(() => f.service.assertCurrent(lease), /authorization changed/);
  strict.equal(lease.signal.aborted, true);
  scope = { active: true, apps: ['bundle:com.apple.Notes'] };
  strict.throws(() => f.service.assertCurrent(lease), /unavailable/); f.service.release(lease);
  const next = await f.service.approve(notes, f.context()); f.service.release(next);
});
h.test('friend policy descriptions never query login-password presence or disclose global app policy', async () => {
  let secretReads = 0;
  const f = fixture({ taskScope: () => ({ active: true, apps: ['bundle:com.apple.Notes'] }), loginPassword: {
    available: () => true, hasPassword: async () => { secretReads++; return true; },
    prompt: async () => ({ cancelled: true, created: false, discard: async () => {} }), remove: async () => {},
  } });
  f.put('computer_use.auto_unlock', '1'); f.put('computer_use.denied_apps', '["private-global-denial"]');
  const description = await f.service.describeSessionPolicy('a', new AbortController().signal);
  strict.match(description, /bundle:com.apple.Notes/); strict.match(description, /auto-unlock: disabled/);
  strict.equal(description.includes('private-global-denial'), false); strict.equal(secretReads, 0);
});


h.test('a friend cannot self-authorize through Klaus or an alias of the host executable', async () => {
  const executable = realpathSync.native(process.execPath), application = process.platform === 'darwin' ? executable.replace(/\/Contents\/MacOS\/[^/]+$/, '') : executable;
  const f = fixture({ taskScope: () => ({ active: true, apps: ['bundle:ai.klaus.desktop', 'bundle:com.apple.Notes', 'path:' + application] }) });
  strict.throws(() => f.service.guardInput('a', 'Klaus'), /cannot operate Klaus/);
  await strict.rejects(f.service.approve({ input: 'Alias', name: 'Alias', bundleId: 'ai.klaus.desktop', path: '/Applications/Alias.app', pid: 99 }, f.context()), /cannot operate Klaus/);
  await strict.rejects(f.service.approve({ ...notes, pid: process.pid }, f.context()), /cannot operate Klaus/);
  await strict.rejects(f.service.approve({ input: 'Alias', name: 'Alias', path: application }, f.context()), /cannot operate Klaus/);
  strict.equal(f.prompts.length, 0);
});

h.test('governance vectors pin the safety list and the refusal wording', () => {
  const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/computer-use-governance-vectors.json'), 'utf8'));
  strict.deepEqual(vector.safetyForbiddenBundleIds, [...COMPUTER_USE_SAFETY_FORBIDDEN_BUNDLE_IDS]);
  strict.equal(vector.messages.organizationDisabled, COMPUTER_USE_GOVERNANCE_MESSAGES.organizationDisabled);
  strict.equal(vector.messages.organizationBlockedApp.replace('{app}', 'Notes'), COMPUTER_USE_GOVERNANCE_MESSAGES.organizationBlockedApp('Notes'));
  strict.equal(vector.messages.safetyForbiddenApp.replace('{app}', 'Dock'), COMPUTER_USE_GOVERNANCE_MESSAGES.safetyForbiddenApp('Dock'));
});

h.test('system safety surfaces are refused everywhere and cannot be saved as allowed apps', async () => {
  const f = fixture();
  const dock = { input: 'Dock', name: 'Dock', bundleId: 'com.apple.dock', path: '/System/Library/CoreServices/Dock.app', pid: 300 };
  strict.throws(() => f.service.guardInput('a', 'com.apple.dock'), /for safety reasons/);
  strict.throws(() => f.service.guardInput('a', 'bundle:com.apple.dock'), /for safety reasons/);
  await strict.rejects(f.service.approve(dock, f.context()), /not allowed to use the app 'Dock' for safety reasons/);
  await strict.rejects(f.service.approve({ input: 'helper', bundleId: 'com.klaus.computer-use-helper' }, f.context()), /for safety reasons/);
  strict.throws(() => f.service.addAllowedApp({ app: 'bundle:com.apple.dock' }), /for safety reasons/);
  strict.throws(() => f.service.setAppPolicy({ always_allowed_apps: ['bundle:com.apple.controlcenter'] }), /for safety reasons/);
  strict.equal(f.prompts.length, 0);
  strict.equal(f.stored()['computer_use.allowed_apps'], '[]');
});

h.test('an organization policy blocks everything and cannot be overridden locally', async () => {
  let snapshot: ManagedPolicySnapshot = { status: 'absent' };
  const f = fixture({ managedPolicy: () => snapshot });
  strict.equal(f.service.get().managedDisabled, false);
  snapshot = { status: 'active', policy: { computerUseEnabled: false, computerHistoryEnabled: true, blockedApps: [] } };
  strict.equal(f.service.get().enabled, false);
  strict.equal(f.service.get().managedDisabled, true);
  strict.throws(() => f.service.guardSession('a'), /blocked by your organization's policy/);
  await strict.rejects(f.service.approve(notes, f.context()), /organization's policy/);
  strict.equal(f.prompts.length, 0);
  const attempt = await f.service.setEnabled({ enabled: true });
  strict.equal(attempt.ok, false); strict.match(String(attempt.error), /organization's policy/);
  strict.equal(f.stored()['computer_use.enabled'], undefined, 'a refused enable never writes the preference');
  strict.equal((await f.service.setEnabled({ enabled: false })).ok, true);
  strict.match(await f.service.describePolicy(), /Organization policy: Computer Use is blocked by your organization's policy\./);
});

h.test('an organization app block wins over saved always-allowed entries and task grants', async () => {
  const snapshot: ManagedPolicySnapshot = { status: 'active', policy: { computerUseEnabled: true, computerHistoryEnabled: true, blockedApps: ['bundle:com.apple.Notes', 'Safari'] } };
  const f = fixture({ managedPolicy: () => snapshot });
  f.service.addAllowedApp({ app: 'Notes' });
  await strict.rejects(f.service.approve(notes, f.context()), /blocked from using the app 'Notes' by your organization's policy/);
  strict.throws(() => f.service.guardInput('a', 'Safari'), /blocked from using the app 'Safari' by your organization's policy/);
  strict.equal(f.prompts.length, 0);
  strict.match(await f.service.describePolicy(), /Organization-blocked apps \(never operated\): bundle:com\.apple\.Notes, Safari/);
  const other = { input: 'Mail', name: 'Mail', bundleId: 'com.apple.Mail', path: '/Applications/Mail.app', pid: 43 };
  const lease = await f.service.approve(other, f.context()); f.service.release(lease);
  strict.equal(f.prompts.length, 1, 'unblocked apps keep the ordinary approval flow');
});

h.test('an unreadable organization policy fails closed until repaired', async () => {
  let snapshot: ManagedPolicySnapshot = { status: 'unreadable', error: MANAGED_COMPUTER_USE_UNREADABLE };
  const f = fixture({ managedPolicy: () => snapshot });
  strict.equal(f.service.get().enabled, false);
  strict.equal(f.service.get().managedDisabled, true);
  strict.throws(() => f.service.guardSession('a'), /unreadable/);
  const attempt = await f.service.setEnabled({ enabled: true });
  strict.equal(attempt.ok, false); strict.match(String(attempt.error), /unreadable/);
  snapshot = { status: 'absent' };
  strict.equal(f.service.get().enabled, true);
  strict.equal(f.service.get().managedDisabled, false);
});

h.test('friend task authorization cannot bypass an organization disable', () => {
  const snapshot: ManagedPolicySnapshot = { status: 'active', policy: { computerUseEnabled: false, computerHistoryEnabled: true, blockedApps: [] } };
  const f = fixture({ managedPolicy: () => snapshot, taskScope: () => ({ active: true, apps: ['bundle:com.apple.Notes'] }) });
  strict.equal(f.service.sessionSettings('a').enabled, false);
  strict.equal(f.service.sessionSettings('a').managedDisabled, true);
  strict.throws(() => f.service.guardSession('a'), /organization's policy/);
});

h.test('a mid-session organization change voids live leases', async () => {
  let snapshot: ManagedPolicySnapshot = { status: 'absent' };
  const f = fixture({ managedPolicy: () => snapshot });
  const lease = await f.service.approve(notes, f.context());
  snapshot = { status: 'active', policy: { computerUseEnabled: true, computerHistoryEnabled: true, blockedApps: ['bundle:com.apple.Notes'] } };
  strict.throws(() => f.service.assertCurrent(lease), /organization's policy/);
  f.service.release(lease);
});

h.test('approval questions are recorded in the local usage ledger', async () => {
  const events: Array<Record<string, unknown>> = [];
  const f = fixture({ telemetry: { record: event => events.push(event) } });
  const lease = await f.service.approve(notes, { ...f.context('a', async () => ({ action: 'accept' })), toolName: 'get_app_state' });
  f.service.release(lease);
  strict.deepEqual(events.map(event => event.event), ['computer_use_app_approval_requested', 'computer_use_app_approval_resolved']);
  strict.equal(events[0]!.app, 'Notes'); strict.equal(events[0]!.bundleIdentifier, 'com.apple.Notes');
  strict.equal(events[0]!.toolName, 'get_app_state'); strict.equal(events[0]!.sessionId, 'a');
  strict.equal(events[1]!.approvalResult, 'accepted');
  events.length = 0;
  f.service.addAllowedApp({ app: 'Safari' });
  const safari = { input: 'Safari', name: 'Safari', bundleId: 'com.apple.Safari', path: '/Applications/Safari.app', pid: 43 };
  const saved = await f.service.approve(safari, { ...f.context(), toolName: 'click' }); f.service.release(saved);
  strict.equal(events.length, 0, 'a saved app never asks, so nothing is recorded');
  const mail = { input: 'Mail', name: 'Mail', bundleId: 'com.apple.Mail', path: '/Applications/Mail.app', pid: 44 };
  events.length = 0;
  await strict.rejects(f.service.approve(mail, { ...f.context('b', async () => ({ action: 'decline' })), toolName: 'type_text' }), /was decline/);
  strict.deepEqual(events.map(event => event.event), ['computer_use_app_approval_requested', 'computer_use_app_approval_resolved']);
  strict.equal(events[1]!.approvalResult, 'decline'); strict.equal(events[1]!.toolName, 'type_text');
  events.length = 0;
  await strict.rejects(f.service.approve({ ...mail, pid: 45 }, { ...f.context('b', async () => { throw new Error('gone'); }), toolName: 'click' }), /gone/);
  strict.equal(events.at(-1)!.approvalResult, 'cancelled');
});

void h.finish(join(__dirname, 'computer-use-policy-results.json'), 'computer-use-policy').then(async code => {
  for (const f of fixtures) {
    const report = await f.service.close(50);
    if (!report.complete) { console.error(`Computer Use fixture cleanup incomplete: ${f.root}`); code = 1; }
    else rmSync(f.root, { recursive: true, force: true });
  }
  process.exitCode = code;
});
