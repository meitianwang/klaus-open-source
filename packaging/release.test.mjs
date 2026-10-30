import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { captureUnsignedBundle, makeSignedReceipt, validateReceiptPlatformProof, validateSigningChanges } from './release-receipt.mjs';
import { bundleInventory, privateDirectory, runTool } from './release-io.mjs';
import { releaseIdentity } from './release-metadata.mjs';
import { createSignedRelease, validateReleaseCandidate } from './release.mjs';
import { containsV8, notarize, parseCodeIdentity, signMacBundle, verifyMacBundle } from './release-macos.mjs';
import { verifyWindowsFile, windowsReleaseSigning, windowsSigningIdentity } from './release-windows.mjs';

const require = createRequire(import.meta.url);
const { updateFixture } = require('../dist/tests/updater-fixture.js');
const { parseReleaseEnvelope } = require('../dist/main/updater/policy.js');
const { verifyMinisign } = require('../dist/main/updater/minisign.js');
const commit = 'a'.repeat(40), engineCommit = 'b'.repeat(40), version = '1.2.3';
const teamId = 'ABCDE12345', identity = `Developer ID Application: Fixture (${teamId})`;
const macText = `Identifier=ai.klaus.desktop\nAuthority=${identity}\nTeamIdentifier=${teamId}\nTimestamp=Sep 8, 2026 at 10:00:00\nCodeDirectory flags=0x10000(runtime)\nCDHash=${'c'.repeat(40)}\n`;

