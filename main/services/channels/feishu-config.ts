import { object, string, type JsonObject } from '../service-types';
import { channelUrl } from './channel-http';

export function feishuId(value: unknown, label = 'identifier'): string {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || Buffer.byteLength(value) > 2048 || /[\u0000-\u0020\u007f]/u.test(value)) throw new Error('Invalid Feishu ' + label);
  return value;
}
const names = ['requireMention', 'enabled', 'allowFrom', 'groupSessionScope', 'topicSessionMode', 'replyInThread'] as const;
export interface FeishuGroupConfig { requireMention?: boolean; enabled?: boolean; allowFrom?: string[]; groupSessionScope?: string; topicSessionMode?: string; replyInThread?: string }
export interface FeishuConfig extends FeishuGroupConfig {
  appId: string; appSecret: string; domain: string; connectionMode: 'websocket' | 'webhook';
  encryptKey?: string; verificationToken?: string; webhookHost: string; webhookPort: number; webhookPath: string; httpTimeoutMs: number;
  dmPolicy: string; groupPolicy: string; groupAllowFrom?: string[]; groupSenderAllowFrom?: string[]; groups: Record<string, FeishuGroupConfig>;
  renderMode: string; typingIndicator: boolean; resolveSenderNames: boolean;
}
const snake = (key: string): string => key.replace(/[A-Z]/gu, character => '_' + character.toLowerCase());
function field(input: JsonObject, key: string): unknown { return input[key] ?? input[snake(key)]; }
function decode(value: unknown): unknown { if (typeof value !== 'string') return value; try { return JSON.parse(value); } catch { return value; } }
function bool(value: unknown): boolean | undefined { if (value === undefined) return undefined; const parsed = decode(value); if (parsed === true || parsed === 1) return true; if (parsed === false || parsed === 0) return false; throw new Error('Invalid Feishu boolean setting'); }
function list(value: unknown): string[] | undefined {
  if (value === undefined) return undefined; const parsed = decode(value);
  if (!Array.isArray(parsed) || parsed.length > 10_000 || parsed.some(entry => typeof entry !== 'string' && typeof entry !== 'number')) throw new Error('Invalid Feishu allowlist setting');
  const result = parsed.map(String); if (result.some(entry => Buffer.byteLength(entry) > 2048)) throw new Error('Feishu allowlist entry exceeds the size limit'); return result;
}
function choice(value: unknown, allowed: string[]): string | undefined { if (value === undefined) return undefined; if (typeof value !== 'string' || !allowed.includes(value)) throw new Error('Invalid Feishu policy or routing setting'); return value; }
function group(input: JsonObject): FeishuGroupConfig {
  const result: FeishuGroupConfig = {};
  for (const key of names) {
    const value = field(input, key); if (value === undefined) continue;
    if (key === 'requireMention' || key === 'enabled') result[key] = bool(value);
    else if (key === 'allowFrom') result[key] = list(value);
    else result[key] = choice(value, key === 'groupSessionScope' ? ['group', 'group_sender', 'group_topic', 'group_topic_sender'] : ['enabled', 'disabled']);
  }
  return result;
}
export function feishuConfiguration(account: Record<string, string> | JsonObject): FeishuConfig {
  const input = account as JsonObject, appId = feishuId(field(input, 'appId'), 'app id'), appSecret = string(field(input, 'appSecret'));
  if (!appSecret.trim() || Buffer.byteLength(appSecret) > 16_384 || /[\u0000-\u001f\u007f]/u.test(appSecret)) throw new Error('Invalid Feishu app secret');
  const rawDomain = string(input.domain, 'feishu'), domain = rawDomain === 'lark' ? 'https://open.larksuite.com' : !rawDomain || rawDomain === 'feishu' ? 'https://open.feishu.cn' : channelUrl(rawDomain).toString().replace(/\/+$/u, '');
  const groupsValue = field(input, 'groups'), groupsRaw = groupsValue === undefined ? {} : decode(groupsValue);
  if (!groupsRaw || typeof groupsRaw !== 'object' || Array.isArray(groupsRaw) || Object.keys(groupsRaw).length > 1000) throw new Error('Invalid Feishu groups setting');
  const groups: Record<string, FeishuGroupConfig> = Object.create(null) as Record<string, FeishuGroupConfig>;
  for (const key of Object.keys(groupsRaw).sort()) { feishuId(key, 'group configuration key'); const value = object(groupsRaw)[key]; if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Feishu group override'); groups[key] = group(object(value)); }
  const integer = (key: string, fallback: number, min: number, max: number): number => { const raw = field(input, key), value = raw === undefined ? fallback : Number(raw); if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid Feishu numeric setting'); return value; };
  const encryptKey = string(field(input, 'encryptKey')) || undefined, verificationToken = string(field(input, 'verificationToken')) || undefined;
  for (const secret of [encryptKey, verificationToken]) if (secret && (Buffer.byteLength(secret) > 16_384 || /[\u0000-\u001f\u007f]/u.test(secret))) throw new Error('Invalid Feishu webhook credential');
  const connectionMode = choice(field(input, 'connectionMode'), ['websocket', 'webhook']) ?? 'websocket';
  if (connectionMode === 'webhook' && !encryptKey && !verificationToken) throw new Error('Feishu webhook requires encrypt_key or verification_token');
  const webhookHost = string(field(input, 'webhookHost'), '127.0.0.1'), webhookPath = string(field(input, 'webhookPath'), '/feishu/events');
  if (!webhookHost || /[\u0000-\u0020\u007f/]/u.test(webhookHost) || !webhookPath.startsWith('/') || /[?#\u0000-\u0020\u007f]/u.test(webhookPath)) throw new Error('Invalid Feishu webhook address');
  return { ...group(input), appId, appSecret, domain, connectionMode: connectionMode as FeishuConfig['connectionMode'], encryptKey, verificationToken, webhookHost, webhookPath,
    webhookPort: integer('webhookPort', 3000, 0, 65535), httpTimeoutMs: integer('httpTimeoutMs', 30_000, 1, 300_000),
    dmPolicy: choice(field(input, 'dmPolicy'), ['open', 'pairing', 'allowlist', 'disabled']) ?? 'pairing', groupPolicy: choice(field(input, 'groupPolicy'), ['open', 'allowlist', 'disabled']) ?? 'allowlist',
    groupAllowFrom: list(field(input, 'groupAllowFrom')), groupSenderAllowFrom: list(field(input, 'groupSenderAllowFrom')), groups,
    renderMode: choice(field(input, 'renderMode'), ['auto', 'card', 'text']) ?? 'auto', typingIndicator: bool(field(input, 'typingIndicator')) ?? true, resolveSenderNames: bool(field(input, 'resolveSenderNames')) ?? true };
}
export function feishuGroupConfig(config: FeishuConfig, id: string): FeishuGroupConfig | undefined {
  const key = id.trim(); return config.groups[key] ?? config.groups[Object.keys(config.groups).find(entry => entry.toLowerCase() === key.toLowerCase()) ?? ''] ?? config.groups['*'];
}
export function feishuAllows(allowed: string[] | undefined, ids: string[]): boolean {
  const normalize = (value: string): string => value.trim().replace(/^feishu:/iu, '').trim().toLowerCase(), values = (allowed ?? []).map(normalize).filter(Boolean);
  return values.includes('*') || ids.map(normalize).filter(Boolean).some(id => values.includes(id));
}
