import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bytesProof, indexEntries, mergeReleaseIndexes, parseRemoteIndex, receiptName, releaseTargets, verifyReleaseEntry } from './release-index.mjs';
import { createReleaseMetadata, releaseIdentity, signedJson } from './release-metadata.mjs';
import { fileProof } from './release-io.mjs';
import { publishRelease, SshReleaseStore } from './release-publish.mjs';
import { renewReleaseMetadata } from './release-renew.mjs';

const require = createRequire(import.meta.url), { updateFixture } = require('../dist/tests/updater-fixture.js');
async function temporary(callback) { const root = await mkdtemp(join(tmpdir(), 'klaus-publish-fixture-')); try { await callback(root); } finally { await rm(root, { recursive: true, force: true }); } }
async function release(root, fixture, version = '1.2.3', targets = releaseTargets, windowsMinisignOnly = false) {
  await mkdir(root, { recursive: true });
  const signer = { key: fixture.key, sign: async file => fixture.signed(await readFile(file)) };
  let manifest = { schemaVersion: 2, framework: 'electron', channels: {} };
  for (const target of targets) {
    const [platform, arch] = target.split('-'), identity = releaseIdentity({ platform, arch, version, channel: 'stable', origin: 'https://releases.example.invalid' });
    const artifact = join(root, `Klaus-${version}-${target}${platform === 'darwin' ? '.zip' : '-setup.exe'}`), download = platform === 'darwin' ? join(root, `Klaus-${version}-${target}.dmg`) : artifact;
    await writeFile(artifact, `fixture ${target} update ${version}`); if (download !== artifact) await writeFile(download, `fixture ${target} download ${version}`);
    const result = await createReleaseMetadata({ identity, artifact, download, directory: root, signer });
    const receipt = { schemaVersion: 1, kind: 'signed-package-receipt', application: 'ai.klaus.desktop', framework: 'electron', buildKind: 'signed-release', platform, arch, version, channel: 'stable',
      unsigned: { source: { clientTreeDirty: false, clientCommit: 'a'.repeat(40), engineCommit: 'b'.repeat(40), recordedEngineCommit: 'b'.repeat(40), version, target, buildKind: 'local-unsigned' } },
      platformProof: { verified: true, platform }, ...(platform === 'darwin' ? { notarization: { status: 'Accepted', stapled: true, dmg: { status: 'Accepted', stapled: true } } } : {}),
      artifacts: { update: { ...await fileProof(artifact), signature: result.release.artifact.signature }, download: { ...await fileProof(download), signature: (await readFile(`${download}.sig`, 'utf8')).trim() } } };
    if (platform === 'win32' && windowsMinisignOnly) {
      const bytes = Buffer.from(JSON.stringify({ ...identity, kind: 'installed-update-policy', installer: 'nsis', windowsAuthenticode: 'not-configured' }));
      receipt.installedPolicy = { payload: bytes.toString('base64'), signature: fixture.signed(bytes) };
      const policy = Buffer.from(`${JSON.stringify(receipt.installedPolicy)}\n`);
      receipt.platformProof = { platform, authenticode: 'not-configured', verified: false };
      const original = [{ path: 'Klaus.exe', type: 'file', size: 1, sha256: bytesProof('', Buffer.from('M')).sha256 }];
      receipt.unsigned.files = original; receipt.unsigned.binaries = ['Klaus.exe'];
      receipt.files = [...original, { path: 'resources/electron-update.json', type: 'file', size: policy.length, sha256: bytesProof('', policy).sha256 }];
    }
    await signedJson(join(root, receiptName('stable', target, version)), receipt, signer);
    manifest = mergeReleaseIndexes(result.manifest, manifest);
  }
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest)); return manifest;
}
class FixtureStore {
  files = new Map(); mutations = []; corrupt = false; conflict = false;
  async load(root) { for (const name of await readdir(root)) this.files.set(name, await readFile(join(root, name))); }
  async read(name) { return this.files.get(name); }
  async proof(name) { const bytes = this.files.get(name); return bytes && bytesProof(name, bytes); }
  async prepare() { this.mutations.push('prepare'); }
  async put(file, name) { this.mutations.push(`put:${name}`); this.files.set(name, this.corrupt ? Buffer.from('corrupted transfer') : await readFile(file)); }
  async publishFile(temporary, destination) { this.mutations.push(`publish:${destination}`); assert.ok(!this.files.has(destination)); this.files.set(destination, this.files.get(temporary)); this.files.delete(temporary); }
  async compareAndSwap(temporary, expected) {
    this.mutations.push('compare-and-swap');
    if (this.conflict || bytesProof('manifest.json', this.files.get('manifest.json') ?? Buffer.alloc(0)).sha256 !== expected) throw new Error('Concurrent index publication');
    this.files.set('manifest.json', this.files.get(temporary)); this.files.delete(temporary);
  }
  async restart() { this.mutations.push('restart'); }
  async verifyHttp() { this.httpVerified = true; }
}
const verifier = fixture => options => verifyReleaseEntry({ ...options, key: fixture.key });
const snapshot = store => Object.fromEntries([...store.files].map(([name, bytes]) => [name, bytesProof(name, bytes).sha256]));