async function temporary(callback) {
  const directory = await mkdtemp(join(tmpdir(), 'klaus-release-test-'));
  try { return await callback(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
function executable(platform) {
  const bytes = Buffer.alloc(128);
  if (platform === 'darwin') { bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(0x100000c, 4); bytes.writeUInt32LE(2, 12); }
  else { bytes.writeUInt16LE(0x5a4d); bytes.writeUInt32LE(64, 60); bytes.writeUInt32LE(0x4550, 64); bytes.writeUInt16LE(0x8664, 68); }
  return bytes;
}
async function candidate(directory, platform) {
  const arch = platform === 'darwin' ? 'arm64' : 'x64';
  const bundle = join(directory, platform === 'darwin' ? 'candidate.app' : 'candidate');
  const resource = platform === 'darwin' ? 'Contents/Resources' : 'resources';
  await mkdir(join(bundle, resource), { recursive: true });
  await mkdir(join(bundle, platform === 'darwin' ? 'Contents/MacOS' : '.'), { recursive: true });
  await writeFile(join(bundle, platform === 'darwin' ? 'Contents/MacOS/Klaus' : 'Klaus.exe'), executable(platform));
  await writeFile(join(bundle, resource, 'app.asar'), 'fixture immutable application code');
  await writeFile(join(bundle, resource, 'desktop-resources.json'), '{"fixture":"original manifest"}');
  const source = { bundle, buildKind: 'local-unsigned', clientTreeDirty: false, clientCommit: commit, engineCommit, recordedEngineCommit: engineCommit, version, target: `${platform}-${arch}`, electronVersion: '44.2.0', engineSha256: 'd'.repeat(64), nativeSha256: 'e'.repeat(64) };
  return { source, current: { commit, engineCommit, version, platform, arch } };
}

test('formal candidate rejects dirty source, wrong checkout, wrong gitlink and cross-platform inputs', () => {
  const source = { buildKind: 'local-unsigned', clientTreeDirty: false, clientCommit: commit, recordedEngineCommit: engineCommit, engineCommit, version, target: 'darwin-arm64' };
  const current = { commit, engineCommit, version, platform: 'darwin', arch: 'arm64' };
  validateReleaseCandidate(source, current);
  for (const patch of [{ clientTreeDirty: true }, { clientCommit: 'f'.repeat(40) }, { recordedEngineCommit: 'f'.repeat(40) }, { engineCommit: 'f'.repeat(40) }, { buildKind: 'local-unsigned-installer' }, { version: '1.2.2' }, { target: 'win32-x64' }]) assert.throws(() => validateReleaseCandidate({ ...source, ...patch }, current));
});

test('installed policy uses an explicit versioned HTTPS route and rejects origin manipulation', () => {
  assert.equal(releaseIdentity({ platform: 'darwin', arch: 'arm64', version, channel: 'stable', origin: 'https://updates.example.invalid' }).feedUrl, `https://updates.example.invalid/releases/electron/stable/darwin/arm64/${version}`);
  for (const origin of ['http://updates.example.invalid', 'https://user:password@updates.example.invalid', 'https://updates.example.invalid/path', 'https://updates.example.invalid/?key=x']) assert.throws(() => releaseIdentity({ platform: 'darwin', arch: 'arm64', version, channel: 'stable', origin }));
});

test('signed receipt permits code seals and binary changes but rejects JavaScript, raw manifests, removed links and unexpected files', async () => temporary(async root => {
  const { source } = await candidate(root, 'darwin'), unsigned = await captureUnsignedBundle(source.bundle, source);
  await writeFile(join(source.bundle, 'Contents/Resources/electron-update.json'), '{}');
  await mkdir(join(source.bundle, 'Contents/_CodeSignature'));
  await writeFile(join(source.bundle, 'Contents/_CodeSignature/CodeResources'), 'signature seal');
  const files = await bundleInventory(source.bundle);
  validateSigningChanges(unsigned, files, 'darwin');
  for (const path of ['Contents/Resources/app.asar', 'Contents/Resources/desktop-resources.json']) assert.throws(() => validateSigningChanges(unsigned, files.map(file => file.path === path ? { ...file, sha256: '0'.repeat(64) } : file), 'darwin'), /immutable application content/);
  assert.throws(() => validateSigningChanges(unsigned, files.filter(file => file.path !== 'Contents/Resources/app.asar'), 'darwin'), /removed/);
  assert.throws(() => validateSigningChanges(unsigned, [...files, { path: 'Contents/Resources/injected.js', type: 'file', size: 1, sha256: '0'.repeat(64) }], 'darwin'), /unexpected/);
  await assert.rejects(makeSignedReceipt({ bundle: source.bundle, unsigned, identity: { platform: 'darwin' }, platformProof: { verified: true, platform: 'darwin', binaries: [] } }), /Every packaged executable/);
}));

test('a stapled macOS ticket is allowed only at its exact path after accepted notarization', async () => temporary(async root => {
  const { source } = await candidate(root, 'darwin'), unsigned = await captureUnsignedBundle(source.bundle, source);
  await writeFile(join(source.bundle, 'Contents/Resources/electron-update.json'), '{}');
  await writeFile(join(source.bundle, 'Contents/CodeResources'), 'opaque Apple ticket fixture; never installed');
  const files = await bundleInventory(source.bundle), ticket = files.find(file => file.path === 'Contents/CodeResources');
  const notarization = { status: 'Accepted', stapled: true };
  validateSigningChanges(unsigned, files, 'darwin', notarization);
  for (const proof of [undefined, { status: 'Invalid', stapled: true }, { status: 'Accepted', stapled: false }]) assert.throws(() => validateSigningChanges(unsigned, files, 'darwin', proof), /accepted, stapled notarization/);
  for (const patch of [{ type: 'symlink', target: '_CodeSignature/CodeResources' }, { type: 'directory' }, { size: 0 }, { size: 1024 * 1024 + 1 }]) {
    assert.throws(() => validateSigningChanges(unsigned, files.map(file => file === ticket ? { ...file, ...patch } : file), 'darwin', notarization), /bounded regular file/);
  }
  for (const path of ['CodeResources', 'Contents/Resources/CodeResources', 'Contents/CodeResources/injected.js']) {
    assert.throws(() => validateSigningChanges(unsigned, files.map(file => file === ticket ? { ...file, path } : file), 'darwin', notarization), /unexpected application content/);
  }
  assert.throws(() => validateSigningChanges(unsigned, files, 'win32', notarization), /unexpected application content/);
  const platformProof = { verified: true, platform: 'darwin', binaries: unsigned.binaries.map(path => ({ path })) };
  assert.equal((await makeSignedReceipt({ bundle: source.bundle, unsigned, identity: { platform: 'darwin' }, platformProof, notarization })).files.find(file => file.path === ticket.path).sha256, ticket.sha256);
}));

test('the locked public macOS signer reaches application validation without a test replacement', async () => temporary(async root => {
  await assert.rejects(signMacBundle({ bundle: join(root, 'missing.app'), arch: 'arm64', teamId, identity, electronVersion: '44.2.0',
    run: async () => { throw new Error('Signature verification must not run for a missing application'); } }), /Application at path .* could not be found/);
}));

test('Mac preflight requires team, timestamp, hardened runtime and detects embedded V8 across stream chunks', async () => temporary(async root => {
  assert.equal(parseCodeIdentity(macText, { teamId }).teamId, teamId);
  for (const invalid of [macText.replace('ABCDE12345', 'WRONG12345'), macText.replace(/^Timestamp=.*\n/m, ''), macText.replace('(runtime)', '(adhoc)'), macText.replace('Developer ID Application:', 'Apple Development:')]) assert.throws(() => parseCodeIdentity(invalid, { teamId }));
  const file = join(root, 'engine'); await writeFile(file, Buffer.concat([Buffer.alloc(65_531), Buffer.from('v8::internal::Isolate')]));
  assert.equal(await containsV8(file), true);
}));

test('Mac signature verification rejects unplanned non-boolean helper entitlements', async () => temporary(async root => {
  const bundle = join(root, 'Fixture.app'), directory = join(bundle, 'Contents/Resources/recording/darwin-arm64');
  await mkdir(directory, { recursive: true }); await writeFile(join(directory, 'klaus-recording-helper'), executable('darwin'));
  const { default: plist } = await import('plist');
  const options = entitlements => ({ bundle, arch: 'arm64', teamId, identity, electronVersion: '44.2.0',
    run: async (_command, args) => ({ stdout: args.includes('--entitlements') ? plist.build(entitlements) : args[0] === '--display' ? macText : '', stderr: '' }) });
  assert.equal((await verifyMacBundle(options({}))).binaries.length, 1);
  await assert.rejects(verifyMacBundle(options({ 'com.apple.security.application-groups': ['unexpected.group'] })), /Unexpected executable entitlements/);
}));

test('Mac JIT verification distinguishes shared V8 code from each executable host', async () => temporary(async root => {
  const bundle = join(root, 'Klaus.app'), { default: plist } = await import('plist');
  async function verify(path, { fileType = 2, marker = false, entitlements = {} } = {}) {
    const file = join(bundle, path), bytes = executable('darwin');
    bytes.writeUInt32LE(fileType, 12);
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, marker ? Buffer.concat([bytes, Buffer.from('v8::internal::Isolate')]) : bytes);
    try {
      return await verifyMacBundle({ bundle, arch: 'arm64', teamId, identity, electronVersion: '44.2.0',
        run: async (_command, args) => ({ stdout: args.includes('--entitlements') ? plist.build(entitlements) : args[0] === '--display' ? macText : '', stderr: '' }) });
    } finally { await rm(bundle, { recursive: true, force: true }); }
  }
  // Frameworks inherit the permissions of the process that loads them.
  assert.equal((await verify('Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework', { fileType: 6, marker: true })).verified, true);
  assert.equal((await verify('Contents/Resources/ordinary-plugin.bundle', { fileType: 8, marker: true })).verified, true);
  await assert.rejects(verify('Contents/Resources/custom-v8-helper', { marker: true }), /JIT permission/);
  assert.equal((await verify('Contents/Resources/custom-v8-helper', { marker: true, entitlements: { 'com.apple.security.cs.allow-jit': true } })).verified, true);
  for (const suffix of ['', ' (GPU)', ' (Renderer)', ' (Plugin)']) {
    const name = `Klaus Helper${suffix}`, path = `Contents/Frameworks/${name}.app/Contents/MacOS/${name}`;
    await assert.rejects(verify(path), /JIT permission/);
    assert.equal((await verify(path, { entitlements: { 'com.apple.security.cs.allow-jit': true } })).verified, true);
    await assert.rejects(verify(path, { fileType: 6, entitlements: { 'com.apple.security.cs.allow-jit': true } }), /Mach-O executable/);
  }
  for (const path of ['Contents/MacOS/Klaus', 'Contents/Resources/bin/darwin-arm64/klaus-agent-stdio']) await assert.rejects(verify(path), /entitlements|JIT permission/);
  assert.equal((await verify('Contents/Frameworks/Electron Framework.framework/Versions/A/Helpers/chrome_crashpad_handler')).verified, true);
}));

test('Mac entitlement inspection requests XML with the supported codesign output path', async () => temporary(async root => {
  const bundle = join(root, 'Klaus.app'), file = join(bundle, 'Contents/Resources/helper');
  await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, executable('darwin'));
  let inspected = false;
  await verifyMacBundle({ bundle, arch: 'arm64', teamId, identity, electronVersion: '44.2.0',
    run: async (_command, args) => {
      if (args.includes('--entitlements')) { inspected = true; assert.deepEqual(args, ['--display', '--architecture', 'arm64', '--entitlements', '-', '--xml', file]); }
      return { stdout: args.includes('--entitlements') ? '' : args[0] === '--display' ? macText : '', stderr: '' };
    } });
  assert.equal(inspected, true);
}));

test('universal signature display checks the supported target slice and rejects retired Intel releases', async () => temporary(async root => {
  const bundle = join(root, 'Klaus.app'), file = join(bundle, 'Contents/Frameworks/Klaus Helper (Renderer).app/Contents/MacOS/Klaus Helper (Renderer)');
  const fat = Buffer.alloc(304); fat.writeUInt32BE(0xcafebabe, 0); fat.writeUInt32BE(2, 4);
  for (let index = 0; index < 2; index++) {
    const entry = 8 + index * 20, offset = 48 + index * 128, cpu = index ? 0x1000007 : 0x100000c;
    fat.writeUInt32BE(cpu, entry); fat.writeUInt32BE(offset, entry + 8); fat.writeUInt32BE(128, entry + 12);
    const bytes = executable('darwin'); bytes.writeUInt32LE(cpu, 4); bytes.copy(fat, offset);
  }
  await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, fat);
  const { default: plist } = await import('plist'), displays = [];
  const verify = arch => verifyMacBundle({ bundle, arch, teamId, identity, electronVersion: '44.2.0',
    run: async (_command, args) => {
      if (args[0] === '--display') displays.push(args);
      const selected = args.includes('--architecture') ? args[args.indexOf('--architecture') + 1] : 'arm64';
      return { stdout: args.includes('--entitlements') ? plist.build(selected === 'arm64' ? { 'com.apple.security.cs.allow-jit': true } : {}) : args[0] === '--display' ? macText : '', stderr: '' };
    } });
  await assert.rejects(verify('x64'), /Unsupported desktop target/);
  assert.equal(displays.length, 0);
  assert.equal((await verify('arm64')).verified, true);
  assert(displays.every(args => args[args.indexOf('--architecture') + 1] === 'arm64'));
}));

