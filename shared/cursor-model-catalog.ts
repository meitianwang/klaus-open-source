import { antigravityModelOptionForValue, antigravityModelOptionHasValue, pickAntigravityModelMetadata } from './antigravity-model-catalog';
import { pickTraeModelMetadata, traeModelOptionForValue, traeModelOptionHasValue } from './trae-model-catalog';
import { isKiroRoutingAlias, kiroModelOptionForValue, kiroModelOptionHasValue, pickKiroModelMetadata } from './kiro-model-catalog';

/** Exact provider variants stay stable while model menus display one family row. */
export interface CursorModelVariant {
  value: string;
  label: string;
  parameters: Record<string, string>;
  maxMode: boolean;
  isDefault?: boolean;
  contextTokens?: number;
  supportedThinkingLevels?: string[];
  defaultThinkingLevel?: string;
}

export interface CursorParameterDefinition {
  id: string;
  name: string;
  type: 'boolean' | 'enum';
  values: Array<{ value: string; displayName?: string; increasesModelCost?: boolean; blockedByAdminAllowlist?: boolean }>;
}

export interface CursorModelMetadata {
  cursorModelId?: string;
  cursorVariants?: CursorModelVariant[];
  cursorParameterDefinitions?: CursorParameterDefinition[];
  cursorThinkingToggle?: boolean;
}

const NATIVE_LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];
const REASONING_PARAMETERS = new Set(['effort', 'reasoning_effort', 'reasoning', 'thinking']);

export function cursorVariant(model: CursorModelMetadata | null | undefined, selection: string): CursorModelVariant | undefined {
  const qualified = selection.startsWith('cursor:') ? selection : `cursor:${selection}`;
  return model?.cursorVariants?.find(variant => variant.value === qualified);
}

function nativeLevel(variant: CursorModelVariant): string | undefined {
  for (const id of REASONING_PARAMETERS) {
    const value = variant.parameters[id];
    if (value === undefined) continue;
    if (value === 'false' || value === 'none' || value === 'off') return 'off';
    if (value === 'true') return 'high';
    const normalized = value === 'minimal' ? 'low' : value === 'ultra' ? 'max' : value;
    if (NATIVE_LEVELS.includes(normalized)) return normalized;
  }
  if (variant.defaultThinkingLevel && NATIVE_LEVELS.includes(variant.defaultThinkingLevel)) return variant.defaultThinkingLevel;
  return undefined;
}

function compatible(current: CursorModelVariant, candidate: CursorModelVariant, changed: ReadonlySet<string>): boolean {
  return [...new Set([...Object.keys(current.parameters), ...Object.keys(candidate.parameters)])]
    .every(key => changed.has(key) || current.parameters[key] === candidate.parameters[key]);
}