test('Minisign-only Windows publication still authenticates the policy, receipt, artifacts and index', async () => temporary(async root => {
  const fixture = updateFixture(), directory = join(root, 'local'), remote = new FixtureStore();
  await release(directory, fixture, '1.2.3', ['win32-x64'], true);
  await assert.rejects(publishRelease({ localDirectory: directory, requiredTargets: ['win32-x64'] }, { remote }), /key does not match/);
  assert.deepEqual(remote.mutations, []);
  const result = await publishRelease({ localDirectory: directory, requiredTargets: ['win32-x64'] }, { remote, verify: verifier(fixture) });
  assert.equal(result.published, true);
  remote.mutations.length = 0;
  const checked = await publishRelease({ verifyOnly: true, requiredTargets: ['win32-x64'] }, { remote, verify: verifier(fixture) });
  assert.equal(checked.published, false); assert.deepEqual(remote.mutations, []);
  const file = receiptName('stable', 'win32-x64', '1.2.3'), original = JSON.parse(remote.files.get(file));
  for (const mutate of [
    value => { value.platformProof.authenticode = 'unknown'; },
    value => { value.platformProof.verified = true; },
    value => { delete value.installedPolicy; },
    value => { value.files.find(entry => entry.path === 'resources/electron-update.json').sha256 = '0'.repeat(64); },
  ]) {
    const changed = structuredClone(original); mutate(changed);
    const bytes = Buffer.from(JSON.stringify(changed)); remote.files.set(file, bytes); remote.files.set(`${file}.sig`, Buffer.from(fixture.signed(bytes)));
    await assert.rejects(publishRelease({ verifyOnly: true, requiredTargets: ['win32-x64'] }, { remote, verify: verifier(fixture) }));
    assert.deepEqual(remote.mutations, []);
  }
}));

test('default publication requires the two supported targets while an explicit subset stays possible', async () => temporary(async root => {
  const fixture = updateFixture(), directory = join(root, 'local'), remote = new FixtureStore();
  const subset = ['darwin-arm64'];
  await release(directory, fixture, '1.2.3', subset);
  await assert.rejects(publishRelease({ localDirectory: directory }, { remote, verify: verifier(fixture) }), /Manifest missing platform keys: win32-x64/);
  assert.deepEqual(remote.mutations, []); assert.equal(remote.files.size, 0);
  const result = await publishRelease({ localDirectory: directory, requiredTargets: subset }, { remote, verify: verifier(fixture) });
  assert.deepEqual(result.platforms.map(item => item.target), subset);
  assert.deepEqual(Object.keys(JSON.parse(remote.files.get('manifest.json')).channels.stable.platforms), subset);
  remote.mutations.length = 0;
  await assert.rejects(publishRelease({ verifyOnly: true }, { remote, verify: verifier(fixture) }), /Manifest missing platform keys: win32-x64/);
  const verified = await publishRelease({ verifyOnly: true, requiredTargets: subset }, { remote, verify: verifier(fixture) });
  assert.equal(verified.published, false); assert.deepEqual(remote.mutations, []);
}));