test('notarization refuses invalid, malformed and timed-out results before any staple step', async () => {
  const options = { file: '/fixture/application.zip', credentials: { keyPath: '/private/key.p8', keyId: 'ABCDE12345', issuer: '12345678-1234-1234-1234-123456789abc' } };
  for (const stdout of ['not json', JSON.stringify({ status: 'Invalid', id: '12345678-1234-1234-1234-123456789abc' }), JSON.stringify({ status: 'Accepted' })]) await assert.rejects(notarize({ ...options, run: async () => ({ stdout }) }));
  await assert.rejects(notarize({ ...options, run: async () => { throw new Error('deadline'); } }), /deadline/);
  const calls = [];
  const result = await notarize({ ...options, run: async (command, args) => { calls.push([command, args]); return { stdout: JSON.stringify({ status: 'Accepted', id: '12345678-1234-1234-1234-123456789abc' }) }; } });
  assert.equal(result.status, 'Accepted'); assert.equal(calls.length, 1); assert.ok(calls[0][1].includes('--no-s3-acceleration'));
});

test('notarization stores Apple ID credentials in a keychain profile and submits without the password', async () => {
  const calls = [];
  const run = async (command, args) => { calls.push([command, args]); return { stdout: JSON.stringify({ status: 'Accepted', id: '12345678-1234-1234-1234-123456789abc' }) }; };
  const credentials = { appleId: 'release@example.com', applePassword: 'abcd-efgh-ijkl-mnop', teamId: 'PLK4M54R8W' };
  const result = await notarize({ file: '/fixture/application.zip', credentials, run });
  assert.equal(result.status, 'Accepted');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0][1].slice(0, 3), ['notarytool', 'store-credentials', 'klaus-notary-PLK4M54R8W']);
  assert.ok(calls[0][1].includes('--apple-id') && calls[0][1].includes('release@example.com'));
  assert.deepEqual(calls[1][1].slice(0, 5), ['notarytool', 'submit', '/fixture/application.zip', '--keychain-profile', 'klaus-notary-PLK4M54R8W']);
  assert.ok(!calls[1][1].includes('abcd-efgh-ijkl-mnop'));
  assert.ok(calls[1][1].includes('--no-s3-acceleration'));
  for (const incomplete of [{ appleId: 'release@example.com', teamId: 'PLK4M54R8W' }, { appleId: 'release@example.com', applePassword: 'x', teamId: 'short' }]) {
    await assert.rejects(notarize({ file: '/fixture/application.zip', credentials: incomplete, run }), /app-specific password and team ID/);
  }
  await assert.rejects(notarize({ file: '/fixture/application.zip', credentials, transport: 'api', run }), /notarytool transport/);
});

