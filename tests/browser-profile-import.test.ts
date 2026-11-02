import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserImportTarget } from '../contracts/browser-import';
import { discoverBrowserProfiles } from '../main/browser/profile-discovery';
import { importBrowserProfile } from '../main/browser/profile-import';
import { assert, assertDeepEqual, assertEqual, Harness } from './harness';
import {
  createCookies,
  createExtension,
  createHistory,
  createLogins,
  profileDirectory,
  RecordingDecryptor,
  RecordingTarget,
  sourceRoot,
  writeLocalState,
} from './browser-profile-import-helpers';

const h = new Harness();
const root = mkdtempSync(join(tmpdir(), 'klaus-browser-import-'));
let sequence = 0;

function fixture() {
  const base = join(root, String(++sequence));
  const userDataDir = join(base, 'user-data');
  const profileDir = join(userDataDir, 'Default');
  writeLocalState(userDataDir, { Default: { name: 'Synthetic Person' } });
  mkdirSync(profileDir, { recursive: true });
  return {
    base,
    userDataDir,
    profileDir,
    source: sourceRoot(userDataDir),
    tempRoot: join(base, 'temp'),
    extensionRoot: join(base, 'extensions'),
  };
}

function hashFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

h.test('discovery reads Local State metadata and file existence and rejects symlinked profiles', async () => {
  const { base, userDataDir, profileDir } = fixture();
  writeFileSync(join(profileDir, 'Cookies'), '');
  writeFileSync(join(profileDir, 'Login Data'), '');
  writeFileSync(join(profileDir, 'History'), '');
  mkdirSync(join(profileDir, 'Extensions'));

  const work = profileDirectory(userDataDir, 'Profile 1');
  writeFileSync(join(work, 'History'), '');

  symlinkSync(profileDir, join(userDataDir, 'Linked'));
  writeLocalState(userDataDir, {
    Default: { name: 'Default Person' },
    'Profile 1': { name: 'Work' },
    Linked: { name: 'Linked' },
    '../escape': { name: 'Escape' },
  }, 'Profile 1');

  const broken = join(base, 'broken');
  mkdirSync(broken);
  writeFileSync(join(broken, 'Local State'), '{ not valid json');

  const result = await discoverBrowserProfiles([
    sourceRoot(userDataDir),
    { id: 'broken', label: 'Broken', userDataDir: broken, family: 'chromium' },
    { id: 'absent', label: 'Absent', userDataDir: join(base, 'absent'), family: 'edge' },
  ]);

  assertEqual(result.profiles.length, 2, 'only regular indexed profiles are returned');
  const first = result.profiles[0]!;
  assertEqual(first.profileId, 'Profile 1', 'last used profile sorts first');
  assertEqual(first.lastUsed, true, 'last used flag');
  assertEqual(first.displayName, 'Work', 'metadata name');
  assertEqual(first.history, true, 'history file exists');
  assertEqual(first.cookies, false, 'cookie file absent');
  const second = result.profiles[1]!;
  assertEqual(second.profileId, 'Default', 'regular profile retained');
  assertEqual(second.cookies, true, 'cookie file exists');
  assertEqual(second.passwords, true, 'login data exists');
  assertEqual(second.history, true, 'history exists');
  assertEqual(second.extensions, true, 'extensions directory exists');
  assert(!result.profiles.some(profile => profile.profileId === 'Linked'), 'symlinked profile rejected');
  assert(result.errors.some(issue => issue.sourceId === 'broken' && issue.code === 'local_state_unreadable'), 'malformed index reported');
  assert(result.errors.some(issue => issue.sourceId === 'chrome' && issue.code === 'profile_id_rejected'), 'traversal key reported');
  assert(!result.errors.some(issue => issue.sourceId === 'absent'), 'absent default root is skipped');
});

