import { antigravityModelOptions } from './antigravity-model-options';
import { antigravityThinkingLevel, antigravityVariantForThinking, pickAntigravityModelMetadata, type AntigravityModelMetadata } from '../../shared/antigravity-model-catalog';
import { isTraeNativeEffort, pickTraeModelMetadata, traeThinkingLevel, traeThinkingLevels, traeVariantForThinking, traeModelOptionForValue, type TraeModelMetadata } from '../../shared/trae-model-catalog';
import { isKiroNativeEffort, isKiroRoutingAlias, pickKiroModelMetadata, kiroThinkingLevel, kiroThinkingLevels, kiroVariantForThinking, kiroModelOptionForValue, type KiroModelMetadata } from '../../shared/kiro-model-catalog';
import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { configRootFrom } from './config-root';
import { EngineSettings } from './engine-settings';
import { cursorModelOptions } from './cursor-model-options';
import { nativeFastModeMetadata, resolvedFastModeMetadata } from './native-fast-mode';
import { fastModePreferenceKey, isRequestFastSource } from '../../shared/model-fast-mode';
import { cursorFastMode, cursorThinkingLevel, cursorVariantForFast, cursorVariantForThinking, cursorVariantForThinkingAndFast,
  modelOptionForValue, pickCursorModelMetadata, type CursorModelMetadata } from '../../shared/cursor-model-catalog';

import { isFailure, kvDel, kvSet, withSettingsDb } from './settings';
import { storedAuthMode, thinkingLevelFor } from './session-init';
import {
  MODEL_SOURCES, THINKING_LEVELS, modelSource, readSessionModel, setSessionModel,
  applySessionThinkingSelection, applySessionRuntimePolicy, applySessionUltraSelection, readSessionFastMode, readSessionUltraMode, setSessionFastMode, sourceTierSelections, validModelSelection, readLastSourceModel, type SessionModelPreference,
} from './session-store';
import { type EngineRequest, type JsonObject, type ServicePush, object, string, errorMessage, SerialMutations } from './service-types';
import { classifyRuntimePolicy, presetRuntimePolicy } from '../../contracts/runtime-settings';
import { runtimePolicyForSession } from './runtime-policy';
import { friendPolicySeed, friendSessionScope } from './friend-session-scope';
import type { RuntimePolicyProjection } from './windows-runtime-policy';

export interface ComposerChange { kind: 'model' | 'thinking' | 'fast' | 'permission'; sessionId?: string }
export interface ComposerDeps {
  configRoot?: string;
  request: EngineRequest;
  push: ServicePush;
  onSessionConfigChanged: (change: ComposerChange) => void | Promise<void>;
  beforeSessionModelChange?: (sessionId: string) => Promise<void>;
  engineSettings?: EngineSettings;
  sessionCwd?: (sessionId: string) => Promise<string | undefined>;
  runtimePolicyProjection?: RuntimePolicyProjection;
}
const LEVELS: readonly string[] = THINKING_LEVELS;
const PERMISSIONS = ['default', 'auto', 'bypassPermissions'];
function cursorDefaultSelection(selection: string): boolean {
  return /^cursor:(?:auto(?:-smart)?|default)(?:\[.*\])?(?:@max)?$/i.test(selection);
}
function level(value: Json | undefined): string | undefined {
  const raw = string(value).trim().toLowerCase();
  // `none` is the wire spelling of "thinking off". The picker does have that
  // rung — the host expresses it as `config.thinking = false` plus an omitted
  // effort, not as an EffortLevel, so the engine's named ladder never
  // has to carry it.
  if (raw === 'none') return 'off';
  // Catalog values describe native provider capabilities, not local modes.
  // Vendor Ultra aliases remain native Max; local Ultra uses a separate switch.
  if (raw === 'minimal') return 'low';
  if (raw === 'ultra') return 'max';
  return LEVELS.includes(raw) ? raw : undefined;
}
function mapped(values: Json | undefined): string[] {
  const found = Array.isArray(values) ? values.map(level) : [];
  return LEVELS.filter(l => found.includes(l));
}
function metadata(row: JsonObject, levels: string[] | undefined, defaultLevel?: string): JsonObject {
  const native = levels ?? [];
  // Native rungs only: an undeclared capability stays undeclared so the picker
  // hides the control instead of inventing provider effort levels. The local
  // orchestration mode rides its own switch, never this ladder.
  row.supportedThinkingLevels = [...new Set(native)];
  if (defaultLevel !== undefined && levels?.includes(defaultLevel)) row.defaultThinkingLevel = defaultLevel;
  return row;
}
function sessionIdOf(payload: JsonObject): string {
  if (payload.sessionId !== undefined && typeof payload.sessionId !== 'string') throw new IpcHandlerError('BAD_REQUEST', 'sessionId must be a string');
  return string(payload.sessionId);
}

