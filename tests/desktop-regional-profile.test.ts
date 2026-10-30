import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { configRootFrom, defaultConfigRootFrom, homeFrom, canonicalProfilePath } from '../main/services/config-root';
import { getDesktopEdition, resolveDesktopEditionId } from '../main/services/desktop-edition';
import { instanceIdentity } from '../main/app/instance-identity';
import { instanceActivation } from '../main/native/instance-guard';
import { parseDeepLink, teamIssueDeepLink } from '../main/app/deep-links';
import { parseFriendInvite } from '../shared/friends';
import { systemRelaunchPreservesProfile } from '../main/updater/relaunch-profile';
import { MobileSettingsStore } from '../main/services/mobile/settings';
import { withSettingsTransaction } from '../main/services/settings';
import { NativeSubscriptionCredentials } from '../main/native/credentials';
import type { NativeAddon } from '../main/native/binding';
import { Harness } from './harness';

const h = new Harness();
const vector = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/desktop-regional-profile-vectors.json'), 'utf8')) as {
  editions: Array<{ id: string; application: string; configDirectory: string; protocol: string; mobilePort: number; keychainService: string }>;
};
function fixture(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'klaus-regional-profile-'));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}
function production(run: () => void): void {
  const nodeEnv = process.env.NODE_ENV, test = process.env.KLAUS_TEST;
  delete process.env.NODE_ENV; delete process.env.KLAUS_TEST;
  try { run(); } finally {
    if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
    if (test === undefined) delete process.env.KLAUS_TEST; else process.env.KLAUS_TEST = test;
  }
}
h.test('canonical vectors pin edition defaults without language-based identity', () => {
  fixture(root => {
    for (const expected of vector.editions) {
      const edition = getDesktopEdition(expected.id);
      for (const [key, value] of Object.entries(expected)) assert.equal(edition[key as keyof typeof edition], value);
      const defaultRoot = join(root, expected.configDirectory);
      assert.equal(configRootFrom({ HOME: root, LANG: 'zh_CN', KLAUS_DESKTOP_EDITION: expected.id }), expected.id === 'international' ? canonicalProfilePath(defaultRoot) : defaultRoot);
      assert.equal(defaultConfigRootFrom({ HOME: root }, edition), join(root, expected.configDirectory));
    }
  });
  assert.equal(resolveDesktopEditionId({ klausDesktopLayoutVersion: 1 }, { KLAUS_DESKTOP_EDITION: 'international' }), 'domestic');
  assert.equal(resolveDesktopEditionId({ klausDesktopLayoutVersion: 1, klausDesktopEdition: 'international' }, { KLAUS_DESKTOP_EDITION: 'domestic' }), 'international');
  assert.equal(homeFrom({ HOME: '', USERPROFILE: '/synthetic' }), '/synthetic');
  assert.equal(homeFrom({ HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\fixture' }), 'C:\\Users\\fixture');
  assert.equal(homeFrom({}), undefined);
});
h.test('production overrides refuse opposite profiles and aliases while independent roots remain valid', () => {
  fixture(root => production(() => {
    const alias = join(root, 'alias'); symlinkSync(root, alias, 'dir');
    for (const id of ['domestic', 'international'] as const) {
      const edition = getDesktopEdition(id), other = getDesktopEdition(id === 'domestic' ? 'international' : 'domestic');
      const env = { HOME: root, KLAUS_DESKTOP_EDITION: id };
      const expectedPath = (value: string) => id === 'international' ? canonicalProfilePath(value) : value;
      for (const path of [join(root, other.configDirectory), join(alias, other.configDirectory), join(root, 'unused', '..', other.configDirectory), join(alias, other.configDirectory, 'nested')]) {
        assert.throws(() => configRootFrom({ ...env, KLAUS_CONFIG_DIR: path }), /another edition/);
      }
      const directAlias = join(root, id + '-direct'); symlinkSync(join(root, other.configDirectory), directAlias, 'dir');
      assert.throws(() => configRootFrom({ ...env, KLAUS_CONFIG_DIR: directAlias }), /another edition/);
      assert.equal(configRootFrom({ ...env, KLAUS_CONFIG_DIR: join(root, edition.configDirectory) }), expectedPath(join(root, edition.configDirectory)));
      assert.equal(configRootFrom({ ...env, KLAUS_CONFIG_DIR: join(root, 'custom-' + id) }), expectedPath(join(root, 'custom-' + id)));
      assert.equal(configRootFrom({ ...env, KLAUS_CONFIG_DIR: '~/custom' }), expectedPath(join(root, 'custom')));
      if (id === 'domestic') assert.equal(configRootFrom({ ...env, KLAUS_CONFIG_DIR: ' ' }), ' ');
      else assert.throws(() => configRootFrom({ ...env, KLAUS_CONFIG_DIR: ' ' }), /whitespace/);
    }
    mkdirSync(join(root, '.klaus'));
    symlinkSync(join(root, '.klaus'), join(root, '.klaus-international'), 'dir');
    for (const id of ['domestic', 'international']) {
      assert.throws(() => configRootFrom({ HOME: root, KLAUS_DESKTOP_EDITION: id }), /another edition/);
    }
  }));
});
h.test('test guard protects both real profiles even through normalized and symbolic aliases', () => {
  fixture(root => {
    const old = process.env.KLAUS_TEST;
    process.env.KLAUS_TEST = '1';
    try {
      const alias = join(root, 'home-alias'); symlinkSync(homedir(), alias, 'dir');
      for (const id of ['domestic', 'international'] as const) {
        const directory = getDesktopEdition(id).configDirectory;
        for (const path of [join(homedir(), directory), join(alias, directory), join(alias, directory, 'tests')]) {
          assert.throws(() => configRootFrom({ HOME: root, KLAUS_CONFIG_DIR: path, KLAUS_DESKTOP_EDITION: id }), /REAL profile/);
        }
      }
      assert.equal(configRootFrom({ HOME: root, KLAUS_CONFIG_DIR: join(root, 'independent') }), join(root, 'independent'));
    } finally { if (old === undefined) delete process.env.KLAUS_TEST; else process.env.KLAUS_TEST = old; }
  });
});
h.test('international instance identity cannot borrow the development fixture bypass', () => {
  assert.equal(instanceIdentity({ application: 'ai.klaus.desktop.international', packaged: false, configRoot: '/missing', defaultConfigRoot: '/default', env: { KLAUS_TEST: '1', KLAUS_INSTANCE_FIXTURE_ID: 'ai.klaus.instance-fixture.fake' } }), 'ai.klaus.desktop.international');
  assert.throws(() => instanceIdentity({ application: 'arbitrary', packaged: true, configRoot: '/fixture', defaultConfigRoot: '/default', env: {} }), /identity/);
});
h.test('deep links and invites only accept their injected protocol in both directions', () => {
  const project = '00000000-0000-0000-0000-000000000001', issue = '00000000-0000-0000-0000-000000000002';
  for (const protocol of ['klaus', 'klaus-international']) {
    const other = protocol === 'klaus' ? 'klaus-international' : 'klaus';
    const invite = `${protocol}:friend?v=1&email=owner%40example.com`;
    assert.deepEqual(parseFriendInvite(invite, protocol), { email: 'owner@example.com' });
    assert.equal(parseFriendInvite(invite, other), null);
    assert.equal(parseDeepLink(`${other}://settings`, protocol), undefined);
    assert.deepEqual(parseDeepLink(`${protocol}://new`, protocol), { kind: 'new' });
    assert.deepEqual(instanceActivation([`${other}://new`, `${protocol}://settings`], protocol), { deepLink: `${protocol}://settings` });
    assert.deepEqual(instanceActivation([invite], protocol), { deepLink: invite });
    const link = teamIssueDeepLink(project, issue, protocol);
    assert.deepEqual(parseDeepLink(link, protocol), { kind: 'issue', projectId: project, issueId: issue });
    assert.equal(parseDeepLink(link, other), undefined);
    assert.deepEqual(instanceActivation([link], protocol), { deepLink: link });
  }
  assert.deepEqual(parseFriendInvite('owner@example.com', 'klaus-international'), { email: 'owner@example.com' });
  assert.equal(parseDeepLink('https://new', 'https'), undefined);
});
h.test('trusted international default remains eligible for system relaunch including missing leaves', () => {
  fixture(root => {
    const alias = join(root, 'alias'); symlinkSync(root, alias, 'dir');
    const defaultRoot = join(root, '.klaus-international');
    assert.equal(systemRelaunchPreservesProfile(join(alias, '.klaus-international'), defaultRoot), true);
    assert.equal(systemRelaunchPreservesProfile(join(root, 'custom'), defaultRoot), false);
    assert.equal(canonicalProfilePath(join(alias, '.klaus-international')), canonicalProfilePath(defaultRoot));
  });
});
h.test('mobile defaults are injected per edition while saved ports win', () => {
  fixture(root => {
    const domestic = new MobileSettingsStore(join(root, 'domestic'), 'https://relay.example.test', {});
    const international = new MobileSettingsStore(join(root, 'international'), 'https://relay.example.test', {}, 27190);
    assert.equal(domestic.read().port, 27189); assert.equal(international.read().port, 27190);
    assert.equal(international.read({ port: 30001 }).port, 30001);
    withSettingsTransaction(international.configRoot, db => db.prepare('UPDATE settings SET value=? WHERE key=?').run('99999', 'mobile_bridge.port'));
    assert.equal(international.read().port, 27190);
    assert.throws(() => new MobileSettingsStore(join(root, 'invalid'), 'https://relay.example.test', {}, -1), /port/);
  });
});
h.test('native credentials pass a restricted service and preserve the real user home', () => {
  let args: unknown[] = [];
  const addon = { credentialKeychainServices: () => ['agent-engine', 'agent-engine-international'], NativeCredentials: class { constructor(...values: unknown[]) { args = values; } } } as unknown as NativeAddon;
  fixture(root => {
    mkdirSync(join(root, 'config'));
    new NativeSubscriptionCredentials({ configRoot: join(root, 'config'), userHome: homedir(), keychainService: 'agent-engine-international', addon });
    assert.equal(args[1], join(root, 'config')); assert.equal(args[2], homedir()); assert.equal(args[3], 'agent-engine-international');
    new NativeSubscriptionCredentials({ configRoot: root, userHome: homedir(), keychainService: 'agent-engine', addon });
    assert.equal(args[3], 'agent-engine');
    assert.throws(() => new NativeSubscriptionCredentials({ configRoot: root, userHome: homedir(), keychainService: 'invalid', addon }), /INVALID_KEYCHAIN_SERVICE/);
  });
});
h.test('international credentials reject legacy native addons before constructing a resource', () => {
  let constructed = false;
  const addon = { NativeCredentials: class { constructor() { constructed = true; } } } as unknown as NativeAddon;
  fixture(root => {
    assert.throws(() => new NativeSubscriptionCredentials({ configRoot: root, userHome: root, keychainService: 'agent-engine-international', addon }), /CREDENTIALS_EDITION_UNSUPPORTED/);
    assert.equal(constructed, false);
  });
});
void h.finish(join(__dirname, 'desktop-regional-profile-result.json'), 'desktop-regional-profile').then(code => { process.exitCode = code; });
