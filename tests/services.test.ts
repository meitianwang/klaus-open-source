// Local-state services preserve settings, account status and isolated test profiles.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assert, assertDeepEqual, assertEqual, Harness } from './harness';
import { errorMessage } from '../main/services/service-types';
import { configRootFrom, expandHomePrefix, homeFrom } from '../main/services/config-root';
import { guestModeActive, isLoggedIn, klausAuthStatus, readStoredAuth } from '../main/services/auth';
import { AUTH_MODES, DEFAULT_AUTH_MODE } from '../main/services/model-sources';
import { isFailure, kvDel, kvGet, kvOpt, kvSet, kvSnapshot, settingsDbPath } from '../main/services/settings';
import { registerServiceHandlerTests } from './service-handlers';
import { registerUsageCacheTests } from './usage-cache';

const h = new Harness();

/** A throwaway config root, removed when the suite finishes. */
const roots: string[] = [];
function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'klaus-services-'));
  roots.push(root);
  return root;
}

function cleanup(): void {
  for (const root of roots) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A temp dir that will not delete is the OS's problem, not a test failure.
    }
  }
}

// The isolation guard must be armed before anything resolves a root.
process.env.KLAUS_TEST = '1';

// ---------------------------------------------------------------------------
// 1. Config root.
// ---------------------------------------------------------------------------

h.test('the config root follows KLAUS_CONFIG_DIR, and is NOT trimmed', () => {
  const root = freshRoot();
  assertEqual(configRootFrom({ KLAUS_CONFIG_DIR: root, HOME: '/Users/t' }), root, 'the override wins');
  assertEqual(configRootFrom({ HOME: '/Users/t' }), join('/Users/t', '.klaus'), 'no override: ~/.klaus');

  // The asymmetry that must survive a tidy-up: config_root filters on !is_empty() only
  // (main.rs:3147-3149), while the ENGINE's env inheritance trims
  // (klaus-host-core/src/pool.rs:53-58). Mirroring only one of them would put the host and
  // the engine child it spawns on different profiles.
  const spaced = configRootFrom({ KLAUS_CONFIG_DIR: '   ', HOME: '/Users/t' });
  assertEqual(spaced, '   ', 'a whitespace-only override is taken literally, not trimmed');
  assert(spaced !== join('/Users/t', '.klaus'), 'and is therefore not the default');

  // Empty and unset both fall back to the default.
  assertEqual(configRootFrom({ KLAUS_CONFIG_DIR: '', HOME: '/Users/t' }), join('/Users/t', '.klaus'), 'empty falls back');
  assertEqual(configRootFrom({ HOME: '/Users/t' }), join('/Users/t', '.klaus'), 'unset falls back');
});

h.test('a ~ prefix in the override is expanded against home', () => {
  assertEqual(configRootFrom({ KLAUS_CONFIG_DIR: '~/cfg', HOME: '/Users/t' }), join('/Users/t', 'cfg'), '~/cfg');
  assertEqual(configRootFrom({ KLAUS_CONFIG_DIR: '~', HOME: '/Users/t' }), '/Users/t', 'bare ~');
  // With no home available, expand_home_prefix returns None and config_root_override
  // propagates that as "no override" (main.rs:3151-3158), so the DEFAULT applies rather than
  // a directory literally named "~". With HOME empty there is no home at all, so the shell
  // falls back to the process directory plus a loud stderr line (main.rs:3211-3217).
  assertEqual(
    configRootFrom({ KLAUS_CONFIG_DIR: '~/cfg', HOME: '' }),
    join('.', '.klaus'),
    'no home: the override cannot expand, so the default applies',
  );
});

