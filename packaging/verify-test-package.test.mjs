import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { packageTestVerifier, signedTestMetadata, verifyTestPackage } from './verify-test-package.mjs';
import { bundleInventory } from './release-io.mjs';
import { validateSigningChanges } from './release-receipt.mjs';

const require = createRequire(import.meta.url);
const { updateFixture } = require('../dist/tests/updater-fixture.js');
const { verifyMinisign } = require('../dist/main/updater/minisign.js');
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const platformProof = { target: 'darwin-arm64', version: '0.4.0', signatureVerified: true, receiptVerified: true, installed: false };

async function withFixture(body) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'signed package verification '))), trust = updateFixture();
  try {
    const bundle = join(root, 'Actual copied bundle with spaces.app'), resources = join(bundle, 'Contents/Resources');
    await mkdir(resources, { recursive: true }); await mkdir(join(bundle, 'Contents/MacOS'));
    await writeFile(join(bundle, 'Contents/MacOS/Klaus'), 'original executable fixture');
    await writeFile(join(resources, 'app.asar'), 'immutable application fixture');
    const unsignedFiles = await bundleInventory(bundle);
    await writeFile(join(bundle, 'Contents/MacOS/Klaus'), 'changed by platform signing fixture');
    await writeFile(join(resources, 'electron-update.json'), 'fixture installed policy');
    const source = { bundle: '/untrusted/old-candidate.app', resources: '/untrusted/old/resources', executable: '/untrusted/old/Klaus',
      version: '0.4.0', target: 'darwin-arm64', electronVersion: '44.2.0', buildKind: 'local-unsigned', clientCommit: 'a'.repeat(40),
      clientTreeDirty: false, engineCommit: 'b'.repeat(40), recordedEngineCommit: 'b'.repeat(40), engineSha256: 'c'.repeat(64), verified: true };
    const receipt = { schemaVersion: 1, kind: 'signed-package-receipt', application: 'ai.klaus.desktop', framework: 'electron', buildKind: 'signed-release',
      platform: 'darwin', arch: 'arm64', version: '0.4.0', channel: 'preview', platformProof: { platform: 'darwin', verified: true },
      notarization: { status: 'Accepted', stapled: true }, unsigned: { source, files: unsignedFiles, binaries: ['Contents/MacOS/Klaus'] }, files: await bundleInventory(bundle) };
    const file = join(root, 'Fixture.receipt.json');
    const save = async value => { const bytes = Buffer.from(JSON.stringify(value)); await writeFile(file, bytes); await writeFile(`${file}.sig`, trust.signed(bytes)); };
    await save(receipt);
    // Only this unit-test dependency trusts the ephemeral key. Production CLI factories never receive it.
    const integrity = async (actual, path) => {
      const bytes = await readFile(path); verifyMinisign(bytes, await readFile(`${path}.sig`, 'utf8'), trust.key);
      const value = JSON.parse(bytes), files = await bundleInventory(actual);
      assert.deepEqual(files, value.files, 'The actual full bundle inventory differs from its receipt');
      validateSigningChanges(value.unsigned, files, value.platform, value.notarization); return value;
    };
    const acceptedPlatform = async () => structuredClone(platformProof); // No live OS signature claim is made by this fixture.
    await body({ root, bundle, resources, file, receipt, source, save, integrity, acceptedPlatform });
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('signed validation relocates all execution paths and retains the original unsigned source/hash verbatim', async () => withFixture(async fixture => {
  const order = [], original = JSON.stringify(fixture.source);
  const verify = packageTestVerifier({ unsigned: () => { throw new Error('No unsigned fallback'); },
    signed: async args => { order.push('platform'); assert.equal(args.bundle, fixture.bundle); return fixture.acceptedPlatform(); },
    integrity: async (...args) => { order.push('inventory'); return fixture.integrity(...args); } });
  const result = await verify(fixture.bundle, { receipt: fixture.file });
  assert.deepEqual(order, ['platform', 'inventory']);
  assert.equal(result.bundle, fixture.bundle); assert.equal(result.resources, fixture.resources); assert.equal(result.executable, join(fixture.bundle, 'Contents/MacOS/Klaus'));
  assert.equal(result.buildKind, 'signed-release'); assert.equal(result.verification.mode, 'signed');
  assert.deepEqual(result.verification.originalUnsignedSource, fixture.source); assert.equal(JSON.stringify(fixture.source), original);
  assert.equal(result.engineSha256, undefined, 'Original unsigned binary hashes must not be relabelled as current signed bytes');
  assert.equal(result.verification.receipt.sha256, digest(await readFile(fixture.file)));
  assert.equal(result.verification.receipt.signatureSha256, digest(await readFile(`${fixture.file}.sig`)));
  result.verification.originalUnsignedSource.bundle = '/changed-report'; assert.equal(JSON.stringify(fixture.source), original);
}));

test('absence of a receipt preserves the strict unsigned checker; explicit receipt errors cannot fall back', async () => withFixture(async fixture => {
  let unsigned = 0, signed = 0;
  const verify = packageTestVerifier({ unsigned: () => { unsigned++; return { verified: true, buildKind: 'local-unsigned', engineSha256: fixture.source.engineSha256 }; },
    signed: () => { signed++; throw new Error('platform signature rejected'); }, integrity: fixture.integrity });
  const result = await verify(fixture.bundle); assert.equal(result.engineSha256, fixture.source.engineSha256); assert.equal(result.verification.mode, 'unsigned');
  assert.equal(unsigned, 1); assert.equal(signed, 0);
  await assert.rejects(verify(fixture.bundle, { receipt: '' }), /explicit receipt/);
  await assert.rejects(verify(fixture.bundle, { receipt: join(fixture.root, 'missing.receipt.json') }), /ENOENT/);
  await assert.rejects(verify(fixture.bundle, { receipt: fixture.file }), /platform signature rejected/);
  assert.equal(unsigned, 1); assert.equal(signed, 1);
}));

test('an OS rejection or missing live proof stops metadata projection', async () => withFixture(async fixture => {
  let inventoryCalled = false;
  const verify = packageTestVerifier({ signed: () => { throw new Error('Authenticode rejected'); }, integrity: () => { inventoryCalled = true; } });
  await assert.rejects(verify(fixture.bundle, { receipt: fixture.file }), /Authenticode rejected/); assert.equal(inventoryCalled, false);
  for (const patch of [{ signatureVerified: false }, { receiptVerified: false }, { target: 'win32-x64' }, { version: '0.4.1' }]) {
    assert.throws(() => signedTestMetadata(fixture.bundle, fixture.receipt, { ...platformProof, ...patch }, {}), /platform verification differs/);
  }
}));

test('a receipt for another bundle and post-signing file tampering reject before any launch', async () => withFixture(async fixture => {
  const verify = packageTestVerifier({ signed: fixture.acceptedPlatform, integrity: fixture.integrity });
  const other = join(fixture.root, 'Wrong bundle.app'); await mkdir(other); await writeFile(join(other, 'foreign'), 'different bytes');
  await assert.rejects(verify(other, { receipt: fixture.file }), /full bundle inventory/);
  await writeFile(join(fixture.resources, 'app.asar'), 'changed application');
  await assert.rejects(verify(fixture.bundle, { receipt: fixture.file }), /full bundle inventory/);
}));

test('signed metadata cannot change target/version or hide a dirty or mismatched source', async () => withFixture(async fixture => {
  for (const patch of [{ clientTreeDirty: true }, { buildKind: 'signed-release' }, { target: 'win32-x64' }, { version: '0.4.1' },
    { verified: false }, { recordedEngineCommit: 'c'.repeat(40) }, { clientCommit: 'bad' }]) {
    const value = structuredClone(fixture.receipt); Object.assign(value.unsigned.source, patch);
    assert.throws(() => signedTestMetadata(fixture.bundle, value, platformProof, {}), /candidate provenance/);
  }
}));

test('signed relocation derives the supported Windows layout and rejects retired macOS x64 receipts', async () => withFixture(async fixture => {
  const intel = structuredClone(fixture.receipt);
  intel.platform = 'darwin'; intel.arch = 'x64'; intel.platformProof.platform = 'darwin'; intel.unsigned.source.target = 'darwin-x64';
  assert.throws(() => signedTestMetadata(fixture.bundle, intel, { ...platformProof, target: 'darwin-x64' }, {}), /Unsupported desktop target/);

  const value = structuredClone(fixture.receipt), target = 'win32-x64', actual = join(fixture.root, 'Relocated measured copy');
  value.platform = 'win32'; value.arch = 'x64'; value.platformProof.platform = 'win32'; value.unsigned.source.target = target;
  value.files = [{ path: 'Klaus.exe', type: 'file' }, { path: 'resources/app.asar', type: 'file' }];
  const result = signedTestMetadata(actual, value, { ...platformProof, target }, {});
  assert.equal(result.resources, join(actual, 'resources'));
  assert.equal(result.executable, join(actual, 'Klaus.exe'));
  assert.deepEqual(result.verification.originalUnsignedSource, value.unsigned.source);
}));

test('Minisign-only Windows metadata reports authenticated inventory without claiming an OS signature', async () => withFixture(async fixture => {
  const receipt = structuredClone(fixture.receipt);
  receipt.platform = 'win32'; receipt.arch = 'x64'; receipt.unsigned.source.target = 'win32-x64';
  receipt.platformProof = { platform: 'win32', authenticode: 'not-configured', verified: false };
  receipt.files = [{ path: 'Klaus.exe', type: 'file' }, { path: 'resources/app.asar', type: 'file' }];
  const proof = { target: 'win32-x64', version: receipt.version, receiptVerified: true, integrityVerified: true, signatureVerified: false, authenticode: 'not-configured', installed: false };
  const metadata = signedTestMetadata(fixture.bundle, receipt, proof, {});
  assert.equal(metadata.verification.platform.signatureVerified, false);
  assert.equal(metadata.verification.platform.integrityVerified, true);
  assert.equal(metadata.verification.platform.authenticode, 'not-configured');
  for (const change of [{ signatureVerified: true }, { integrityVerified: false }, { receiptVerified: false }, { authenticode: undefined }, { authenticode: 'disabled' }]) {
    assert.throws(() => signedTestMetadata(fixture.bundle, receipt, { ...proof, ...change }, {}), /verification differs/);
  }
  for (const change of [{ authenticode: 'disabled' }, { verified: true }, { publisher: 'CN=Existing publisher' }]) {
    assert.throws(() => signedTestMetadata(fixture.bundle, { ...receipt, platformProof: { ...receipt.platformProof, ...change } }, proof, {}), /Authenticode mode/);
  }
  const oldReceipt = { ...receipt, platformProof: { platform: 'win32', verified: true, publisher: 'CN=Existing publisher' } };
  assert.throws(() => signedTestMetadata(fixture.bundle, oldReceipt, proof, {}), /verification differs/);
}));

test('receipt, detached signature, and requested bundle path substitutions during checks reject', async () => withFixture(async fixture => {
  const newReceipt = packageTestVerifier({ signed: fixture.acceptedPlatform, integrity: async (...args) => {
    const value = await fixture.integrity(...args); await fixture.save({ ...value, createdAt: 'changed-during-check' }); return value;
  } });
  await assert.rejects(newReceipt(fixture.bundle, { receipt: fixture.file }), /Receipt or detached signature changed/);
  await fixture.save(fixture.receipt);
  const changed = packageTestVerifier({ signed: fixture.acceptedPlatform, integrity: async (...args) => {
    const value = await fixture.integrity(...args); await writeFile(`${fixture.file}.sig`, 'replaced signature'); return value;
  } });
  await assert.rejects(changed(fixture.bundle, { receipt: fixture.file }), /signature changed/);
  await fixture.save(fixture.receipt);
  const alias = join(fixture.root, 'alias.app'), other = join(fixture.root, 'replacement.app'); await mkdir(other);
  await symlink(fixture.bundle, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const retargeted = packageTestVerifier({ signed: fixture.acceptedPlatform, integrity: async (...args) => {
    const value = await fixture.integrity(...args); await rm(alias); await symlink(other, alias, process.platform === 'win32' ? 'junction' : 'dir'); return value;
  } });
  await assert.rejects(retargeted(alias, { receipt: fixture.file }), /package path changed/);
}));

test('the default shipping-key verifier rejects this ephemeral signature without a public-key override', async () => withFixture(async fixture => {
  await assert.rejects(verifyTestPackage(fixture.bundle, { receipt: fixture.file }), /key|signature/i);
  await assert.rejects(verifyTestPackage(fixture.bundle), /desktop-resources/);
}));

test('real smoke and measurement CLIs honor --receipt and refuse an untrusted receipt before launch', async () => withFixture(async fixture => {
  for (const name of ['smoke-package.mjs', 'measure-package.mjs']) {
    const output = join(fixture.root, `${name}.report.json`), script = fileURLToPath(new URL(`../scripts/${name}`, import.meta.url));
    const child = spawnSync(process.execPath, [script, fixture.bundle, '--receipt', fixture.file, '--output', output], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(child.status, 1, `${name}: ${child.stdout}\n${child.stderr}`);
    if (name === 'smoke-package.mjs') {
      assert.match(child.stderr, /key|signature/i);
      assert.equal(existsSync(output), false);
    }
    else {
      const report = JSON.parse(await readFile(output, 'utf8'));
      assert.equal(report.status, 'failed'); assert.equal(report.rounds.length, 0); assert.equal(report.package, undefined);
      assert.match(report.errors[0].message, /key|signature/i);
    }
  }
}));