h.test('cookie import preserves fields, applies the hostname allowlist and uses the default categories', async () => {
  const { source, profileDir, tempRoot } = fixture();
  createCookies(profileDir, [
    { host: '.example.test', name: 'session', value: 'plain', secure: true, httpOnly: true, sameSite: 1, hasExpires: false },
    { host: 'app.example.test', name: 'persistent', encrypted: Buffer.from('v10-encrypted-value'), path: '/app', expiresAt: 1_800_000_000_000, sameSite: 2 },
    { host: 'other.invalid', name: 'outside', value: 'skip' },
  ]);
  createLogins(profileDir, []);

  const decryptor = new RecordingDecryptor();
  const target = new RecordingTarget();
  const result = await importBrowserProfile(
    { sourceId: 'chrome', profileId: 'Default', cookieHostnameAllowlist: ['*.example.test'] },
    { roots: [source], decryptor, target, tempRoot },
  );

  assertEqual(result.ok, true, 'import completes without errors');
  assertEqual(result.counts.cookies, 2, 'allowlisted cookies imported');
  assertEqual(result.counts.passwords, 0, 'login table has no rows');
  assertEqual(result.counts.history, 0, 'history is off by default');
  assertEqual(target.cookies.length, 2, 'target received the batch');

  const session = target.cookies.find(cookie => cookie.name === 'session')!;
  assertEqual(session.domain, '.example.test', 'cookie domain retained');
  assertEqual(session.path, '/', 'cookie path retained');
  assertEqual(session.secure, true, 'secure flag retained');
  assertEqual(session.httpOnly, true, 'httpOnly flag retained');
  assertEqual(session.sameSite, 'lax', 'sameSite retained');
  assertEqual(session.expiresAt, undefined, 'session cookie has no expiry');

  const persistent = target.cookies.find(cookie => cookie.name === 'persistent')!;
  assertEqual(persistent.value, 'encrypted-value', 'encrypted cookie decrypted through the adapter');
  assertEqual(persistent.path, '/app', 'cookie path retained');
  assertEqual(persistent.sameSite, 'strict', 'sameSite retained');
  assertEqual(persistent.expiresAt, 1_800_000_000_000, 'expiry converted to epoch milliseconds');
  assertEqual(decryptor.calls.length, 1, 'only the encrypted cookie reached the decryptor');
  assertDeepEqual(
    [...decryptor.calls[0]!.bytes],
    [...Buffer.from('v10-encrypted-value')],
    'decryptor receives the original encrypted bytes',
  );
});

h.test('encrypted logins are delegated to the decryptor and app-bound failure is structured', async () => {
  const { source, profileDir, tempRoot } = fixture();
  createLogins(profileDir, [
    { origin: 'https://example.test/login', username: 'synthetic', encrypted: Buffer.from('v10-SyntheticSecret') },
    { origin: 'https://bound.example.test/login', username: 'bound', encrypted: Buffer.from('v20-AppBoundSecret') },
  ]);

  const decryptor = new RecordingDecryptor();
  const target = new RecordingTarget();
  const result = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      categories: { cookies: false, passwords: true, history: false, extensions: false },
    },
    { roots: [source], decryptor, target, tempRoot },
  );

  assertEqual(result.ok, false, 'unsupported encryption is not reported as success');
  assertEqual(result.counts.passwords, 1, 'only the supported row is applied');
  assertEqual(decryptor.calls.length, 2, 'both encrypted rows are delegated to the decryptor');
  assertEqual(decryptor.calls[0]?.context.family, 'chrome', 'source family is available to the decryptor');
  const boundCall = decryptor.calls.find(call => Buffer.from(call.bytes).toString('utf8').startsWith('v20-'));
  assert(boundCall, 'v20 bytes reach the injected decryptor for a platform decision');
  assertEqual(target.passwords[0]?.password, 'SyntheticSecret', 'plaintext reaches only the target');
  assert(result.errors.some(issue => issue.code === 'app_bound_encryption_unsupported'), 'structured encryption error');

  const serialized = JSON.stringify(result);
  assert(!serialized.includes('SyntheticSecret'), 'result never contains a plaintext password');
  assert(!serialized.includes('AppBoundSecret'), 'result never contains an encrypted or plaintext secret');
});

