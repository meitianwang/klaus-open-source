import { isFastModePreferenceKey } from '../../shared/model-fast-mode';
import type { ModelUpdateOrigin } from './model-updates';
import type { Json } from '../ipc/contract';
import type { HostState } from '../services/host-state';
import type { ComposerChange } from '../services/composer';
import { SIDEBAR_UI_STATE_KEYS } from '../../contracts/sidebar-collapse';
import { FEATURE_ONBOARDING_UI_STATE_KEYS } from '../../contracts/feature-onboarding';
import { RUNTIME_POLICY_SETTING_KEYS, resolveWebSearchAccess, sandboxWorkspaceWrite, type RuntimeConfigScope } from '../../contracts/runtime-settings';
import { runtimePolicyForSession } from '../services/runtime-policy';
import { EngineSettings } from '../services/engine-settings';
import { type RuntimePolicyProjection } from '../services/windows-runtime-policy';
import { loadSubagentModelOptions, resolveSubagentModelPolicy, type SubagentModelOption } from '../services/subagent-model-policy';

/** Settings rows that are pure UI chrome. Writing one must not mark a live
 *  session stale, because a stale binding forces `session/close` + rebuild on
 *  the next call (and a side task throws SIDE_TASK_CONFIGURATION_CHANGED).
 *  `language` / the two shortcut keys were already exempt for the same reason;
 *  the sidebar collapse rows join them so folding a group never rebuilds a
 *  session.
 *
 *  The feature-discovery rows are exempt for the same reason and with higher
 *  stakes: they are written by arriving at a screen, so a session rebuild would
 *  land on exactly the click where the user is looking at a new feature. */
const UI_ONLY_SETTINGS_KEYS: readonly string[] = [
  'language', 'global_shortcut', 'quick_input_shortcut',
  'composer_predictions_enabled', 'composer_predictions_has_accepted',
  ...SIDEBAR_UI_STATE_KEYS,
  ...FEATURE_ONBOARDING_UI_STATE_KEYS,
];

interface ConfigurationDeps {
  modelSourceStatus?: (source: string) => Promise<Json>;
  state: HostState;
  configRoot: string;
  request(method: string, params: Record<string, Json>): Promise<unknown>;
  log(kind: string, detail: string): void;
  publishInference?(sessionId?: string, origin?: ModelUpdateOrigin): Promise<void>;
  isUnattended?(sessionId: string): boolean;
  refreshModelTiers?(): Promise<void>;
  /** Approval cards the engine already answered itself when prompting was turned off. */
  settleBypassedApprovals?(sessionId: string): Promise<void>;
  updateRuntimeConfig?(sessionId: string, update: Record<string, Json>): Promise<void>;
  runtimePolicyProjection?: RuntimePolicyProjection;
}

/** Inference preferences fence the next capture; permission policy retains its lifecycle. */
export class SessionConfiguration {
  private subagentModelSync: Promise<void> = Promise.resolve();

  constructor(private readonly deps: ConfigurationDeps) {}

  markChanged(sessionId?: string): void {
    for (const binding of this.deps.state.bindings()) {
      if (sessionId === undefined || binding.rendererId === sessionId) this.deps.state.markStale(binding.rendererId);
    }
  }

  async markInferenceChanged(sessionId?: string, origin?: ModelUpdateOrigin): Promise<void> {
    this.deps.state.markModelChanged(sessionId);
    try { await this.deps.publishInference?.(sessionId, origin); }
    catch (error) {
      // Preferences are already persisted. Publication has its own failed push state;
      // rejecting the save here would make the picker roll back to an unsaved value.
      this.deps.log('model-fence-failed', error instanceof Error ? error.message : String(error));
    }
  }