test('publication CLI defaults to Apple Silicon and Windows and preserves the explicit environment form', async () => temporary(async root => {
  const directory = join(root, 'local'); await release(directory, updateFixture(), '1.2.3', ['darwin-arm64', 'win32-x64']);
  const publisher = new URL('./release-publish.mjs', import.meta.url).href, entry = new URL('../scripts/publish-electron-release.mjs', import.meta.url).href;
  // Run the actual entrypoint with its remote port disabled, including any future accidental SSH call.
  const script = `const { SshReleaseStore } = await import(${JSON.stringify(publisher)});
    SshReleaseStore.prototype.read = async () => undefined;
    SshReleaseStore.prototype.ssh = async () => { throw new Error('Unexpected fixture SSH call'); };
    process.argv = [process.execPath, ${JSON.stringify(entry)}, '--directory', ${JSON.stringify(directory)}, '--ssh-host', 'release-fixture'];
    await import(${JSON.stringify(entry)});`;
  const bootstrap = join(root, 'publish-cli-fixture.mjs'); await writeFile(bootstrap, script);
  const env = { ...process.env };
  for (const name of ['KLAUS_DESKTOP_PLATFORMS', 'KLAUS_SSH_HOST', 'KLAUS_REMOTE_RELEASE_DIR', 'KLAUS_REMOTE_ENV_FILE', 'KLAUS_REMOTE_SERVICE']) delete env[name];
  // Both forms pass target validation, but the fixture key must still fail shipping trust.
  for (const [platforms, error] of [[undefined, /key does not match/], ['darwin-arm64 win32-x64', /key does not match/]]) {
    const childEnv = { ...env }; if (platforms !== undefined) childEnv.KLAUS_DESKTOP_PLATFORMS = platforms;
    await assert.rejects(promisify(execFile)(process.execPath, [bootstrap], { env: childEnv, timeout: 15_000 }), result => {
      assert.equal(result.code, 1); assert.match(result.stderr, error); return true;
    });
  }
}));

test('a retired macOS x64 target cannot enter a new local publication', async () => temporary(async root => {
  const fixture = updateFixture(), directory = join(root, 'local'), remote = new FixtureStore(), index = await release(directory, fixture);
  index.channels.stable.platforms['darwin-x64'] = {
    version: '1.2.3', envelopeFile: `Klaus-1.2.3-stable-darwin-x64-${'0'.repeat(16)}.update.json`, envelopeSha256: '0'.repeat(64),
    download: { kind: 'dmg', file: 'Klaus-1.2.3-darwin-x64.dmg', size: 1, sha256: '0'.repeat(64) },
  };
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(index));
  await assert.rejects(publishRelease({ localDirectory: directory }, { remote, verify: verifier(fixture) }), /Invalid Electron release target or version/);
  assert.deepEqual(remote.mutations, []); assert.equal(remote.files.size, 0);
}));

test('release schema rejects traversal, target mismatch, downgrade and same-version download replacement', async () => temporary(async root => {
  const fixture = updateFixture(), index = await release(join(root, 'good'), fixture);
  for (const patch of [{ envelopeFile: '../policy.json' }, { envelopeFile: index.channels.stable.platforms['darwin-arm64'].envelopeFile.replace('arm64', 'x64') }, { download: { ...index.channels.stable.platforms['darwin-arm64'].download, file: 'Klaus-1.2.2-darwin-arm64.dmg' } }]) {
    const bad = structuredClone(index); Object.assign(bad.channels.stable.platforms['darwin-arm64'], patch); assert.throws(() => indexEntries(bad));
  }
  const old = await release(join(root, 'old'), fixture, '1.2.2'); assert.throws(() => mergeReleaseIndexes(old, index), /downgrade/);
  const changed = structuredClone(index); changed.channels.stable.platforms['darwin-arm64'].download.sha256 = '0'.repeat(64); assert.throws(() => mergeReleaseIndexes(changed, index), /change bytes/);
  assert.equal(parseRemoteIndex(Buffer.from('{"version":"0.3.15","updater":{}}')), undefined);
  assert.throws(() => parseRemoteIndex(Buffer.from('{"framework":"unknown"}')));
}));

