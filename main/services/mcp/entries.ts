import { join } from 'node:path';
import { object, string, type JsonObject } from '../service-types';

export const validServerName = (name: string): boolean => /^[a-zA-Z0-9_-]+$/.test(name);
export const enabled = (entry: unknown): boolean => object(entry).enabled !== false;
export const disabledTools = (entry: unknown): string[] => Array.isArray(object(entry).disabledTools)
  ? (object(entry).disabledTools as unknown[]).filter((value): value is string => typeof value === 'string' && value.length > 0) : [];
export function setEnabled(entry: JsonObject, value: boolean): void { if (value) delete entry.enabled; else entry.enabled = false; }
export function carryEnabled(previous: unknown, next: unknown): void { if (!enabled(previous)) setEnabled(object(next), false); }
export function setToolEnabled(entry: JsonObject, name: string, value: boolean): void {
  let denied = disabledTools(entry);
  if (value) denied = denied.filter(item => item !== name); else if (!denied.includes(name)) denied.push(name);
  if (denied.length) entry.disabledTools = denied; else delete entry.disabledTools;
}
function stringRecord(value: unknown): JsonObject | undefined {
  const pairs = Object.entries(object(value)).filter(([, value]) => typeof value === 'string');
  return pairs.length ? Object.fromEntries(pairs) : undefined;
}
export interface McpServerRuntimeOptions {
  resourcesRoot?: string;
  execPath?: string;
  isElectron?: boolean;
  configRoot?: string;
  marketBaseUrl?: string;
}
const bundledServer = /^@klaus\/mcp-servers\/([a-z0-9-]+\.cjs)$/;

/** Transport follows its declaration; a URL alone is an invalid stdio entry. */
export function serverConfig(name: string, raw: unknown, runtimeOptions?: McpServerRuntimeOptions): JsonObject | undefined {
  const entry = object(raw), transport = string(entry.type, 'stdio');
  let result: JsonObject;
  if (transport === 'stdio' && typeof entry.command === 'string') {
    const args = Array.isArray(entry.args) ? entry.args.filter((value): value is string => typeof value === 'string') : undefined;
    if (entry.command.startsWith('@klaus/') && entry.command !== '@klaus/runtime-node') return undefined;
    if (args?.some(arg => arg.startsWith('@klaus/') && !bundledServer.test(arg))) return undefined;
    result = { name, transport, command: entry.command };
    if (args) result.args = args;
    const env = stringRecord(entry.env); if (env) result.env = env;
    const root = runtimeOptions?.resourcesRoot;
    if (runtimeOptions && root !== undefined && entry.command === '@klaus/runtime-node') {
      result.command = runtimeOptions.execPath ?? process.execPath;
      if (args) result.args = args.map(arg => {
        const file = bundledServer.exec(arg)?.[1];
        return file ? join(root, 'mcp-servers', file) : arg;
      });
      result.env = {
        ...env,
        ...(runtimeOptions.isElectron ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        ...(runtimeOptions.configRoot !== undefined ? { KLAUS_CONFIG_ROOT: runtimeOptions.configRoot } : {}),
        ...(runtimeOptions.marketBaseUrl !== undefined ? { KLAUS_MARKET_BASE_URL: runtimeOptions.marketBaseUrl } : {}),
      };
    }
  } else if ((transport === 'http' || transport === 'sse') && typeof entry.url === 'string') {
    result = { name, transport, url: entry.url };
    const headers = stringRecord(entry.headers); if (headers) result.headers = headers;
    if (Object.hasOwn(entry, 'oauth')) result.oauth = entry.oauth!;
  } else return undefined;
  if (entry.alwaysLoad === true) result.alwaysLoad = true;
  const denied = disabledTools(entry); if (denied.length) result.disabledTools = denied;
  return result;
}
export interface McpDeclarations {
  servers: JsonObject[];
  skipped: Array<{ name: string; reason: string; scope: 'user' | 'project' | 'local' }>;
}
/** Preserve the configured order and scope precedence; the engine loads plugin MCP itself. */
export function resolveServerTables(user: JsonObject, project: JsonObject, local: JsonObject, runtimeOptions?: McpServerRuntimeOptions): McpDeclarations {
  const selected = new Map<string, { raw: unknown; scope: 'user' | 'project' | 'local' }>(), servers: JsonObject[] = [], skipped: McpDeclarations['skipped'] = [];
  for (const [scope, rows] of [['user', user], ['project', project], ['local', local]] as const) {
    for (const [name, raw] of Object.entries(rows)) selected.set(name, { raw, scope });
  }
  // Select before filtering: disabling or invalidating an override must never activate a lower scope.
  for (const [name, { raw, scope }] of selected) {
    if (!enabled(raw)) { skipped.push({ name, scope, reason: 'disabled' }); continue; }
    const parsed = serverConfig(name, raw, runtimeOptions);
    if (parsed) servers.push(parsed);
    else skipped.push({ name, scope, reason: 'unsupported-transport:' + (string(object(raw).type) || 'stdio') });
  }
  return { servers, skipped };
}