h.test('v11 derived-key secrets are not hard-rejected as app-bound', async () => {
  const { source, profileDir, tempRoot } = fixture();
  createLogins(profileDir, [
    { origin: 'https://example.test/login', username: 'derived', encrypted: Buffer.from('v11-DerivedKeySecret') },
  ]);

  const decryptor = new RecordingDecryptor('v11-', '');
  const target = new RecordingTarget();
  const result = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      categories: { cookies: false, passwords: true, history: false, extensions: false },
    },
    { roots: [source], decryptor, target, tempRoot },
  );

  assertEqual(result.ok, true, 'v11 is left to the injected decryptor');
  assertEqual(result.counts.passwords, 1, 'derived-key row imported');
  assertEqual(target.passwords[0]?.password, 'DerivedKeySecret', 'plaintext reaches only the target');
  assertEqual(decryptor.calls[0]?.context.platform, process.platform, 'platform is available to the decryptor');
});

h.test('history timestamps become epoch milliseconds and are marked source other', async () => {
  const { source, profileDir, tempRoot } = fixture();
  createHistory(profileDir, [
    { url: 'https://example.test/one', title: 'One', visitedAt: 1_700_000_000_000 },
    { url: 'https://example.test/two', visitedAt: 1_700_000_001_000 },
    { url: 'https://example.test/bad', title: 'Bad', visitedAt: -1 },
  ]);

  const target = new RecordingTarget();
  const result = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      categories: { cookies: false, passwords: false, history: true, extensions: false },
    },
    { roots: [source], decryptor: new RecordingDecryptor(), target, tempRoot },
  );

  assertEqual(result.ok, false, 'a skipped row is a structured error');
  assertEqual(result.counts.history, 2, 'usable visits imported');
  assertDeepEqual(target.history, [
    { url: 'https://example.test/one', title: 'One', visitedAt: 1_700_000_000_000, source: 'other' },
    { url: 'https://example.test/two', title: 'https://example.test/two', visitedAt: 1_700_000_001_000, source: 'other' },
  ], 'Chrome storage time becomes epoch milliseconds and source other');
  assert(result.errors.some(issue => issue.code === 'history_rows_skipped'), 'invalid timestamp reported');
});

h.test('SQLite snapshots include WAL rows and leave the original file untouched', async () => {
  const { source, profileDir, tempRoot } = fixture();
  const open = createCookies(profileDir, [
    { host: 'example.test', name: 'wal-cookie', value: 'from-wal' },
  ], { keepOpen: true });
  assert(open, 'fixture keeps the writing connection open');
  assert(existsSync(join(profileDir, 'Cookies-wal')), 'WAL file exists before the import');
  const before = hashFile(join(profileDir, 'Cookies'));

  const target = new RecordingTarget();
  const result = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      categories: { cookies: true, passwords: false, history: false, extensions: false },
    },
    { roots: [source], decryptor: new RecordingDecryptor(), target, tempRoot },
  );
  assertEqual(result.ok, true, 'snapshot import completes');
  assertEqual(target.cookies[0]?.value, 'from-wal', 'row still present in the WAL is visible');
  assertEqual(hashFile(join(profileDir, 'Cookies')), before, 'original database bytes are unchanged while the writer connection stays open');
  open.close();
  assert(existsSync(tempRoot), 'temporary root was created');
  assertDeepEqual(readdirSync(tempRoot), [], 'snapshot directories are removed in finally');
});

h.test('a corrupted SQLite file is retried and then reported as a snapshot error', async () => {
  const { source, profileDir, tempRoot } = fixture();
  writeFileSync(join(profileDir, 'History'), 'this is not a SQLite database');
  const target = new RecordingTarget();
  const result = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      categories: { cookies: false, passwords: false, history: true, extensions: false },
    },
    { roots: [source], decryptor: new RecordingDecryptor(), target, tempRoot },
  );

  assertEqual(result.ok, false, 'corrupt data is not a success');
  assertEqual(result.counts.history, 0, 'no history rows are applied');
  assert(result.errors.some(issue => issue.code === 'snapshot_corrupted'), 'explicit snapshot integrity error');
});