h.test('home resolution follows the shell order, including the Windows trio', () => {
  assertEqual(homeFrom({ HOME: '/Users/t' }), '/Users/t', 'HOME first');
  assertEqual(homeFrom({ HOME: '/a', USERPROFILE: 'C:\\b' }), '/a', 'HOME beats USERPROFILE');
  assertEqual(homeFrom({ USERPROFILE: 'C:\\b' }), 'C:\\b', 'USERPROFILE when no HOME');
  assertEqual(homeFrom({ HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\t' }), 'C:\\Users\\t', 'drive+path');
  // The pair only counts when BOTH are present (main.rs:3166-3171).
  assertEqual(homeFrom({ HOMEDRIVE: 'C:' }), undefined, 'drive alone is not a home');
  assertEqual(homeFrom({ HOMEPATH: '\\Users\\t' }), undefined, 'path alone is not a home');
  // Empty values are skipped, not treated as a home.
  assertEqual(homeFrom({ HOME: '', USERPROFILE: 'C:\\b' }), 'C:\\b', 'an empty HOME is skipped');
});

h.test('expandHomePrefix matches klaus_host_core, including its platform-dependent rule', () => {
  // lib.rs:17-25. Three cases: no "~" component -> Some(path) unchanged; "~" with a home ->
  // Some(home.join(suffix)); "~" with NO home -> None. The last is the one that matters:
  // echoing "~/cfg" instead would make the host open a directory named "~" under the
  // working directory, and report no problem doing it.
  assertEqual(expandHomePrefix('/abs/path', '/Users/t'), '/abs/path', 'absolute unchanged');
  assertEqual(expandHomePrefix('relative', '/Users/t'), 'relative', 'relative unchanged');
  assertEqual(expandHomePrefix('~', '/Users/t'), '/Users/t', 'bare ~ becomes the home');
  assertEqual(expandHomePrefix('~/x', '/Users/t'), '/Users/t/x', '~/x is expanded');
  assertEqual(expandHomePrefix('~/x', undefined), undefined, 'no home -> None, NOT the literal value');

  // It is a path COMPONENT test, not a string prefix test: ~x and ~user are ordinary names.
  assertEqual(expandHomePrefix('~x', '/Users/t'), '~x', '~x is not a ~ component');
  assertEqual(expandHomePrefix('~user/x', '/Users/t'), '~user/x', 'neither is ~user/x');

  // The separator set is platform-dependent, so "~\x" is ONE component on POSIX (a file
  // name containing a backslash) and a home path on Windows. Both are asserted explicitly
  // rather than left to whatever machine runs the suite — `platform` is a parameter of
  // expandHomePrefix for exactly this reason.
  assertEqual(expandHomePrefix('~\\x', 'C:\\Users\\t', 'darwin'), '~\\x', 'POSIX: a backslash is not a separator');
  assertEqual(expandHomePrefix('~\\x', 'C:\\Users\\t', 'win32'), 'C:\\Users\\t\\x', 'Windows: it is');
  assertEqual(expandHomePrefix('~/x', 'C:\\Users\\t', 'win32'), 'C:\\Users\\t\\x', 'and a forward slash works there too');

  // The join preserves home's separator convention rather than normalising, because the
  // result feeds an environment variable and spawnKey (a rewritten separator would split a
  // process that should be shared).
  const windows = expandHomePrefix('~/x', 'C:\\Users\\t', 'win32');
  assert(windows !== undefined, 'the windows case resolves');
  assert(!windows?.includes('/'), 'no POSIX separator is introduced into a windows path');
});

h.test('configRootFrom refuses to hand a test the real profile', () => {
  // The TypeScript stand-in for the Rust's #[cfg(test)] redirect (main.rs:3189-3209), which
  // exists so "the TEST binary must never fall back to the developer's own ~/.klaus". It is
  // built into configRootFrom rather than offered as a helper a test must remember to call,
  // because a guard that only fires when someone opts in is not a guard.
  //
  // It is precise rather than conservative: only a resolution that IS the real profile
  // throws, which is what makes the home-resolution rules above testable at all.
  const realHome = homeFrom(process.env);

  // A synthetic home is not the real profile, so it resolves normally.
  assertEqual(
    configRootFrom({ HOME: '/Users/synthetic' }),
    join('/Users/synthetic', '.klaus'),
    'a synthetic home resolves normally',
  );
  // No home at all resolves to the process directory, which is also not the real profile.
  assertEqual(configRootFrom({ HOME: '' }), join('.', '.klaus'), 'no home -> the process directory');
  // A throwaway override resolves normally, which is how every other test here works.
  const root = freshRoot();
  assertEqual(configRootFrom({ KLAUS_CONFIG_DIR: root }), root, 'a temp-dir override resolves');

  if (realHome === undefined) {
    h.info('real-profile guard', 'skipped: this machine reports no HOME, so there is no real profile to protect');
    return;
  }

  const realRoot = join(realHome, '.klaus');

  // An override that NAMES the real profile is refused just like no override at all. The
  // running app injects exactly this variable into every shell it spawns, so "an override is
  // present" cannot be treated as proof of isolation — the value has to be checked.
  let overrideThrew = false;
  try {
    configRootFrom({ KLAUS_CONFIG_DIR: realRoot, HOME: realHome });
  } catch {
    overrideThrew = true;
  }
  assertEqual(overrideThrew, true, 'an override that names the real profile is refused');

  // The real profile, resolved from an environment with no override, is refused — and the
  // message names the fix and the directory that would have been touched. The default
  // env (process.env) is used deliberately: it carries the real HOME, which is what makes
  // this resolution land on the real profile rather than on a synthetic one.
  let threw = false;
  let message = '';
  try {
    configRootFrom();
  } catch (error) {
    threw = true;
    message = String(error);
  }
  assertEqual(threw, true, 'resolving the real profile from a test throws');
  assert(message.includes('KLAUS_CONFIG_DIR'), 'the message names the fix');
  assert(message.includes(realHome), 'and the profile it would have touched');

  // The same resolution WITHOUT the test marker is the production path, so it must not
  // throw. Asserting that keeps the guard from leaking into shipped behaviour: it is a
  // test-discipline mechanism, not a runtime policy. Production also resolves the real
  // profile through the injected override, so that value must pass through untouched.
  const savedTest = process.env.KLAUS_TEST;
  const savedEnv = process.env.NODE_ENV;
  try {
    delete process.env.KLAUS_TEST;
    delete process.env.NODE_ENV;
    const resolved = configRootFrom();
    assertEqual(resolved, join(realHome, '.klaus'), 'outside a test run the real profile resolves');
    assertEqual(
      configRootFrom({ KLAUS_CONFIG_DIR: realRoot, HOME: realHome }),
      realRoot,
      'and so does the injected override outside a test run',
    );
  } finally {
    if (savedTest !== undefined) process.env.KLAUS_TEST = savedTest;
    else delete process.env.KLAUS_TEST;
    if (savedEnv !== undefined) process.env.NODE_ENV = savedEnv;
    else delete process.env.NODE_ENV;
  }
});

// ---------------------------------------------------------------------------
// 2. Settings KV.
// ---------------------------------------------------------------------------

h.test('settings round-trips through a real SQLite database', () => {
  const root = freshRoot();
  // A fresh profile has no database yet; opening it creates the schema.
  assertEqual(kvGet('language', root), null, 'a missing key reads as null');
  assertEqual(kvOpt('language', root), undefined, 'and kvOpt distinguishes it as undefined');

  assertEqual(kvSet('language', 'zh', root), true, 'a write succeeds');
  assertEqual(kvGet('language', root), 'zh', 'and reads back');

  // The upsert is on the primary key, so a second write replaces rather than duplicates.
  assertEqual(kvSet('language', 'en', root), true, 'a second write succeeds');
  assertEqual(kvGet('language', root), 'en', 'replacing the value');
  assertDeepEqual(kvSnapshot(root), { language: 'en' }, 'and leaving exactly one row');

  assertEqual(kvDel('language', root), true, 'a delete succeeds');
  assertEqual(kvGet('language', root), null, 'after which the key is gone');

  // The value column is TEXT NOT NULL, so a non-string is stored as its string form
  // rather than rejected — the renderer writes numbers and booleans through this channel.
  assertEqual(kvSet('appearance.ui_font_size', '14', root), true, 'a numeric-looking value');
  assertEqual(kvGet('appearance.ui_font_size', root), '14', 'reads back as text');
});

h.test('the settings schema matches the one the retired shell created', () => {
  // This is the compatibility claim that let two hosts share one profile during the
  // migration window, and it is what keeps an existing ~/.klaus/settings.db readable
  // now. The retired shell's settings.rs declared exactly this table (SCHEMA_DDL;
  // readable through git history — see main/paths.ts), and the real ~/.klaus/settings.db
  // was read back with the same DDL during the Electron probe.
  const root = freshRoot();
  kvSet('probe', '1', root);
  const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
  const db = new DatabaseSync(settingsDbPath(root), { readOnly: true });
  const row = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'settings'").get() as { sql: string };
  db.close();
  assertEqual(row.sql.replace(/\s+/g, ' ').trim(), 'CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL )', 'two columns, TEXT/TEXT');
  assertEqual(settingsDbPath(root), join(root, 'settings.db'), 'and the file is settings.db in the config root');
});

h.test('settings snapshot reads every row', () => {
  const root = freshRoot();
  kvSet('a', '1', root);
  kvSet('b', '2', root);
  kvSet('c', '3', root);
  assertDeepEqual(kvSnapshot(root), { a: '1', b: '2', c: '3' }, 'all three rows');
  kvDel('b', root);
  assertDeepEqual(kvSnapshot(root), { a: '1', c: '3' }, 'and a deleted one is gone');
});

h.test('settings values never surface as a failure envelope by accident', () => {
  // isFailure exists because kvGet can return a string OR a SettingsFailure, and a handler
  // that forgot to check would send the envelope to the renderer as if it were the value.
  const root = freshRoot();
  kvSet('theme', 'dark', root);
  assertEqual(isFailure(kvGet('theme', root)), false, 'a real value is not a failure');
  assertEqual(isFailure(kvGet('nope', root)), false, 'a missing key is not a failure either');
  assertEqual(isFailure({ code: 'SETTINGS_DB_READ_FAILED', message: 'x' }), true, 'an envelope is');
  assertEqual(isFailure(null), false, 'null is not');
  assertEqual(isFailure('text'), false, 'a bare string is not');
});

h.test('settings survives a corrupt database rather than throwing', () => {
  // A handler that throws here becomes a rejecting ipcMain.handle, which Electron turns
  // into "[object Object]" at the renderer — see main/ipc/binding.ts.
  const root = freshRoot();
  mkdirSync(root, { recursive: true });
  writeFileSync(settingsDbPath(root), 'this is not a sqlite database');
  const result = kvGet('language', root);
  assert(isFailure(result), 'a corrupt database is reported as a failure envelope');
  if (isFailure(result)) {
    assert(
      result.code === 'SETTINGS_DB_READ_FAILED' || result.code === 'SETTINGS_DB_OPEN_FAILED',
      `with a settings code, got ${result.code}`,
    );
    assert(result.message.length > 0, 'and a message a developer can act on');
  }
});

// ---------------------------------------------------------------------------
// errorMessage — the last stop before an engine/IPC failure reaches the UI.
// ---------------------------------------------------------------------------

h.test('errorMessage surfaces an Error message', () => {
  assertEqual(errorMessage(new Error('boom')), 'boom', 'a real Error keeps its message');
});

h.test('errorMessage decodes engine RpcError records instead of "[object Object]"', () => {
  // The engine rejects requests with plain { kind, ... } records; String() on those is
  // "[object Object]", which is exactly what a user reported when the model catalog
  // timed out. These records must read as actionable text.
  assertEqual(errorMessage({ kind: 'timeout', method: 'codex/models' }), 'app-server request timed out: codex/models', 'timeout carries the method');
  assertEqual(errorMessage({ kind: 'closed' }), 'app-server client closed', 'closed reads as closed');
  assertEqual(errorMessage({ kind: 'io', message: 'connection reset' }), 'app-server io error: connection reset', 'io carries the OS message');
  assertEqual(errorMessage({ kind: 'server', code: -32001, message: 'unauthorized' }), 'app-server rpc error -32001: unauthorized', 'server carries code and message');
});

h.test('errorMessage decodes nested { error: { message } } envelopes', () => {
  assertEqual(errorMessage({ error: { message: 'sign-in expired' } }), 'sign-in expired', 'the nested message wins');
  assertEqual(errorMessage({ message: 'direct' }), 'direct', 'a direct message wins');
});

// ---------------------------------------------------------------------------
// 3. Auth status — the boot gate.
// ---------------------------------------------------------------------------

h.test('a guest marker with no account passes the login gate', () => {
  // A guest marker grants access only when no stored account is present.
  const root = freshRoot();
  writeFileSync(join(root, 'klaus-guest-mode'), '1');

  assertEqual(readStoredAuth(root), undefined, 'no stored account');
  assertEqual(guestModeActive(root), true, 'so the marker makes guest mode active');
  assertDeepEqual(klausAuthStatus(root), { loggedIn: false, guest: true }, 'the gate-passing shape');
  assertEqual(isLoggedIn(root), false, 'not signed in');

  // THE ASSERTION THAT MATTERS: this shape must not send the frontend to showLoginScreen().
  // chat.ts:11595 is `if (!loggedIn && !guest) { ... return }` — so guest:true is what
  // keeps boot() running through to init().
  const status = klausAuthStatus(root) as { loggedIn?: boolean; guest?: boolean };
  assert(!(status.loggedIn !== true && status.guest !== true), 'boot() would NOT return early on this shape');
});

h.test('a stored account wins over a stale guest marker', () => {
  // accounts.rs:305-309: successful sign-in removes the marker, but this guard also keeps a
  // partial cleanup harmless. So BOTH conditions must hold for guest mode.
  const root = freshRoot();
  writeFileSync(join(root, 'klaus-guest-mode'), '1');
  writeFileSync(join(root, 'klaus-auth.json'), JSON.stringify({ user: { id: 'u1', email: 'a@b.c' }, token: 't' }));

  assertEqual(guestModeActive(root), false, 'a stored account disables guest mode');
  assertDeepEqual(
    klausAuthStatus(root),
    { loggedIn: true, user: { id: 'u1', email: 'a@b.c' } },
    'and reports the account, not the marker',
  );
  assertEqual(isLoggedIn(root), true, 'signed in');
  // The token is NOT echoed to the renderer — only the user object is, matching the Rust's
  // json!({ "loggedIn": true, "user": user }) at main.rs:3233.
  const status = klausAuthStatus(root) as Record<string, unknown>;
  assert(!('token' in status), 'the token stays out of the reply');
});

h.test('no account and no marker means the login screen', () => {
  const root = freshRoot();
  assertEqual(guestModeActive(root), false, 'no marker');
  assertDeepEqual(klausAuthStatus(root), { loggedIn: false, guest: false }, 'neither gate passes');
  const status = klausAuthStatus(root) as { loggedIn?: boolean; guest?: boolean };
  assert(status.loggedIn !== true && status.guest !== true, 'so boot() DOES return early here');
});

h.test('a corrupt or oddly-shaped auth file never rejects', () => {
  // read_stored_auth collapses Missing and Unreadable to None (accounts.rs:290-296), which
  // is load-bearing: a corrupt file must not lock the user out, it reads as "no account"
  // and the guest marker still decides.
  // TWO CLASSES, and the distinction is the whole test. `guest_mode_active` is
  // `read_stored_auth().is_none() && marker.exists()` (accounts.rs:307-309), so what
  // decides guest mode is whether the file PARSES — not whether its `user` field is usable:
  //
  //   unparseable (missing, empty, not JSON) -> read_stored_auth is None -> the marker still
  //     decides, so a corrupt file does not lock the user out.
  //   parseable but `user` is not an object -> read_stored_auth is Some, so guest mode is
  //     OFF, while klaus_auth_status's `Some(user) if user.is_object()` guard fails and falls
  //     to guest() -> {loggedIn:false, guest:false} -> the login screen.
  //
  // The second class parks the user on the login screen, and that is the Rust's behaviour
  // rather than a defect to smooth over: a file that parses is treated as "an account exists",
  // and an account this host cannot read is not one it should silently downgrade to guest.
  const cases: Array<{ name: string; contents: string; expectGuest: boolean }> = [
    { name: 'not JSON', contents: '}{', expectGuest: true },
    { name: 'empty file', contents: '', expectGuest: true },
    { name: 'user is a string', contents: '{"user":"nope"}', expectGuest: false },
    { name: 'user is an array', contents: '{"user":[1,2]}', expectGuest: false },
    { name: 'user is null', contents: '{"user":null}', expectGuest: false },
    { name: 'no user key', contents: '{"token":"t"}', expectGuest: false },
  ];
  for (const row of cases) {
    const root = freshRoot();
    writeFileSync(join(root, 'klaus-auth.json'), row.contents);
    writeFileSync(join(root, 'klaus-guest-mode'), '1');
    const status = klausAuthStatus(root) as { loggedIn?: boolean; guest?: boolean };
    assertEqual(status.loggedIn, false, `${row.name}: not signed in`);
    assertEqual(status.guest, row.expectGuest, `${row.name}: guest is ${row.expectGuest}`);
    // In every case the reply is still an OBJECT — never a rejection, which is what would
    // park boot() permanently (see the module header).
    assertEqual(typeof status, 'object', `${row.name}: an object, so boot() does not throw`);
  }

  // The parse split is visible in readStoredAuth, which is what guest_mode_active keys on.
  const unparseable = freshRoot();
  writeFileSync(join(unparseable, 'klaus-auth.json'), '}{');
  assertEqual(readStoredAuth(unparseable), undefined, 'unparseable -> undefined');
  assertEqual(guestModeActive(unparseable), false, 'and with no marker, guest mode is off');
  writeFileSync(join(unparseable, 'klaus-guest-mode'), '1');
  assertEqual(guestModeActive(unparseable), true, 'but the marker still decides for an unparseable file');

  const parseable = freshRoot();
  writeFileSync(join(parseable, 'klaus-auth.json'), '{"user":"nope"}');
  writeFileSync(join(parseable, 'klaus-guest-mode'), '1');
  assert(guestModeActive(parseable) === false, 'a parseable file turns guest mode OFF despite the marker');

  // And a valid user object IS honoured.
  const ok = freshRoot();
  writeFileSync(join(ok, 'klaus-auth.json'), '{"user":{"id":"u"}}');
  assertEqual((klausAuthStatus(ok) as { loggedIn?: boolean }).loggedIn, true, 'a real user object signs in');
});

h.test('auth status follows account removal without changing the guest marker', () => {
  const root = freshRoot();
  assertDeepEqual(klausAuthStatus(root), { loggedIn: false, guest: false }, 'a fresh profile needs a choice');
  writeFileSync(join(root, 'klaus-auth.json'), JSON.stringify({ user: { id: 'u1' }, token: 'fixture-token' }));
  assertDeepEqual(klausAuthStatus(root), { loggedIn: true, user: { id: 'u1' } }, 'the account is reflected');
  rmSync(join(root, 'klaus-auth.json'));
  assertDeepEqual(klausAuthStatus(root), { loggedIn: false, guest: false }, 'removing the account restores the login state');
  assertEqual(existsSync(join(root, 'klaus-guest-mode')), false, 'reading status does not grant guest access');
});

h.test('independent profile auth status is deterministic and never exposes its credential', () => {
  const root = freshRoot();
  writeFileSync(join(root, 'klaus-auth.json'), JSON.stringify({ user: { id: 'isolated-profile-user' }, token: 'isolated-profile-token' }));
  const status = klausAuthStatus(root);
  assert(typeof status === 'object' && status !== null, 'an object, not a rejection');
  assertDeepEqual(status, { loggedIn: true, user: { id: 'isolated-profile-user' } }, 'only the account projection is returned');
  assert(!('token' in status), 'credentials are not included in the status reply');
});

h.test('supported sources need no account or membership to persist a preference', () => {
  const root = freshRoot();
  for (const mode of AUTH_MODES) {
    assertEqual(kvSet('auth_mode', mode, root), true, 'each supported source can be stored');
    assertEqual(kvGet('auth_mode', root), mode, 'the source remains selected');
  }
  for (const mode of ['klaus', 'local', 'unknown', '']) {
    assertEqual(kvSet('auth_mode', mode, root), true, 'obsolete values normalize without a gate');
    assertEqual(kvGet('auth_mode', root), DEFAULT_AUTH_MODE, 'the default source is persisted');
  }
});

registerServiceHandlerTests(h, freshRoot);
registerUsageCacheTests(h);

// Drain the queue, clean up, then report.
void (async () => {
  const failed = await h.finish(`${__dirname}/services-result.json`, 'services');
  cleanup();
  process.exit(failed);
})();
