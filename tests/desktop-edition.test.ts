import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { getDesktopEdition, loadedDesktopEditions, publicDesktopDistribution, resolveDesktopEditionId, desktopEngineEnvironment, desktopEditionSources } from '../main/services/desktop-edition';
import { validateDesktopEditionDocuments, type DesktopEdition } from '../shared/desktop-edition';
import { assertDesktopProfileEdition, claimDesktopProfileEdition } from '../main/services/desktop-profile';
import { AccountService } from '../main/services/account-service';
import { assertMacApplicationSignature } from '../main/updater/platform';
import { computerUseSelfAppMatches, isHostProductApp } from '../main/services/computer-use/policy';
import { configRootFrom, canonicalProfilePath } from '../main/services/config-root';
import { productionPolicy } from '../main/updater/policy';
import { isDesktopEditionBundle } from '../main/services/friend-apps';
import { instanceIdentity } from '../main/app/instance-identity';
import { NativeSubscriptionCredentials } from '../main/native/credentials';
import type { NativeAddon } from '../main/native/binding';
import { effectiveEnv } from '../main/engine/spawn';
import { nodeResolvableInPath } from '../main/engine/js-runtime-env';
import { chromeDiscoveryDirectory } from '../main/browser/chrome-native-host';
import { Harness } from './harness';

const h = new Harness();
const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/desktop-edition-vectors.json'), 'utf8')) as {
  defaults: Array<{ edition: string; serverUrl: string; productName: string; application: string }>;
};
function temporary(run: (root: string) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'klaus-edition-core-'));
  try { run(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

h.test('canonical defaults bind services and identity independently of language', () => {
  for (const expected of vectors.defaults) {
    const edition = getDesktopEdition(expected.edition);
    assert.equal(edition.serverUrl, expected.serverUrl);
    assert.equal(edition.productName, expected.productName);
    assert.equal(edition.application, expected.application);
    const publicValue = publicDesktopDistribution(edition);
    assert.equal(publicValue.edition, expected.edition);
    assert.equal(publicValue.serverUrl, expected.serverUrl);
    assert.equal(publicValue.siteUrl, expected.serverUrl);
    assert.equal(Object.isFrozen(publicValue), true);
  }
  assert.equal(resolveDesktopEditionId({ klausDesktopLayoutVersion: 1, klausDesktopEdition: 'international' }, { KLAUS_DESKTOP_EDITION: 'domestic', LANG: 'zh_CN' }), 'international');
  assert.equal(resolveDesktopEditionId({ klausDesktopLayoutVersion: 1 }, { KLAUS_DESKTOP_EDITION: 'international' }), 'domestic');
  assert.throws(() => resolveDesktopEditionId({ klausDesktopLayoutVersion: 2 }, {}), /layout/);
  assert.throws(() => getDesktopEdition('preview'), /Unknown desktop edition/);
  assert.throws(() => getDesktopEdition('Preview'), /edition id/);
});

h.test('account defaults follow the build edition without issuing requests', () => {
  const originalEdition = process.env.KLAUS_DESKTOP_EDITION, originalServer = process.env.KLAUS_SERVER_URL;
  delete process.env.KLAUS_SERVER_URL;
  try {
    temporary(root => {
      for (const expected of vectors.defaults) {
        process.env.KLAUS_DESKTOP_EDITION = expected.edition;
        const service = new AccountService({ configRoot: join(root, expected.edition), appVersion: '1.0.0', request: async () => null,
          openExternal: async () => { throw new Error('No external access expected'); }, push: () => {}, onAuthChanged: () => {},
          fetch: async () => { throw new Error('No network access expected'); } });
        assert.equal(service.serverUrl, expected.serverUrl);
      }
    });
  } finally {
    if (originalEdition === undefined) delete process.env.KLAUS_DESKTOP_EDITION; else process.env.KLAUS_DESKTOP_EDITION = originalEdition;
    if (originalServer === undefined) delete process.env.KLAUS_SERVER_URL; else process.env.KLAUS_SERVER_URL = originalServer;
  }
});

h.test('both editions keep engine directories profile-local despite inherited overrides', () => {
  for (const expected of vectors.defaults) {
    const root = join(tmpdir(), 'isolated-engine-profiles', expected.edition);
    const environment = desktopEngineEnvironment(root, { PATH: join(root, 'absent-node-path') }, process.execPath);
    assert.deepEqual(environment, [
      ['KLAUS_CONFIG_DIR', root], ['KLAUS_PLUGIN_HOME', join(root, 'plugins')], ['KLAUS_SESSION_DIR', join(root, 'sessions')],
      ['KLAUS_NODE', process.execPath], ['ELECTRON_RUN_AS_NODE', '1'],
    ]);
    const inherited = effectiveEnv({ command: 'fixture-engine', args: [], env: environment }, {
      KLAUS_PLUGIN_HOME: join(tmpdir(), 'foreign-profile', 'plugins'),
      KLAUS_SESSION_DIR: join(tmpdir(), 'foreign-profile', 'sessions'),
    });
    const paths = Object.fromEntries(inherited);
    assert.equal(paths.KLAUS_PLUGIN_HOME, join(root, 'plugins'));
    assert.equal(paths.KLAUS_SESSION_DIR, join(root, 'sessions'));
  }
});

h.test('engine env carries the bundled Node runtime when PATH cannot resolve node', () => {
  temporary(root => {
    const configRoot = join(root, 'cfg');
    const emptyDir = join(root, 'empty');
    mkdirSync(emptyDir, { recursive: true });
    const appBinary = join(root, 'Klaus');
    writeFileSync(appBinary, '');
    const trio: Array<[string, string]> = [
      ['KLAUS_CONFIG_DIR', configRoot], ['KLAUS_PLUGIN_HOME', join(configRoot, 'plugins')], ['KLAUS_SESSION_DIR', join(configRoot, 'sessions')],
    ];
    assert.deepEqual(desktopEngineEnvironment(configRoot, { PATH: emptyDir }, appBinary), [
      ...trio, ['KLAUS_NODE', appBinary], ['ELECTRON_RUN_AS_NODE', '1'],
    ]);
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'node'), '');
    assert.deepEqual(desktopEngineEnvironment(configRoot, { PATH: binDir }, appBinary), trio);
    assert.deepEqual(desktopEngineEnvironment(configRoot, { PATH: emptyDir, KLAUS_NODE: '/custom/node' }, appBinary), trio);
    assert.deepEqual(desktopEngineEnvironment(configRoot, { PATH: emptyDir }, join(emptyDir, 'Klaus')), trio);
  });
});

