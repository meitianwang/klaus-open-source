import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import plist from 'plist';
import { desktopEdition, candidateEdition, indexEdition, loadedDesktopEditions, packagedDesktopEditionDocument, publicDesktopEditionDocument, useDesktopEditionsFile, validateDesktopEditionDocuments } from './desktop-edition.mjs';
import { installerConfiguration, macDmgConfiguration, prepareInstallerInclude } from './installers.mjs';
import { createSignedRelease } from './release.mjs';
import { releaseIdentity } from './release-metadata.mjs';
import { bundleInventory, fileProof } from './release-io.mjs';
import { indexEntries, mergeReleaseIndexes, verifyReleaseEntry } from './release-index.mjs';
import { verifyReceiptIntegrity } from './release-receipt.mjs';
import { SshReleaseStore, publishRelease } from './release-publish.mjs';
import { renewReleaseMetadata } from './release-renew.mjs';
import { macSigningOptions } from './macos-signing.mjs';
import { parseCodeIdentity, verifyMacBundle } from './release-macos.mjs';
import { verifyMacPackageIdentity } from './verify.mjs';
import { signedTestMetadata } from './verify-test-package.mjs';

const require = createRequire(import.meta.url), { updateFixture } = require('../dist/tests/updater-fixture.js');
const rootUrl = new URL('..', import.meta.url), assets = fileURLToPath(new URL('./assets/', import.meta.url));
const version = '1.2.3', teamId = 'ABCDE12345', signingIdentity = `Developer ID Application: Fixture (${teamId})`;
const commit = 'a'.repeat(40), engineCommit = 'b'.repeat(40);
async function temporary(callback) {
  const root = await mkdtemp(join(tmpdir(), 'klaus-edition-test-'));
  try { return await callback(root); } finally { await rm(root, { recursive: true, force: true }); }
}
const details = application => `Identifier=${application}\nAuthority=${signingIdentity}\nTeamIdentifier=${teamId}\nTimestamp=fixture\nCodeDirectory flags=0x10000(runtime)\nCDHash=${'c'.repeat(40)}\n`;

