import { createDecipheriv, createHash, createPrivateKey, createPublicKey, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JsonObject } from './service-types';

const MAX_STORAGE_BYTES = 8 * 1024 * 1024;
const MAX_ENCODED_BYTES = 128 * 1024;
const HEADERS = [[116, 99, 5, 16, 0, 0], [18, 57, 32, 32, 2, 3]];
// The local storage codec uses fixed, non-account salts and a per-record seed.
const SALTS = [
  [77,212,194,230,184,49,98,9,14,82,179,199,166,115,59,164,28,178,70,43,130,154,181,138,25,107,57,219,87,23,117,36,244,155,175,127,8,232,214,141,38,167,46,55,193,169,90,47,31,5,165,24,146,174,242,148,151,50,182,42,56,170,221,88],
  [73,12,194,18,146,176,93,12,192,108,203,233,31,185,46,33,181,167,197,56,129,29,200,94,39,169,110,40,16,78,28,246,156,113,102,239,171,35,40,7,57,13,167,138,139,145,228,156,68,180,154,67,254,185,65,161,228,111,38,86,230,19,228,123],
];
const sha512 = (value: Uint8Array): Buffer => createHash('sha512').update(value).digest();
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

function decode(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length > MAX_ENCODED_BYTES || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length % 4 !== 0) throw new Error('trae_local_unreadable');
  const bytes = Buffer.from(value, 'base64');
  const index = HEADERS.findIndex(header => bytes.subarray(0, 6).equals(Buffer.from(header)));
  if (index < 0 || bytes.length < 118 || (bytes.length - 38) % 16 !== 0) throw new Error('trae_local_unreadable');
  const material = sha512(Buffer.concat([sha512(bytes.subarray(6, 38)), Buffer.from(SALTS[index]!)]));
  const decipher = createDecipheriv('aes-128-cbc', material.subarray(0, 16), material.subarray(16, 32));
  const plain = Buffer.concat([decipher.update(bytes.subarray(38)), decipher.final()]);
  const payload = plain.subarray(64);
  if (plain.length <= 64 || !timingSafeEqual(plain.subarray(0, 64), sha512(payload))) throw new Error('trae_local_unreadable');
  const parsed: unknown = JSON.parse(payload.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('trae_local_unreadable');
  return record(parsed);
}

function opaque(value: unknown, limit = 32 * 1024): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limit && /^[\x21-\x7e]+$/.test(value);
}

function expiry(value: unknown): number {
  if (typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value)) {
    const parsed = Date.parse(value);
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed;
    throw new Error('trae_local_unreadable');
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error('trae_local_unreadable');
  const milliseconds = value < 100_000_000_000 ? value * 1000 : value;
  if (!Number.isSafeInteger(milliseconds) || !Number.isFinite(new Date(milliseconds).getTime())) throw new Error('trae_local_unreadable');
  return milliseconds;
}

async function readStore(home: string): Promise<Record<string, unknown>> {
  let file;
  try { file = await open(join(home, 'Library', 'Application Support', 'Trae CN', 'User', 'globalStorage', 'storage.json'), constants.O_RDONLY | (constants.O_NONBLOCK ?? 0)); }
  catch (error) { throw new Error((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'trae_local_not_found' : 'trae_local_unreadable'); }
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_STORAGE_BYTES) throw new Error('trae_local_unreadable');
    const buffer = Buffer.alloc(Math.min(info.size + 1, MAX_STORAGE_BYTES + 1));
    let length = 0;
    while (length < buffer.length) {
      const part = await file.read(buffer, length, buffer.length - length, null);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length > MAX_STORAGE_BYTES || length > info.size) throw new Error('trae_local_unreadable');
    const parsed: unknown = JSON.parse(buffer.subarray(0, length).toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('trae_local_unreadable');
    return record(parsed);
  } catch { throw new Error('trae_local_unreadable'); }
  finally { await file.close(); }
}

export interface TraeDeviceProof {
  deviceId: string; machineId: string; devicePrivateKey: string; devicePublicKey: string;
}

function deviceProof(store: Record<string, unknown>): TraeDeviceProof {
  const prefix = 'iCubeAuthInfo://icube-dc:';
  const devices = Object.entries(store).filter(([key]) => key.startsWith(prefix));
  if (devices.length !== 1) throw new Error('trae_local_device_unavailable');
  const [key, value] = devices[0]!;
  const deviceId = key.slice(prefix.length), machineId = store['telemetry.machineId'];
  if (!opaque(deviceId, 256) || !opaque(machineId, 256)) throw new Error('trae_local_device_unavailable');
  const device = decode(value);
  if (typeof device.privateKeyPEM !== 'string' || device.privateKeyPEM.length > 4096 || typeof device.publicKeyPEM !== 'string' || device.publicKeyPEM.length > 4096) throw new Error('trae_local_device_unavailable');
  const privateKey = createPrivateKey(device.privateKeyPEM), publicKey = createPublicKey(device.publicKeyPEM);
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1' ||
    !createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).equals(publicKey.export({ type: 'spki', format: 'der' }))) throw new Error('trae_local_device_unavailable');
  return { deviceId, machineId, devicePrivateKey: device.privateKeyPEM, devicePublicKey: device.publicKeyPEM };
}

/** Preserve external device exclusions even when an account grant is absent or unreadable. */
export async function readTraeLoginDevice(home = homedir()): Promise<{ excludedDeviceIds: string[]; localDeviceProof?: TraeDeviceProof }> {
  let store: Record<string, unknown>;
  try { store = await readStore(home); }
  catch (error) { if (error instanceof Error && error.message === 'trae_local_not_found') return { excludedDeviceIds: [] }; throw error; }
  const prefix = 'iCubeAuthInfo://icube-dc:';
  const excludedDeviceIds = Object.keys(store).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
  if (excludedDeviceIds.length > 32 || excludedDeviceIds.some(id => !/^[1-9]\d{0,31}$/.test(id))) throw new Error('trae_local_device_unavailable');
  try { return { excludedDeviceIds, localDeviceProof: deviceProof(store) }; }
  catch { return { excludedDeviceIds }; }
}

/** Read only the authorized account and matching device proof; never return the source document. */
export async function readTraeCredential(home = homedir()): Promise<JsonObject> {
  try {
    const store = await readStore(home);
    const user = decode(store['iCubeAuthInfo://icube.cloudide']);
    if (user.host !== 'https://api.trae.cn') throw new Error('trae_local_region_unsupported');
    if (!opaque(user.token) || !opaque(user.refreshToken)) throw new Error('trae_local_unreadable');
    const proof = deviceProof(store);
    const account = record(user.account);
    const label = [account.username, account.email, account.name, user.userId].find(value => typeof value === 'string' && value.length > 0 && value.length <= 320 && !/[\x00-\x1f\x7f]/.test(value));
    return {
      accessToken: user.token, refreshToken: user.refreshToken,
      expiresAt: expiry(user.expiredAt), refreshExpiresAt: expiry(user.refreshExpiredAt),
      ...(typeof label === 'string' ? { account: label } : {}),
      ...(opaque(user.userId, 256) ? { userId: user.userId } : {}),
      ...proof,
      clientVersion: '3.4.7', region: 'cn',
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (['trae_local_not_found', 'trae_local_region_unsupported', 'trae_local_device_unavailable'].includes(message)) throw error;
    throw new Error('trae_local_unreadable');
  }
}
