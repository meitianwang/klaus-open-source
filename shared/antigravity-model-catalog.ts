/** A menu family retains every concrete cloud selection and its account state. */
export interface AntigravityModelVariant {
  value: string;
  thinkingLevel?: string;
  available: boolean;
  reason?: string;
  isDefault?: boolean;
  mediaInputMimeTypes?: string[];
  contextTokens?: number;
}

export interface AntigravityModelMetadata {
  antigravityFamilyId?: string;
  antigravityVariants?: AntigravityModelVariant[];
  antigravityThinkingToggle?: boolean;
}

const LEVELS = ['off', 'low', 'medium', 'high', 'xhigh', 'max'];

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function pickAntigravityModelMetadata(value: unknown): AntigravityModelMetadata {
  const row = record(value);
  if (typeof row.antigravityFamilyId !== 'string' || !row.antigravityFamilyId || row.antigravityFamilyId.length > 256
    || !Array.isArray(row.antigravityVariants)) return {};
  const variants: AntigravityModelVariant[] = [];
  const seen = new Set<string>();
  for (const raw of row.antigravityVariants.slice(0, 512)) {
    const item = record(raw);
    if (typeof item.value !== 'string' || !item.value.startsWith('antigravity:') || item.value.length <= 12
      || item.value.length > 1024 || seen.has(item.value) || typeof item.available !== 'boolean'
      || item.thinkingLevel !== undefined && !LEVELS.includes(String(item.thinkingLevel))) continue;
    seen.add(item.value);
    const variant: AntigravityModelVariant = { value: item.value, available: item.available };
    if (typeof item.thinkingLevel === 'string') variant.thinkingLevel = item.thinkingLevel;
    if (typeof item.reason === 'string') variant.reason = item.reason.slice(0, 4096);
    if (typeof item.isDefault === 'boolean') variant.isDefault = item.isDefault;
    if (typeof item.contextTokens === 'number' && Number.isFinite(item.contextTokens) && item.contextTokens > 0) variant.contextTokens = item.contextTokens;
    if (Array.isArray(item.mediaInputMimeTypes)) variant.mediaInputMimeTypes = item.mediaInputMimeTypes.slice(0, 128)
      .filter((mime): mime is string => typeof mime === 'string' && mime.length <= 256);
    variants.push(variant);
  }
  return variants.length ? { antigravityFamilyId: row.antigravityFamilyId, antigravityVariants: variants,
    ...(row.antigravityThinkingToggle === true ? { antigravityThinkingToggle: true } : {}) } : {};
}

export function antigravityVariant(model: AntigravityModelMetadata | null | undefined, selection: string): AntigravityModelVariant | undefined {
  const value = selection.startsWith('antigravity:') ? selection : `antigravity:${selection}`;
  return model?.antigravityVariants?.find(variant => variant.value === value);
}

export function antigravityThinkingLevel(model: AntigravityModelMetadata | null | undefined, selection: string): string | undefined {
  return antigravityVariant(model, selection)?.thinkingLevel;
}

export function antigravityVariantForThinking(model: AntigravityModelMetadata | null | undefined, selection: string, level: string): AntigravityModelVariant | undefined {
  const current = antigravityVariant(model, selection);
  if (!current) return undefined;
  const targets = (model?.antigravityVariants ?? []).filter(variant => variant.thinkingLevel === level);
  return targets.find(variant => variant.value === current.value) ?? (targets.length === 1 ? targets[0] : undefined);
}

export function antigravityThinkingLevels(model: AntigravityModelMetadata | null | undefined, selection: string): string[] {
  return LEVELS.filter(level => antigravityVariantForThinking(model, selection, level) !== undefined);
}

export function antigravityModelOptionHasValue(option: unknown, selection: string): boolean {
  return antigravityVariant(pickAntigravityModelMetadata(option), selection) !== undefined;
}

/** Resolve saved members without replacing them with the family's default. */
export function antigravityModelOptionForValue<T>(option: T, selection: string): T | undefined {
  const metadata = pickAntigravityModelMetadata(option);
  const variant = antigravityVariant(metadata, selection);
  if (!variant) return undefined;
  const row = record(option), selected = { ...row };
  if (typeof row.value === 'string') selected.value = variant.value;
  if (typeof row.modelId === 'string') selected.modelId = variant.value.slice('antigravity:'.length);
  selected.available = variant.available;
  if (variant.reason) selected.reason = variant.reason;
  else delete selected.reason;
  selected.supportedThinkingLevels = [...antigravityThinkingLevels(metadata, variant.value)];
  if (variant.thinkingLevel) selected.defaultThinkingLevel = variant.thinkingLevel;
  else delete selected.defaultThinkingLevel;
  if (variant.mediaInputMimeTypes) selected.mediaInputMimeTypes = [...variant.mediaInputMimeTypes];
  else delete selected.mediaInputMimeTypes;
  if (variant.contextTokens !== undefined) selected.contextTokens = variant.contextTokens;
  else delete selected.contextTokens;
  return selected as T;
}