  async settingsChanged(key: string, scope?: RuntimeConfigScope): Promise<void> {
    if (key === 'klaus.subagentModelCatalog') {
      await this.syncSubagentModels(scope);
      return;
    }
    if (key === 'modelProviders' || key === 'auth_mode' || key === 'model_tiers:global') await this.syncSubagentModels(scope, true);
    if (RUNTIME_POLICY_SETTING_KEYS.includes(key)) {
      await this.syncPolicy(undefined, scope);
      return;
    }
    if (key === 'klaus.webSearch.access') {
      await this.syncSearchAccess(scope);
      return;
    }
    if (key === 'model_tiers:global' && this.deps.refreshModelTiers) {
      try { await this.deps.refreshModelTiers(); }
      catch (error) { this.markInferenceChanged(); throw error; }
      return;
    }
    if (['advisor', 'feature_models', 'modelProviders', 'auth_mode', 'klaus.maxOutputTokens', 'klaus.maxOutputRetryTokens', 'klaus.modelVerbosity', 'klaus.reasoningSummary'].includes(key) || key.startsWith('model_tiers:')) {
      if (scope?.kind === 'project') {
        for (const binding of this.deps.state.bindings()) if (this.matchesScope(binding.rendererId, scope)) await this.markInferenceChanged(binding.rendererId);
      } else await this.markInferenceChanged();
    } else if (!['composer.main_model', 'composer.thinking_level', 'composer.ultra_mode'].includes(key) && !isFastModePreferenceKey(key) && !UI_ONLY_SETTINGS_KEYS.includes(key)) {
      this.markChanged();
    }
    // Model, thinking, and source Fast mode defaults are deliberately in
    // neither branch. They are per-conversation: the global row is only the
    // default future conversations inherit, so writing it must not reconfigure any
    // live conversation. Each conversation reads its own frozen row and is
    // invalidated only through `composerChanged`, which carries its session id.
  }

  async composerChanged(change: ComposerChange): Promise<void> {
    if (change.kind === 'permission') {
      // A permission pick names the conversation it changed, so only that
      // conversation is re-published. Broadcasting instead re-armed every live
      // session's sandbox for a choice none of them made. A default-only change
      // carries no session id and still reaches every session without its own row.
      await this.syncPolicy(change.sessionId);
    } else if (change.sessionId) {
      // Both the model and the reasoning level are per-conversation: a pick
      // reconfigures the conversation it names (and updates the default for future
      // ones) and leaves every other live conversation on its own stored value. A
      // change with no session id is default-only and invalidates nobody — which is
      // why this keys on sessionId rather than on kind.
      await this.markInferenceChanged(change.sessionId);
    }
  }

  async refreshSubagentModelCatalog(): Promise<void> {
    await this.syncSubagentModels(undefined, true);
  }

  private matchesScope(sessionId: string, scope?: RuntimeConfigScope): boolean {
    return scope?.kind !== 'project' || this.deps.state.resourceRoots(sessionId)[0] === scope.cwd;
  }

  private async resolvedSettings(sessionId: string): Promise<Record<string, Json>> {
    const cwd = this.deps.state.resourceRoots(sessionId)[0];
    return new EngineSettings((method, params) => this.deps.request(method, params as Record<string, Json>)).resolved(cwd);
  }

  private async syncSearchAccess(scope?: RuntimeConfigScope): Promise<void> {
    if (!this.deps.updateRuntimeConfig) { this.markChanged(); return; }
    for (const binding of this.deps.state.bindings()) {
      if (!this.matchesScope(binding.rendererId, scope) || this.deps.isUnattended?.(binding.rendererId)) continue;
      const values = await this.resolvedSettings(binding.rendererId);
      const policy = runtimePolicyForSession(binding.rendererId, values, this.deps.configRoot, undefined, false).policy;
      await this.deps.updateRuntimeConfig(binding.rendererId, { webSearchAccess: resolveWebSearchAccess(values, policy.sandboxMode) });
    }
  }

  private syncSubagentModels(scope?: RuntimeConfigScope, onlyEnabled = false): Promise<void> {
    // A later toggle or source refresh must not overtake an earlier catalog load
    // and then be overwritten by its stale policy.
    const next = this.subagentModelSync.then(() => this.publishSubagentModels(scope, onlyEnabled));
    this.subagentModelSync = next.catch(() => {});
    return next;
  }