h.test('node resolution honors Windows PATH separators and executable names', () => {
  const seen: string[] = [];
  const exists = (candidate: string): boolean => { seen.push(candidate); return candidate === 'C:\\tools\\node.exe'; };
  assert.equal(nodeResolvableInPath('C:\\bare;C:\\tools', ';', '\\', ['node.exe'], exists), true);
  assert.ok(seen.includes('C:\\bare\\node.exe'));
  assert.equal(nodeResolvableInPath('/usr/bin:/bin', ':', '/', ['node'], () => false), false);
});

h.test('public metadata strips URL credentials without changing the edition site', () => {
  const metadata = publicDesktopDistribution(getDesktopEdition('international'), 'https://fixture-user:fixture-secret@api.example.invalid/proxy');
  assert.equal(metadata.serverUrl, 'https://api.example.invalid/proxy');
  assert.equal(metadata.siteUrl, 'https://klaus-ai.site');
  assert.throws(() => publicDesktopDistribution(getDesktopEdition(), 'javascript:fixture'), /URL/);
});

h.test('shared Chrome extension discovery stays bound to the selected desktop edition', () => {
  const domestic = chromeDiscoveryDirectory('domestic');
  const international = chromeDiscoveryDirectory('international');
  assert.equal(basename(domestic), 'klaus-browser-use');
  assert.equal(basename(international), 'klaus-browser-use-international');
  assert.notEqual(domestic, international);
  const previous = process.env.KLAUS_DESKTOP_EDITION;
  try {
    process.env.KLAUS_DESKTOP_EDITION = 'international';
    assert.equal(chromeDiscoveryDirectory(), international);
    process.env.KLAUS_DESKTOP_EDITION = 'domestic';
    assert.equal(chromeDiscoveryDirectory(), domestic);
  } finally {
    if (previous === undefined) delete process.env.KLAUS_DESKTOP_EDITION;
    else process.env.KLAUS_DESKTOP_EDITION = previous;
  }
});

