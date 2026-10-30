import { WINDOWS_SANDBOX_SETTING_KEY } from '../../../contracts/windows-sandbox';
import type { Json } from '../contract';
import { SUBSCRIPTION_WEB_SEARCH_SOURCES } from '../../../contracts/web-search-settings';
import { WORKSPACE_DEPENDENCIES_CHANNELS } from '../../../contracts/workspace-dependency-settings';
import { ChannelRegistry, IpcHandlerError } from '../registry';
import { configRootFrom } from '../../services/config-root';
import { EngineSettings, isEngineConfigRow, isRetiredEngineConfigRow, runtimeConfigScope } from '../../services/engine-settings';
import { decodeApprovalPolicy, type RuntimeConfigScope } from '../../../contracts/runtime-settings';
import { kvGet, kvSet, kvDel, isFailure } from '../../services/settings';
import type { WorkspaceDependencySettingsService } from '../../services/workspace-dependency-settings';
import { type EngineRequest, type JsonObject, object, string, requiredString } from '../../services/service-types';
import { MODEL_FEATURE_CHANNELS, registerModelFeatureHandlers } from './model-features';
import { GLOBAL_MODEL_TIERS_KEY, initializeModelTierMapping, modelReference, setModelTierMapping } from '../../services/model-tier-settings';
import { modelTierCatalog, validateTierTarget } from '../../services/model-tier-catalog';

export interface SettingsDeps {
  configRoot?: string;
  request: EngineRequest;
  engineSettings?: EngineSettings;
  onSettingsChanged: (key: string, scope?: RuntimeConfigScope) => void | Promise<void>;
  openConfig?: (path: string) => Promise<void>;
  sourceStatus?: (source: string) => Promise<Json>;
  catalogTimeoutMs?: number;
  log?: (kind: string, detail: string) => void;
  workspaceDependencies?: WorkspaceDependencySettingsService;
}
export const SETTINGS_CHANNELS = [
  'settings:kv:get', 'settings:kv:set', 'settings:models:list',
  'settings:runtime-config:get', 'settings:runtime-config:open',
  'settings:models:upsert', 'settings:models:delete',
  'settings:models:tiers:get', 'settings:models:tiers:set', 'settings:models:tiers:options',
  'settings:web-search-sources:get', 'settings:web-fetch-sources:get',
  ...WORKSPACE_DEPENDENCIES_CHANNELS,
  ...MODEL_FEATURE_CHANNELS,
] as const;

/** Account readiness is separate from the verified subscription catalog. */
async function sourceSignedIn(deps: SettingsDeps, source: string): Promise<boolean> {
  if (!deps.sourceStatus) return false;
  try {
    const state = object(await deps.sourceStatus(source));
    if (state.needsLogin === true || state.needsReimport === true) return false;
    return state.loggedIn === true || state.logged_in === true || state.authenticated === true;
  } catch { return false; }
}

