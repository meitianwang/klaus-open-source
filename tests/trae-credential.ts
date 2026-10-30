import assert from 'node:assert/strict';
import { createCipheriv, createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTraeCredential, readTraeLoginDevice } from '../main/services/trae-credential';
import type { Harness } from './harness';

const salt = Buffer.from([77,212,194,230,184,49,98,9,14,82,179,199,166,115,59,164,28,178,70,43,130,154,181,138,25,107,57,219,87,23,117,36,244,155,175,127,8,232,214,141,38,167,46,55,193,169,90,47,31,5,165,24,146,174,242,148,151,50,182,42,56,170,221,88]);
const hash = (value: Uint8Array): Buffer => createHash('sha512').update(value).digest();
function encoded(value: unknown): string {
  const payload = Buffer.from(JSON.stringify(value));
  const seed = randomBytes(32);
  const material = hash(Buffer.concat([hash(seed), salt]));
  const cipher = createCipheriv('aes-128-cbc', material.subarray(0, 16), material.subarray(16, 32));
  return Buffer.concat([Buffer.from([116,99,5,16,0,0]), seed, cipher.update(Buffer.concat([hash(payload), payload])), cipher.final()]).toString('base64');
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'klaus-trae-reader-'));
  const directory = join(root, 'Library', 'Application Support', 'Trae CN', 'User', 'globalStorage');
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'storage.json');
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
  const user = { token: 'synthetic-access', refreshToken: 'synthetic-refresh', expiredAt: '2030-01-01T00:00:00.000Z', refreshExpiredAt: '2030-02-01T00:00:00.000Z', host: 'https://api.trae.cn', userId: 'synthetic-user', account: { username: 'Test User', email: '', unrelatedSecret: 'must-not-escape' } };
  const device = { privateKeyPEM: keys.privateKey, publicKeyPEM: keys.publicKey };
  const store: Record<string, unknown> = { 'iCubeAuthInfo://icube.cloudide': encoded(user), 'iCubeAuthInfo://icube-dc:1234567890': encoded(device), 'telemetry.machineId': 'synthetic-machine', unrelatedSetting: 'must-not-escape' };
  await writeFile(path, JSON.stringify(store));
  return { root, path, user, device, store, save: () => writeFile(path, JSON.stringify(store)), close: () => rm(root, { recursive: true, force: true }) };
}

