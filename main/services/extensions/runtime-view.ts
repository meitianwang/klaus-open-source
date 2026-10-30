import type { Json } from '../../ipc/contract';
import { errorMessage, object, string, type EngineRequest, type JsonObject } from '../service-types';

export interface DesiredPlugin { id: string; name: string; enabled: boolean }
export type RuntimeQuery = { ok: true; value: unknown } | { ok: false; error: string };
export interface RuntimeResults { capabilities: RuntimeQuery; extensions: RuntimeQuery; plugins: RuntimeQuery; installed: RuntimeQuery }
export interface RuntimeViewDeps {
  request: EngineRequest;
  binding: (sessionId: string) => { engineId: string; stale: boolean } | undefined;
  /** Must verify an existing thread before resolving it; never create a replacement. */
  resolveSession: (sessionId: string) => Promise<string>;
  /** A failed runtime publication or legacy migration may still require endpoint replacement. */
  endpointRestartRequired?: () => boolean;
}
const array = (value: unknown): Json[] => Array.isArray(value) ? value as Json[] : [];
const records = (value: unknown): JsonObject[] => array(value).filter(value => value !== null && typeof value === 'object' && !Array.isArray(value)) as JsonObject[];
const strings = (value: unknown): string[] => array(value).filter((value): value is string => typeof value === 'string');
const normalize = (value: string) => value.trim().toLowerCase();
const emptyContributions = (): JsonObject => ({ agents: [], skills: [], outputStyles: [], hooks: [], mcpServers: [], lspServers: [] });
const querySources = ['capabilities', 'extensions', 'plugins', 'installed'] as const;
const queryFields = ['runtimeCapabilities', 'extensionRuntime', 'pluginRuntime', 'installedPlugins'] as const;

function names(plugin: DesiredPlugin): Set<string> { return new Set([plugin.id, plugin.id.split('@')[0] ?? '', plugin.name].map(normalize).filter(Boolean)); }
function matches(row: JsonObject, names: Set<string>): boolean { return ['name', 'pluginId', 'pluginNamespace', 'displayName'].some(key => typeof row[key] === 'string' && names.has(normalize(string(row[key])))); }
function sourced(value: unknown, names: Set<string>): JsonObject[] {
  return records(value).filter(row => { const source = object(row.source); return source.kind === 'plugin' && names.has(normalize(string(source.id))); });
}
function issues(value: unknown, names: Set<string>): string[] {
  return records(value).flatMap(row => {
    const searchable = ['name', 'pluginId', 'dir'].flatMap(key => typeof row[key] === 'string' ? [normalize(string(row[key]))] : []);
    return typeof row.message === 'string' && (!searchable.length || searchable.some(value => [...names].some(name => value.includes(name)))) ? [row.message] : [];
  });
}
function pluginView(plugin: DesiredPlugin, runtime: JsonObject, extensions: JsonObject, stale: boolean): JsonObject {
  const aliases = names(plugin), entry = records(runtime.entries).find(row => matches(row, aliases));
  const disabled = records(runtime.disabled).find(row => matches(row, aliases));
  const summary = records(runtime.capabilitySummaries).find(row => matches(row, aliases));
  const errors = issues(runtime.errors, aliases), warnings = issues(runtime.warnings, aliases);
  warnings.push(...sourced(extensions.suppressed, aliases).flatMap(row => typeof row.reason === 'string' ? [(typeof row.name === 'string' ? row.name : 'extension') + ': ' + row.reason] : []));
  const active = entry?.enabled === true;
  const status = errors.length ? 'load_error' : stale && (active !== plugin.enabled || plugin.enabled) ? 'pending_restart'
    : active ? plugin.enabled ? 'active' : 'pending_restart' : disabled || !plugin.enabled ? 'disabled' : 'unknown';
  const contribution = (field: string, key = 'name'): string[] => sourced(extensions[field], aliases).flatMap(row => typeof row[key] === 'string' ? [row[key] as string] : []);
  return { pluginId: plugin.id, desiredEnabled: plugin.enabled, effectiveStatus: status, restartRequired: status === 'pending_restart',
    contributions: { agents: contribution('agents'), skills: contribution('skills'), outputStyles: contribution('outputStyles'), hooks: contribution('hooks', 'event'),
      mcpServers: strings(object(entry?.permissionScope).mcpServers ?? summary?.mcpServerNames), lspServers: strings(object(entry?.permissionScope).lspServers ?? summary?.lspServerNames) }, warnings, errors };
}

