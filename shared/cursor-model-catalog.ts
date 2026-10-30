import { antigravityModelOptionForValue, antigravityModelOptionHasValue, pickAntigravityModelMetadata } from './antigravity-model-catalog';
import { traeModelOptionForValue, traeModelOptionHasValue } from './trae-model-catalog';
import { kiroModelOptionForValue, kiroModelOptionHasValue } from './kiro-model-catalog';

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

function nonContextSignature(variant: CursorModelVariant): string {
  return Object.keys(variant.parameters).filter(key => key !== 'context').sort()
    .map(key => `${key}=${variant.parameters[key]}`).join('\0');
}

/** Keep effort and speed, and use the longest context tier that combination offers. */
export function cursorMaxContextVariant(model: CursorModelMetadata | null | undefined, variant: CursorModelVariant | undefined): CursorModelVariant | undefined {
  if (!variant || !model?.cursorVariants?.length) return variant;
  const signature = nonContextSignature(variant);
  return model.cursorVariants.reduce((best, candidate) => nonContextSignature(candidate) === signature
    && (candidate.contextTokens ?? 0) > (best.contextTokens ?? 0) ? candidate : best, variant);
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
  const variant = cursorMaxContextVariant(metadata, metadata.cursorVariants?.find(variant => variant.value === qualified));
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
