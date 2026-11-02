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
import { BROWSER_IMPORT_DEFAULT_LIMITS, type BrowserImportTarget } from '../contracts/browser-import';
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
  syntheticExtensionKey,
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

h.test('discovery rejects an oversized Local State index', async () => {
  const { userDataDir } = fixture();
  writeFileSync(join(userDataDir, 'Local State'), 'x'.repeat(16 * 1024 * 1024 + 1));
  const result = await discoverBrowserProfiles([sourceRoot(userDataDir)]);
  assertEqual(result.profiles.length, 0, 'oversized index yields no profiles');
  assert(result.errors.some(issue => issue.code === 'local_state_too_large'), 'size bound is reported');
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
  assertEqual(decryptor.calls[0]?.context.database?.layout, 'legacy', 'legacy cookie layout is reported');
  assertEqual(decryptor.calls[0]?.context.database?.version, undefined, 'old schema has no meta version');
  assertEqual(session.topFrameSiteKey, undefined, 'old schema has no partition key');
  assertEqual(session.hasCrossSiteAncestor, undefined, 'old schema has no cross-site ancestor flag');
  assertDeepEqual(
    [...decryptor.calls[0]!.bytes],
    [...Buffer.from('v10-encrypted-value')],
    'decryptor receives the original encrypted bytes',
  );
});

h.test('Network cookie databases report schema metadata and preserve CHIPS partition fields', async () => {
  const { source, profileDir, tempRoot } = fixture();
  createCookies(join(profileDir, 'Network'), [
    {
      host: 'example.test',
      name: 'partitioned',
      encrypted: Buffer.from('v10-cookie-secret'),
      topFrameSiteKey: 'https://top.example.test',
      hasCrossSiteAncestor: true,
    },
    { host: 'example.test', name: 'unpartitioned', value: 'plain-value', topFrameSiteKey: '' },
  ], { schemaVersion: 24, partitionedSchema: true });

  const discovery = await discoverBrowserProfiles([source]);
  assertEqual(discovery.profiles[0]?.cookies, true, 'Network cookie database satisfies discovery');

  const decryptor = new RecordingDecryptor();
  const target = new RecordingTarget();
  const result = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      categories: { cookies: true, passwords: false, history: false, extensions: false },
    },
    { roots: [source], decryptor, target, tempRoot },
  );

  assertEqual(result.ok, true, 'Network cookie import completes');
  assertEqual(result.counts.cookies, 2, 'both Network cookies imported');
  const partitioned = target.cookies.find(cookie => cookie.name === 'partitioned')!;
  assertEqual(partitioned.topFrameSiteKey, 'https://top.example.test', 'top-frame site key retained');
  assertEqual(partitioned.hasCrossSiteAncestor, true, 'cross-site ancestor flag retained');
  const unpartitioned = target.cookies.find(cookie => cookie.name === 'unpartitioned')!;
  assertEqual(unpartitioned.topFrameSiteKey, undefined, 'empty partition key remains unpartitioned');
  const cookieCall = decryptor.calls.find(call => call.context.kind === 'cookie')!;
  assertEqual(cookieCall.context.database?.version, 24, 'cookie schema version reaches the decryptor');
  assertEqual(cookieCall.context.database?.layout, 'network', 'Network layout reaches the decryptor');
});

h.test('a symlinked Network directory is rejected instead of followed', async () => {
  const { base, source, profileDir, tempRoot } = fixture();
  const outside = join(base, 'outside-network');
  createCookies(outside, [{ host: 'example.test', name: 'outside', value: 'outside' }]);
  symlinkSync(outside, join(profileDir, 'Network'));

  const target = new RecordingTarget();
  const result = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      categories: { cookies: true, passwords: false, history: false, extensions: false },
    },
    { roots: [source], decryptor: new RecordingDecryptor(), target, tempRoot },
  );

  assertEqual(result.ok, false, 'symlinked Network directory is not accepted');
  assertEqual(result.counts.cookies, 0, 'no cookies imported');
  assert(result.errors.some(issue => issue.code === 'cookie_database_symlink_rejected'), 'structured symlink rejection');
  assertEqual(target.cookies.length, 0, 'target was not called');
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