export class ComposerService {
  readonly configRoot: string;
  private readonly engine: EngineSettings;
  private readonly mutations = new SerialMutations();
  constructor(private readonly deps: ComposerDeps) {
    this.configRoot = deps.configRoot ?? configRootFrom();
    this.engine = deps.engineSettings ?? new EngineSettings(deps.request);
  }
  async resolveSelection(sessionId: string): Promise<string> {
    return this.resolvePreference(readSessionModel(sessionId, this.configRoot));
  }
  async mediaInputMimeTypes(sessionId: string): Promise<string[]> {
    const saved = readSessionModel(sessionId, this.configRoot);
    if (saved.source !== 'antigravity') return [];
    const selection = await this.resolvePreference(saved);
    this.assertPreference(sessionId, saved);
    const rows = await this.options(saved.source);
    this.assertPreference(sessionId, saved);
    const row = modelOptionForValue(rows, selection);
    const types = row && object(row).mediaInputMimeTypes;
    return Array.isArray(types) ? [...new Set(types.filter((mime): mime is string => typeof mime === 'string'))] : [];
  }
  private async cursorModel(selection: string, read: 'warm' | 'cached' = 'warm'): Promise<CursorModelMetadata> {
    const rows = await this.options('cursor', true, read);
    const model = modelOptionForValue(rows, selection);
    if (!model) throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'The selected model is unavailable');
    return pickCursorModelMetadata(model);
  }
  // One raw catalog read keeps `catalogBaseline` visible before the rows are
  // projected. A baseline answer carries model identities, not this account's
  // catalog, so it cannot decide that a remembered member was retired.
  private async antigravityCatalog(): Promise<{ reply: JsonObject; rows: Json[] }> {
    const reply = object(await this.deps.request('antigravity/models', { read: 'warm' })) ?? {};
    return { reply, rows: await this.options('antigravity', true, 'warm', reply) };
  }
  // Reuse the source-switch catalog when reading the restored member's metadata.
  private async antigravityModel(selection: string, read: 'warm' | 'cached' = 'warm', rows?: Json[]): Promise<{ selection: string; metadata: AntigravityModelMetadata }> {
    const resolved = selection === 'auto' ? await this.resolvePreference({ source: 'antigravity', mode: selection }) : selection;
    const row = modelOptionForValue(rows ?? await this.options('antigravity', true, read), resolved);
    if (!row) throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'The selected model is unavailable');
    return { selection: resolved, metadata: pickAntigravityModelMetadata(row) };
  }
  private async antigravitySourceSelection(remembered: string | undefined, rows: Json[], baseline: boolean): Promise<string> {
    if (remembered && modelOptionForValue(rows, remembered)) return remembered;
    // A bundled baseline is not this account's catalog: its silence about a
    // remembered member says nothing about the account. Fail before any
    // preference is written instead of replacing a possibly valid selection.
    if (remembered && baseline) {
      throw new IpcHandlerError('MODEL_CATALOG_NOT_READY', 'The Antigravity model catalog is still refreshing; the previous selection was kept');
    }
    let preferred = '';
    try { preferred = await this.resolvePreference({ source: 'antigravity', mode: 'auto' }); }
    catch { /* A readable catalog can still supply a model when its routing default cannot be resolved. */ }
    // Source memory can outlive a provider catalog. Persist a concrete replacement
    // so the store cannot restore the removed member again when saving `auto`.
    const row = modelOptionForValue(rows, preferred) ?? rows[0];
    if (!row) throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'The selected model is unavailable');
    return string(object(row).value);
  }
  private assertPreference(sessionId: string, captured: SessionModelPreference): void {
    const latest = readSessionModel(sessionId, this.configRoot);
    if (latest.source !== captured.source || latest.mode !== captured.mode) {
      throw new IpcHandlerError('MODEL_SELECTION_CHANGED', 'The selected model changed while saving');
    }
  }
  private async resolvePreference(saved: SessionModelPreference): Promise<string> {
    const params: JsonObject = { source: saved.source, selection: saved.mode, modelTierSelections: sourceTierSelections(saved.source, this.configRoot) };
    const answer = object(await this.deps.request('model/selection/resolve', params));
    const selected = string(answer.selection);
    if (!validModelSelection(selected) || answer.source !== saved.source || modelSource(selected) !== saved.source
      || (saved.source === 'cursor' && cursorDefaultSelection(selected))) {
      throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'The engine did not resolve the saved model source');
    }
    return selected;
  }
  async getModel(sessionId: string, resolve = true, previewSource?: string): Promise<Json> {
    if (previewSource !== undefined && !MODEL_SOURCES.includes(previewSource)) throw new IpcHandlerError('BAD_REQUEST', 'previewSource is invalid');
    const saved = previewSource === undefined ? readSessionModel(sessionId, this.configRoot) : { source: previewSource, mode: 'auto' };
    // Source labels and quota routing need only persisted state, even offline.
    if (!resolve) return { ...saved, resolvedMode: null };
    try {
      const resolvedMode = await this.displaySelection(saved, await this.resolvePreference(saved));
      return { ...saved, resolvedMode };
    }
    catch (error) { return { ...saved, resolvedMode: null, resolutionError: errorMessage(error) }; }
  }
  // The engine resolves a bare default to a concrete catalog row for most
  // sources, and that row paints directly. A few sources still resolve a bare
  // default to a synthetic alias that names no picker row (a routing `auto`, a
  // `default-model` the service marks but does not list, or a cold-cache fallback
  // before any catalog is in hand); for those, show the catalog head the alias
  // stands for. An unreachable catalog keeps the alias and the picker reports it
  // unavailable. A source whose engine default is already a real catalog row must
  // NOT be here: the remap would then also hijack an explicit pick of that row's
  // old alias and display the head instead of what the user chose.
  private async displaySelection(saved: SessionModelPreference, resolved: string): Promise<string> {
    // Kimi, Bailian, Zhipu and QoderWork now resolve a bare default to a concrete
    // catalog row, so they are deliberately absent here. The remaining entries are
    // synthetic aliases: qoder/qwenwork's cold-cache `auto`, workbuddy's service
    // `default-model`, minimax's flagship (which is also the catalog head, so its
    // remap is a no-op), and ark's routing alias.
    const serviceDefaults: Record<string, string> = { qoder: 'auto', qwenwork: 'qwork-auto', workbuddy: 'default-model', minimax: 'MiniMax-M3.1-Flash-Preview', ark: 'ark-code-latest' };
    const alias = serviceDefaults[saved.source];
    if (alias === undefined || resolved !== `${saved.source}:${alias}`) return resolved;
    try {
      const rows = await this.options(saved.source);
      const head = Array.isArray(rows) ? rows.find(row => string(object(row).value)) : undefined;
      return head ? string(object(head).value) : resolved;
    } catch { return resolved; }
  }
  private async kiroModel(selection: string, read: 'warm' | 'cached' = 'warm'): Promise<{ selection: string; metadata: KiroModelMetadata }> {
    const resolved = ['auto', 'high', 'medium', 'low'].includes(selection) ? await this.resolvePreference({ source: 'kiro', mode: selection }) : selection;
    const row = modelOptionForValue(await this.options('kiro', true, read), resolved);
    if (!row) throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'The selected Kiro model is unavailable');
    return { selection: resolved, metadata: pickKiroModelMetadata(row) };
  }
  private async traeModel(selection: string, read: 'warm' | 'cached' = 'warm'): Promise<{ selection: string; metadata: TraeModelMetadata }> {
    const resolved = ['auto', 'high', 'medium', 'low'].includes(selection) ? await this.resolvePreference({ source: 'trae', mode: selection }) : selection;
    const row = modelOptionForValue(await this.options('trae', true, read), resolved);
    if (!row) throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'The selected TRAE CN model is unavailable');
    return { selection: resolved, metadata: pickTraeModelMetadata(row) };
  }
  async setModel(payload: JsonObject, assertCurrent?: () => void): Promise<Json> {
    const mode = string(payload.mode);
    if (!validModelSelection(mode)) return { error: 'invalid mode' };
    if (payload.source !== undefined && typeof payload.source !== 'string') throw new IpcHandlerError('BAD_REQUEST', 'source must be a string');
    const requestedSource = payload.source ?? modelSource(mode) ?? readSessionModel(sessionIdOf(payload), this.configRoot).source;
    if (payload.thinkingLevel !== undefined && !LEVELS.includes(string(payload.thinkingLevel)) && string(payload.thinkingLevel) !== 'ultra'
      && !(requestedSource === 'trae' && isTraeNativeEffort(payload.thinkingLevel))
      && !(requestedSource === 'kiro' && isKiroNativeEffort(payload.thinkingLevel))) throw new IpcHandlerError('BAD_REQUEST', 'invalid thinking level');
    if (payload.ultraMode !== undefined && typeof payload.ultraMode !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'ultraMode must be a boolean');
    if (payload.fastMode !== undefined && typeof payload.fastMode !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'fastMode must be a boolean');
    if (payload.updateDefaults !== undefined && typeof payload.updateDefaults !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'updateDefaults must be a boolean');
    return this.mutations.run(async () => {
      assertCurrent?.();
      const sessionId = sessionIdOf(payload);
      let selection = mode;
      let thinkingSelection = payload.thinkingLevel as string | undefined;
      // A source switch restores the last concrete model the user picked while
      // that source was active, so switching back does not land on the source's
      // built-in default every time. The lower-level store independently restores
      // the saved reasoning configuration.
      const currentSaved = readSessionModel(sessionId, this.configRoot);
      const source = payload.source ?? modelSource(mode) ?? currentSaved.source;
      let antigravityRows: Json[] | undefined;
      if (mode === 'auto' && typeof payload.source === 'string' && payload.source !== currentSaved.source) {
        const remembered = withSettingsDb(this.configRoot, db => readLastSourceModel(db, payload.source as string));
        if (source === 'antigravity') {
          const catalog = await this.antigravityCatalog();
          antigravityRows = catalog.rows;
          assertCurrent?.();
          selection = await this.antigravitySourceSelection(remembered, catalog.rows, catalog.reply.catalogBaseline === true);
          assertCurrent?.();
        } else if (remembered && remembered !== 'auto') selection = remembered;
      }
      // Legacy callers may still express the orchestration mode as a ladder
      // rung on the model channel; route it to its own switch.
      let ultraAlias = false;
      if (thinkingSelection === 'ultra') { ultraAlias = true; thinkingSelection = undefined; }
      if (source === 'cursor' && (selection === 'auto' || cursorDefaultSelection(selection))) {
        selection = await this.resolvePreference({ source: 'cursor', mode: 'auto' });
        assertCurrent?.();
      }
      if (source === 'cursor' && thinkingSelection !== undefined && payload.fastMode === undefined) {
        const target = cursorVariantForThinking(await this.cursorModel(selection), selection, thinkingSelection);
        assertCurrent?.();
        if (!target) throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'The selected reasoning level is unavailable');
        selection = target.value;
      }
      if (source === 'antigravity') {
        const model = await this.antigravityModel(selection, 'warm', antigravityRows);
        assertCurrent?.();
        if (model.metadata.antigravityFamilyId) {
          thinkingSelection ??= antigravityThinkingLevel(model.metadata, model.selection);
          if (thinkingSelection !== undefined) {
            const target = antigravityVariantForThinking(model.metadata, model.selection, thinkingSelection);
            if (!target) throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'The selected reasoning level is unavailable');
            if (selection !== 'auto' || target.value !== model.selection) selection = target.value;
          }
        }
      }
      if (source === 'kiro' && thinkingSelection !== undefined) {
        const current = await this.kiroModel(selection);
        assertCurrent?.();
        if (kiroThinkingLevels(current.metadata).length) {
          const target = kiroVariantForThinking(current.metadata, current.selection, thinkingSelection);
          if (!target) throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'The selected reasoning level is unavailable');
          if (selection !== 'auto' || target.value !== current.selection) selection = target.value;
        }
        thinkingSelection = undefined;
      }
      if (source === 'trae' && thinkingSelection !== undefined) {
        const current = await this.traeModel(selection);
        assertCurrent?.();
        if (traeThinkingLevels(current.metadata).length) {
          const target = traeVariantForThinking(current.metadata, current.selection, thinkingSelection);
          if (!target) throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'The selected reasoning level is unavailable');
          if (selection !== 'auto' || target.value !== current.selection) selection = target.value;
        }
        // Native effort is encoded in the exact member, not the shared canonical preference.
        thinkingSelection = undefined;
      }
      if (payload.fastMode !== undefined) {
        if (source === 'cursor') {
          const model = await this.cursorModel(selection);
          const target = thinkingSelection === undefined ? cursorVariantForFast(model, selection, payload.fastMode as boolean)
            : cursorVariantForThinkingAndFast(model, selection, thinkingSelection!, payload.fastMode as boolean);
          assertCurrent?.();
          if (!target) throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'Fast mode is unavailable for this model selection');
          selection = target.value;
        } else {
          if (!isRequestFastSource(string(source))) throw new IpcHandlerError('INVALID_MODEL_SOURCE', 'Fast mode is unavailable for this model source');
          const resolved = source === 'codex' ? selection : await this.resolvePreference({ source: string(source), mode: selection });
          const capability = await resolvedFastModeMetadata(this.deps.request, string(source), resolved);
          assertCurrent?.();
          if (capability.supportsFastMode !== true) throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'Fast mode is unavailable for this model selection');
        }
      }
      // A full remote configuration gets one transaction and one capture fence.
      // Owned first-send initialization changes only the newly created session.
      const explicitSource = modelSource(selection);
      if (!MODEL_SOURCES.includes(string(source)) || (explicitSource && payload.source !== undefined && explicitSource !== source)) {
        throw new IpcHandlerError('INVALID_MODEL_SOURCE', 'The model source does not match the selection');
      }
      if (sessionId) await this.deps.beforeSessionModelChange?.(sessionId);
      assertCurrent?.();
      setSessionModel(sessionId, selection, payload.source as string | undefined, this.configRoot, {
        thinkingLevel: thinkingSelection,
        ultraMode: payload.ultraMode as boolean | undefined ?? (ultraAlias ? true : undefined),
        fastMode: source === 'cursor' ? undefined : payload.fastMode as boolean | undefined,
        updateDefaults: payload.updateDefaults as boolean | undefined,
      });
      await this.deps.onSessionConfigChanged({ kind: 'model', sessionId });
      if (ultraAlias || payload.ultraMode !== undefined) this.deps.push('app:preferences-changed', { key: 'composer.ultra_mode' });
      this.deps.push('app:preferences-changed', { key: 'composer.main_model' });
      if (payload.fastMode !== undefined && source !== 'cursor') this.deps.push('app:preferences-changed', { key: fastModePreferenceKey(string(source))! });
      return { ok: true };
    });
  }
  /**
   * The reasoning level of ONE conversation.
   *
   * Session-scoped like {@link getModel}: the renderer always has a current
   * conversation, and asking for the global default instead would make the
   * composer show a level the conversation is not actually running with.
   */
  async getThinking(sessionId: string): Promise<Json> {
    const level = thinkingLevelFor(sessionId, this.configRoot), saved = readSessionModel(sessionId, this.configRoot);
    if (saved.source === 'kiro') {
      try {
        const model = await this.kiroModel(saved.mode, 'cached');
        return { level: kiroThinkingLevel(model.metadata, model.selection) ?? level };
      } catch { return { level }; }
    }
    if (saved.source === 'trae') {
      try {
        const model = await this.traeModel(saved.mode, 'cached');
        return { level: traeThinkingLevel(model.metadata, model.selection) ?? level };
      } catch { return { level }; }
    }
    if (saved.source === 'antigravity') {
      try {
        const model = await this.antigravityModel(saved.mode, 'cached');
        return { level: antigravityThinkingLevel(model.metadata, model.selection) ?? level };
      } catch { return { level }; }
    }
    if (saved.source !== 'cursor') return { level };
    try { return { level: cursorThinkingLevel(await this.cursorModel(saved.mode, 'cached'), saved.mode) ?? level }; }
    catch { return { level }; }
  }
  async getUltraMode(sessionId: string): Promise<Json> {
    return { enabled: readSessionUltraMode(sessionId, this.configRoot) };
  }
  /**
   * Toggle the local orchestration mode of ONE conversation. The reasoning
   * ladder and the native model selection stay untouched: Ultra authorizes
   * proactive delegation, it is not a provider effort rung.
   */
  async setUltraMode(payload: JsonObject, assertCurrent?: () => void): Promise<Json> {
    if (typeof payload.enabled !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'enabled must be a boolean');
    const enabled = payload.enabled;
    const permission = payload.permissionMode;
    if (permission !== undefined && (!enabled || typeof permission !== 'string' || !PERMISSIONS.includes(permission))) {
      throw new IpcHandlerError('BAD_REQUEST', 'A permission choice requires enabling Ultra');
    }
    return this.mutations.run(async () => {
      assertCurrent?.();
      const sessionId = sessionIdOf(payload);
      const previous = readSessionUltraMode(sessionId, this.configRoot);
      const values = permission === undefined ? undefined : await this.engine.resolved(sessionId ? await this.deps.sessionCwd?.(sessionId) : undefined);
      const permissionPolicy = typeof permission === 'string'
        ? presetRuntimePolicy(permission as import('../../contracts/runtime-settings').PermissionPreset, runtimePolicyForSession(sessionId, values!, this.configRoot).policy) : undefined;
      const defaultSelection = typeof permission === 'string' ? await this.engine.writePermissionPreset(permission as import('../../contracts/runtime-settings').PermissionPreset) : undefined;
      let selection: ReturnType<typeof applySessionUltraSelection> | undefined;
      try {
        assertCurrent?.();
        selection = applySessionUltraSelection(sessionId, enabled, this.configRoot, permissionPolicy, { updateDefaults: !sessionId });
        if (permissionPolicy) await this.deps.onSessionConfigChanged({ kind: 'permission', ...(sessionId ? { sessionId } : {}) });
        if (previous !== enabled || permission !== undefined) await this.deps.onSessionConfigChanged({ kind: 'thinking', sessionId });
      } catch (error) {
        selection?.rollback();
        await defaultSelection?.rollback();
        if (permissionPolicy) {
          try { await this.deps.onSessionConfigChanged({ kind: 'permission', ...(sessionId ? { sessionId } : {}) }); }
          catch { /* The policy publisher fences failed bindings. */ }
        }
        throw error;
      }
      this.deps.push('app:preferences-changed', { key: 'composer.ultra_mode' });
      if (permission !== undefined) this.deps.push('app:preferences-changed', { key: 'composer.permission_mode' });
      return { ok: true };
    });
  }
  /**
   * Change the reasoning level of ONE conversation and the default for future
   * conversations, never of any other conversation.
   *
   * A native selection leaves Ultra in the same transaction. Existing chats
   * update only their own selection; draft selections supply the defaults for
   * future chats. The publication names the selected chat so unrelated live
   * conversations retain their own inference settings.
   */
  async setThinking(payload: JsonObject, assertCurrent?: () => void): Promise<Json> {
    const selected = string(payload.level);
    // Legacy clients (older mobile builds) still express the orchestration mode
    // as a ladder rung; honor it as the independent switch and keep the native
    // level untouched.
    if (selected === 'ultra') return this.setUltraMode({ ...payload, enabled: true }, assertCurrent);
    if (!LEVELS.includes(selected) && !isTraeNativeEffort(selected) && !isKiroNativeEffort(selected)) return { error: 'invalid level' };
    if (payload.ultraMode !== undefined && payload.ultraMode !== false) {
      throw new IpcHandlerError('BAD_REQUEST', 'A native reasoning selection can only leave Ultra');
    }
    return this.mutations.run(async () => {
      assertCurrent?.();
      const sessionId = sessionIdOf(payload);
      const previous = thinkingLevelFor(sessionId, this.configRoot);
      const previousUltra = readSessionUltraMode(sessionId, this.configRoot);
      const permission = payload.permissionMode;
      if (permission !== undefined) {
        throw new IpcHandlerError('BAD_REQUEST', 'A permission choice rides the Ultra selection, not a reasoning level');
      }
      const saved = readSessionModel(sessionId, this.configRoot);
      if (!['trae', 'kiro'].includes(saved.source) && !LEVELS.includes(selected)) return { error: 'invalid level' } as Json;
      let model: SessionModelPreference | undefined;
      if (saved.source === 'kiro') {
        const current = await this.kiroModel(saved.mode);
        assertCurrent?.();
        this.assertPreference(sessionId, saved);
        const target = kiroVariantForThinking(current.metadata, current.selection, selected);
        if (!target) throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'The selected reasoning level is unavailable');
        if (target.value !== saved.mode && !(saved.mode === 'auto' && target.value === current.selection)) model = { source: 'kiro', mode: target.value };
      }
      if (saved.source === 'trae') {
        const current = await this.traeModel(saved.mode);
        assertCurrent?.();
        this.assertPreference(sessionId, saved);
        const target = traeVariantForThinking(current.metadata, current.selection, selected);
        if (!target) throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'The selected reasoning level is unavailable');
        if (target.value !== saved.mode && !(saved.mode === 'auto' && target.value === current.selection)) model = { source: 'trae', mode: target.value };
      }
      if (saved.source === 'cursor') {
        const target = cursorVariantForThinking(await this.cursorModel(saved.mode), saved.mode, selected);
        assertCurrent?.();
        this.assertPreference(sessionId, saved);
        if (!target) throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'The selected reasoning level is unavailable');
        if (target.value !== saved.mode) model = { source: 'cursor', mode: target.value };
      }
      if (saved.source === 'antigravity') {
        const current = await this.antigravityModel(saved.mode);
        assertCurrent?.();
        this.assertPreference(sessionId, saved);
        if (current.metadata.antigravityFamilyId) {
          const target = antigravityVariantForThinking(current.metadata, current.selection, selected);
          if (!target) throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'The selected reasoning level is unavailable');
          if (target.value !== saved.mode && !(saved.mode === 'auto' && target.value === current.selection)) model = { source: 'antigravity', mode: target.value };
        }
      }
      const nativeMember = saved.source === 'trae' || saved.source === 'kiro';
      const selection = applySessionThinkingSelection(sessionId, nativeMember ? previous : selected, this.configRoot, undefined,
        // A reasoning pick in any chat becomes the reasoning default for future
        // chats. The exact native variant and leaving Ultra change only the
        // draft's defaults.
        { model, ultraMode: false, updateThinking: !nativeMember, updateUltraDefault: !sessionId, updateModelDefault: !sessionId });
      try {
        if (model || previous !== selected || previousUltra) await this.deps.onSessionConfigChanged({ kind: model ? 'model' : 'thinking', sessionId });
      } catch (error) {
        selection.rollback();
        if (model) {
          try { await this.deps.onSessionConfigChanged({ kind: 'model', sessionId }); }
          catch { /* The configuration publisher fences failed bindings. */ }
        }
        throw error;
      }
      this.deps.push('app:preferences-changed', { key: 'composer.thinking_level' });
      this.deps.push('app:preferences-changed', { key: 'composer.ultra_mode' });
      if (model) this.deps.push('app:preferences-changed', { key: 'composer.main_model' });
      return { ok: true };
    });
  }
  async getFastMode(sessionId: string): Promise<Json> {
    const saved = readSessionModel(sessionId, this.configRoot);
    if (saved.source === 'cursor') {
      try { return cursorFastMode(await this.cursorModel(saved.mode, 'cached'), saved.mode); }
      catch { return { enabled: false, supported: false }; }
    }
    if (!isRequestFastSource(saved.source)) return { enabled: false, supported: false };
    try {
      const selection = saved.source === 'codex' ? saved.mode : await this.resolvePreference(saved);
      const capability = await resolvedFastModeMetadata(this.deps.request, saved.source, selection);
      const supported = capability.supportsFastMode === true;
      return { enabled: supported && readSessionFastMode(sessionId, this.configRoot, saved.source), supported,
        ...(supported && capability.fastBilling ? { billing: capability.fastBilling } : {}) };
    } catch { return { enabled: false, supported: false }; }
  }
  async setFastMode(payload: JsonObject, assertCurrent?: () => void): Promise<Json> {
    if (typeof payload.enabled !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'enabled must be a boolean');
    const enabled = payload.enabled;
    if (payload.updateDefaults !== undefined && typeof payload.updateDefaults !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'updateDefaults must be a boolean');
    if (payload.updateDefaults === false && !sessionIdOf(payload)) throw new IpcHandlerError('BAD_REQUEST', 'Session-only Fast mode requires a session id');
    return this.mutations.run(async () => {
      assertCurrent?.();
      const sessionId = sessionIdOf(payload);
      const saved = readSessionModel(sessionId, this.configRoot);
      if (saved.source === 'cursor') {
        const target = cursorVariantForFast(await this.cursorModel(saved.mode), saved.mode, enabled);
        assertCurrent?.();
        this.assertPreference(sessionId, saved);
        if (!target) throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'Fast mode is unavailable for this model selection');
        if (target.value === saved.mode) return { ok: true };
        const selection = applySessionThinkingSelection(sessionId, thinkingLevelFor(sessionId, this.configRoot), this.configRoot, undefined,
          { model: { source: 'cursor', mode: target.value }, updateThinking: false, updateDefaults: payload.updateDefaults !== false });
        try { await this.deps.onSessionConfigChanged({ kind: 'model', sessionId }); }
        catch (error) {
          selection.rollback();
          try { await this.deps.onSessionConfigChanged({ kind: 'model', sessionId }); }
          catch { /* The configuration publisher fences failed bindings. */ }
          throw error;
        }
        this.deps.push('app:preferences-changed', { key: 'composer.main_model' });
        return { ok: true };
      }
      if (!isRequestFastSource(saved.source)) {
        throw new IpcHandlerError('INVALID_MODEL_SOURCE', 'Fast mode is unavailable for this model source');
      }
      const resolved = saved.source === 'codex' ? saved.mode : await this.resolvePreference(saved);
      const capability = await resolvedFastModeMetadata(this.deps.request, saved.source, resolved);
      assertCurrent?.();
      this.assertPreference(sessionId, saved);
      if (capability.supportsFastMode !== true) throw new IpcHandlerError('MODEL_SELECTION_UNAVAILABLE', 'Fast mode is unavailable for this model selection');
      const previous = readSessionFastMode(sessionId, this.configRoot, saved.source);
      setSessionFastMode(sessionId, enabled, this.configRoot, saved.source, payload.updateDefaults !== false);
      if (previous !== enabled) await this.deps.onSessionConfigChanged({ kind: 'fast', sessionId });
      this.deps.push('app:preferences-changed', { key: fastModePreferenceKey(saved.source)! });
      return { ok: true };
    });
  }
  async getPermission(sessionId: string): Promise<Json> {
    const values = await this.engine.resolved(sessionId ? await this.deps.sessionCwd?.(sessionId) : undefined);
    const configured = runtimePolicyForSession('', values, this.configRoot);
    const friendScope = sessionId ? friendSessionScope(this.configRoot, sessionId) : undefined;
    const seed = friendScope ? friendPolicySeed(friendScope, sessionId, this.configRoot) : undefined;
    const { policy } = runtimePolicyForSession(sessionId, values, this.configRoot, seed);
    const preset = classifyRuntimePolicy(policy);
    const mode = preset;
    const effective = this.deps.runtimePolicyProjection?.applies(sessionId)
      ? await this.deps.runtimePolicyProjection.project(sessionId, policy) : { policy };
    return { mode, preset, effectiveMode: effective.effectiveMode ?? mode, policy: { ...effective.policy }, configuredPolicy: { ...configured.policy } };
  }
  async setPermission(payload: JsonObject): Promise<Json> {
    const mode = string(payload.mode);
    if (!PERMISSIONS.includes(mode)) return { error: 'invalid mode' };
    return this.mutations.run<Json>(async (): Promise<Json> => {
      const sessionId = sessionIdOf(payload);
      if (sessionId) {
        const values = await this.engine.resolved(await this.deps.sessionCwd?.(sessionId));
        const friendScope = friendSessionScope(this.configRoot, sessionId);
        const seed = friendScope ? friendPolicySeed(friendScope, sessionId, this.configRoot) : undefined;
        const current = runtimePolicyForSession(sessionId, values, this.configRoot, seed);
        const policy = presetRuntimePolicy(mode as import('../../contracts/runtime-settings').PermissionPreset, current.policy);
        const selection = applySessionRuntimePolicy(sessionId, { policy: { ...policy } }, this.configRoot);
        try { await this.deps.onSessionConfigChanged({ kind: 'permission', sessionId }); }
        catch (error) {
          selection.rollback();
          try { await this.deps.onSessionConfigChanged({ kind: 'permission', sessionId }); } catch { /* Failed bindings remain fenced by the policy publisher. */ }
          throw error;
        }
      } else {
        await this.engine.writePermissionPreset(mode as import('../../contracts/runtime-settings').PermissionPreset);
      }
      this.deps.push('app:preferences-changed', { key: 'composer.permission_mode' });
      return { ok: true, mode };
    });
  }
  private writeDefault(key: string, value: string, defaultValue: string): void {
    const result = value === defaultValue ? kvDel(key, this.configRoot) : kvSet(key, value, this.configRoot);
    if (isFailure(result)) throw new IpcHandlerError(result.code, result.message);
  }
  async options(source = storedAuthMode(this.configRoot), legacyTierLabels = true, catalogRead: 'warm' | 'cached' = 'warm', providedReply?: Json): Promise<Json[]> {
    if (!MODEL_SOURCES.includes(source)) throw new IpcHandlerError('INVALID_MODEL_SOURCE', 'Unknown model source');
    if (source === 'custom') {
      const providers = await this.engine.providers();
      return Object.entries(providers).filter(([id]) => id).map(([id, value]) => {
        const entry = object(value), caps = object(entry.capabilities);
        const levels = mapped(object(caps.effort).levels);
        const supported = levels.length ? LEVELS.filter(l => (l === 'off' ? Object.hasOwn(caps, 'thinking') : levels.includes(l))) : undefined;
        return metadata({ value: 'custom:' + id, label: string(entry.name) || string(entry.model), description: string(entry.model) }, supported ?? (Object.keys(caps).length ? [] : undefined));
      }).sort((a, b) => string(a.label).localeCompare(string(b.label)));
    }
    const method = source === 'kiro' ? 'kiro/models' : source === 'trae' ? 'trae/models' : source === 'antigravity' ? 'antigravity/models' : source === 'cursor' ? 'cursor/models' : source === 'subscription'
      ? 'subscription/models'
      : source === 'codex'
        ? 'codex/models'
        : source === 'qwenwork'
          ? 'qwenwork/models'
          : source === 'qoderwork'
            ? 'qoderwork/models'
            : source === 'workbuddy'
              ? 'workbuddy/models'
              : source === 'kimi'
                ? 'kimi/models'
                : source === 'bailian'
                  ? 'bailian/models'
                  : source === 'minimax'
                    ? 'minimax/models'
                    : source === 'zhipu'
                      ? 'zhipu/models'
                      : source === 'ark'
                        ? 'ark/models'
                        : 'qoder/models';
    // The tier settings page passes 'cached': a stale-while-revalidate read so
    // the pane paints from whatever catalog is at hand instead of waiting on a
    // live fetch. Pickers keep the default warm read.
    const reply = object(providedReply ?? await this.deps.request(method, { read: catalogRead }));
    const entries = Array.isArray(reply.models) ? reply.models.map(object) : [];
    if (source === 'subscription') {
      const tiers = legacyTierLabels ? sourceTierSelections(source, this.configRoot) : {};
      return entries.flatMap(entry => {
        const alias = string(entry.alias).trim();
        if (!alias) return [];
        const pick = string(tiers[string(entry.tier)]).trim();
        const remapped = pick && pick !== alias ? entries.find(row => row.alias === pick) : undefined;
        const shown = remapped ?? entry;
        const levels = mapped(shown.effortLevels);
        // An empty ladder means the model has no effort knob. Substituting a
        // rung would invent one: the picker would hide its single-rung control
        // while the clamp could overwrite the user's previous effort choice.
        return [metadata({ value: 'subscription:' + alias, label: pick && pick !== alias && !remapped ? pick : string(shown.label) || alias,
          ...nativeFastModeMetadata(shown, source) }, levels)];
      });
    }
    if (source === 'codex') return entries.flatMap(entry => {
      const id = string(entry.id).trim();
      if (!id) return [];
      const levels = mapped(entry.supportedReasoningLevels);
      return [metadata({ value: 'codex:' + id, label: string(entry.name).trim() || id, description: string(entry.description) || id, supportsFastMode: true }, levels.length ? levels : undefined, level(entry.defaultReasoning))];
    });
    const options = entries.flatMap(entry => {
      if (typeof entry.key !== 'string') return [];
      if (source === 'kiro' && isKiroRoutingAlias(entry.key)) return [];
      if ((source === 'trae' || source === 'kiro') && (entry.purpose !== undefined && entry.purpose !== 'chat'
        || entry.hidden === true || entry.is_invisible_to_user === true || entry.isInvisibleToUser === true)) return [];
      if (source === 'cursor' && cursorDefaultSelection('cursor:' + entry.key)) return [];
      const label = string(entry.display_name) || entry.key;
      const efforts = Array.isArray(entry.efforts) ? entry.efforts : [];
      const declared = mapped(efforts);
      const levels = efforts.length ? LEVELS.filter(l => declared.includes(l) || (l === 'off' && entry.canDisableThinking === true)) : [];
      // Preserve provider model descriptions, icons and credit multipliers in picker rows.
      const row: JsonObject = { value: `${source}:` + entry.key, label, description: string(entry.description) || label,
        ...(source === 'trae' ? pickTraeModelMetadata(entry) as JsonObject : {}),
        ...(source === 'kiro' ? pickKiroModelMetadata(entry) as JsonObject : {}),
        ...(isRequestFastSource(source) ? nativeFastModeMetadata(entry, source) : {}) };
      if (source === 'antigravity' || source === 'trae' || source === 'kiro') {
        row.available = entry.disabled !== true && entry.unavailable !== true && entry.available !== false;
        if (source === 'antigravity' && entry.inRecommendedSort === true) row.inRecommendedSort = true;
        const reason = string(entry.reason) || string(entry.unavailableReason);
        if (reason) row.reason = reason;
        const mimeTypes = object(entry.capabilities).mediaInputMimeTypes ?? entry.mediaInputMimeTypes;
        if (Array.isArray(mimeTypes)) row.mediaInputMimeTypes = mimeTypes.filter(value => typeof value === 'string').slice(0, 128);
      }
      if (typeof entry.priceFactor === 'number'  && Number.isFinite(entry.priceFactor)) row.priceFactor = entry.priceFactor;
      const icon = string(entry.icon);
      if (icon) row.icon = icon;
      const option = metadata(row, levels, level(entry.defaultEffort));
      return [source === 'trae' ? traeModelOptionForValue(option, string(option.value)) ?? option
        : source === 'kiro' ? kiroModelOptionForValue(option, string(option.value)) ?? option : option];
    });
    return source === 'antigravity' ? antigravityModelOptions(entries, options) : source === 'cursor' ? cursorModelOptions(entries, options) : options;
  }
}
