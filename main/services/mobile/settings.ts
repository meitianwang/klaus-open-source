import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { withSettingsTransaction } from '../settings';
import { string, type JsonObject } from '../service-types';

export interface MobileSettings { enabled: boolean; port: number; token: string; relayURL: string; relayOverride: string | null; relayId: string; relaySecret: string }
const prefix = 'mobile_bridge.';
const normalizeURL = (value: string): string => value.trim().replace(/\/+$/u, '');
export function relayURL(value: string): string {
  const normalized = normalizeURL(value), url = new URL(normalized);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) throw new Error('Invalid mobile relay URL');
  return normalized;
}
export class MobileSettingsStore {
  constructor(readonly configRoot: string, private readonly defaultURL: string, private readonly env: NodeJS.ProcessEnv = process.env, private readonly defaultPort = 27189) {
    if (!isAbsolute(configRoot)) throw new Error('Mobile configRoot must be absolute');
    if (!Number.isInteger(defaultPort) || defaultPort < 0 || defaultPort > 65535) throw new Error('Invalid mobile default port');
    relayURL(defaultURL);
  }
  read(update?: JsonObject, rotate = false): MobileSettings {
    return withSettingsTransaction(this.configRoot, db => {
      const get = (key: string): string => string((db.prepare('SELECT value FROM settings WHERE key=?').get(prefix + key) as { value?: string } | undefined)?.value);
      const put = (key: string, value: string): void => { db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(prefix + key, value); };
      const mint = (key: string, size: number): string => { const value = get(key); if (value.trim()) return value; const next = randomBytes(size).toString('base64url'); put(key, next); return next; };
      if (typeof update?.enabled === 'boolean') put('enabled', update.enabled ? '1' : '0');
      if (typeof update?.port === 'number' && Number.isFinite(update.port)) put('port', String(Math.max(0, Math.min(65535, Math.floor(update.port)))));
      if (typeof update?.relayUrl === 'string') { const next = normalizeURL(update.relayUrl); if (next) relayURL(next); put('relay_url', next); }
      if (rotate) put('token', randomBytes(32).toString('base64url'));
      const rawPort = get('port'), port = /^\d+$/u.test(rawPort) ? Number(rawPort) : this.defaultPort;
      const rawEnabled = get('enabled').trim().toLowerCase();
      const override = normalizeURL(get('relay_url')) || normalizeURL(this.env.KLAUS_MOBILE_RELAY_URL || '');
      return { enabled: rawEnabled ? ['1', 'true'].includes(rawEnabled) : true, port: Number.isSafeInteger(port) && port <= 65535 ? port : this.defaultPort, token: mint('token', 32),
        relayURL: relayURL(override || this.defaultURL), relayOverride: override || null, relayId: mint('relay_id', 18), relaySecret: mint('relay_secret', 32) };
    });
  }
}
export async function readMobileMachineIdentifier(platform: NodeJS.Platform): Promise<string | undefined> {
  if (platform !== 'darwin') return undefined;
  try {
    const { stdout } = await promisify(execFile)('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { timeout: 5000, maxBuffer: 1024 * 1024 });
    const value = /"IOPlatformUUID" = "([^"]+)"/u.exec(stdout)?.[1]?.trim();
    return value && value.length >= 8 && value.length <= 512 ? value : undefined;
  } catch { return undefined; }
}
export async function mobileDeviceId(configRoot: string, userId: string, platform: NodeJS.Platform, machine: () => Promise<string | undefined>): Promise<string> {
  if (!userId || userId.trim() !== userId || Buffer.byteLength(userId) > 512) throw new Error('Desktop account identity is invalid.');
  const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
  const key = 'desktop_device_identity.account.v1.' + hash('klaus-device-account-key:v1\0' + userId);
  const read = (entry: string): string | undefined => withSettingsTransaction(configRoot, db => (db.prepare('SELECT value FROM settings WHERE key=?').get(entry) as { value?: string } | undefined)?.value);
  const existing = read(key); if (existing && /^[0-9a-f]{64}$/u.test(existing)) return existing;
  let seed = read('mobile_bridge.device_seed')?.trim();
  const machineId = seed ? undefined : await machine();
  return withSettingsTransaction(configRoot, db => {
    const winner = (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as { value?: string } | undefined)?.value;
    if (winner && /^[0-9a-f]{64}$/u.test(winner)) return winner;
    if (winner) throw new Error('Desktop device identity is unavailable.');
    const getSeed = (db.prepare('SELECT value FROM settings WHERE key=?').get('mobile_bridge.device_seed') as { value?: string } | undefined)?.value?.trim();
    seed = getSeed || seed;
    if (!seed && !machineId) {
      seed = randomUUID();
      db.prepare('INSERT INTO settings(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('mobile_bridge.device_seed', seed);
    }
    const source = seed ? 'fallback:' + seed : 'machine:' + platform + ':' + machineId!;
    const value = hash('klaus-mobile-bridge:v1\0' + userId + '\0' + source);
    db.prepare('INSERT INTO settings(key,value) VALUES (?,?)').run(key, value); return value;
  });
}
