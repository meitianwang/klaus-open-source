import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type { Json } from '../../ipc/contract';
import { atomicDocument } from '../extensions/file-store';
import { PendingAcquisitions } from '../extensions/acquisition';
import { object, type JsonObject } from '../service-types';
import type { McpConfigurationService } from './configuration';

function endpoint(value: unknown): string {
  if (typeof value !== 'string') return '-';
  try { const url = new URL(value); return ['http:', 'https:', 'socks:', 'socks5:'].includes(url.protocol) ? `${url.protocol}//${url.host}${url.pathname === '/' ? '/' : '/[path omitted]'}` : '[unsupported scheme]'; }
  catch { return '[invalid URL]'; }
}
/** Error text may echo credentials; diagnostic bundles retain a useful category, not raw bytes. */
function category(value: unknown): string {
  if (typeof value !== 'string' || !value) return '-';
  if (/auth|\b40[13]\b|denied|forbidden/i.test(value)) return 'authorization';
  if (/timeout|timed out|deadline/i.test(value)) return 'timeout';
  if (/ENOENT|not found|missing executable/i.test(value)) return 'missing resource or executable';
  if (/ECONN|ENET|EHOST|ENOTFOUND|DNS|TLS|certificate|socket/i.test(value)) return 'network or transport';
  if (/JSON|parse|protocol|schema|invalid response/i.test(value)) return 'protocol or response format';
  return 'other reported failure';
}
export class McpDiagnosticsService {
  private readonly pending = new PendingAcquisitions();
  constructor(private readonly deps: { configRoot: string; mcp: McpConfigurationService; environment?: NodeJS.ProcessEnv }) {}
  bundle(payload: JsonObject): Promise<Json> {
    return this.pending.run(async (signal): Promise<Json> => {
      try {
        const name = payload.name;
        if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(name)) throw new Error('Invalid MCP server name');
        const list = await this.deps.mcp.list(); signal.throwIfAborted();
        const row = (Array.isArray(list) ? list : []).map(object).find(row => row.name === name), config = object(row?.config);
        const transport = typeof config.type === 'string' ? config.type : 'stdio';
        const lines = [`time: ${new Date().toISOString()}`, `server: ${name}`, `platform: ${process.platform} ${process.arch}`,
          `config: ${row ? 'engine user scope' : 'not found in engine user scope'}`, `transport: ${row ? transport : '-'}`];
        if (row && ['http', 'sse'].includes(transport)) lines.push(`url: ${endpoint(config.url)}`, `oauth: ${Object.hasOwn(config, 'oauth') ? 'enabled' : 'none'}`);
        else if (row) lines.push(`command: ${typeof config.command === 'string' ? basename(config.command).replace(/[\r\n\0]/g, '') : '-'}`,
          `argumentCount: ${Array.isArray(config.args) ? config.args.length : 0}`, `envKeys: ${Object.keys(object(config.env)).filter(key => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key)).join(', ') || '-'}`);
        lines.push(`lastErrorCategory: ${category(payload.lastError)}`);
        const env = this.deps.environment ?? process.env;
        for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy']) if (env[key]) lines.push(`env.${key}: ${endpoint(env[key])}`);
        if (env.NO_PROXY || env.no_proxy) lines.push('env.NO_PROXY: configured');
        signal.throwIfAborted();
        const logPath = await atomicDocument(this.deps.configRoot, `logs/mcp-diagnose-${name}-${randomUUID()}.log`, lines.join('\n') + '\n', true);
        return { ok: true, logPath };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : 'MCP diagnostics failed' }; }
    });
  }
  close(): Promise<void> { return this.pending.close(); }
}