test('signed receipt binds manual DMG bytes and rejects candidates or missing artifact signatures', async () => temporary(async root => {
  const fixture = updateFixture(), directory = join(root, 'local'), index = await release(directory, fixture);
  const item = indexEntries(index)[0], read = name => readFile(join(directory, name)), proof = name => fileProof(join(directory, name));
  const options = { ...item, read, proof, localPath: name => join(directory, name), key: fixture.key };
  await verifyReleaseEntry(options);
  await assert.rejects(verifyReleaseEntry({ ...options, key: undefined }), /key does not match/);
  const bad = structuredClone(item); bad.entry.download.sha256 = '0'.repeat(64); await assert.rejects(verifyReleaseEntry({ ...options, ...bad }), /does not bind/);
  const receiptFile = receiptName(item.channel, item.target, item.entry.version), bytes = await read(receiptFile), receipt = JSON.parse(bytes);
  receipt.buildKind = 'local-unsigned-installer'; const unsigned = Buffer.from(JSON.stringify(receipt));
  await assert.rejects(verifyReleaseEntry({ ...options, read: async name => name === receiptFile ? unsigned : name === `${receiptFile}.sig` ? Buffer.from(fixture.signed(unsigned)) : read(name) }), /signed platform release receipt/);
  await writeFile(join(directory, `${item.entry.download.file}.sig`), 'wrong signature');
  await assert.rejects(verifyReleaseEntry(options), /signature differs/);
}));

test('same-version platforms with different clean commits are rejected before publication', async () => temporary(async root => {
  const fixture = updateFixture(), directory = join(root, 'local'); await release(directory, fixture);
  const file = receiptName('stable', 'win32-x64', '1.2.3'), receipt = JSON.parse(await readFile(join(directory, file)));
  receipt.unsigned.source.clientCommit = 'c'.repeat(40);
  const bytes = Buffer.from(JSON.stringify(receipt));
  await writeFile(join(directory, file), bytes); await writeFile(join(directory, `${file}.sig`), fixture.signed(bytes));
  const remote = new FixtureStore();
  await assert.rejects(publishRelease({ localDirectory: directory }, { remote, verify: verifier(fixture) }), /same client and engine commits/);
  assert.deepEqual(remote.mutations, []);
}));

test('an older authentic DMG renamed as a new version cannot bypass the signed receipt binding', async () => temporary(async root => {
  const fixture = updateFixture(), directory = join(root, 'local'), oldDirectory = join(root, 'old');
  const index = await release(directory, fixture, '1.2.3', ['darwin-arm64']), old = await release(oldDirectory, fixture, '1.2.2', ['darwin-arm64']);
  const entry = index.channels.stable.platforms['darwin-arm64'], oldFile = old.channels.stable.platforms['darwin-arm64'].download.file;
  await writeFile(join(directory, entry.download.file), await readFile(join(oldDirectory, oldFile)));
  await writeFile(join(directory, `${entry.download.file}.sig`), await readFile(join(oldDirectory, `${oldFile}.sig`)));
  const replaced = await fileProof(join(directory, entry.download.file));
  entry.download.size = replaced.size; entry.download.sha256 = replaced.sha256;
  await assert.rejects(verifyReleaseEntry({ ...indexEntries(index)[0], read: name => readFile(join(directory, name)), proof: name => fileProof(join(directory, name)), key: fixture.key }), /does not bind/);
}));

test('expired metadata remains verifiable for manual downloads but cannot enter a new feed publication', async () => temporary(async root => {
  const fixture = updateFixture(), directory = join(root, 'local'), index = await release(directory, fixture);
  const options = { ...indexEntries(index)[0], read: name => readFile(join(directory, name)), proof: name => fileProof(join(directory, name)), localPath: name => join(directory, name), key: fixture.key, now: Date.now() + 40 * 86_400_000 };
  await assert.rejects(verifyReleaseEntry(options), /expired/);
  const verified = await verifyReleaseEntry({ ...options, requireFresh: false });
  assert.equal(verified.receipt.version, '1.2.3');
}));

test('metadata renewal reuses artifact signatures and receipts byte-for-byte and publishes only new envelopes', async () => temporary(async root => {
  const fixture = updateFixture(), directory = join(root, 'local'), out = join(root, 'renewed'), index = await release(directory, fixture);
  const signed = [], signer = { key: fixture.key, preflight: async () => {}, sign: async file => { signed.push(file); return fixture.signed(await readFile(file)); } };
  const before = new FixtureStore(); await before.load(directory); const original = snapshot(before);
  const result = await renewReleaseMetadata({ directory, out, lifetimeDays: 31 }, { signer, verify: verifier(fixture) });
  assert.equal(result.artifactsChanged, false); assert.equal(result.published, false);
  assert.equal(signed.length, 2); assert.ok(signed.every(file => file.endsWith('.release.json')));
  for (const { channel, target, entry } of indexEntries(index)) {
    const receiptFile = receiptName(channel, target, entry.version);
    assert.deepEqual(await readFile(join(directory, receiptFile)), await readFile(join(out, receiptFile)));
    assert.notEqual(result.manifest.channels[channel].platforms[target].envelopeFile, entry.envelopeFile);
  }
  const after = new FixtureStore(); await after.load(directory); assert.deepEqual(snapshot(after), original);
  await publishRelease({ localDirectory: out }, { remote: before, verify: verifier(fixture) });
  assert.equal(before.mutations.filter(name => name.startsWith('publish:')).length, 2);
  assert.ok(before.mutations.filter(name => name.startsWith('publish:')).every(name => name.endsWith('.update.json')));
}));