export function registerSettingsHandlers(registry: ChannelRegistry, deps: SettingsDeps): EngineSettings {
  registerModelFeatureHandlers(registry, deps);
  const root = deps.configRoot ?? configRootFrom();
  const engine = deps.engineSettings ?? new EngineSettings(deps.request);
  const checked = (result: unknown): Json => {
    if (isFailure(result)) throw new IpcHandlerError(result.code, result.message);
    return result as Json;
  };
  registry.register('settings:kv:get', async ctx => {
    const payload = object(ctx.args[0]), key = payload.key;
    if (typeof key !== 'string' || key === 'klaus.maxTurns') return null;
    if (key === 'composer.permission_mode' || key === 'migrated.composer_permission_v2') throw new IpcHandlerError('BAD_REQUEST', 'Use the permission presets or runtime configuration');
    if (isRetiredEngineConfigRow(key)) throw new IpcHandlerError('BAD_REQUEST', 'This private sandbox setting has been retired; use the runtime configuration');
    if (key === 'klaus.workflow') return 'on';
    const scope = runtimeConfigScope(payload.scope);
    if (scope.kind === 'project' && !isEngineConfigRow(key)) throw new IpcHandlerError('BAD_REQUEST', 'This setting is not project scoped');
    return isEngineConfigRow(key) ? engine.row(key, scope) : checked(kvGet(key, root));
  }, 'settings');
  registry.register('settings:kv:set', async ctx => {
    const payload = object(ctx.args[0]);
    const key = requiredString(payload.key, 'key');
    if (key === 'composer.permission_mode' || key === 'migrated.composer_permission_v2') throw new IpcHandlerError('BAD_REQUEST', 'Use the permission presets or runtime configuration');
    if (isRetiredEngineConfigRow(key)) throw new IpcHandlerError('BAD_REQUEST', 'This private sandbox setting has been retired; use the runtime configuration');
    const granular = key === 'klaus.approvalPolicy' && typeof payload.value !== 'string' ? decodeApprovalPolicy(payload.value) : undefined;
    const clearWindowsSandbox = key === WINDOWS_SANDBOX_SETTING_KEY && payload.value === null;
    if (!clearWindowsSandbox && typeof payload.value !== 'string' && (typeof granular !== 'object' || granular === null)) throw new IpcHandlerError('BAD_REQUEST', 'The setting value must be a string or a granular approval policy');
    const value = string(payload.value);
    const scope = runtimeConfigScope(payload.scope);
    if (payload.expectedVersion !== undefined && (typeof payload.expectedVersion !== 'string' || !payload.expectedVersion)) throw new IpcHandlerError('BAD_REQUEST', 'expectedVersion must be a nonempty string');
    if (scope.kind === 'project' && !isEngineConfigRow(key)) throw new IpcHandlerError('BAD_REQUEST', 'This setting is not project scoped');
    if (key === 'klaus.workflow') {
      checked(kvDel(key, root));
      return { ok: true };
    }
    if (key.startsWith('model_tiers:')) throw new IpcHandlerError('MODEL_TIER_API_REQUIRED', 'Use the model tier settings to change the shared mapping');
    if (key === 'klaus.webFetch.source' && value.trim() && value.trim() !== 'builtin') throw new IpcHandlerError('BAD_REQUEST', 'Page fetching does not use a selectable source');
    if (key === 'klaus.maxTurns') {
      await engine.writeRow(key, value, { scope, expectedVersion: payload.expectedVersion as string | undefined });
      checked(kvDel(key, root));
    } else if (isEngineConfigRow(key)) await engine.writeRow(key, clearWindowsSandbox ? null : granular ?? value, { scope, expectedVersion: payload.expectedVersion as string | undefined });
    else checked(kvSet(key, value, root));
    if (key === 'language') {
      if (value) process.env.KLAUS_LANGUAGE = value;
      else delete process.env.KLAUS_LANGUAGE;
    }
    await deps.onSettingsChanged(key, scope);
    return { ok: true };
  }, 'settings');
  registry.register('settings:runtime-config:get', ctx => engine.runtimeSnapshot(runtimeConfigScope(object(ctx.args[0]).scope)) as unknown as Promise<Json>, 'settings');
  registry.register('settings:runtime-config:open', async ctx => {
    if (!deps.openConfig) throw new IpcHandlerError('UNAVAILABLE', 'Opening configuration files is unavailable');
    const path = await engine.ensureConfigFile(runtimeConfigScope(object(ctx.args[0]).scope));
    await deps.openConfig(path);
    return { ok: true, path };
  }, 'settings');
  const workspaceDependencies = (): WorkspaceDependencySettingsService => {
    if (!deps.workspaceDependencies) throw new IpcHandlerError('UNAVAILABLE', 'Workspace dependencies are unavailable in this build');
    return deps.workspaceDependencies;
  };
  registry.register('settings:workspace-dependencies:get', async () => ({ ok: true, ...workspaceDependencies().status() }) as unknown as Json, 'settings');
  registry.register('settings:workspace-dependencies:diagnose', async () => ({ ok: true, ...await workspaceDependencies().diagnose() }) as unknown as Json, 'settings');
  registry.register('settings:workspace-dependencies:reinstall', async () => ({ ok: true, ...await workspaceDependencies().reinstall() }) as unknown as Json, 'settings');
  // Read credentials only for the connection hint. Never rediscover product
  // capabilities or use account readiness to filter the subscription catalog.
  registry.register('settings:web-search-sources:get', async () => {
    const availability: JsonObject = Object.fromEntries(await Promise.all(SUBSCRIPTION_WEB_SEARCH_SOURCES.map(async source => [source, await sourceSignedIn(deps, source)])));
    return { ok: true, availability } as unknown as Json;
  }, 'settings');
  registry.register('settings:web-fetch-sources:get', async () => ({ ok: true, availability: { builtin: true } }), 'settings');
  const tierDeps = { ...deps, configRoot: root, engine, log: deps.log };
  registry.register('settings:models:tiers:get', async () => ({ ok: true, mapping: await initializeModelTierMapping(engine, root) }) as unknown as Json, 'settings');
  registry.register('settings:models:tiers:options', async () => modelTierCatalog(await initializeModelTierMapping(engine, root), tierDeps), 'settings');
  registry.register('settings:models:tiers:set', async ctx => {
    const payload = object(ctx.args[0]);
    if (!Object.hasOwn(payload, 'target')) throw new IpcHandlerError('BAD_REQUEST', 'Provide a model target or null to follow the main model');
    const target = modelReference(payload.target);
    // Step-level timing: the handler mixes local writes with engine RPCs and a
    // per-chat push, and the wire log's single elapsed number cannot say which
    // leg a slow save spent its time in.
    const startedAt = Date.now();
    await initializeModelTierMapping(engine, root);
    const initializedAt = Date.now();
    if (target) await validateTierTarget(target, tierDeps);
    const validatedAt = Date.now();
    const mapping = setModelTierMapping(payload.tier, target, payload.expectedRevision, root);
    const writtenAt = Date.now();
    // The stored row IS the save. Pushing the new routes into every open chat
    // is one engine round trip per chat and used to gate this reply, so a save
    // with several chats open cost several seconds of spinner. The push now
    // runs in the background: a chat that cannot apply the routes keeps its
    // own failed-push state, which admission surfaces before the next request
    // instead of silently using stale routes, and the refresh loop's own
    // timing log records what the background push spent.
    deps.log?.('model-tier-set-steps', JSON.stringify({
      tier: String(payload.tier), source: target?.source ?? null,
      initMs: initializedAt - startedAt, validateMs: validatedAt - initializedAt,
      writeMs: writtenAt - validatedAt, push: 'background',
      totalMs: writtenAt - startedAt,
    }));
    void Promise.resolve()
      .then(() => deps.onSettingsChanged(GLOBAL_MODEL_TIERS_KEY))
      .catch(error => {
        deps.log?.('model-tier-push-failed', JSON.stringify({
          ms: Date.now() - writtenAt,
          error: error instanceof Error ? error.message : String(error),
        }));
      });
    return { ok: true, mapping } as unknown as Json;
  }, 'settings');
  registry.register('settings:models:list', () => engine.listModels(), 'settings');
  registry.register('settings:models:upsert', async ctx => {
    const result = await engine.upsertModel(object(ctx.args[0]));
    await deps.onSettingsChanged('modelProviders');
    return result;
  }, 'settings');
  registry.register('settings:models:delete', async ctx => {
    const result = await engine.deleteModel(string(object(ctx.args[0]).id));
    await deps.onSettingsChanged('modelProviders');
    return result;
  }, 'settings');
  return engine;
}