test('Windows Authenticode checks exact publisher, thumbprint and timestamp without embedding filenames in PowerShell code', async () => {
  const identity = windowsSigningIdentity({ certificateSha1: 'c'.repeat(40), publisher: 'CN=Fixture', timestampUrl: 'https://timestamp.example.invalid' });
  const file = 'C:\\Profile with spaces\\$(not-code).exe';
  const run = async (command, args, options) => { assert.equal(command, 'powershell.exe'); assert.ok(!args.at(-1).includes(file)); assert.equal(options.env.KLAUS_SIGNED_FILE, file); return { stdout: JSON.stringify({ subject: 'CN=Fixture', thumbprint: 'C'.repeat(40), timestampSubject: 'CN=Timestamp' }) }; };
  await verifyWindowsFile(file, identity, run);
  for (const value of [{ subject: 'CN=Wrong', thumbprint: 'C'.repeat(40), timestampSubject: 'CN=Timestamp' }, { subject: 'CN=Fixture', thumbprint: 'D'.repeat(40), timestampSubject: 'CN=Timestamp' }, { subject: 'CN=Fixture', thumbprint: 'C'.repeat(40) }]) await assert.rejects(verifyWindowsFile(file, identity, async () => ({ stdout: JSON.stringify(value) })));
});

test('Windows signing configuration is either entirely absent or complete; partial and blank inputs fail', () => {
  assert.equal(windowsReleaseSigning(), undefined);
  assert.equal(windowsReleaseSigning({ signtool: undefined, certificateSha1: undefined, publisher: undefined, timestampUrl: undefined }), undefined);
  const complete = { signtool: 'C:/SDK/signtool.exe', certificateSha1: 'a'.repeat(40), publisher: 'CN=Fixture' };
  assert.equal(windowsReleaseSigning(complete).identity.timestampUrl, 'https://timestamp.digicert.com/');
  const fields = Object.keys(complete);
  for (let mask = 1; mask < 7; mask++) assert.throws(() => windowsReleaseSigning(Object.fromEntries(fields.filter((_, index) => mask & (1 << index)).map(field => [field, complete[field]]))));
  for (const field of [...fields, 'timestampUrl']) {
    assert.throws(() => windowsReleaseSigning({ [field]: '' }));
    assert.throws(() => windowsReleaseSigning({ ...complete, [field]: '' }));
  }
  assert.throws(() => windowsReleaseSigning({ timestampUrl: 'https://timestamp.example.invalid' }));
  assert.throws(() => windowsReleaseSigning({ ...complete, timestampUrl: 'http://timestamp.example.invalid' }), /HTTPS/);
});