/** Select a real, unambiguous member. Native Max mode travels with that member. */
function uniqueTarget(current: CursorModelVariant, candidates: CursorModelVariant[]): CursorModelVariant | undefined {
  const exact = candidates.find(candidate => candidate.value === current.value);
  if (exact) return exact;
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function cursorThinkingLevel(model: CursorModelMetadata | null | undefined, selection: string): string | undefined {
  const current = cursorVariant(model, selection);
  return current && nativeLevel(current);
}

export function cursorVariantForThinking(model: CursorModelMetadata | null | undefined, selection: string, level: string): CursorModelVariant | undefined {
  const current = cursorVariant(model, selection);
  if (!current || !model) return undefined;
  return uniqueTarget(current, (model.cursorVariants ?? []).filter(candidate => nativeLevel(candidate) === level
    && compatible(current, candidate, REASONING_PARAMETERS)));
}

export function cursorThinkingLevels(model: CursorModelMetadata | null | undefined, selection: string): string[] {
  return NATIVE_LEVELS.filter(level => cursorVariantForThinking(model, selection, level) !== undefined);
}

export function cursorVariantForFast(model: CursorModelMetadata | null | undefined, selection: string, enabled: boolean): CursorModelVariant | undefined {
  const current = cursorVariant(model, selection);
  if (!current || !model || current.parameters.fast === undefined) return undefined;
  return uniqueTarget(current, (model.cursorVariants ?? []).filter(candidate => candidate.parameters.fast === String(enabled)
    && compatible(current, candidate, new Set(['fast']))));
}

/** Resolve an explicit combined edit without requiring intermediate members. */
export function cursorVariantForThinkingAndFast(model: CursorModelMetadata | null | undefined, selection: string, level: string, enabled: boolean): CursorModelVariant | undefined {
  const current = cursorVariant(model, selection);
  if (!current || !model || current.parameters.fast === undefined) return undefined;
  const changed = new Set(level === 'ultra' ? ['fast'] : [...REASONING_PARAMETERS, 'fast']);
  return uniqueTarget(current, (model.cursorVariants ?? []).filter(candidate => (level === 'ultra' || nativeLevel(candidate) === level)
    && candidate.parameters.fast === String(enabled) && compatible(current, candidate, changed)));
}

export function cursorFastMode(model: CursorModelMetadata | null | undefined, selection: string): { enabled: boolean; supported: boolean } {
  const enabled = cursorVariant(model, selection)?.parameters.fast === 'true';
  return { enabled, supported: cursorVariantForFast(model, selection, !enabled) !== undefined };
}

/** Context tiers the catalog offers for the current effort/speed/max combination, in upstream definition order. */
export function cursorContextTiers(model: CursorModelMetadata | null | undefined, selection: string): string[] {
  const current = cursorVariant(model, selection);
  if (!current || !model || current.parameters.context === undefined) return [];
  const available = (model.cursorVariants ?? []).filter(candidate => compatible(current, candidate, new Set(['context'])))
    .map(candidate => candidate.parameters.context)
    .filter((tier): tier is string => typeof tier === 'string');
  const declared = (model.cursorParameterDefinitions ?? []).find(definition => definition.id === 'context')?.values.map(value => value.value) ?? [];
  const ordered = declared.filter(value => available.includes(value));
  for (const value of available) if (!ordered.includes(value)) ordered.push(value);
  return ordered;
}

export function cursorVariantForContext(model: CursorModelMetadata | null | undefined, selection: string, tier: string): CursorModelVariant | undefined {
  const current = cursorVariant(model, selection);
  if (!current || !model || current.parameters.context === undefined) return undefined;
  return uniqueTarget(current, (model.cursorVariants ?? []).filter(candidate => candidate.parameters.context === tier
    && compatible(current, candidate, new Set(['context']))));
}

/** Max mode is a variant projection flag, not a parameter: same parameters, other projection. */
export function cursorMaxMode(model: CursorModelMetadata | null | undefined, selection: string): { enabled: boolean; supported: boolean } {
  const current = cursorVariant(model, selection);
  if (!current || !model) return { enabled: false, supported: false };
  const supported = (model.cursorVariants ?? []).some(candidate => candidate.maxMode !== current.maxMode
    && compatible(candidate, current, new Set()));
  return { enabled: current.maxMode, supported };
}

export function cursorVariantForMaxMode(model: CursorModelMetadata | null | undefined, selection: string, enabled: boolean): CursorModelVariant | undefined {
  const current = cursorVariant(model, selection);
  if (!current || !model) return undefined;
  return uniqueTarget(current, (model.cursorVariants ?? []).filter(candidate => candidate.maxMode === enabled
    && compatible(candidate, current, new Set())));
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Project only model metadata that is safe to carry across renderer boundaries. */
export function pickCursorModelMetadata(value: unknown): CursorModelMetadata {
  const row = record(value);
  if (typeof row.cursorModelId !== 'string' || !row.cursorModelId || !Array.isArray(row.cursorVariants)) return {};
  const variants: CursorModelVariant[] = [];
  const seen = new Set<string>();
  for (const raw of row.cursorVariants.slice(0, 512)) {
    const variant = record(raw), parameters = record(variant.parameters);
    if (typeof variant.value !== 'string' || !variant.value.startsWith('cursor:') || seen.has(variant.value)
      || typeof variant.label !== 'string' || typeof variant.maxMode !== 'boolean'
      || Object.keys(parameters).length > 32 || Object.values(parameters).some(value => typeof value !== 'string')) continue;
    seen.add(variant.value);
    const item: CursorModelVariant = { value: variant.value, label: variant.label, parameters: { ...parameters } as Record<string, string>, maxMode: variant.maxMode };
    if (typeof variant.isDefault === 'boolean') item.isDefault = variant.isDefault;
    if (typeof variant.contextTokens === 'number' && Number.isFinite(variant.contextTokens) && variant.contextTokens > 0) item.contextTokens = variant.contextTokens;
    if (Array.isArray(variant.supportedThinkingLevels)) item.supportedThinkingLevels = variant.supportedThinkingLevels.filter((level): level is string => typeof level === 'string');
    if (typeof variant.defaultThinkingLevel === 'string') item.defaultThinkingLevel = variant.defaultThinkingLevel;
    variants.push(item);
  }
  if (!variants.length) return {};
  const definitions: CursorParameterDefinition[] = [];
  if (Array.isArray(row.cursorParameterDefinitions)) for (const raw of row.cursorParameterDefinitions.slice(0, 32)) {
    const definition = record(raw);
    if (typeof definition.id !== 'string' || typeof definition.name !== 'string'
      || !['boolean', 'enum'].includes(String(definition.type)) || !Array.isArray(definition.values)) continue;
    const values: CursorParameterDefinition['values'] = [];
    for (const rawValue of definition.values.slice(0, 64)) {
      const option = record(rawValue);
      if (typeof option.value !== 'string') continue;
      values.push({ value: option.value,
        ...(typeof option.displayName === 'string' ? { displayName: option.displayName } : {}),
        ...(typeof option.increasesModelCost === 'boolean' ? { increasesModelCost: option.increasesModelCost } : {}),
        ...(typeof option.blockedByAdminAllowlist === 'boolean' ? { blockedByAdminAllowlist: option.blockedByAdminAllowlist } : {}) });
    }
    definitions.push({ id: definition.id, name: definition.name, type: definition.type as CursorParameterDefinition['type'], values });
  }
  return { cursorModelId: row.cursorModelId, cursorVariants: variants, ...(definitions.length ? { cursorParameterDefinitions: definitions } : {}) };
}

/** Account entitlement is informational for this cloud source; the service admits requests. */
export function modelOptionIsAntigravity(option: unknown, source?: string): boolean {
  const row = record(option);
  if (!Object.keys(row).length) return false;
  if (source !== undefined) return source === 'antigravity';
  return typeof row.value === 'string' && row.value.startsWith('antigravity:') && row.value.length > 12
    || Boolean(pickAntigravityModelMetadata(option).antigravityVariants?.length);
}

/** Catalog membership permits selection; the provider admits inference requests. */
export function modelOptionIsSelectable(option: unknown, source?: string): boolean {
  const row = record(option);
  const value = typeof row.value === 'string' ? row.value.trim() : '';
  const modelId = typeof row.modelId === 'string' ? row.modelId.trim() : '';
  if (!value && !modelId) return false;
  if (source !== undefined && value.includes(':') && !value.startsWith(`${source}:`)) return false;
  return true;
}

export function modelOptionHasValue(option: unknown, value: string): boolean {
  const row = record(option);
  if (row.value === value || row.modelId === value) return true;
  if (antigravityModelOptionHasValue(option, value)) return true;
  if (traeModelOptionHasValue(option, value)) return true;
  if (kiroModelOptionHasValue(option, value)) return true;
  if (typeof row.cursorModelId !== 'string' || !Array.isArray(row.cursorVariants)) return false;
  const qualified = value.startsWith('cursor:') ? value : `cursor:${value}`;
  return row.cursorVariants.some(variant => record(variant).value === qualified);
}

/** Resolve a saved member without replacing its identity with the family default. */
export function modelOptionForValue<T>(options: readonly T[], value: string): T | undefined {
  const found = options.find(option => modelOptionHasValue(option, value));
  if (!found) return undefined;
  const antigravity = antigravityModelOptionForValue(found, value);
  if (antigravity) return antigravity;
  const trae = traeModelOptionForValue(found, value);
  if (trae) return trae;
  const kiro = kiroModelOptionForValue(found, value);
  if (kiro) return kiro;
  const row = record(found), metadata = pickCursorModelMetadata(row);
  const qualified = value.startsWith('cursor:') ? value : `cursor:${value}`;
  // The saved member is the inference identity: context tier and max mode stay
  // exactly as stored instead of being re-promoted to a longer tier.
  const variant = metadata.cursorVariants?.find(candidate => candidate.value === qualified);
  if (!variant) return found;
  const selected = { ...row };
  if (typeof row.value === 'string') selected.value = variant.value;
  if (typeof row.modelId === 'string') selected.modelId = variant.value.slice('cursor:'.length);
  selected.supportedThinkingLevels = [...cursorThinkingLevels(metadata, variant.value)];
  selected.cursorThinkingToggle = variant.parameters.thinking === 'true' || variant.parameters.thinking === 'false';
  const native = nativeLevel(variant);
  if (native !== undefined) selected.defaultThinkingLevel = native;
  else delete selected.defaultThinkingLevel;
  return selected as T;
}

/** Native selects need a row whose value is the exact saved member. */
export function modelOptionsForValue<T>(options: readonly T[], value: string): T[] {
  return options.map(option => modelOptionHasValue(option, value) ? modelOptionForValue([option], value)! : option);
}

/** Identify the per-model or per-family slot used to remember reasoning choices. */
export function modelPreferenceKey(option: unknown, selection?: string): string | undefined {
  const antigravity = pickAntigravityModelMetadata(option);
  if (antigravity.antigravityFamilyId) return `antigravityFamily:${antigravity.antigravityFamilyId}`;
  const cursor = pickCursorModelMetadata(option);
  if (cursor.cursorModelId) return `cursorFamily:${cursor.cursorModelId}`;
  const trae = pickTraeModelMetadata(option);
  if (trae.traeFamilyId) return `traeFamily:${trae.traeFamilyId}`;
  const kiro = pickKiroModelMetadata(option);
  if (kiro.kiroFamilyId) return `kiroFamily:${kiro.kiroFamilyId}`;
  const row = record(option);
  const raw = typeof selection === 'string' && selection ? selection.trim()
    : (typeof row.value === 'string' ? row.value.trim() : '');
  if (!raw || ['auto', 'high', 'medium', 'low'].includes(raw)) return undefined;
  if (raw.startsWith('cursor:')) {
    if (['cursor:default', 'cursor:auto'].includes(raw.toLowerCase())) return undefined;
    const base = raw.slice('cursor:'.length).replace(/@max$/i, '').replace(/\[.*\]$/, '');
    return base ? `cursorFamily:${base}` : undefined;
  }
  if (raw.startsWith('kiro:')) {
    if (isKiroRoutingAlias(raw)) return undefined;
    const family = raw.slice('kiro:'.length).split('::effort=')[0];
    return family ? `kiroFamily:${family}` : undefined;
  }
  if (raw.startsWith('trae:')) {
    const family = raw.slice('trae:'.length).split('::effort=')[0];
    return family ? `traeFamily:${family}` : undefined;
  }
  const colon = raw.indexOf(':');
  return colon > 0 && colon < raw.length - 1 ? raw : undefined;
}

/** Project both the active selection and previously chosen family members onto menu rows. */
export function modelOptionsForRemembered<T>(
  options: readonly T[],
  activeValue: string,
  rememberedModes?: Readonly<Record<string, string>>,
): T[] {
  return options.map(option => {
    if (modelOptionHasValue(option, activeValue)) return modelOptionForValue([option], activeValue)!;
    const key = rememberedModes ? modelPreferenceKey(option) : undefined;
    const remembered = key ? rememberedModes?.[key] : undefined;
    if (remembered && modelOptionHasValue(option, remembered)) return modelOptionForValue([option], remembered)!;
    return option;
  });
}
