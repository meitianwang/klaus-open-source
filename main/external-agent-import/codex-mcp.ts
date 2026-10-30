import * as TOML from '@iarna/toml';
import { join } from 'node:path';
import { object, type JsonObject } from '../services/service-types';
import { sourceBytes } from './files';

const MAX_CONFIG_BYTES = 8 * 1024 ** 2;
const STDIO_FIELDS = new Set(['command', 'args', 'env', 'enabled', 'required']);
const HTTP_FIELDS = new Set(['url', 'http_headers', 'enabled', 'required']);

async function config(path: string, signal: AbortSignal): Promise<JsonObject> {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(await sourceBytes(path, MAX_CONFIG_BYTES, signal));
  return object(TOML.parse(text));
}

export async function codexProjectTrusted(home: string, cwd: string, registeredProjects: string[], signal: AbortSignal): Promise<boolean> {
  if (!registeredProjects.includes(cwd)) return false;
  try {
    const user = await config(join(home, '.codex/config.toml'), signal);
    return object(object(user.projects)[cwd]).trust_level === 'trusted';
  } catch {
    if (signal.aborted) throw signal.reason;
    return false;
  }
}

function stringMap(value: unknown): JsonObject | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value);
  if (entries.some(([, field]) => typeof field !== 'string')) return undefined;
  return Object.fromEntries(entries);
}

function server(raw: unknown): JsonObject | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const entry = object(raw);
  if (entry.required === true || (entry.required !== undefined && entry.required !== false)) return undefined;
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') return undefined;
  const fields = new Set(Object.keys(entry));
  if (typeof entry.command === 'string' && entry.command.trim()) {
    if ([...fields].some(field => !STDIO_FIELDS.has(field))) return undefined;
    if (entry.args !== undefined && (!Array.isArray(entry.args) || entry.args.some(arg => typeof arg !== 'string'))) return undefined;
    const env = entry.env === undefined ? undefined : stringMap(entry.env);
    if (entry.env !== undefined && !env) return undefined;
    return { command: entry.command, ...(entry.args === undefined ? {} : { args: entry.args }),
      ...(env === undefined ? {} : { env }), ...(entry.enabled === false ? { enabled: false } : {}) };
  }
  if (typeof entry.url === 'string') {
    if ([...fields].some(field => !HTTP_FIELDS.has(field))) return undefined;
    const headers = entry.http_headers === undefined ? undefined : stringMap(entry.http_headers);
    if (entry.http_headers !== undefined && !headers) return undefined;
    return { type: 'http', url: entry.url, ...(headers === undefined ? {} : { headers }),
      ...(entry.enabled === false ? { enabled: false } : {}) };
  }
  return undefined;
}

export async function codexMcpSource(path: string, signal: AbortSignal): Promise<JsonObject> {
  const servers: JsonObject = {};
  for (const [name, raw] of Object.entries(object((await config(path, signal)).mcp_servers))) {
    const converted = server(raw);
    if (converted) Object.defineProperty(servers, name, { value: converted, enumerable: true, configurable: true, writable: true });
  }
  return { mcpServers: servers };
}