test('Minisign-only Windows release binds its policy, full unchanged bundle and artifacts without OS signature claims', async () => temporary(async root => {
  const { source, current } = await candidate(root, 'win32'), original = await bundleInventory(source.bundle), f = updateFixture();
  const options = { bundle: source.bundle, out: join(root, 'release'), origin: 'https://updates.example.invalid' };
  const dependencies = { currentCheckout: async () => current, inspect: bundle => ({ ...source, bundle }),
    signer: { key: f.key, preflight: async () => {}, sign: async file => f.signed(await readFile(file)) },
    windowsSignatures: async () => { throw new Error('No Authenticode configuration'); }, verifyWindows: async () => { throw new Error('No Authenticode configuration'); },
    buildInstaller: async ({ output, windows }) => {
      assert.equal(windows, undefined);
      const file = join(output, `Klaus-${version}-win32-x64-setup.exe`); await writeFile(file, 'fixture NSIS, never installed'); return [file];
    } };
  const result = await createSignedRelease(options, dependencies), receipt = JSON.parse(await readFile(result.receiptFile));
  assert.deepEqual(receipt.platformProof, { platform: 'win32', authenticode: 'not-configured', verified: false });
  validateReceiptPlatformProof(receipt, f.key);
  const policy = JSON.parse(Buffer.from(receipt.installedPolicy.payload, 'base64'));
  assert.equal(policy.windowsAuthenticode, 'not-configured'); assert.equal(Object.hasOwn(policy, 'publisher'), false);
  assert.deepEqual(await bundleInventory(source.bundle), original);
  const { verifyReleaseEntry } = await import('./release-index.mjs');
  const { fileProof } = await import('./release-io.mjs');
  const entry = result.manifest.channels.stable.platforms['win32-x64'];
  await verifyReleaseEntry({ channel: 'stable', target: 'win32-x64', entry, key: f.key, read: name => readFile(join(result.output, name)), proof: name => fileProof(join(result.output, name)), localPath: name => join(result.output, name) });
  for (const mutate of [
    value => { value.platformProof.authenticode = 'disabled'; },
    value => { value.platformProof.verified = true; },
    value => { value.platformProof.publisher = 'CN=Fixture'; },
    value => { delete value.installedPolicy; },
    value => { value.installedPolicy.signature = updateFixture().signed(Buffer.from(value.installedPolicy.payload, 'base64')); },
    value => { value.files.find(file => file.path === 'resources/electron-update.json').sha256 = '0'.repeat(64); },
    value => { value.files.find(file => file.path === 'Klaus.exe').sha256 = '0'.repeat(64); },
    value => { const bytes = Buffer.from(JSON.stringify({ ...policy, publisher: 'CN=Existing publisher' })); value.installedPolicy = { payload: bytes.toString('base64'), signature: f.signed(bytes) }; },
  ]) {
    const invalid = structuredClone(receipt); mutate(invalid); assert.throws(() => validateReceiptPlatformProof(invalid, f.key));
  }
  await assert.rejects(createSignedRelease({ ...options, out: join(root, 'mutated') }, { ...dependencies, buildInstaller: async args => {
    const files = await dependencies.buildInstaller(args); await writeFile(join(args.bundle, 'Klaus.exe'), 'changed executable'); return files;
  } }), /original bundle bytes/);
  assert.ok(!(await readdir(join(root, 'mutated'))).includes('manifest.json'));
}));