h.test('custom profiles are permanently owned by one edition and legacy domestic data is not changed', () => {
  temporary(root => {
    const domestic = getDesktopEdition(), international = getDesktopEdition('international');
    const legacy = join(root, 'legacy'); mkdirSync(legacy);
    const original = Buffer.from('fixture-existing-data'); writeFileSync(join(legacy, 'settings.db'), original);
    claimDesktopProfileEdition(legacy, domestic);
    assert.deepEqual(readFileSync(join(legacy, 'settings.db')), original);
    assert.throws(() => claimDesktopProfileEdition(legacy, international), /another desktop edition/);
    const fresh = join(root, 'international');
    claimDesktopProfileEdition(fresh, international); claimDesktopProfileEdition(fresh, international);
    assert.throws(() => assertDesktopProfileEdition(fresh, domestic), /another desktop edition/);
    assert.equal(existsSync(join(fresh, '.desktop-edition.json')), true);
    const unmarked = join(root, 'unmarked'); mkdirSync(unmarked); writeFileSync(join(unmarked, 'klaus-auth.json'), 'fixture-not-read');
    assert.throws(() => claimDesktopProfileEdition(unmarked, international), /fresh data profile/);
    assert.equal(existsSync(join(unmarked, '.desktop-edition.json')), false);
    const invalid = join(root, 'invalid'); mkdirSync(invalid);
    symlinkSync(join(root, 'missing-marker'), join(invalid, '.desktop-edition.json'));
    assert.throws(() => assertDesktopProfileEdition(invalid, international), /ownership record/);
  });
});

h.test('macOS signature identity and Computer Use self permissions do not cross editions', () => {
  for (const expected of vectors.defaults) {
    const edition = getDesktopEdition(expected.edition), other = getDesktopEdition(expected.edition === 'domestic' ? 'international' : 'domestic');
    const signature = `Identifier=${edition.application}\nTeamIdentifier=ABCDE12345\nAuthority=Developer ID Application: Fixture\n`;
    assertMacApplicationSignature(signature, { application: edition.application, teamId: 'ABCDE12345' });
    assert.throws(() => assertMacApplicationSignature(signature, { application: other.application, teamId: 'ABCDE12345' }), /another desktop edition/);
    const bundle = `/fixture/${edition.productName}.app`, executable = bundle + `/Contents/MacOS/${edition.executableName}`;
    assert.equal(computerUseSelfAppMatches({ input: edition.productName, path: bundle, bundleId: edition.application }, executable, 'darwin', edition), true);
    assert.equal(computerUseSelfAppMatches({ input: other.productName, path: bundle, bundleId: other.application }, executable, 'darwin', edition), false);
  }
});


// A third edition defined only in a temporary definitions file, the way an
// edition outside the repository is supplied to a development run.
const definitionVectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/desktop-edition-definition-vectors.json'), 'utf8')) as {
  extra: Record<string, unknown>;
  accepted: Array<{ name: string; patch: Record<string, unknown> }>;
  rejected: Array<{ name: string; patch: Record<string, unknown>; error: string }>;
  rejectedIds: string[];
  conflictingRedefinition: { edition: string; patch: Record<string, unknown>; error: string };
};
const committedDefinitions = JSON.parse(readFileSync(join(__dirname, '../../contracts/desktop-editions.json'), 'utf8')) as { schemaVersion: 1; editions: Record<string, unknown> };
function patched(patch: Record<string, unknown>): Record<string, unknown> {
  const value: Record<string, unknown> = { ...definitionVectors.extra, ...patch };
  for (const [key, item] of Object.entries(patch)) if (item === null) delete value[key];
  return value;
}
function withExtraEdition<T>(run: (env: NodeJS.ProcessEnv, sample: DesktopEdition, root: string) => T): T {
  const root = mkdtempSync(join(tmpdir(), 'klaus-edition-extra-'));
  const file = join(root, 'editions.json');
  writeFileSync(file, JSON.stringify({ schemaVersion: 1, editions: { sample: definitionVectors.extra } }));
  const env: NodeJS.ProcessEnv = { ...process.env, KLAUS_DESKTOP_EDITIONS_FILE: file };
  try { return run(env, getDesktopEdition('sample', env), root); } finally { rmSync(root, { recursive: true, force: true }); }
}