h.test('extensions need explicit confirmation and install from an app-owned copy', async () => {
  const { source, profileDir, tempRoot, extensionRoot } = fixture();
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  createExtension(profileDir, {
    id,
    version: '1.2.3',
    name: 'Synthetic Extension',
    files: { 'background.js': 'console.log("synthetic");' },
  });
  const preferences = join(profileDir, 'Preferences');
  writeFileSync(preferences, '{"safe":true}\n');
  const preferencesBefore = hashFile(preferences);

  const target = new RecordingTarget();
  const denied = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      categories: { cookies: false, passwords: false, history: false, extensions: true },
    },
    { roots: [source], decryptor: new RecordingDecryptor(), target, tempRoot, extensionRoot },
  );
  assertEqual(denied.ok, false, 'unconfirmed extension import is refused');
  assert(denied.errors.some(issue => issue.code === 'extensions_not_confirmed'), 'confirmation error');
  assertEqual(target.extensions.length, 0, 'target was not called');

  const confirmed = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      allowUnverifiedExtensions: true,
      categories: { cookies: false, passwords: false, history: false, extensions: true },
    },
    { roots: [source], decryptor: new RecordingDecryptor(), target, tempRoot, extensionRoot },
  );
  assertEqual(confirmed.ok, true, 'confirmed extension import completes');
  assertEqual(confirmed.counts.extensions, 1, 'one extension installed');
  const installed = target.extensions[0]!;
  assertEqual(installed.id, id, 'manifest directory id retained');
  assertEqual(installed.version, '1.2.3', 'manifest version retained');
  assertEqual(installed.name, 'Synthetic Extension', 'manifest name retained');
  assert(installed.path.startsWith(extensionRoot), 'install path is inside the app-owned root');
  assert(existsSync(join(installed.path, 'background.js')), 'bounded copy contains the extension file');
  assertEqual(hashFile(preferences), preferencesBefore, 'Preferences is never modified');
});

h.test('extension symlinks, escapes and id mismatches are rejected without leaving a copy', async () => {
  const { base, source, profileDir, tempRoot, extensionRoot } = fixture();
  const outside = join(base, 'outside.txt');
  writeFileSync(outside, 'outside');

  const symlinkId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  createExtension(profileDir, { id: symlinkId, version: '1.0.0', symlinkTo: outside });
  const mismatchId = 'cccccccccccccccccccccccccccccccc';
  createExtension(profileDir, {
    id: mismatchId,
    version: '1.0.0',
    manifestId: 'dddddddddddddddddddddddddddddddd',
  });

  const target = new RecordingTarget();
  const result = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      allowUnverifiedExtensions: true,
      categories: { cookies: false, passwords: false, history: false, extensions: true },
    },
    { roots: [source], decryptor: new RecordingDecryptor(), target, tempRoot, extensionRoot },
  );

  assertEqual(result.ok, false, 'rejected extensions make the result fail');
  assertEqual(result.counts.extensions, 0, 'no extension counted as installed');
  assert(result.errors.some(issue => issue.code === 'extension_symlink_rejected'), 'symlink rejected');
  assert(result.errors.some(issue => issue.code === 'extension_id_mismatch'), 'manifest id mismatch rejected');
  assertEqual(target.extensions.length, 0, 'install callback was not called');
  const runRoots = readdirSync(extensionRoot);
  for (const runRoot of runRoots) {
    const entries = readdirSync(join(extensionRoot, runRoot));
    assertDeepEqual(entries, [], 'failed extension copies are removed');
  }
});

h.test('cancellation returns a structured result and leaves no snapshots behind', async () => {
  const { source, profileDir, tempRoot } = fixture();
  createCookies(profileDir, [{ host: 'example.test', name: 'cookie', value: 'a' }]);
  const controller = new AbortController();
  controller.abort();
  const target = new RecordingTarget();
  const result = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      categories: { cookies: true, passwords: false, history: false, extensions: false },
    },
    { roots: [source], decryptor: new RecordingDecryptor(), target, tempRoot, signal: controller.signal },
  );

  assertEqual(result.cancelled, true, 'cancellation is reported');
  assertEqual(result.ok, false, 'cancelled import is not a success');
  assert(result.errors.some(issue => issue.code === 'cancelled'), 'structured cancellation error');
  assertEqual(target.cookies.length, 0, 'target was not called');
  assert(!existsSync(tempRoot) || readdirSync(tempRoot).length === 0, 'no temporary snapshot remains');
});