test('Windows private signing directory removes inherited ACLs before writing any private key', async () => temporary(async root => {
  const calls = [];
  const directory = await privateDirectory(root, { platform: 'win32', run: async (command, args) => { calls.push([command, args]); return { stdout: command === 'whoami.exe' ? '"RELEASEBOX\\builder","S-1-5-21-123-456",RELEASEBOX\r\n' : '' }; } });
  assert.deepEqual(await readdir(directory), []); assert.equal(calls[1][0], 'icacls.exe'); assert.ok(calls[1][1].includes('/inheritance:r')); assert.ok(calls[1][1].includes('*S-1-5-21-123-456:(OI)(CI)F'));
}));

for (const platform of ['darwin', 'win32']) test(`${platform} orchestration preserves candidate bytes and only creates a manifest after signed receipt and artifact verification`, async () => temporary(async root => {
  const { source, current } = await candidate(root, platform), original = await bundleInventory(source.bundle), fixture = updateFixture(), operations = [];
  const signer = { key: fixture.key, preflight: async () => operations.push('signer-preflight'), sign: async file => fixture.signed(await readFile(file)) };
  const proof = async ({ bundle }) => ({ verified: true, platform, ...(platform === 'darwin' ? { teamId } : { publisher: 'CN=Fixture', certificateSha1: 'C'.repeat(40) }), binaries: (await bundleInventory(bundle)).filter(file => file.type === 'file' && file.path.endsWith(platform === 'darwin' ? '/Klaus' : '.exe')).map(file => ({ path: file.path })) });
  const output = join(root, 'release');
  const options = { bundle: source.bundle, out: output, origin: 'https://updates.example.invalid', mac: { identity, teamId, credentials: {} }, windows: { signtool: '/fixture/signtool.exe', certificateSha1: 'c'.repeat(40), publisher: 'CN=Fixture', timestampUrl: 'https://timestamp.example.invalid' }, onProgress: stage => operations.push(stage) };
  const dependencies = { currentCheckout: async () => current, inspect: bundle => ({ ...source, bundle }), signer,
    run: async (command, args) => { operations.push(`${command}:${args[0]}`); return { stdout: command === 'codesign' && args[0] === '--display' ? macText : '', stderr: '' }; },
    signMac: proof, verifyMac: proof, windowsSignatures: proof, verifyWindows: async () => ({ verified: true }),
    notarize: async () => ({ status: 'Accepted', id: '12345678-1234-1234-1234-123456789abc' }), staple: async () => {},
    zip: async (bundle, file) => writeFile(file, 'fixture ZIP, never installed'),
    buildInstaller: async ({ output }) => { const file = join(output, `Klaus-${version}-${platform}-${current.arch}${platform === 'darwin' ? '.dmg' : '-setup.exe'}`); await writeFile(file, 'fixture installer, never installed'); return [file]; } };
  const result = await createSignedRelease(options, dependencies);
  assert.deepEqual(await bundleInventory(source.bundle), original); assert.equal(result.published, false); assert.equal(result.installed, false);
  const entry = result.manifest.channels.stable.platforms[source.target];
  const envelope = JSON.parse(await readFile(join(output, entry.envelopeFile), 'utf8'));
  assert.equal(parseReleaseEnvelope(envelope, { ...fixture.policy, platform, arch: current.arch }).release.version, version);
  const receiptBytes = await readFile(result.receiptFile); verifyMinisign(receiptBytes, (await readFile(`${result.receiptFile}.sig`, 'utf8')).trim(), fixture.key);
  assert.equal(JSON.parse(receiptBytes).artifacts.download.sha256, entry.download.sha256);
  assert.ok(operations.indexOf('verifying-signed-receipt') < operations.indexOf('signing-update-metadata'));
  assert.ok(!(await readdir(output)).some(file => file.startsWith('.release-work-')));
  await assert.rejects(createSignedRelease(options, dependencies), /EEXIST/);
  if (platform === 'darwin') {
    const failed = join(root, 'notary-failed');
    await assert.rejects(createSignedRelease({ ...options, out: failed }, { ...dependencies, notarize: async () => { throw new Error('notarization rejected'); } }), /notarization rejected/);
    assert.ok(!(await readdir(failed)).includes('manifest.json'));
    assert.ok(!(await readdir(failed)).some(file => file.startsWith('.release-work-')));
  }
}));

test('tool errors and timeouts never echo command arguments or stdin secrets', async () => {
  const secret = 'private-argument-fixture';
  await assert.rejects(runTool(process.execPath, ['-e', 'process.stderr.write(process.argv[1]); process.exit(7)', secret], { input: Buffer.from(secret) }), error => error.message.includes('exit 7') && !error.message.includes(secret));
  await assert.rejects(runTool(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeoutMs: 20 }), /deadline/);
});