test('first publication verifies all platforms, keeps historical files and commits manifest after every artifact', async () => temporary(async root => {
  const fixture = updateFixture(), directory = join(root, 'local'); await release(directory, fixture);
  await writeFile(join(directory, 'unlisted.exe'), 'must not upload');
  const remote = new FixtureStore(); remote.files.set('old-install.dmg', Buffer.from('historical artifact')); remote.files.set('manifest.json', Buffer.from('{"version":"0.3.15","updater":{}}'));
  const result = await publishRelease({ localDirectory: directory }, { remote, verify: verifier(fixture) });
  assert.equal(result.published, true); assert.deepEqual(result.platforms.map(item => item.target), ['darwin-arm64', 'win32-x64']); assert.equal(remote.files.get('old-install.dmg').toString(), 'historical artifact'); assert.ok(!remote.files.has('unlisted.exe'));
  assert.equal(remote.mutations.at(-1), 'restart'); assert.equal(remote.mutations.at(-2), 'compare-and-swap'); assert.ok(remote.mutations.at(-3).startsWith('put:.manifest-'));
  assert.equal(remote.httpVerified, true);
}));

test('partial platform release preserves Windows, retires Intel Mac and verify-only ignores stale local bytes', async () => temporary(async root => {
  const fixture = updateFixture(), oldDirectory = join(root, 'old'), directory = join(root, 'local'), remote = new FixtureStore();
  await release(oldDirectory, fixture, '1.2.2'); await remote.load(oldDirectory);
  const oldIndex = JSON.parse(remote.files.get('manifest.json'));
  oldIndex.channels.stable.platforms['darwin-x64'] = {
    version: '1.2.2', envelopeFile: `Klaus-1.2.2-stable-darwin-x64-${'0'.repeat(16)}.update.json`, envelopeSha256: '0'.repeat(64),
    download: { kind: 'dmg', file: 'Klaus-1.2.2-darwin-x64.dmg', size: 1, sha256: '0'.repeat(64) },
  };
  remote.files.set('manifest.json', Buffer.from(JSON.stringify(oldIndex)));
  await release(directory, fixture, '1.2.3', ['darwin-arm64']);
  await publishRelease({ localDirectory: directory }, { remote, verify: verifier(fixture) });
  const index = JSON.parse(remote.files.get('manifest.json')); assert.equal(index.channels.stable.platforms['darwin-arm64'].version, '1.2.3'); assert.equal(index.channels.stable.platforms['darwin-x64'], undefined); assert.equal(index.channels.stable.platforms['win32-x64'].version, '1.2.2');
  remote.mutations.length = 0; const before = snapshot(remote);
  const result = await publishRelease({ localDirectory: '/does/not/exist', verifyOnly: true }, { remote, verify: verifier(fixture) });
  assert.equal(result.published, false); assert.deepEqual(remote.mutations, []); assert.deepEqual(snapshot(remote), before);
}));

test('missing platform, signature, artifact and immutable collision reject before the first remote mutation', async () => temporary(async root => {
  const fixture = updateFixture();
  for (const failure of ['platform', 'signature', 'artifact', 'collision']) {
    const directory = join(root, failure), index = await release(directory, fixture, '1.2.3', failure === 'platform' ? ['darwin-arm64'] : undefined), remote = new FixtureStore();
    const file = index.channels.stable.platforms['darwin-arm64'].download.file;
    if (failure === 'signature') await rm(join(directory, `${file}.sig`));
    if (failure === 'artifact') await rm(join(directory, file));
    if (failure === 'collision') remote.files.set(file, Buffer.from('already published different bytes'));
    const before = snapshot(remote);
    await assert.rejects(publishRelease({ localDirectory: directory }, { remote, verify: verifier(fixture) }));
    assert.deepEqual(remote.mutations, []); assert.deepEqual(snapshot(remote), before);
  }
}));

