import { isAbsolute } from 'node:path';
import { withSettingsDb, withSettingsTransaction } from '../settings';
import { ChannelCredentialCodec } from './credentials';
import { channelDefinition } from './types';
import type { JsonObject } from '../service-types';

export interface WechatPairingCredential { token: string; baseUrl: string; accountId: string }
export function validateChannelConfiguration(id: string, config: JsonObject): void {
  const definition = channelDefinition(id);
  if (!definition) throw new Error('Unknown channel: ' + id);
  for (const field of definition.fields) if (typeof config[field] !== 'string' || !config[field].trim()) throw new Error('Missing required field: ' + field);
  for (const key of Object.keys(config)) if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,127}$/u.test(key)) throw new Error('Invalid channel setting key');
}

/** Shares the existing settings table; it never creates a second credential file. */
export class ChannelSettingsStore {
  constructor(readonly configRoot: string, private readonly codec = new ChannelCredentialCodec()) {
    if (!isAbsolute(configRoot)) throw new Error('Channel configRoot must be absolute');
  }
  get(key: string): string | undefined {
    return withSettingsDb(this.configRoot, db => {
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
      if (!row) return undefined;
      if (typeof row.value !== 'string') throw new Error('Invalid channel setting value');
      return row.value;
    });
  }
  configuration(id: string, decrypt = false): Record<string, string> {
    if (!channelDefinition(id)) throw new Error('Unknown channel: ' + id);
    const prefix = 'channel.' + id + '.';
    return withSettingsDb(this.configRoot, db => {
      const values: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const row of db.prepare('SELECT key, value FROM settings WHERE key LIKE ?').all(prefix + '%')) {
        if (typeof row.key !== 'string' || typeof row.value !== 'string') throw new Error('Invalid channel setting value');
        values[row.key.slice(prefix.length)] = decrypt ? this.codec.decrypt(row.value) : row.value;
      }
      return values;
    });
  }
  saveConfiguration(id: string, config: JsonObject): void {
    validateChannelConfiguration(id, config);
    withSettingsTransaction(this.configRoot, db => {
      const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      const get = db.prepare('SELECT value FROM settings WHERE key = ?');
      for (const [field, value] of Object.entries(config)) {
        const key = 'channel.' + id + '.' + field;
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        const secret = /(?:token|secret|password|api_key|encrypt_?key)$/iu.test(field);
        // The form may submit the existing opaque envelope unchanged.
        const unchangedEnvelope = get.get(key)?.value === text && /^[a-fA-F0-9]{32}:(?:[a-fA-F0-9]{2})+$/u.test(text);
        const stored = secret && !unchangedEnvelope ? this.codec.encrypt(text) : text;
        put.run(key, stored);
      }
      put.run('channel.' + id + '.enabled', '1');
    });
  }
  disable(id: string): boolean {
    const definition = channelDefinition(id); if (!definition) return false;
    withSettingsTransaction(this.configRoot, db => {
      const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      put.run('channel.' + id + '.enabled', '0');
      for (const field of definition.fields) put.run('channel.' + id + '.' + field, '');
    });
    return true;
  }
  claimOwner(id: string, senderId: string): void {
    if (!channelDefinition(id) || !senderId) return;
    withSettingsTransaction(this.configRoot, db => {
      db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value WHERE settings.value = ''").run('channel.' + id + '.owner_id', senderId);
    });
  }
  saveWechatPairing(credential: WechatPairingCredential): void {
    if (!credential.token || !credential.baseUrl || !credential.accountId) throw new Error('Incomplete WeChat pairing credentials');
    const rows: Array<[string, string]> = [
      ['channel.wechat.token', this.codec.encrypt(credential.token)],
      ['channel.wechat.base_url', credential.baseUrl],
      ['channel.wechat.account_id', credential.accountId],
      ['channel.wechat.enabled', '1'],
    ];
    withSettingsTransaction(this.configRoot, db => {
      const put = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      for (const [key, value] of rows) put.run(key, value);
    });
  }
  wechatCredential(): WechatPairingCredential | undefined {
    return withSettingsDb(this.configRoot, db => {
      const rows = db.prepare('SELECT key, value FROM settings WHERE key IN (?, ?, ?)').all('channel.wechat.token', 'channel.wechat.base_url', 'channel.wechat.account_id');
      const values: Record<string, string> = {};
      for (const row of rows) {
        if (typeof row.key !== 'string' || typeof row.value !== 'string') throw new Error('Invalid channel setting value');
        values[row.key] = row.value;
      }
      const token = values['channel.wechat.token'], baseUrl = values['channel.wechat.base_url'], accountId = values['channel.wechat.account_id'];
      return token && baseUrl && accountId ? { token: this.codec.decrypt(token), baseUrl, accountId } : undefined;
    });
  }
}