h.test('database snapshots honor maxDatabaseBytes and explicit default limits', async () => {
  const bounded = fixture();
  createCookies(bounded.profileDir, [{ host: 'example.test', name: 'cookie', value: 'value' }]);
  const boundedTarget = new RecordingTarget();
  const boundedResult = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      categories: { cookies: true, passwords: false, history: false, extensions: false },
    },
    {
      roots: [bounded.source],
      decryptor: new RecordingDecryptor(),
      target: boundedTarget,
      tempRoot: bounded.tempRoot,
      limits: { maxDatabaseBytes: 1 },
    },
  );
  assertEqual(boundedResult.ok, false, 'oversized database is rejected');
  assertEqual(boundedResult.counts.cookies, 0, 'no rows applied from an oversized database');
  assert(boundedResult.errors.some(issue => issue.code === 'database_too_large'), 'database size error');
  assertEqual(boundedTarget.cookies.length, 0, 'target not called for an oversized database');

  const defaults = fixture();
  createCookies(defaults.profileDir, []);
  const defaultsTarget = new RecordingTarget();
  const defaultsResult = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      categories: { cookies: true, passwords: false, history: false, extensions: false },
    },
    {
      roots: [defaults.source],
      decryptor: new RecordingDecryptor(),
      target: defaultsTarget,
      tempRoot: defaults.tempRoot,
      limits: {
        maxExtensionBytes: BROWSER_IMPORT_DEFAULT_LIMITS.maxExtensionBytes,
        maxDatabaseBytes: BROWSER_IMPORT_DEFAULT_LIMITS.maxDatabaseBytes,
      },
    },
  );
  assertEqual(defaultsResult.ok, true, 'explicit default byte limits are accepted');
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

h.test('manifest key verifies the extension id and allows a void install result', async () => {
  const { source, profileDir, tempRoot, extensionRoot } = fixture();
  const generated = syntheticExtensionKey();
  createExtension(profileDir, {
    id: generated.id,
    version: '1.0.0',
    key: generated.key,
    files: { 'a.js': 'synthetic' },
  });
  const target = new RecordingTarget();
  target.installResult = 'void';
  const result = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      allowUnverifiedExtensions: true,
      categories: { cookies: false, passwords: false, history: false, extensions: true },
    },
    { roots: [source], decryptor: new RecordingDecryptor(), target, tempRoot, extensionRoot },
  );

  assertEqual(result.ok, true, 'key-verified extension installs without a target id');
  assertEqual(result.counts.extensions, 1, 'one extension installed');
  const installed = target.extensions[0]!;
  assertEqual(installed.id, generated.id, 'derived id matches the folder');
  assertEqual(installed.idVerified, true, 'key verification is explicit');
  assertEqual(installed.publicKey, generated.key, 'public key is available to the target');
});