h.test('definition documents accept and refuse the shared vector cases', () => {
  for (const item of definitionVectors.accepted) {
    const editions = validateDesktopEditionDocuments([committedDefinitions, { schemaVersion: 1, editions: { sample: patched(item.patch) } }]);
    assert.equal(editions.sample?.legacyIdentity, false, item.name);
    assert.equal(editions.domestic?.legacyIdentity, true, item.name);
  }
  for (const item of definitionVectors.rejected) {
    assert.throws(() => validateDesktopEditionDocuments([committedDefinitions, { schemaVersion: 1, editions: { sample: patched(item.patch) } }]),
      (error: Error) => error.message.includes(item.error), item.name);
  }
  for (const id of definitionVectors.rejectedIds) {
    assert.throws(() => validateDesktopEditionDocuments([committedDefinitions, { schemaVersion: 1, editions: { [id]: { ...definitionVectors.extra, id } } }]), /edition/, id);
  }
  const conflict = definitionVectors.conflictingRedefinition;
  const redefined = { ...(committedDefinitions.editions[conflict.edition] as Record<string, unknown>), ...conflict.patch };
  assert.throws(() => validateDesktopEditionDocuments([committedDefinitions, { schemaVersion: 1, editions: { [conflict.edition]: redefined } }]), (error: Error) => error.message.includes(conflict.error));
  // Repeating a public edition verbatim is harmless.
  const domestic = committedDefinitions.editions.domestic;
  assert.equal(validateDesktopEditionDocuments([committedDefinitions, { schemaVersion: 1, editions: { domestic } }]).domestic?.id, 'domestic');
  assert.throws(() => validateDesktopEditionDocuments([{ schemaVersion: 2, editions: {} }]), /Unsupported/);
});

h.test('an edition from the definitions file loads only in an unpackaged checkout', () => {
  withExtraEdition((env, sample) => {
    assert.equal(sample.application, definitionVectors.extra.application);
    assert.equal(sample.legacyIdentity, false);
    assert.deepEqual(Object.keys(loadedDesktopEditions(env)).sort(), ['domestic', 'international', 'sample']);
    assert.equal(desktopEditionSources(env, {}).length, 2);
    assert.equal(desktopEditionSources(env, { klausDesktopLayoutVersion: 1, klausDesktopEdition: 'sample' }).length, 1, 'a packaged app reads only its own definitions');
    assert.equal(resolveDesktopEditionId({}, { ...env, KLAUS_DESKTOP_EDITION: 'sample' }), 'sample');
    assert.throws(() => desktopEditionSources({ KLAUS_DESKTOP_EDITIONS_FILE: 'relative/editions.json' }, {}), /absolute/);
    assert.throws(() => getDesktopEdition('sample', { ...env, KLAUS_DESKTOP_EDITIONS_FILE: '' }), /Unknown desktop edition/);
  });
});