test('canonical editions drive installer identities, output names, deep links, volumes and launcher defaults', async () => temporary(async root => {
  const definitions = JSON.parse(await readFile(new URL('../contracts/desktop-editions.json', import.meta.url)));
  for (const id of ['domestic', 'international']) {
    const edition = desktopEdition(id);
    assert.deepEqual(edition, { ...definitions.editions[id] });
    const include = prepareInstallerInclude({ directory: root, assets, edition: id });
    for (const platform of ['darwin', 'win32']) {
      const arch = platform === 'darwin' ? 'arm64' : 'x64';
      const config = installerConfiguration({ platform, arch, version, electronVersion: '44.2.0', output: root, assets, edition: id, installerInclude: include });
      assert.equal(config.appId, edition.application);
      assert.equal(config.executableName, edition.executableName);
      assert.equal(config.productName, edition.productName);
      assert.equal(config.nsis.guid, edition.nsisGuid);
      assert.deepEqual(config.protocols[0].schemes, [edition.protocol]);
      assert.equal(config.extraMetadata.klausDesktopEdition, id);
      assert.equal(config.extraMetadata.klausDesktopLayoutVersion, 1);
      assert(config[platform === 'darwin' ? 'mac' : 'win'].artifactName.startsWith(`${edition.artifactPrefix}-`));
      assert.equal(config.nsis.deleteAppDataOnUninstall, false);
      assert.equal(config.win.verifyUpdateCodeSignature, true);
    }
    const dmg = macDmgConfiguration({ version, arch: 'arm64', edition: id });
    assert.equal(dmg.title, edition.productName);
    assert.equal(dmg.artifactName, `${edition.artifactPrefix}-${version}-darwin-arm64.dmg`);
    const hook = await readFile(include, 'utf8');
    assert(hook.startsWith(`!define KLAUS_CONFIG_DIRECTORY "${edition.configDirectory}"\n`));
    assert(hook.includes('ReadEnvStr $R6 "KLAUS_CONFIG_DIR"'));
    assert(hook.includes(`!define KLAUS_DESKTOP_EDITION "${id}"`));
    assert(hook.includes(`!define KLAUS_APPLICATION "${edition.application}"`));
    assert(hook.includes(`!define KLAUS_LEGACY_IDENTITY "${edition.legacyIdentity ? 1 : 0}"`));
    assert(!hook.includes('== "domestic"'), 'the installer script keys legacy behavior on the injected flag, not an edition id');
    assert(hook.includes('.desktop-edition.json'));
    assert(hook.includes('$PROFILE\\${KLAUS_CONFIG_DIRECTORY}'));
    assert(hook.includes('klaus-chrome-host.cmd.updating'));
    const identity = releaseIdentity({ edition: id, platform: 'darwin', arch: 'arm64', version, channel: 'stable' });
    assert.equal(identity.application, edition.application);
    assert.equal(new URL(identity.feedUrl).origin, edition.serverUrl);
    const options = macSigningOptions({ app: join(root, `${edition.productName}.app`), arch: 'arm64', identity: signingIdentity, electronVersion: '44.2.0', edition: id });
    assert(options.optionsForFile(join(options.app, `Contents/MacOS/${edition.executableName}`)).entitlements.includes('com.apple.security.cs.allow-jit'));
    const info = { CFBundleIdentifier: edition.application, CFBundleExecutable: edition.executableName, CFBundleURLTypes: [{ CFBundleURLSchemes: [edition.protocol] }] };
    verifyMacPackageIdentity(plist.build(info), edition);
    assert.throws(() => verifyMacPackageIdentity(plist.build({ ...info, CFBundleIdentifier: desktopEdition(id === 'domestic' ? 'international' : 'domestic').application }), edition), /identity mismatch/);
  }
  assert.throws(() => installerConfiguration({ platform: 'win32', arch: 'x64', version, electronVersion: '44.2.0', output: root, assets, edition: 'international' }), /scoped include/);
  assert.throws(() => desktopEdition('preview'), /Unknown desktop edition/);
  assert.equal(candidateEdition({}).id, 'domestic');
  assert.equal(candidateEdition({ edition: 'international' }).id, 'international');
  assert.throws(() => candidateEdition({ edition: 'international' }, 'domestic'), /mismatch/);
  assert.throws(() => candidateEdition({ edition: 'international', application: desktopEdition().application }), /mismatch/);
  for (const origin of ['http://invalid.example', 'https://user@invalid.example', 'https://invalid.example/path']) {
    assert.throws(() => releaseIdentity({ edition: 'international', platform: 'darwin', arch: 'arm64', version, channel: 'stable', origin }), /HTTPS origin/);
  }
}));

async function signedFixture(root, fixture, id, platform, configured = true) {
  const edition = desktopEdition(id), arch = platform === 'darwin' ? 'arm64' : 'x64', target = `${platform}-${arch}`;
  const candidate = join(root, `${id}-candidate${platform === 'darwin' ? '.app' : ''}`), resourcePath = platform === 'darwin' ? 'Contents/Resources' : 'resources';
  const path = platform === 'darwin' ? `Contents/MacOS/${edition.executableName}` : `${edition.executableName}.exe`;
  await mkdir(join(candidate, resourcePath), { recursive: true }); await mkdir(join(candidate, path, '..'), { recursive: true });
  const binary = Buffer.alloc(128);
  if (platform === 'darwin') { binary.writeUInt32LE(0xfeedfacf); binary.writeUInt32LE(0x100000c, 4); binary.writeUInt32LE(2, 12); }
  else { binary.writeUInt16LE(0x5a4d); binary.writeUInt32LE(64, 60); binary.writeUInt32LE(0x4550, 64); binary.writeUInt16LE(0x8664, 68); }
  await writeFile(join(candidate, path), binary); await writeFile(join(candidate, resourcePath, 'app.asar'), 'fixture immutable bytes');
  const source = { bundle: candidate, edition: id, application: edition.application, buildKind: 'local-unsigned', clientTreeDirty: false,
    clientCommit: commit, engineCommit, recordedEngineCommit: engineCommit, version, target, electronVersion: '44.2.0', engineSha256: 'd'.repeat(64), nativeSha256: 'e'.repeat(64) };
  const signer = { key: fixture.key, preflight: async () => {}, sign: async file => fixture.signed(await readFile(file)) };
  const proof = async ({ bundle, edition: selected }) => {
    if (selected !== undefined) assert.equal(selected, id);
    return { platform, verified: true, ...(platform === 'darwin' ? { teamId } : { publisher: 'CN=Fixture' }), binaries: [{ path }] };
  };
  const dependencies = { signer, currentCheckout: async () => ({ commit, engineCommit, version, platform, arch }), inspect: bundle => ({ ...source, bundle }),
    run: async (command, args) => ({ stdout: command === 'codesign' && args[0] === '--display' ? details(edition.application) : '', stderr: '' }),
    signMac: proof, verifyMac: proof, windowsSignatures: proof, verifyWindows: async () => ({ verified: true }),
    notarize: async () => ({ status: 'Accepted', id: '12345678-1234-1234-1234-123456789abc' }), staple: async () => {},
    zip: async (_bundle, file) => writeFile(file, 'fixture ZIP, never installed'),
    buildInstaller: async ({ output, edition: selected }) => {
      assert.equal(selected.id, id);
      const file = join(output, `${edition.artifactPrefix}-${version}-${target}${platform === 'darwin' ? '.dmg' : '-setup.exe'}`);
      await writeFile(file, 'fixture installer, never installed'); return [file];
    } };
  const options = { bundle: candidate, out: join(root, `${id}-signed`), mac: { identity: signingIdentity, teamId, credentials: {} },
    ...(platform === 'win32' && configured ? { windows: { signtool: '/fixture/signtool.exe', certificateSha1: 'c'.repeat(40), publisher: 'CN=Fixture', timestampUrl: 'https://timestamp.example.invalid' } } : {}) };
  const original = await bundleInventory(candidate);
  const result = await createSignedRelease(options, dependencies);
  assert.deepEqual(await bundleInventory(candidate), original);
  await assert.rejects(createSignedRelease({ ...options, out: join(root, 'wrong-edition'), edition: id === 'domestic' ? 'international' : 'domestic' }, dependencies), /edition mismatch/);
  await assert.rejects(createSignedRelease(options, dependencies), /EEXIST/);
  return { result, source, signer };
}