test('corrupt transfer and concurrent publication retain the active manifest and never restart', async () => temporary(async root => {
  const fixture = updateFixture(), directory = join(root, 'local'), old = join(root, 'old'); await release(directory, fixture); await release(old, fixture, '1.2.2');
  for (const failure of ['corrupt', 'conflict']) {
    const remote = new FixtureStore(); await remote.load(old); remote[failure] = true;
    const before = Buffer.from(remote.files.get('manifest.json'));
    await assert.rejects(publishRelease({ localDirectory: directory }, { remote, verify: verifier(fixture) }), failure === 'corrupt' ? /Uploaded hash mismatch/ : /Concurrent/);
    assert.deepEqual(remote.files.get('manifest.json'), before); assert.ok(!remote.mutations.includes('restart'));
  }
}));

test('post-commit failures explicitly report the saved index and never silently roll it back', async () => temporary(async root => {
  const fixture = updateFixture(), directory = join(root, 'local'); await release(directory, fixture);
  for (const failure of ['restart', 'verifyHttp']) {
    const remote = new FixtureStore(); remote[failure] = async () => { throw new Error('fixture failure'); };
    await assert.rejects(publishRelease({ localDirectory: directory }, { remote, verify: verifier(fixture) }), /index is committed/);
    assert.equal(JSON.parse(remote.files.get('manifest.json')).channels.stable.platforms['darwin-arm64'].version, '1.2.3');
  }
}));

test('SSH publisher quotes paths, uses a locked compare-and-swap, and never uses rsync --delete', async () => {
  const commands = [], store = new SshReleaseStore({ host: 'release-fixture', run: async (command, args) => { commands.push([command, args]); return { stdout: '' }; } });
  const local = join(tmpdir(), 'path with spaces', 'install.exe');
  await store.put(local, '.upload-fixture.tmp');
  await store.compareAndSwap('.manifest-fixture.tmp', 'a'.repeat(64));
  assert.ok(commands[0][1].includes(local)); assert.ok(!commands[0][1].includes('--delete'));
  assert.match(commands[1][1].at(-1), /^flock -x /); assert.ok(commands[1][1].at(-1).includes('mv -f'));
  assert.throws(() => new SshReleaseStore({ host: '-oProxyCommand=bad' }), /Invalid release SSH host/); assert.throws(() => new SshReleaseStore({ host: 'release-fixture', directory: '/release/../private' }), /simple paths/);
});

test('public route verification requires exact envelopes, artifact lengths and retired legacy feeds', async () => temporary(async root => {
  const fixture = updateFixture(), directory = join(root, 'local'), index = await release(directory, fixture, '1.2.3', ['darwin-arm64']);
  const verified = await verifyReleaseEntry({ ...indexEntries(index)[0], read: name => readFile(join(directory, name)), proof: name => fileProof(join(directory, name)), key: fixture.key });
  for (const failure of [undefined, 'envelope', 'length', 'legacy', 'oversized']) {
    const urls = []; let canceled = false;
    const store = new SshReleaseStore({ host: 'release-fixture', fetch: async (url, options) => {
      urls.push(url); assert.equal(options.redirect, 'manual');
      if (url.includes('/artifact/') || url.includes('/releases/latest/')) {
        assert.equal(options.method, 'HEAD');
        const name = new URL(url).pathname.split('/').at(-1), artifact = name === 'zip' ? verified.receipt.artifacts.update : name === 'dmg' ? verified.receipt.artifacts.download : Object.values(verified.receipt.artifacts).find(item => item.file === name);
        return new Response(null, { status: 200, headers: { 'content-length': String(failure === 'length' ? 1 : artifact.size) } });
      }
      if (url.includes('/releases/desktop/')) return new Response(null, { status: failure === 'legacy' ? 200 : 204 });
      if (url.endsWith('/1.2.3')) return new Response(null, { status: 204 });
      if (failure === 'oversized') return new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(70 * 1024)); }, cancel() { canceled = true; } }));
      return new Response(JSON.stringify(failure === 'envelope' ? { ...verified.envelope, extra: true } : verified.envelope));
    } });
    if (failure) await assert.rejects(store.verifyHttp([verified]));
    else { await store.verifyHttp([verified]); assert.equal(urls.length, 10); }
    if (failure === 'oversized') assert.equal(canceled, true);
  }
}));