h.test('a third edition owns its profile and refuses every other edition profile in both directions', () => {
  withExtraEdition((env, sample, root) => {
    const nodeEnv = process.env.NODE_ENV, test = process.env.KLAUS_TEST;
    delete process.env.NODE_ENV; delete process.env.KLAUS_TEST;
    try {
      const home = { ...env, HOME: root, KLAUS_CONFIG_DIR: undefined };
      assert.equal(configRootFrom({ ...home, KLAUS_DESKTOP_EDITION: 'sample' }, sample), canonicalProfilePath(join(root, sample.configDirectory)));
      for (const other of ['domestic', 'international']) {
        const otherEdition = getDesktopEdition(other, env);
        assert.throws(() => configRootFrom({ ...home, KLAUS_CONFIG_DIR: join(root, otherEdition.configDirectory) }, sample), /another edition/);
        assert.throws(() => configRootFrom({ ...home, KLAUS_CONFIG_DIR: join(root, sample.configDirectory) }, otherEdition), /another edition/);
      }
      assert.throws(() => configRootFrom({ ...home, KLAUS_CONFIG_DIR: ' ' }, sample), /whitespace/);
      const unmarked = join(root, 'unmarked'); mkdirSync(unmarked); writeFileSync(join(unmarked, 'settings.db'), 'fixture-not-read');
      assert.throws(() => claimDesktopProfileEdition(unmarked, sample), /fresh data profile/);
      const fresh = join(root, 'fresh');
      claimDesktopProfileEdition(fresh, sample);
      assert.deepEqual(JSON.parse(readFileSync(join(fresh, '.desktop-edition.json'), 'utf8')), { schemaVersion: 1, edition: 'sample', application: sample.application });
      assert.throws(() => assertDesktopProfileEdition(fresh, getDesktopEdition('domestic', env)), /another desktop edition/);
    } finally {
      if (nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = nodeEnv;
      if (test === undefined) delete process.env.KLAUS_TEST; else process.env.KLAUS_TEST = test;
    }
  });
});

h.test('a third edition binds Chrome discovery, updates, instance identity and self detection to its own data', () => {
  withExtraEdition((env, sample) => {
    const previous = process.env.KLAUS_DESKTOP_EDITIONS_FILE;
    process.env.KLAUS_DESKTOP_EDITIONS_FILE = env.KLAUS_DESKTOP_EDITIONS_FILE;
    try {
      assert.equal(basename(chromeDiscoveryDirectory('sample')), sample.chromeDiscoveryName);
      const policy = productionPolicy({ application: sample.application, platform: 'darwin', arch: 'arm64', currentVersion: '1.0.0', channel: 'stable', feedUrl: 'https://desktop.example.invalid/feed' });
      assert.equal(policy.application, sample.application);
      assert.throws(() => productionPolicy({ application: 'invalid.example.unknown', platform: 'darwin', arch: 'arm64', currentVersion: '1.0.0', channel: 'stable', feedUrl: 'https://desktop.example.invalid/feed' }), /application/);
      assert.equal(isDesktopEditionBundle(sample.application.toUpperCase(), env), true);
      assert.equal(isDesktopEditionBundle('invalid.example.other', env), false);
      for (const app of [{ input: sample.productName }, { input: 'Other', bundleId: sample.application }, { input: 'Other', bundleId: sample.helperApplication }]) {
        assert.equal(isHostProductApp(app), true, JSON.stringify(app));
      }
      assert.equal(isHostProductApp({ input: 'Notes', bundleId: 'com.apple.Notes' }), false);
      const bundle = `/fixture/${sample.productName}.app`;
      assert.equal(computerUseSelfAppMatches({ input: sample.productName, path: bundle, bundleId: sample.application }, `${bundle}/Contents/MacOS/${sample.executableName}`, 'darwin', sample), true);
      const fixtureEnv = { ...env, KLAUS_TEST: '1', KLAUS_INSTANCE_FIXTURE_ID: 'ai.klaus.instance-fixture.fake' };
      assert.equal(instanceIdentity({ application: sample.application, packaged: false, configRoot: '/missing', defaultConfigRoot: '/default', env: fixtureEnv }), sample.application);
      assert.throws(() => instanceIdentity({ application: 'invalid.example.unknown', packaged: true, configRoot: '/fixture', defaultConfigRoot: '/default', env }), /identity/);
    } finally {
      if (previous === undefined) delete process.env.KLAUS_DESKTOP_EDITIONS_FILE; else process.env.KLAUS_DESKTOP_EDITIONS_FILE = previous;
    }
  });
});

h.test('a third edition credential namespace requires an addon that can isolate it', () => {
  withExtraEdition((_env, sample, root) => {
    let constructed: unknown[] = [];
    const binding = class { constructor(...values: unknown[]) { constructed = values; } };
    const current = { credentialKeychainServiceAccepted: (service: string) => /^agent-engine(?:-[a-z0-9]+)*$/.test(service), NativeCredentials: binding } as unknown as NativeAddon;
    new NativeSubscriptionCredentials({ configRoot: root, userHome: root, keychainService: sample.keychainService, addon: current });
    assert.equal(constructed[3], sample.keychainService);
    constructed = [];
    const legacy = { credentialKeychainServices: () => ['agent-engine', 'agent-engine-international'], NativeCredentials: binding } as unknown as NativeAddon;
    assert.throws(() => new NativeSubscriptionCredentials({ configRoot: root, userHome: root, keychainService: sample.keychainService, addon: legacy }), /CREDENTIALS_EDITION_UNSUPPORTED/);
    const oldest = { NativeCredentials: binding } as unknown as NativeAddon;
    assert.throws(() => new NativeSubscriptionCredentials({ configRoot: root, userHome: root, keychainService: sample.keychainService, addon: oldest }), /CREDENTIALS_EDITION_UNSUPPORTED/);
    assert.deepEqual(constructed, [], 'no native resource is constructed for a refused namespace');
    new NativeSubscriptionCredentials({ configRoot: root, userHome: root, keychainService: 'agent-engine', addon: oldest });
    assert.throws(() => new NativeSubscriptionCredentials({ configRoot: root, userHome: root, keychainService: 'sample', addon: current }), /INVALID_KEYCHAIN_SERVICE/);
  });
});

void h.finish(join(__dirname, 'desktop-edition-result.json'), 'desktop-edition').then(code => { process.exitCode = code; });
