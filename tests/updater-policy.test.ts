import { deepEqual, equal, throws, rejects } from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KLAUS_UPDATE_PUBLIC_KEY, parseReleaseEnvelope, productionPolicy, updateUrl } from '../main/updater/policy';
import { parseMinisignKey, strictBase64, verifyMinisign, verifyMinisignFile } from '../main/updater/minisign';
import { updateFixture } from './updater-fixture';
import { parseInstalledUpdateConfiguration } from '../main/updater/configuration';
import { verifyPlatformSignature } from '../main/updater/platform';
import { Harness } from './harness';
import { readFileSync } from 'node:fs';
import { getDesktopEdition } from '../main/services/desktop-edition';

const h = new Harness();
const encode = (value: string) => Buffer.from(value).toString('base64');
void (async () => {
  await h.test('same-key same-version update policies and offers bind the exact installed application in both directions', () => {
    const vectors = JSON.parse(readFileSync(join(__dirname, '../../contracts/vectors/desktop-edition-update-vectors.json'), 'utf8')) as {
      cases: { installed: string; offered: string; accepted: boolean }[];
    };
    const f = updateFixture();
    for (const platform of ['darwin', 'win32'] as const) for (const vector of vectors.cases) {
      const installed = getDesktopEdition(vector.installed), offered = getDesktopEdition(vector.offered);
      const target = { application: installed.application, platform, arch: platform === 'darwin' ? 'arm64' as const : 'x64' as const, version: '1.0.0' };
      const feedUrl = `${installed.serverUrl}/releases/electron/stable/${platform}/${target.arch}/1.0.0`;
      const policy = { ...productionPolicy({ ...target, currentVersion: target.version, channel: 'stable', feedUrl }), key: f.key };
      const release = { ...f.release(), application: offered.application, platform, arch: target.arch,
        artifact: { ...f.release().artifact, kind: platform === 'darwin' ? 'mac-zip' as const : 'nsis' as const,
          url: `${offered.serverUrl}/${offered.artifactPrefix}-1.1.0.${platform === 'darwin' ? 'zip' : 'exe'}` } };
      const config = { schemaVersion: 1, kind: 'installed-update-policy', framework: 'electron', ...target, application: offered.application,
        channel: 'stable', feedUrl, installer: platform === 'darwin' ? 'mac-zip' : 'nsis',
        ...(platform === 'darwin' ? { teamId: 'ABCDE12345' } : { windowsAuthenticode: 'not-configured' }) };
      const bytes = Buffer.from(JSON.stringify(config)), envelope = { payload: bytes.toString('base64'), signature: f.signed(bytes) };
      if (vector.accepted) {
        equal(parseReleaseEnvelope(f.envelope(release), policy).release.application, installed.application);
        equal(parseInstalledUpdateConfiguration(envelope, target, f.key).application, installed.application);
      } else {
        throws(() => parseReleaseEnvelope(f.envelope(release), policy), /product or framework mismatch/);
        throws(() => parseInstalledUpdateConfiguration(envelope, target, f.key), /identity/);
      }
    }
    equal(productionPolicy({ ...f.policy, feedUrl: 'https://updates.example.invalid/feed' }).application, getDesktopEdition().application);
    throws(() => productionPolicy({ ...f.policy, application: 'unknown', feedUrl: 'https://updates.example.invalid/feed' }), /application/);
  });
  await h.test('the existing Klaus public key retains its exact key id and Ed25519 bytes', () => {
    const key = parseMinisignKey(KLAUS_UPDATE_PUBLIC_KEY);
    equal(key.id.toString('hex'), 'd49d790e2309ac04');
    equal(key.key.asymmetricKeyType, 'ed25519');
  });
  await h.test('official Minisign published legacy and streaming vectors verify; altered data and trusted comments fail', () => {
    // Independent vectors published by jedisct1/rust-minisign-verify 0.2.5, src/lib.rs.
    const key = parseMinisignKey(encode('untrusted comment: public test vector\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3'));
    const vectors = [
      'untrusted comment: signature from minisign secret key\nRWQf6LRCGA9i59SLOFxz6NxvASXDJeRtuZykwQepbDEGt87ig1BNpWaVWuNrm73YiIiJbq71Wi+dP9eKL8OC351vwIasSSbXxwA=\ntrusted comment: timestamp:1555779966\tfile:test\nQtKMXWyYcwdpZAlPF7tE2ENJkRd1ujvKjlj1m9RtHTBnZPa5WKU5uWRs5GoP5M/VqE81QFuMKI5k/SfNQUaOAA==',
      'untrusted comment: signature from minisign secret key\nRUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\ntrusted comment: timestamp:1556193335\tfile:test\ny/rUw2y8/hOUYjZU71eHp/Wo1KZ40fGy2VJEDl34XMJM+TX48Ss/17u3IvIfbVR1FkZZSNCisQbuQY+bHwhEBg==',
    ];
    for (const vector of vectors) {
      verifyMinisign(Buffer.from('test'), encode(vector), key);
      throws(() => verifyMinisign(Buffer.from('Test'), encode(vector), key), /verification failed/);
      throws(() => verifyMinisign(Buffer.from('test'), encode(vector.replace('file:test', 'file:other')), key), /verification failed/);
    }
  });
  await h.test('signature parsing rejects unknown keys, algorithms and permissive base64 forms', () => {
    const a = updateFixture(), b = updateFixture();
    throws(() => verifyMinisign(a.artifact, a.signed(a.artifact), b.key), /key does not match/);
    for (const value of ['abcd!', 'YQ=', 'YQ', 'Y Q==', 'YR==']) throws(() => strictBase64(value));
    const bad = Buffer.from(a.signed(a.artifact), 'base64').toString().split('\n');
    const bytes = Buffer.from(bad[1]!, 'base64'); bytes[0] = 0; bad[1] = bytes.toString('base64');
    throws(() => verifyMinisign(a.artifact, encode(bad.join('\n')), a.key), /Unsupported/);
  });
  await h.test('installed policy is signed separately and pins the current app and OS publisher', () => {
    const f = updateFixture(), config = { schemaVersion: 1, kind: 'installed-update-policy', application: 'ai.klaus.desktop', framework: 'electron', version: '1.0.0', platform: 'darwin', arch: 'arm64', installer: 'mac-zip', channel: 'stable', feedUrl: 'https://updates.example.invalid/releases/electron/feed.json', teamId: '5TMKAXN7M6' };
    const payload = Buffer.from(JSON.stringify(config)), envelope = { payload: payload.toString('base64'), signature: f.signed(payload) }, target = { platform: 'darwin', arch: 'arm64', version: '1.0.0' };
    deepEqual(parseInstalledUpdateConfiguration(envelope, target, f.key), config);
    throws(() => parseInstalledUpdateConfiguration(config, target, f.key), /signed envelope/);
    throws(() => parseInstalledUpdateConfiguration(envelope, { ...target, version: '1.1.0' }, f.key), /identity/);
    throws(() => parseInstalledUpdateConfiguration(envelope, target), /key does not match/);
    throws(() => parseInstalledUpdateConfiguration({ ...envelope, payload: encode(JSON.stringify({ ...config, teamId: 'AAAAAAAAAA' })) }, target, f.key), /verification/);
    throws(() => parseReleaseEnvelope(envelope, f.policy), /framework mismatch/);
  });
  await h.test('only an explicitly signed Windows policy selects Minisign without Authenticode', async () => {
    const f = updateFixture(), target = { platform: 'win32', arch: 'x64', version: '1.0.0' };
    const base = { schemaVersion: 1, kind: 'installed-update-policy', application: 'ai.klaus.desktop', framework: 'electron', ...target,
      installer: 'nsis', channel: 'stable', feedUrl: 'https://updates.example.invalid/releases/electron/stable/win32/x64/1.0.0' };
    const seal = (config: object) => { const bytes = Buffer.from(JSON.stringify(config)); return { payload: bytes.toString('base64'), signature: f.signed(bytes) }; };
    const config = { ...base, windowsAuthenticode: 'not-configured' };
    deepEqual(parseInstalledUpdateConfiguration(seal(config), target, f.key), config);
    const publisher = { ...base, publisher: 'CN=Existing publisher' };
    deepEqual(parseInstalledUpdateConfiguration(seal(publisher), target, f.key), publisher);
    for (const change of [{}, { windowsAuthenticode: null }, { windowsAuthenticode: 'disabled' }, { windowsAuthenticode: false },
      { windowsAuthenticode: 'not-configured', publisher: 'CN=Existing publisher' }, { windowsAuthenticode: 'not-configured', publisher: null }]) {
      throws(() => parseInstalledUpdateConfiguration(seal({ ...base, ...change }), target, f.key), /publisher|Authenticode/);
    }
    throws(() => parseInstalledUpdateConfiguration({ ...seal(config), signature: seal(publisher).signature }, target, f.key), /verification/);
    throws(() => parseInstalledUpdateConfiguration(seal(config), target), /key does not match/);
    throws(() => parseInstalledUpdateConfiguration(seal({ ...config, feedUrl: 'http://updates.example.invalid/' }), target, f.key), /HTTPS/);
    const identity = { platform: 'win32' as const, executable: '/fixture/not-executed.exe', windowsAuthenticode: 'not-configured' as const };
    await verifyPlatformSignature(identity.executable, identity);
    await rejects(verifyPlatformSignature(identity.executable, { ...identity, publisher: 'CN=Existing publisher' }), /Authenticode policy/);
    await rejects(verifyPlatformSignature(identity.executable, { platform: 'win32', executable: identity.executable }), /pinned Windows publisher/);
    await rejects(verifyPlatformSignature(identity.executable, identity, AbortSignal.abort()), /abort/i);
  });
  await h.test('a signed Electron release binds product, framework, target, version and installer kind', () => {
    const f = updateFixture(), release = f.release();
    deepEqual(parseReleaseEnvelope(f.envelope(release), f.policy).release, release);
    for (const change of [{ application: 'other' }, { framework: 'tauri' }, { platform: 'win32' }, { arch: 'x64' }, { version: '1.0.0' }, { version: '0.9.0' }, { version: '1.2.0-beta.1' }, { version: 'v1.2.0' }, { channel: 'preview' }]) throws(() => parseReleaseEnvelope(f.envelope({ ...release, ...change } as typeof release), f.policy));
    throws(() => parseReleaseEnvelope(f.envelope({ ...release, artifact: { ...release.artifact, kind: 'nsis' } }), f.policy), /format mismatch/);
    throws(() => parseReleaseEnvelope(f.envelope({ ...release, artifact: { ...release.artifact, url: 'https://updates.example.invalid/Klaus.app.tar.gz' } }), f.policy), /filename/);
  });
  await h.test('metadata tampering, unsigned Tauri offers, expiration and oversized downloads fail closed', () => {
    const f = updateFixture(), release = f.release(), envelope = f.envelope(release);
    throws(() => parseReleaseEnvelope({ ...envelope, payload: encode(JSON.stringify({ ...release, version: '9.9.9' })) }, f.policy), /verification/);
    throws(() => parseReleaseEnvelope({ version: '9.9.9', signature: envelope.signature, url: release.artifact.url }, f.policy), /envelope/);
    throws(() => parseReleaseEnvelope(f.envelope({ ...release, expiresAt: new Date(0).toISOString() }), f.policy), /expired/);
    throws(() => parseReleaseEnvelope(f.envelope({ ...release, artifact: { ...release.artifact, size: 3 * 1024 ** 3 } }), f.policy), /size/);
  });
  await h.test('production transport rejects HTTP, credentials and fixture-origin overrides', () => {
    const f = updateFixture();
    for (const url of ['http://127.0.0.1/feed', 'http://example.com/feed', 'file:///update.zip', 'https://user:password@example.com/feed', 'https://example.com/feed#part']) throws(() => productionPolicy({ ...f.policy, feedUrl: url }));
    throws(() => productionPolicy({ ...f.policy, platform: 'darwin', arch: 'x64', feedUrl: 'https://updates.example.invalid/feed' }), /Unsupported installed Electron update target/);
    equal(updateUrl('http://127.0.0.1:43210/feed', { fixtureOrigin: 'http://127.0.0.1:43210' }).port, '43210');
    throws(() => updateUrl('http://127.0.0.1:43211/feed', { fixtureOrigin: 'http://127.0.0.1:43210' }));
  });
  await h.test('streaming artifact verification checks both hashes, size, signature and abort', async () => {
    const f = updateFixture(), directory = await mkdtemp(join(tmpdir(), 'klaus-update-proof-'));
    const path = join(directory, 'update.zip'), expected = f.release().artifact;
    try {
      await writeFile(path, f.artifact); await verifyMinisignFile(path, expected.signature, f.key, expected);
      await rejects(verifyMinisignFile(path, expected.signature, f.key, { ...expected, sha512: Buffer.alloc(64).toString('base64') }), /checksum/);
      await writeFile(path, Buffer.alloc(f.artifact.length)); await rejects(verifyMinisignFile(path, expected.signature, f.key, expected), /checksum/);
      await writeFile(path, f.artifact); await rejects(verifyMinisignFile(path, expected.signature, f.key, expected, AbortSignal.abort()), /abort/i);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
  process.exitCode = await h.finish(join(__dirname, 'updater-policy.result.json'), 'updater-policy');
})();