for (const platform of ['darwin', 'win32']) for (const configured of platform === 'darwin' ? [true] : [true, false]) {
  test(`${platform} regional releases isolate same-key same-version envelopes and receipts with ${configured ? 'platform signing' : 'Minisign-only Windows'}`, async () => temporary(async root => {
    const fixture = updateFixture(), releases = {};
    for (const id of ['domestic', 'international']) {
      const edition = desktopEdition(id), { result, signer } = await signedFixture(root, fixture, id, platform, configured);
      releases[id] = result;
      assert.equal(result.manifest.edition, id); assert.equal(result.release.application, edition.application);
      assert(result.receiptFile.includes(`${edition.artifactPrefix}-${version}-stable-`));
      const item = indexEntries(result.manifest)[0];
      const verification = { ...item, edition: id, read: name => readFile(join(result.output, name)), proof: name => fileProof(join(result.output, name)), localPath: name => join(result.output, name), key: fixture.key };
      assert.equal((await verifyReleaseEntry(verification)).receipt.application, edition.application);
      const wrong = id === 'domestic' ? 'international' : 'domestic';
      await assert.rejects(verifyReleaseEntry({ ...verification, edition: wrong }), /product or framework mismatch/);
      await verifyReceiptIntegrity(result.bundle, result.receiptFile, { application: edition.application, key: fixture.key });
      const receipt = JSON.parse(await readFile(result.receiptFile));
      receipt.unsigned.source.verified = true;
      const projection = signedTestMetadata(result.bundle, receipt, { edition: id, application: edition.application, receiptVerified: true,
        signatureVerified: configured, target: item.target, version, ...(!configured ? { authenticode: 'not-configured', integrityVerified: true } : {}) });
      assert.equal(projection.executable, join(result.bundle, platform === 'darwin' ? `Contents/MacOS/${edition.executableName}` : `${edition.executableName}.exe`));
      await assert.rejects(verifyReceiptIntegrity(result.bundle, result.receiptFile, { application: desktopEdition(wrong).application, key: fixture.key }), /Unknown signed package receipt/);
      const renewed = await renewReleaseMetadata({ edition: id, directory: result.output, out: join(root, `${id}-renewed`) }, { signer, verify: options => verifyReleaseEntry({ ...options, key: fixture.key }) });
      assert.equal(renewed.manifest.edition, id);
      assert.deepEqual(await readFile(join(renewed.output, basename(result.receiptFile))), await readFile(result.receiptFile));
      assert(!(await readdir(result.output)).some(name => name.startsWith('.release-work-')));
      const envelope = JSON.parse(await readFile(join(result.output, item.entry.envelopeFile)));
      const { parseInstalledUpdateConfiguration } = require('../dist/main/updater/configuration.js');
      const policyBytes = await readFile(join(result.bundle, platform === 'darwin' ? 'Contents/Resources/electron-update.json' : 'resources/electron-update.json'));
      assert.equal(parseInstalledUpdateConfiguration(JSON.parse(policyBytes), { application: edition.application, platform, arch: result.release.arch, version }, fixture.key).application, edition.application);
      assert.throws(() => parseInstalledUpdateConfiguration(JSON.parse(policyBytes), { application: desktopEdition(wrong).application, platform, arch: result.release.arch, version }, fixture.key), /identity/);
      assert.equal(JSON.parse(Buffer.from(envelope.payload, 'base64')).application, edition.application);
    }
    for (const [local, remote] of [['domestic', 'international'], ['international', 'domestic']]) {
      assert.throws(() => mergeReleaseIndexes(releases[local].manifest, releases[remote].manifest), /different desktop editions/);
      let reads = 0;
      const store = { read: async () => { reads++; return Buffer.from(JSON.stringify(releases[remote].manifest)); } };
      await assert.rejects(publishRelease({ localDirectory: releases[local].output, edition: remote }, { remote: store }), /Local release index edition mismatch/);
      assert.equal(reads, 0);
      await assert.rejects(publishRelease({ localDirectory: releases[local].output, edition: local }, { remote: store }), /Remote release index edition mismatch/);
      assert.equal(reads, 1);
    }
  }));
}