export function registerTraeCredentialTests(h: Harness): void {
  h.test('local Trae import returns only bounded account and associated device proof without changing source bytes', async () => {
    const f = await fixture();
    try {
      const before = await readFile(f.path);
      const result = await readTraeCredential(f.root);
      assert.deepEqual(result, { accessToken: 'synthetic-access', refreshToken: 'synthetic-refresh', expiresAt: Date.parse(f.user.expiredAt), refreshExpiresAt: Date.parse(f.user.refreshExpiredAt), account: 'Test User', userId: 'synthetic-user', deviceId: '1234567890', machineId: 'synthetic-machine', devicePrivateKey: f.device.privateKeyPEM, devicePublicKey: f.device.publicKeyPEM, clientVersion: '3.4.7', region: 'cn' });
      assert.deepEqual(await readFile(f.path), before);
      assert.equal(JSON.stringify(result).includes('must-not-escape'), false);
    } finally { await f.close(); }
  });

  h.test('independent authorization preserves installed device proof without forwarding account tokens', async () => {
    const f = await fixture();
    const { SubscriptionAuthService } = await import('../main/services/subscription-auth');
    const calls: Array<{ method: string; params: unknown }> = [];
    const service = new SubscriptionAuthService({ homeDir: f.root, configRoot: f.root,
      request: async (method, params) => { calls.push({ method, params }); return { ok: true, flowId: 'independent', authUrl: 'https://www.trae.cn/authorization' }; },
      openExternal: async () => {}, onAuthChanged: () => {} });
    try {
      const before = await readFile(f.path);
      assert.equal((await service.traeStart() as { ok: boolean }).ok, true);
      assert.deepEqual(calls, [{ method: 'trae/loginStart', params: {
        excludedDeviceIds: ['1234567890'], localDeviceProof: { deviceId: '1234567890', machineId: 'synthetic-machine', devicePrivateKey: f.device.privateKeyPEM, devicePublicKey: f.device.publicKeyPEM },
      } }]);
      assert.equal(JSON.stringify(calls).includes('synthetic-access'), false);
      assert.equal(JSON.stringify(calls).includes('synthetic-refresh'), false);
      assert.deepEqual(await readFile(f.path), before);
    } finally { await service.close(); await f.close(); }
  });

  h.test('browser login keeps all external device exclusions without requiring an account grant', async () => {
    const f = await fixture();
    try {
      delete f.store['iCubeAuthInfo://icube.cloudide']; await f.save();
      const device = await readTraeLoginDevice(f.root);
      assert.deepEqual(device.excludedDeviceIds, ['1234567890']);
      assert.equal(device.localDeviceProof?.devicePrivateKey, f.device.privateKeyPEM);
      f.store['iCubeAuthInfo://icube-dc:1234567890'] = 'corrupt-proof'; await f.save();
      assert.deepEqual(await readTraeLoginDevice(f.root), { excludedDeviceIds: ['1234567890'] });
      f.store['iCubeAuthInfo://icube-dc:2345678901'] = encoded(f.device); await f.save();
      assert.deepEqual(await readTraeLoginDevice(f.root), { excludedDeviceIds: ['1234567890', '2345678901'] });
      await writeFile(f.path, '{malformed');
      await assert.rejects(readTraeLoginDevice(f.root), { message: 'trae_local_unreadable' });
      await rm(f.path);
      assert.deepEqual(await readTraeLoginDevice(f.root), { excludedDeviceIds: [] });
    } finally { await f.close(); }
  });

  h.test('malformed or corrupt local account records fail closed without exposing their bytes', async () => {
    const f = await fixture();
    try {
      const valid = String(f.store['iCubeAuthInfo://icube.cloudide']);
      const corrupt = Buffer.from(valid, 'base64'); corrupt[corrupt.length - 20] = corrupt[corrupt.length - 20]! ^ 1;
      const badHeader = Buffer.from(valid, 'base64'); badHeader[0] = badHeader[0]! ^ 1;
      for (const value of ['not base64 secret', 'x'.repeat(128 * 1024 + 1), encoded({ ...f.user, token: 'secret\ninjected' }), encoded({ ...f.user, expiredAt: 'invalid' }), encoded({ ...f.user, expiredAt: Number.MAX_SAFE_INTEGER }), corrupt.toString('base64'), badHeader.toString('base64')]) {
        f.store['iCubeAuthInfo://icube.cloudide'] = value;
        await f.save();
        await assert.rejects(readTraeCredential(f.root), { message: 'trae_local_unreadable' });
      }
      await writeFile(f.path, '{broken-secret');
      await assert.rejects(readTraeCredential(f.root), { message: 'trae_local_unreadable' });
      await writeFile(f.path, 'x'.repeat(8 * 1024 * 1024 + 1));
      await assert.rejects(readTraeCredential(f.root), { message: 'trae_local_unreadable' });
    } finally { await f.close(); }
  });

  h.test('ambiguous devices and mismatched proof keys cannot be associated with an imported account', async () => {
    const f = await fixture();
    try {
      f.store['iCubeAuthInfo://icube-dc:other'] = f.store['iCubeAuthInfo://icube-dc:1234567890'];
      await f.save();
      await assert.rejects(readTraeCredential(f.root), { message: 'trae_local_device_unavailable' });
      delete f.store['iCubeAuthInfo://icube-dc:other'];
      const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
      f.store['iCubeAuthInfo://icube-dc:1234567890'] = encoded({ ...f.device, publicKeyPEM: other.publicKey });
      await f.save();
      await assert.rejects(readTraeCredential(f.root), { message: 'trae_local_device_unavailable' });
      delete f.store['iCubeAuthInfo://icube-dc:1234567890'];
      await f.save();
      await assert.rejects(readTraeCredential(f.root), { message: 'trae_local_device_unavailable' });
    } finally { await f.close(); }
  });

  h.test('unsupported local regions, missing storage and non-file storage have distinct safe outcomes', async () => {
    const f = await fixture();
    try {
      f.store['iCubeAuthInfo://icube.cloudide'] = encoded({ ...f.user, host: 'https://untrusted.invalid' });
      await f.save();
      await assert.rejects(readTraeCredential(f.root), { message: 'trae_local_region_unsupported' });
      await rm(f.path);
      await assert.rejects(readTraeCredential(f.root), { message: 'trae_local_not_found' });
      await mkdir(f.path);
      await assert.rejects(readTraeCredential(f.root), { message: 'trae_local_unreadable' });
    } finally { await f.close(); }
  });
}