  private async publishSubagentModels(scope?: RuntimeConfigScope, onlyEnabled = false): Promise<void> {
    const updateRuntimeConfig = this.deps.updateRuntimeConfig;
    if (!updateRuntimeConfig) { this.markChanged(); return; }
    let failure: unknown;
    let catalog: Promise<SubagentModelOption[]> | undefined;
    const load = () => catalog ??= loadSubagentModelOptions({
      configRoot: this.deps.configRoot,
      request: (method, params) => this.deps.request(method, params as Record<string, Json>) as Promise<Json>,
      sourceStatus: this.deps.modelSourceStatus,
    });
    await Promise.all(this.deps.state.bindings().map(async binding => {
      if (!this.matchesScope(binding.rendererId, scope) || this.deps.isUnattended?.(binding.rendererId)) return;
      try {
        const values = await this.resolvedSettings(binding.rendererId);
        if (onlyEnabled && values.subagentModelCatalog !== true) return;
        const policy = await resolveSubagentModelPolicy(values, load);
        await updateRuntimeConfig(binding.rendererId, { ...policy });
      } catch (error) {
        this.deps.state.markStale(binding.rendererId);
        this.deps.log('subagent-model-policy-failed', error instanceof Error ? error.message : String(error));
        failure ??= error;
      }
    }));
    if (failure) throw failure;
  }

  private workspaceSettings(sessionId: string, values: Record<string, Json>) {
    const table = sandboxWorkspaceWrite(values.sandbox_workspace_write);
    const roots = this.deps.state.hostWritableRoots(sessionId);
    return { ...table, writable_roots: [...new Set([...table.writable_roots, ...roots])] };
  }

  private async syncPolicy(sessionId?: string, scope?: RuntimeConfigScope): Promise<void> {
    let failure: unknown;
    let failed = false;
    for (const binding of this.deps.state.bindings()) {
      if (sessionId !== undefined && binding.rendererId !== sessionId) continue;
      if (!this.matchesScope(binding.rendererId, scope)) continue;
      // Publish the admitting conversation's frozen policy and resource scope together.
      try {
        // Search freshness may be implicit even when the conversation pins its
        // permission preset, so both publications need the current raw intent.
        const values = await this.resolvedSettings(binding.rendererId);
        const requested = runtimePolicyForSession(binding.rendererId, values, this.deps.configRoot, undefined, false);
        const effective = this.deps.runtimePolicyProjection?.applies(binding.rendererId)
          ? await this.deps.runtimePolicyProjection.project(binding.rendererId, requested.policy) : { policy: requested.policy };
        const { policy } = effective;
        const workspace = sessionId === undefined ? this.workspaceSettings(binding.rendererId, values) : undefined;
        await this.deps.request('session/setRuntimePolicy', {
          sessionId: binding.engineId,
          approvalPolicy: policy.approvalPolicy, sandboxMode: policy.sandboxMode, approvalsReviewer: policy.approvalsReviewer,
          networkAllowed: policy.sandboxNetworkAllowed,
          ...(workspace ? { sandboxWorkspaceWrite: workspace } : {}),
        });
        if (workspace) this.deps.state.applyWorkspaceSettings(binding.rendererId, binding.engineId, workspace);
        if (this.deps.updateRuntimeConfig) {
          await this.deps.updateRuntimeConfig(binding.rendererId, { webSearchAccess: resolveWebSearchAccess(values, policy.sandboxMode) });
        } else this.deps.state.markStale(binding.rendererId);
        // Prompting off makes the engine answer its own parked approvals without telling
        // the host, so the card would stay open waiting for a reply nobody reads. Only a
        // publication that actually reached bypass settles them: a failed one leaves the
        // engine still asking, and Plan keeps asking by definition.
        if (policy.approvalPolicy === 'never') await this.deps.settleBypassedApprovals?.(binding.rendererId);
        // The engine re-reads the live approval policy on every decision, so the
        // publication above retunes a conversation in place.
      } catch (error) {
        this.deps.state.markStale(binding.rendererId);
        this.deps.log('live-policy-failed', error instanceof Error ? error.message : String(error));
        if (!failed) failure = error;
        failed = true;
      }
    }
    if (failed) throw failure;
  }
}