test('every edition upload requires an explicit SSH host before any remote invocation', async () => {
  let calls = 0;
  for (const edition of ['domestic', 'international']) {
    assert.throws(() => new SshReleaseStore({ edition, run: async () => { calls++; } }), /explicit SSH host/);
    assert.throws(() => execFileSync(process.execPath, ['scripts/publish-electron-release.mjs', '--edition', edition, '--verify-only'], {
      cwd: rootUrl, env: { ...process.env, KLAUS_SSH_HOST: '' }, encoding: 'utf8', stdio: 'pipe',
    }), error => error.status === 1 && error.stderr.includes('explicit SSH host'));
  }
  assert.equal(calls, 0);
  assert.equal(new SshReleaseStore({ edition: 'international', host: 'explicit-release-fixture' }).host, 'explicit-release-fixture');
  await assert.rejects(publishRelease({ edition: 'international', verifyOnly: true }, { remote: new SshReleaseStore({ edition: 'domestic', host: 'explicit-release-fixture' }) }), /store edition mismatch/);
});

const definitionVectors = JSON.parse(await readFile(new URL('../contracts/vectors/desktop-edition-definition-vectors.json', import.meta.url)));
function patched(patch) {
  const value = { ...definitionVectors.extra, ...patch };
  for (const [key, item] of Object.entries(patch)) if (item === null) delete value[key];
  return value;
}

test('the packaging validator accepts and refuses the same definition vector cases as the host validator', () => {
  const committed = publicDesktopEditionDocument();
  for (const item of definitionVectors.accepted) {
    const editions = validateDesktopEditionDocuments([committed, { schemaVersion: 1, editions: { sample: patched(item.patch) } }]);
    assert.equal(editions.sample.legacyIdentity, false, item.name);
  }
  for (const item of definitionVectors.rejected) {
    assert.throws(() => validateDesktopEditionDocuments([committed, { schemaVersion: 1, editions: { sample: patched(item.patch) } }]), error => error.message.includes(item.error), item.name);
  }
  for (const id of definitionVectors.rejectedIds) {
    assert.throws(() => validateDesktopEditionDocuments([committed, { schemaVersion: 1, editions: { [id]: { ...definitionVectors.extra, id } } }]), /edition/, id);
  }
  const conflict = definitionVectors.conflictingRedefinition;
  assert.throws(() => validateDesktopEditionDocuments([committed, { schemaVersion: 1, editions: { [conflict.edition]: { ...committed.editions[conflict.edition], ...conflict.patch } } }]), error => error.message.includes(conflict.error));
});

