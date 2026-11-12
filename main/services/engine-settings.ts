import { isDeepStrictEqual } from 'node:util';
import type { Json } from '../ipc/contract';
import { DEFAULT_WEB_SEARCH_SOURCE, isWebSearchSource, isWebFetchSource, normalizeWebSearchMode, resolveWebSearchSettings } from '../../contracts/web-search-settings';
import { IpcHandlerError } from '../ipc/registry';
import { type EngineRequest, type JsonObject, object, string, SerialMutations } from './service-types';
import { isAbsolute, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { APPROVAL_POLICIES, SANDBOX_MODES, APPROVAL_REVIEWERS, MODEL_VERBOSITIES, REASONING_SUMMARIES, WEB_SEARCH_ACCESS_MODES,
  RUNTIME_SETTING_KEYS, decodeApprovalPolicy, presetRuntimePolicy, resolveRuntimePolicy, resolveWebSearchAccess, sandboxWorkspaceWrite, runtimePolicyConfig, type GranularApprovalPolicy, type PermissionPreset, type LegacyPermissionPreset, type RuntimeConfigScope, type RuntimeConfigSnapshot, type RuntimeConfigMigrationWarning, type RuntimeSettingValues } from '../../contracts/runtime-settings';
import { normalizeRetiredSearchSource, runtimeConfigValues } from './runtime-config-values';
import { WINDOWS_SANDBOX_LEVELS, WINDOWS_SANDBOX_SETTING_KEY } from '../../contracts/windows-sandbox';

type Kind = 'bool' | 'csv' | 'text' | 'approval' | 'int' | 'number';
type Pref = { path: string; kind: Kind; min?: number; max?: number };
const PREFS: Record<string, Pref> = {};
function rows(kind: Kind, mappings: Record<string, string>, min?: number, max?: number): void {
  for (const [key, path] of Object.entries(mappings)) PREFS[key] = { path, kind, min, max };
}
rows('bool', {
  'klaus.cache1hTtl': 'cache1hTtl', 'klaus.includeGitContext': 'includeGitContext',
  'klaus.editedFiles': 'editedFiles', 'klaus.forwardSubagentText': 'forwardSubagentText',
  'klaus.fork': 'fork', 'klaus.shellEnvCapture': 'shellEnvCapture',
  'klaus.checkpointing': 'checkpointing',
  'klaus.subagentModelCatalog': 'subagentModelCatalog',
  'klaus.worktree': 'worktree', 'klaus.swarm': 'swarm',
  'klaus.sandbox.networkAllowed': 'sandbox_workspace_write.network_access',
  'klaus.memory.enabled': 'memory.enabled', 'klaus.memory.user': 'memory.user',
  'klaus.memory.project': 'memory.project', 'klaus.memory.local': 'memory.local',
  'klaus.memory.allowExternalIncludes': 'memory.allowExternalIncludes', 'feature:lsp': 'lsp',
  'klaus.providerTrace': 'providerTrace',
  'feature:agentMemory': 'agentMemory', 'feature:memoryRecall': 'memoryRecall',
  'feature:agentMemorySnapshot': 'agentMemorySnapshot', 'feature:autoMemory': 'autoMemory',
  'dream.enabled': 'autoDream',
});
rows('int', {
  'klaus.maxToolConcurrency': 'maxToolConcurrency', 'klaus.taskBudgetTokens': 'taskBudgetTokens',
  'klaus.maxOutputTokens': 'maxOutputTokens', 'klaus.maxOutputRetryTokens': 'maxOutputRetryTokens',
  'klaus.toolTimeoutMs': 'toolTimeoutMs',
  'klaus.webSearch.maxUses': 'webSearch.maxUses',
}, 1);
rows('int', { 'klaus.maxRetries': 'maxRetries', 'klaus.maxSubAgentDepth': 'maxSubAgentDepth', 'dream.min_sessions': 'dream.minSessions' }, 0);
rows('number', { 'klaus.engine.maxBudgetUsd': 'maxBudgetUsd' }, 2.2250738585072014e-308);
rows('number', { 'dream.min_hours': 'dream.minHours' }, 0);
rows('csv', {
  'klaus.fallbackModels': 'fallbackModels', 'klaus.webSearch.allowedDomains': 'webSearch.allowedDomains',
  'klaus.webSearch.blockedDomains': 'webSearch.blockedDomains', 'klaus.webFetch.allowedDomains': 'webFetch.allowedDomains',
  'klaus.webFetch.blockedDomains': 'webFetch.blockedDomains',
});
rows('approval', { 'klaus.approvalPolicy': 'approval_policy' });
rows('text', {
  'klaus.sandboxMode': 'sandbox_mode', [WINDOWS_SANDBOX_SETTING_KEY]: 'windows.sandbox',
  'klaus.approvalsReviewer': 'approvals_reviewer', 'klaus.modelVerbosity': 'modelVerbosity',
  'klaus.reasoningSummary': 'reasoningSummary', 'klaus.webSearch.access': 'webSearch.access',
  'klaus.webSearch.enabled': 'desktop.webSearch.enabled', 'klaus.webSearch.source': 'desktop.webSearch.source',
  'klaus.webFetch.source': 'webFetch.source',
  'klaus.webFetch.jsRender': 'desktop.webFetch.jsRender', 'dream.skill_evolution_enabled': 'desktop.dream.skillEvolution',
});

const ENUM_VALUES: Record<string, readonly string[]> = {
  'klaus.approvalPolicy': APPROVAL_POLICIES, 'klaus.sandboxMode': SANDBOX_MODES,
  'klaus.approvalsReviewer': APPROVAL_REVIEWERS, 'klaus.modelVerbosity': MODEL_VERBOSITIES,
  'klaus.reasoningSummary': REASONING_SUMMARIES, 'klaus.webSearch.access': WEB_SEARCH_ACCESS_MODES,
  'klaus.subagentModelCatalog': ['on', 'off'],
};
const RUNTIME_DEFAULTS: JsonObject = {
  approval_policy: 'on-request', sandbox_mode: 'read-only',
  approvals_reviewer: 'user', reasoningSummary: 'auto', subagentModelCatalog: false,
};
export interface EngineSettingWriteOptions { scope?: RuntimeConfigScope; expectedVersion?: string }
export function runtimeConfigScope(value: unknown): RuntimeConfigScope {
  if (value === undefined || value === null) return { kind: 'user' };
  const scope = object(value);
  if (scope.kind === 'user') return { kind: 'user' };
  if (scope.kind !== 'project' || typeof scope.cwd !== 'string' || !isAbsolute(scope.cwd) || /[\x00-\x1f\x7f]/u.test(scope.cwd)) {
    throw new IpcHandlerError('BAD_REQUEST', 'Select an absolute project directory');
  }
  return { kind: 'project', cwd: resolve(scope.cwd) };
}
function configLocation(scope: RuntimeConfigScope): JsonObject {
  return scope.kind === 'project' ? { cwd: scope.cwd, filePath: join(scope.cwd, '.klaus', 'config.toml') } : {};
}

const RETIRED_CONFIG_ROWS = new Set(['klaus.sandbox', 'klaus.sandbox.requireReal', 'klaus.sandbox.retryOnDenial', 'klaus.confineReads', 'klaus.additionalReadableRoots', 'klaus.additionalWritableRoots']);
export function isRetiredEngineConfigRow(key: string): boolean { return RETIRED_CONFIG_ROWS.has(key); }
export function isEngineConfigRow(key: string): boolean { return Object.hasOwn(PREFS, key); }
function truthy(value: string): boolean | null {
  return ['on', '1', 'true'].includes(value.trim()) ? true : ['off', '0', 'false'].includes(value.trim()) ? false : null;
}
function at(value: JsonObject, path: string): Json | undefined {
  return path.split('.').reduce<Json | undefined>((cursor, part) => object(cursor)[part], value);
}
function encode(pref: Pref, raw: string): Json {
  const value = raw.trim();
  if (!value) return null;
  if (pref.kind === 'text' || pref.kind === 'approval') return raw;
  if (pref.kind === 'bool') return truthy(value);
  if (pref.kind === 'csv') {
    const parts = value.split(',').map(part => part.trim()).filter(Boolean);
    if (!parts.length) return null;
    return parts;
  }
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) {
    throw new IpcHandlerError('BAD_REQUEST', 'The engine setting must be a number');
  }
  const numeric = Number(value);
  const parsed = pref.kind === 'int' ? Math.floor(numeric) : numeric;
  if (!Number.isFinite(parsed) || parsed < (pref.min ?? -Infinity) || parsed > (pref.max ?? Infinity)) {
    throw new IpcHandlerError('BAD_REQUEST', 'The engine setting is outside its allowed range');
  }
  return parsed;
}
function decode(pref: Pref, value: Json | undefined): string | GranularApprovalPolicy | null {
  if (pref.kind === 'approval') return decodeApprovalPolicy(value) ?? null;
  if (pref.kind === 'text') return typeof value === 'boolean' ? (value ? 'on' : 'off') : typeof value === 'string' || typeof value === 'number' ? String(value) : null;
  if (pref.kind === 'bool') return typeof value === 'boolean' ? (value ? 'on' : 'off') : null;
  if (pref.kind === 'csv') return Array.isArray(value) ? value.filter(v => typeof v === 'string').join(',') : null;
  return typeof value === 'number' && (pref.kind !== 'int' || Number.isInteger(value)) ? String(value) : null;
}
export function modelProviderPath(id: string): string {
  return 'modelProviders.' + JSON.stringify(id);
}
function edit(keyPath: string, value: Json, mergeStrategy = 'replace'): JsonObject {
  return { keyPath, value, mergeStrategy };
}