/** Renderer-owned projection; raw query envelopes must be unwrapped before this boundary. */
export function buildRuntimeView(sessionId: string, desired: DesiredPlugin[], results?: RuntimeResults, available = false, stale = false): JsonObject {
  if (!available || !results) return { sessionId, status: 'no_session', plugins: desired.map(plugin => ({ pluginId: plugin.id, desiredEnabled: plugin.enabled,
    effectiveStatus: stale ? 'pending_restart' : 'unknown', restartRequired: stale, contributions: emptyContributions(), warnings: [], errors: [] })), diagnostics: [] };
  const diagnostics: Json[] = querySources.flatMap(key => { const result = results[key]; return result.ok ? [] : [{ source: key === 'installed' ? 'installed_plugins' : key, level: 'error', message: result.error }]; });
  const runtime = results.plugins.ok ? object(results.plugins.value) : {};
  for (const [key, level] of [['errors', 'error'], ['warnings', 'warning']] as const) for (const row of records(runtime[key])) {
    if (typeof row.message === 'string') diagnostics.push({ source: 'plugins', level, message: row.message });
  }
  const extensionRaw = results.extensions.ok ? object(results.extensions.value) : undefined;
  const extensions = extensionRaw ? Object.fromEntries(['agents', 'skills', 'outputStyles', 'hooks', 'suppressed'].map(key => [key, array(extensionRaw[key])])) : undefined;
  const capabilities = results.capabilities.ok ? object(results.capabilities.value) : undefined;
  return { sessionId, status: querySources.some(key => results[key].ok) ? 'ready' : 'unavailable',
    ...(capabilities ? { capabilities: { effectiveRoots: array(capabilities.effectiveRoots), missingRoots: array(capabilities.missingRoots) } } : {}),
    ...(extensions ? { extensions } : {}), plugins: desired.map(plugin => pluginView(plugin, runtime, extensions ?? {}, stale)), diagnostics };
}

export class RuntimeViewService {
  constructor(private readonly deps: RuntimeViewDeps) {}
  async view(sessionId: string, desired: DesiredPlugin[] = [], activate = false): Promise<JsonObject> {
    const bound = this.deps.binding(sessionId);
    const isStale = (): boolean => this.deps.endpointRestartRequired?.() === true || this.deps.binding(sessionId)?.stale === true;
    let engineId = bound?.engineId;
    if (!engineId && activate) {
      try { engineId = await this.deps.resolveSession(sessionId); if (!engineId) throw new Error('The existing thread has no engine binding'); }
      catch (error) {
        const failed: RuntimeQuery = { ok: false, error: errorMessage(error) };
        return buildRuntimeView(sessionId, desired, { capabilities: failed, extensions: failed, plugins: failed, installed: failed }, true, isStale());
      }
    }
    if (!engineId) return buildRuntimeView(sessionId, desired, undefined, false, isStale());
    const results = await Promise.all(queryFields.map(async (field): Promise<RuntimeQuery> => {
      try {
        const answer = await this.deps.request('session/' + field, { sessionId: engineId! }), reply = object(answer);
        if (reply.error != null) throw new Error(errorMessage(reply.error));
        return { ok: true, value: Object.hasOwn(reply, field) ? reply[field] : answer };
      } catch (error) { return { ok: false, error: errorMessage(error) }; }
    }));
    return buildRuntimeView(sessionId, desired, { capabilities: results[0]!, extensions: results[1]!, plugins: results[2]!, installed: results[3]! }, true, isStale());
  }
  activeView(payload: JsonObject): Promise<Json> { const id = string(payload.sessionId); return id ? this.view(id, [], true) : Promise.resolve(null); }
}