test('a third edition from a definitions file drives installers, release identity and the packaged definitions', async () => temporary(async root => {
  const file = join(root, 'editions.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 1, editions: { sample: definitionVectors.extra } }));
  const previous = process.env.KLAUS_DESKTOP_EDITIONS_FILE;
  try {
    assert.throws(() => useDesktopEditionsFile('relative/editions.json', {}), /absolute/);
    assert.throws(() => desktopEdition('sample'), /Unknown desktop edition/);
    useDesktopEditionsFile(file);
    const sample = desktopEdition('sample');
    assert.deepEqual(Object.keys(loadedDesktopEditions()).sort(), ['domestic', 'international', 'sample']);
    assert.throws(() => installerConfiguration({ platform: 'win32', arch: 'x64', version, electronVersion: '44.2.0', output: root, assets, edition: 'sample' }), /scoped include/);
    const include = prepareInstallerInclude({ directory: root, assets, edition: 'sample' });
    const hook = await readFile(include, 'utf8');
    for (const line of [`!define KLAUS_CONFIG_DIRECTORY "${sample.configDirectory}"`, `!define KLAUS_DESKTOP_EDITION "sample"`, `!define KLAUS_APPLICATION "${sample.application}"`, '!define KLAUS_LEGACY_IDENTITY "0"']) assert(hook.includes(line), line);
    const config = installerConfiguration({ platform: 'win32', arch: 'x64', version, electronVersion: '44.2.0', output: root, assets, edition: 'sample', installerInclude: include });
    assert.equal(config.appId, sample.application); assert.equal(config.nsis.guid, sample.nsisGuid); assert.deepEqual(config.protocols[0].schemes, [sample.protocol]);
    assert.equal(config.extraMetadata.klausDesktopEdition, 'sample');
    const identity = releaseIdentity({ edition: 'sample', platform: 'darwin', arch: 'arm64', version, channel: 'stable' });
    assert.equal(identity.application, sample.application); assert.equal(new URL(identity.feedUrl).origin, sample.serverUrl);
    assert.throws(() => indexEdition({ edition: 'sample' }), /requires an application/);
    assert.equal(indexEdition({ edition: 'sample', application: sample.application }).id, 'sample');
    assert.equal(indexEdition({}).id, 'domestic');
    const packaged = packagedDesktopEditionDocument('sample');
    assert.deepEqual(Object.keys(packaged.editions).sort(), ['domestic', 'international', 'sample']);
    assert.deepEqual(packaged.editions.sample, { ...sample });
    assert.deepEqual(packagedDesktopEditionDocument('domestic'), publicDesktopEditionDocument(), 'a public package carries only the public definitions');
    assert.equal(validateDesktopEditionDocuments([packaged]).sample.application, sample.application);
  } finally {
    if (previous === undefined) delete process.env.KLAUS_DESKTOP_EDITIONS_FILE; else process.env.KLAUS_DESKTOP_EDITIONS_FILE = previous;
  }
}));

test('macOS regional primary executables require exact signed application identity and privacy permissions', async () => temporary(async root => {
  const edition = desktopEdition('international'), bundle = join(root, `${edition.productName}.app`), path = `Contents/MacOS/${edition.executableName}`;
  await mkdir(join(bundle, path, '..'), { recursive: true });
  const binary = Buffer.alloc(128); binary.writeUInt32LE(0xfeedfacf); binary.writeUInt32LE(0x100000c, 4); binary.writeUInt32LE(2, 12);
  await writeFile(join(bundle, path), binary);
  const options = { bundle, arch: 'arm64', identity: signingIdentity, teamId, electronVersion: '44.2.0', edition: edition.id };
  const run = (application, photos = true) => async (_command, args) => ({ stdout: args.includes('--entitlements') ? plist.build({
    'com.apple.security.cs.allow-jit': true, 'com.apple.security.device.audio-input': true, 'com.apple.security.device.camera': true,
    ...(photos ? { 'com.apple.security.personal-information.photos-library': true } : {}),
  }) : args[0] === '--display' ? details(application) : '', stderr: '' });
  assert.equal((await verifyMacBundle({ ...options, run: run(edition.application) })).verified, true);
  await assert.rejects(verifyMacBundle({ ...options, run: run(edition.application, false) }), /Unexpected executable entitlements/);
  await assert.rejects(verifyMacBundle({ ...options, run: run(desktopEdition().application) }), /identifier mismatch/);
  assert.throws(() => parseCodeIdentity(details(desktopEdition().application), { teamId, application: edition.application }), /identifier mismatch/);
}));