/** The engine remains the sole writer of config.toml and model credentials. */
export class EngineSettings {
  private readonly mutations = new SerialMutations();
  constructor(readonly request: EngineRequest) {}

  async configSnapshot(scope: RuntimeConfigScope = { kind: 'user' }): Promise<JsonObject> {
    const reply = object(await this.request('config/read', configLocation(runtimeConfigScope(scope))));
    if (!reply.values || typeof reply.values !== 'object' || Array.isArray(reply.values)) {
      throw new IpcHandlerError('ENGINE_CONFIG_INVALID', 'The engine returned no config values');
    }
    return reply;
  }
  async read(scope?: RuntimeConfigScope): Promise<JsonObject> {
    return normalizeRetiredSearchSource(object((await this.configSnapshot(scope)).values));
  }
  async resolved(cwd?: string): Promise<JsonObject> {
    const snapshot = object(await this.request('config/read', cwd ? { cwd } : {}));
    if (!snapshot.resolved || typeof snapshot.resolved !== 'object' || Array.isArray(snapshot.resolved)) throw new IpcHandlerError('ENGINE_CONFIG_INVALID', 'The engine returned no effective config values');
    return runtimeConfigValues(snapshot);
  }
  async runtimeSnapshot(scope: RuntimeConfigScope = { kind: 'user' }): Promise<RuntimeConfigSnapshot> {
    const selected = runtimeConfigScope(scope), snapshot = await this.configSnapshot(selected);
    const values = object(snapshot.values), resolvedValues = runtimeConfigValues(snapshot, selected.kind);
    const effective: JsonObject = { ...RUNTIME_DEFAULTS, ...(Object.keys(resolvedValues).length ? resolvedValues : values) };
    const policy = resolveRuntimePolicy(Object.keys(resolvedValues).length ? resolvedValues : values);
    Object.assign(effective, { approval_policy: policy.approvalPolicy, approvals_reviewer: policy.approvalsReviewer, sandbox_mode: policy.sandboxMode, sandbox_workspace_write: { ...sandboxWorkspaceWrite(effective.sandbox_workspace_write), network_access: policy.sandboxNetworkAllowed } });
    for (const [key, value] of Object.entries(RUNTIME_DEFAULTS)) if (effective[key] === null || effective[key] === undefined) effective[key] = value;
    effective.webSearch = { ...object(effective.webSearch), access: resolveWebSearchAccess(resolvedValues, resolveRuntimePolicy(resolvedValues).sandboxMode) };
    const select = (source: JsonObject) => Object.fromEntries(RUNTIME_SETTING_KEYS.map(key => [key, decode(PREFS[key]!, at(source, PREFS[key]!.path))])) as RuntimeSettingValues;
    const sources = Object.fromEntries(Object.entries(object(snapshot.sources)).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    const migrationWarnings = Array.isArray(snapshot.migrationWarnings) ? snapshot.migrationWarnings.map(value => {
      const warning = object(value);
      if (typeof warning.code !== 'string' || typeof warning.message !== 'string' || !Array.isArray(warning.keys) || warning.keys.some(key => typeof key !== 'string')) throw new IpcHandlerError('ENGINE_CONFIG_INVALID', 'The engine returned an invalid configuration migration notice');
      return { code: warning.code, message: warning.message, keys: [...warning.keys] as string[] } satisfies RuntimeConfigMigrationWarning;
    }) : undefined;
    return { scope: selected, path: string(snapshot.path), version: string(snapshot.version), values: select(values), effective: select(effective), sources, ...(migrationWarnings?.length ? { migrationWarnings } : {}) };
  }
  async ensureConfigFile(scope: RuntimeConfigScope): Promise<string> {
    return this.mutations.run(async () => {
      const selected = runtimeConfigScope(scope), snapshot = await this.configSnapshot(selected), path = string(snapshot.path);
      if (!path) throw new IpcHandlerError('ENGINE_CONFIG_INVALID', 'The engine returned no configuration path');
      if (!existsSync(path)) await this.request('config/batchWrite', { edits: [], filePath: path, ...(typeof snapshot.version === 'string' ? { expectedVersion: snapshot.version } : {}) });
      return path;
    });
  }
  async row(key: string, scope?: RuntimeConfigScope): Promise<Json> {
    const pref = PREFS[key];
    if (!pref) return null;
    const values = await this.read(scope);
    const value = decode(pref, at(values, pref.path));
    if (key === 'klaus.webSearch.enabled' && WEB_SEARCH_ACCESS_MODES.includes(at(values, 'webSearch.access') as typeof WEB_SEARCH_ACCESS_MODES[number])) return at(values, 'webSearch.access') === 'disabled' ? 'off' : 'on';
    if (key === 'klaus.webFetch.source') return value ?? 'builtin';
    if (value === null && (key === 'klaus.webSearch.source' || key === 'klaus.webSearch.enabled')) {
      const mode = at(values, 'webSearch.mode');
      if (normalizeWebSearchMode(mode) !== undefined) {
        const desktopSource = at(values, 'desktop.webSearch.source');
        const current = resolveWebSearchSettings({ source: isWebSearchSource(desktopSource) ? desktopSource : at(values, 'webSearch.source'), enabled: at(values, 'desktop.webSearch.enabled'), mode });
        return key.endsWith('.source') ? current.source : current.enabled ? 'on' : 'off';
      }
    }
    return value;
  }
  async writeRow(key: string, raw: string | GranularApprovalPolicy | null, options: EngineSettingWriteOptions = {}): Promise<void> {
    await this.mutations.run(async () => {
      const selectedScope = runtimeConfigScope(options.scope), location = configLocation(selectedScope);
      if (key === 'klaus.webSearch.source' && typeof raw === 'string' && raw.trim() && !isWebSearchSource(raw.trim())) {
        throw new IpcHandlerError('BAD_REQUEST', 'Unknown web search source');
      }
      const write = (edits: JsonObject[], expectedVersion = options.expectedVersion) => this.request('config/batchWrite', {
        edits, ...(typeof location.filePath === 'string' ? { filePath: location.filePath } : {}), ...(expectedVersion ? { expectedVersion } : {}),
      });
      if (key === 'klaus.maxTurns') {
        await write([edit('maxTurns', null)]);
        return;
      }
      const pref = PREFS[key];
      if (!pref) throw new IpcHandlerError('BAD_REQUEST', 'Unknown engine config row');
      if (key === WINDOWS_SANDBOX_SETTING_KEY) {
        if (raw !== null && (typeof raw !== 'string' || !WINDOWS_SANDBOX_LEVELS.includes(raw as typeof WINDOWS_SANDBOX_LEVELS[number]))) {
          throw new IpcHandlerError('BAD_REQUEST', 'Unknown Windows sandbox level');
        }
        await write([edit(pref.path, raw)]);
        return;
      }
      if (typeof raw !== 'string') {
        const policy = key === 'klaus.approvalPolicy' ? decodeApprovalPolicy(raw) : undefined;
        if (!policy || typeof policy === 'string') throw new IpcHandlerError('BAD_REQUEST', 'Invalid granular approval policy');
        await write([edit(pref.path, policy)]);
        return;
      }
      if (ENUM_VALUES[key]) {
        raw = raw.trim();
        if (raw && !ENUM_VALUES[key].includes(raw)) throw new IpcHandlerError('BAD_REQUEST', 'Unknown runtime setting value');
      }
      if (key === 'klaus.webFetch.source') {
        raw = raw.trim();
        if (raw && !isWebFetchSource(raw)) throw new IpcHandlerError('BAD_REQUEST', 'Unknown web fetch source');
      }
      let edits = [edit(pref.path, encode(pref, raw), pref.kind === 'text' && raw.trim() ? 'upsert' : 'replace')];
      let expectedVersion = options.expectedVersion, searchSnapshot: JsonObject | undefined;
      if (key === 'klaus.sandbox.networkAllowed') {
        const snapshot = await this.configSnapshot(selectedScope);
        const values = runtimeConfigValues(snapshot, selectedScope.kind);
        const table = sandboxWorkspaceWrite(values.sandbox_workspace_write), network = encode(pref, raw);
        expectedVersion ??= typeof snapshot.version === 'string' ? snapshot.version : undefined;
        edits = network === null
          ? Object.hasOwn(object(object(snapshot.values).sandbox_workspace_write), 'network_access') ? [edit(pref.path, null)] : []
          : [edit('sandbox_workspace_write', { ...table, network_access: network === true }, 'upsert')];
      }
      if (key === 'klaus.webSearch.access') {
        const snapshot = searchSnapshot = await this.configSnapshot(selectedScope), values = object(snapshot.values);
        const intent = runtimeConfigValues({ ...snapshot, resolved: snapshot.resolved ?? snapshot.values! }, selectedScope.kind);
        expectedVersion ??= typeof snapshot.version === 'string' ? snapshot.version : undefined;
        const current = resolveWebSearchSettings({
          source: isWebSearchSource(at(values, 'desktop.webSearch.source')) ? at(values, 'desktop.webSearch.source') : at(intent, 'webSearch.source'),
          enabled: at(values, 'desktop.webSearch.enabled'), mode: at(intent, 'webSearch.mode'),
          access: at(intent, 'webSearch.access'),
        });
        const enabled = raw.trim() !== 'disabled';
        edits.push(edit('webSearch.mode', enabled ? current.source === 'native' ? 'native' : 'client' : 'off', 'upsert'),
          edit('webSearch.source', current.source, 'upsert'), edit('desktop.webSearch.enabled', enabled, 'upsert'));
        const currentAccess = resolveWebSearchAccess(intent);
        const remembered = enabled ? raw || resolveWebSearchAccess(intent) : currentAccess;
        if (remembered !== 'disabled') edits.push(edit('desktop.webSearch.lastEnabledAccess', remembered, 'upsert'));
      }
      if (key === 'klaus.webSearch.enabled' || key === 'klaus.webSearch.source') {
        const snapshot = searchSnapshot = await this.configSnapshot(selectedScope), values = object(snapshot.values);
        const intent = runtimeConfigValues({ ...snapshot, resolved: snapshot.resolved ?? snapshot.values! }, selectedScope.kind);
        expectedVersion ??= typeof snapshot.version === 'string' ? snapshot.version : undefined;
        const current = resolveWebSearchSettings({
          source: isWebSearchSource(at(values, 'desktop.webSearch.source')) ? at(values, 'desktop.webSearch.source') : at(intent, 'webSearch.source'), enabled: at(values, 'desktop.webSearch.enabled'),
          mode: at(intent, 'webSearch.mode'),
          access: at(intent, 'webSearch.access'),
        });
        const changingEnabled = key.endsWith('.enabled');
        const value = changingEnabled ? truthy(raw) : isWebSearchSource(raw.trim()) ? raw.trim() : null;
        const next = resolveWebSearchSettings({
          source: changingEnabled ? current.source : value ?? DEFAULT_WEB_SEARCH_SOURCE,
          enabled: changingEnabled ? value !== false : current.enabled,
        });
        edits = [
          edit(pref.path, value, value === null ? 'replace' : 'upsert'),
          edit('webSearch.mode', next.mode, 'upsert'),
          // The engine needs the chosen source itself, not just the wire mode:
          // a subscription source swaps the built-in search tool's backend to
          // that subscription's own search service.
          edit('webSearch.source', next.source, 'upsert'),
        ];
        // Persist the normalized source when legacy metadata cannot round-trip it.
        if (changingEnabled && ((current.source === 'native' && !isWebSearchSource(at(values, 'desktop.webSearch.source')))
          || at(values, 'desktop.webSearch.source') === 'brave' || at(values, 'webSearch.source') === 'brave'
          || at(values, 'desktop.webSearch.source') === 'custom' || at(values, 'webSearch.source') === 'custom')) {
          edits.push(edit('desktop.webSearch.source', current.source, 'upsert'));
        }
        if (changingEnabled && (WEB_SEARCH_ACCESS_MODES.includes(at(intent, 'webSearch.access') as typeof WEB_SEARCH_ACCESS_MODES[number])
          || ['cached', 'indexed', 'live'].includes(String(at(intent, 'webSearch.mode'))))) {
          const currentAccess = resolveWebSearchAccess(intent), configured = at(values, 'desktop.webSearch.lastEnabledAccess');
          const enabledValues = structuredClone(intent), search = { ...object(enabledValues.webSearch) };
          delete search.access;
          if (search.mode === 'off' || search.mode === 'disabled') delete search.mode;
          enabledValues.webSearch = search;
          enabledValues.desktop = { ...object(enabledValues.desktop), webSearch: { ...object(object(enabledValues.desktop).webSearch), enabled: true } };
          const remembered = typeof configured === 'string' && ['cached', 'indexed', 'live'].includes(configured) ? configured
            : currentAccess !== 'disabled' ? currentAccess : resolveWebSearchAccess(enabledValues);
          edits.push(edit('webSearch.access', next.enabled ? remembered : 'disabled', 'upsert'), edit('desktop.webSearch.lastEnabledAccess', remembered, 'upsert'));
        }
      }
      if (selectedScope.kind === 'project' && edits.some(row => String(row.keyPath).startsWith('webSearch.'))) {
        const snapshot = searchSnapshot ?? await this.configSnapshot(selectedScope), values = object(snapshot.values);
        expectedVersion ??= typeof snapshot.version === 'string' ? snapshot.version : undefined;
        if (!Object.hasOwn(values, 'webSearch') && object(snapshot.sources).webSearch !== 'defaults') {
          const inherited = object(runtimeConfigValues({ ...snapshot, resolved: snapshot.resolved ?? snapshot.values! }, selectedScope.kind).webSearch);
          // Config layers replace a whole search table, so the first local edit retains inherited restrictions.
          if (Object.keys(inherited).length) edits.unshift(edit('webSearch', inherited, 'upsert'));
        }
      }
      await write(edits, expectedVersion);
    });
  }
  async writePermissionPreset(mode: PermissionPreset): Promise<{ rollback(): Promise<void> }> {
    return this.mutations.run(async () => {
      const snapshot = await this.configSnapshot(), resolved = runtimeConfigValues(snapshot);
      const policy = presetRuntimePolicy(mode, resolveRuntimePolicy(resolved));
      const written = runtimePolicyConfig(policy, resolved.sandbox_workspace_write);
      const receipt = object(await this.request('config/batchWrite', {
        edits: Object.entries(written).map(([key, value]) => edit(key, value, 'upsert')),
        ...(typeof snapshot.version === 'string' ? { expectedVersion: snapshot.version } : {}),
      }));
      return { rollback: () => this.mutations.run(async () => {
        const current = await this.configSnapshot(), values = object(current.values);
        if (typeof receipt.version === 'string' && current.version !== receipt.version) return;
        if (!Object.entries(written).every(([key, value]) => isDeepStrictEqual(values[key], value))) return;
        const previous = object(snapshot.values);
        await this.request('config/batchWrite', {
          edits: Object.keys(written).map(key => edit(key, previous[key] ?? null, 'upsert')),
          ...(typeof current.version === 'string' ? { expectedVersion: current.version } : {}),
        });
      }) };
    });
  }
  async migratePermissionDefault(mode: LegacyPermissionPreset | undefined): Promise<boolean> {
    if (!mode) return false;
    return this.mutations.run(async () => {
      const snapshot = await this.configSnapshot(), values = object(snapshot.values);
      const expected = presetRuntimePolicy(mode);
      if (['approval_policy', 'sandbox_mode', 'approvals_reviewer'].some(key => values[key] !== undefined && values[key] !== null)) {
        const actual = resolveRuntimePolicy(values);
        return Object.keys(expected).every(key => actual[key as keyof typeof actual] === expected[key as keyof typeof expected]);
      }
      await this.request('config/batchWrite', {
        edits: Object.entries(runtimePolicyConfig(expected, runtimeConfigValues(snapshot).sandbox_workspace_write)).map(([key, value]) => edit(key, value, 'upsert')),
        ...(typeof snapshot.version === 'string' ? { expectedVersion: snapshot.version } : {}),
      });
      return true;
    });
  }
  async providers(): Promise<JsonObject> { return object((await this.read()).modelProviders); }
  async listModels(): Promise<Json[]> {
    const providers = await this.providers();
    return Object.entries(providers).filter(([id]) => id).map(([id, entry]) => modelRow(id, object(entry)))
      .sort((a, b) => string(a.name).localeCompare(string(b.name)));
  }
  async upsertModel(payload: JsonObject): Promise<null> {
    const id = string(payload.id);
    if (!id) throw new IpcHandlerError('BAD_REQUEST', 'model id required');
    return this.mutations.run(async () => {
      const entry = modelEntry(payload);
      const current = object((await this.providers())[id]);
      if (!Object.hasOwn(payload, 'realtime') && current.realtime !== undefined) entry.realtime = current.realtime;
      const previousCapabilities = object(current.capabilities), suppliedCapabilities = object(payload.capabilities), capabilities = object(entry.capabilities);
      for (const key of MODEL_METADATA_KEYS) if (!Object.hasOwn(suppliedCapabilities, key) && Object.hasOwn(previousCapabilities, key)) capabilities[key] = previousCapabilities[key]!;
      await this.request('config/batchWrite', { edits: [edit(modelProviderPath(id), entry)] });
      const apiKey = string(payload.apiKey).trim();
      if (apiKey) await this.request('model/credential/write', { id, apiKey });
      return null;
    });
  }
  async deleteModel(id: string): Promise<boolean> {
    return this.mutations.run(async () => {
      await this.request('config/batchWrite', { edits: [edit(modelProviderPath(id), null)] });
      try { await this.request('model/credential/delete', { id }); } catch { /* Missing orphan credentials do not restore a deleted model. */ }
      return true;
    });
  }
}

function integer(value: Json | undefined, fallback: number): number { return typeof value === 'number' && Number.isInteger(value) ? value : fallback; }
const MODEL_METADATA_KEYS = [
  'nativeDeferredTools',
  'autoReviewModelOverride', 'requiresSandboxedReview', 'nodeReplAutoReviewRequired', 'guardian', 'guardianV2', 'modelMessages', 'compHash',
  'supportsReasoningSummaryParameter', 'defaultReasoningSummary', 'supportedReasoningEfforts', 'defaultReasoningEffort', 'multiAgentReasoningEffort',
  'effectiveContextWindowPercent', 'autoCompactTokenLimit', 'usedFallbackModelMetadata', 'modelSpecialty', 'supportsImageDetailOriginal',
] as const;
export function modelEntry(payload: JsonObject): JsonObject {
  const now = Date.now();
  const entry: JsonObject = {
    name: string(payload.name), provider: string(payload.provider), model: string(payload.model),
    maxContextTokens: integer(payload.maxContextTokens, 200_000), thinking: string(payload.thinking, 'off'),
    default: payload.isDefault === true, createdAt: integer(payload.createdAt, now), updatedAt: integer(payload.updatedAt, now),
    capabilities: modelCapabilities(payload),
  };
  if (typeof payload.baseUrl === 'string') entry.baseUrl = payload.baseUrl;
  if (payload.realtime !== undefined && payload.realtime !== null) {
    const realtime = object(payload.realtime), keys = ['model', 'voice', 'transcriptionModel', 'protocol'];
    if (string(payload.provider) !== 'openai' || !string(realtime.model).trim() || !string(realtime.transcriptionModel).trim() || Object.keys(realtime).some(key => !keys.includes(key))
      || realtime.protocol !== undefined && !['public', 'v1', 'frameless'].includes(string(realtime.protocol))
      || keys.some(key => realtime[key] !== undefined && (typeof realtime[key] !== 'string' || !string(realtime[key]).trim() || string(realtime[key]).length > 160 || /[\x00-\x1f\x7f]/u.test(string(realtime[key]))))) throw new IpcHandlerError('BAD_REQUEST', 'Configure explicit realtime and transcription models on an OpenAI-compatible source');
    entry.realtime = Object.fromEntries(keys.filter(key => typeof realtime[key] === 'string').map(key => [key, string(realtime[key]).trim()]));
  }
  if (payload.openaiApi === 'responses' || payload.openaiApi === 'chat') entry.openaiApi = payload.openaiApi;
  // The stored key's carrier on the Anthropic wire. Absent keeps the native
  // header; only gateways that validate the bearer scheme name it.
  if (payload.authScheme === 'bearer') entry.authScheme = 'bearer';
  const cost: JsonObject = {};
  for (const [key, field] of [['input', 'costInput'], ['output', 'costOutput'], ['cacheRead', 'costCacheRead'], ['cacheWrite', 'costCacheWrite']] as const) {
    if (typeof payload[field] === 'number') cost[key] = payload[field];
  }
  if (Object.keys(cost).length) entry.cost = cost;
  return entry;
}
function modelCapabilities(payload: JsonObject): JsonObject {
  const provider = string(payload.provider), model = string(payload.model);
  const hay = (provider + ' ' + model + ' ' + string(payload.baseUrl)).toLowerCase();
  let levels = payload.reasoningEffort === 'max' ? ['low', 'medium', 'high', 'xhigh', 'max']
    : payload.reasoningEffort === 'xhigh' ? ['low', 'medium', 'high', 'xhigh']
      : payload.reasoningEffort === 'std' ? ['low', 'medium', 'high'] : [];
  if (levels.length && hay.includes('kimi-k3')) levels = ['low', 'high', 'max'];
  const caps: JsonObject = { structuredOutput: true, contextWindow: integer(payload.maxContextTokens, 200_000), vision: payload.supportsVision === true };
  if (levels.length) caps.effort = { levels };
  if (provider === 'openai') {
    const dialect = hay.includes('deepseek') ? 'deepseek'
      : ['qwen3.7-max', 'qwen3.7-plus'].includes(model.toLowerCase()) ? 'managedQwen'
        : payload.openaiApi !== 'responses' && /(?:^|\/)qwen3(?:[.-]|$)/i.test(model) ? 'qwen' : 'openai';
    caps.reasoningDialect = dialect;
    if (payload.openaiApi === 'responses') { caps.webSearch = true; caps.nativePdf = true; }
    if (payload.supportsThinking === true) caps.thinking = { adaptive: false, interleaved: false };
  } else if (provider === 'gemini') {
    caps.webSearch = true; caps.nativePdf = true;
    if (payload.supportsThinking === true) {
      caps.thinking = { adaptive: false, interleaved: false };
      caps.geminiThinking = { mode: 'budget', min: 0, max: 24_576, canDisable: true };
    }
  } else {
    caps.promptCacheControl = true; caps.nativePdf = true; caps.webSearch = true;
    if (payload.supportsThinking === true) {
      const native = !['kimi', 'kimi-api', 'bailian', 'deepseek'].includes(provider);
      caps.thinking = { adaptive: native, interleaved: native };
    }
  }
  const metadata = object(payload.capabilities);
  for (const key of MODEL_METADATA_KEYS) if (Object.hasOwn(metadata, key)) caps[key] = metadata[key]!;
  return caps;
}
export function modelRow(id: string, entry: JsonObject): JsonObject {
  const caps = object(entry.capabilities), levels = object(caps.effort).levels;
  const has = (level: string): boolean => Array.isArray(levels) && levels.includes(level);
  const row: JsonObject = {
    id, name: string(entry.name), provider: string(entry.provider), model: string(entry.model), capabilities: caps,
    maxContextTokens: integer(entry.maxContextTokens, 200_000), thinking: string(entry.thinking, 'off'),
    isDefault: entry.default === true, reasoningEffort: has('max') ? 'max' : has('xhigh') ? 'xhigh' : Array.isArray(levels) && levels.length ? 'std' : 'none',
    supportsThinking: Object.hasOwn(caps, 'thinking'), supportsVision: caps.vision === true,
    createdAt: integer(entry.createdAt, 0), updatedAt: integer(entry.updatedAt, 0),
  };
  if (typeof entry.baseUrl === 'string') row.baseUrl = entry.baseUrl;
  if (entry.realtime !== undefined) row.realtime = entry.realtime;
  if (entry.openaiApi === 'responses' || entry.openaiApi === 'chat') row.openaiApi = entry.openaiApi;
  if (entry.authScheme === 'bearer') row.authScheme = 'bearer';
  for (const [key, field] of [['input', 'costInput'], ['output', 'costOutput'], ['cacheRead', 'costCacheRead'], ['cacheWrite', 'costCacheWrite']] as const) {
    const value = object(entry.cost)[key];
    if (typeof value === 'number') row[field] = value;
  }
  return row;
}