h.test('cancellation after a target batch keeps applied counts without starting the next category', async () => {
  const { source, profileDir, tempRoot } = fixture();
  createCookies(profileDir, [{ host: 'example.test', name: 'cookie', value: 'a' }]);
  createLogins(profileDir, [
    { origin: 'https://example.test/login', username: 'user', encrypted: Buffer.from('v10-password') },
  ]);
  const controller = new AbortController();
  let passwordsCalled = false;
  const target: BrowserImportTarget = {
    async applyCookies() {
      controller.abort();
    },
    async applyPasswords() {
      passwordsCalled = true;
    },
  };
  const result = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      categories: { cookies: true, passwords: true, history: false, extensions: false },
    },
    { roots: [source], decryptor: new RecordingDecryptor(), target, tempRoot, signal: controller.signal },
  );

  assertEqual(result.cancelled, true, 'cancellation after apply is reported');
  assertEqual(result.counts.cookies, 1, 'a successfully applied batch stays counted');
  assertEqual(result.counts.passwords, 0, 'the next category is not counted');
  assertEqual(passwordsCalled, false, 'the next target callback is not invoked');
  assert(!existsSync(tempRoot) || readdirSync(tempRoot).length === 0, 'snapshots are cleaned after cancellation');
});

h.test('extension copy honors file limits and rejects invalid manifests', async () => {
  const { source, profileDir, tempRoot, extensionRoot } = fixture();
  const manyId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  createExtension(profileDir, {
    id: manyId,
    version: '1.0.0',
    files: { 'a.txt': 'a', 'b.txt': 'b', 'c.txt': 'c' },
  });
  const invalidId = 'ffffffffffffffffffffffffffffffff';
  createExtension(profileDir, { id: invalidId, version: 'not-a-version' });

  const target = new RecordingTarget();
  const result = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      allowUnverifiedExtensions: true,
      categories: { cookies: false, passwords: false, history: false, extensions: true },
    },
    {
      roots: [source],
      decryptor: new RecordingDecryptor(),
      target,
      tempRoot,
      extensionRoot,
      limits: { maxExtensionFiles: 2 },
    },
  );

  assertEqual(result.ok, false, 'bounded or invalid extensions are not successful');
  assertEqual(result.counts.extensions, 0, 'no extension counted as installed');
  assert(result.errors.some(issue => issue.code === 'extension_file_limit'), 'file bound reported');
  assert(result.errors.some(issue => issue.code === 'extension_version_invalid'), 'invalid manifest version reported');
  assertEqual(target.extensions.length, 0, 'install callback was not called');
});

h.test('row limits bound reads and report a structured error', async () => {
  const { source, profileDir, tempRoot } = fixture();
  createHistory(profileDir, [
    { url: 'https://example.test/one', visitedAt: 1_700_000_000_000 },
    { url: 'https://example.test/two', visitedAt: 1_700_000_001_000 },
    { url: 'https://example.test/three', visitedAt: 1_700_000_002_000 },
  ]);

  const target = new RecordingTarget();
  const result = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      categories: { cookies: false, passwords: false, history: true, extensions: false },
    },
    {
      roots: [source],
      decryptor: new RecordingDecryptor(),
      target,
      tempRoot,
      limits: { maxHistoryRows: 2 },
    },
  );

  assertEqual(result.counts.history, 2, 'history read stops at the configured bound');
  assertEqual(target.history.length, 2, 'target receives only bounded rows');
  assert(result.errors.some(issue => issue.code === 'history_row_limit'), 'limit error is structured');
});

void h.finish(join(__dirname, 'browser-profile-import-result.json'), 'browser-profile-import').then(code => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = code;
});