h.test('packages without a key rely on the real id returned by the target', async () => {
  const id = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

  const wrongFixture = fixture();
  createExtension(wrongFixture.profileDir, { id, version: '1.0.0' });
  const wrongTarget = new RecordingTarget();
  wrongTarget.installResult = 'wrong-id';
  const wrong = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      allowUnverifiedExtensions: true,
      categories: { cookies: false, passwords: false, history: false, extensions: true },
    },
    {
      roots: [wrongFixture.source],
      decryptor: new RecordingDecryptor(),
      target: wrongTarget,
      tempRoot: wrongFixture.tempRoot,
      extensionRoot: wrongFixture.extensionRoot,
    },
  );
  assertEqual(wrong.ok, false, 'mismatched installed id is rejected');
  assertEqual(wrong.counts.extensions, 0, 'mismatched extension is not counted');
  assert(wrong.errors.some(issue => issue.code === 'extension_id_mismatch'), 'id mismatch is structured');
  assertEqual(wrongTarget.extensions.length, 1, 'target was asked to install before verification failed');

  const voidFixture = fixture();
  createExtension(voidFixture.profileDir, { id, version: '1.0.0' });
  const voidTarget = new RecordingTarget();
  voidTarget.installResult = 'void';
  const unverified = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      allowUnverifiedExtensions: true,
      categories: { cookies: false, passwords: false, history: false, extensions: true },
    },
    {
      roots: [voidFixture.source],
      decryptor: new RecordingDecryptor(),
      target: voidTarget,
      tempRoot: voidFixture.tempRoot,
      extensionRoot: voidFixture.extensionRoot,
    },
  );
  assertEqual(unverified.ok, false, 'missing real id is rejected');
  assert(unverified.errors.some(issue => issue.code === 'extension_id_unverified'), 'unverified id is structured');

  const verifiedFixture = fixture();
  createExtension(verifiedFixture.profileDir, { id, version: '1.0.0' });
  const manifestPath = join(verifiedFixture.profileDir, 'Extensions', id, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  manifest.id = 'dddddddddddddddddddddddddddddddd';
  writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, 'utf8');
  const verifiedTarget = new RecordingTarget();
  const verified = await importBrowserProfile(
    {
      sourceId: 'chrome',
      profileId: 'Default',
      allowUnverifiedExtensions: true,
      categories: { cookies: false, passwords: false, history: false, extensions: true },
    },
    {
      roots: [verifiedFixture.source],
      decryptor: new RecordingDecryptor(),
      target: verifiedTarget,
      tempRoot: verifiedFixture.tempRoot,
      extensionRoot: verifiedFixture.extensionRoot,
    },
  );
  assertEqual(verified.ok, true, 'target-returned folder id is accepted');
  assertEqual(verified.counts.extensions, 1, 'verified extension counted');
  assertEqual(verifiedTarget.extensions[0]?.id, id, 'folder id is preserved');
  assertEqual(verifiedTarget.extensions[0]?.idVerified, false, 'manifest.id is not treated as proof');
});

h.test('extension manifests are bounded before parsing', async () => {
  const { source, profileDir, tempRoot, extensionRoot } = fixture();
  const id = 'dddddddddddddddddddddddddddddddd';
  createExtension(profileDir, { id, version: '1.0.0' });
  writeFileSync(join(profileDir, 'Extensions', id, 'manifest.json'), 'x'.repeat(1024 * 1024 + 1));
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

  assertEqual(result.ok, false, 'oversized manifest is rejected');
  assertEqual(result.counts.extensions, 0, 'no extension installed');
  assert(result.errors.some(issue => issue.code === 'extension_manifest_too_large'), 'manifest size error is structured');
});

h.test('extension copy honors the total byte limit', async () => {
  const { source, profileDir, tempRoot, extensionRoot } = fixture();
  const id = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  createExtension(profileDir, {
    id,
    version: '1.0.0',
    files: { 'payload.bin': 'x'.repeat(64) },
  });
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
      limits: { maxExtensionBytes: 32 },
    },
  );

  assertEqual(result.ok, false, 'oversized extension is rejected');
  assertEqual(result.counts.extensions, 0, 'no extension installed');
  assert(result.errors.some(issue => issue.code === 'extension_size_limit'), 'size bound is structured');
  assertEqual(target.extensions.length, 0, 'target was not called');
});

h.test('extension symlinks, escapes and id mismatches are rejected without leaving a copy', async () => {
  const { base, source, profileDir, tempRoot, extensionRoot } = fixture();
  const outside = join(base, 'outside.txt');
  writeFileSync(outside, 'outside');

  const symlinkId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  createExtension(profileDir, { id: symlinkId, version: '1.0.0', symlinkTo: outside });
  const mismatchId = 'cccccccccccccccccccccccccccccccc';
  const unrelatedKey = syntheticExtensionKey();
  createExtension(profileDir, {
    id: mismatchId,
    version: '1.0.0',
    key: unrelatedKey.key,
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
  assert(result.errors.some(issue => issue.code === 'extension_id_mismatch'), 'public key id mismatch rejected');
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
