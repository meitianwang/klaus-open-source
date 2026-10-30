/** A family keeps exact service effort selections without changing global reasoning values. */
export interface TraeModelVariant {
  value: string;
  nativeEffort?: string;
  label?: string;
  available: boolean;
  reason?: string;
  isDefault?: boolean;
  mediaInputMimeTypes?: string[];
  contextTokens?: number;
}
export interface TraeModelMetadata {
  traeFamilyId?: string;
  traeVariants?: TraeModelVariant[];
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function isTraeNativeEffort(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
}
export function pickTraeModelMetadata(value: unknown): TraeModelMetadata {
  const row = record(value);
  if (typeof row.traeFamilyId !== 'string' || !row.traeFamilyId || row.traeFamilyId.length > 512
    || row.traeFamilyId !== row.traeFamilyId.trim() || /[\u0000-\u001f\u007f]/.test(row.traeFamilyId) || !Array.isArray(row.traeVariants)) return {};
  const variants: TraeModelVariant[] = [], seen = new Set<string>();
  for (const raw of row.traeVariants.slice(0, 128)) {
    const variant = record(raw);
    if (typeof variant.value !== 'string' || !variant.value.startsWith('trae:') || variant.value.length <= 5 || variant.value.length > 1024
      || seen.has(variant.value) || typeof variant.available !== 'boolean' || variant.nativeEffort !== undefined && !isTraeNativeEffort(variant.nativeEffort)) continue;
    const base = `trae:${row.traeFamilyId}`;
    if (variant.value !== base && (!isTraeNativeEffort(variant.nativeEffort) || variant.value !== `${base}::effort=${encodeURIComponent(variant.nativeEffort)}`)) continue;
    seen.add(variant.value);
    variants.push({ value: variant.value, available: variant.available,
      ...(typeof variant.nativeEffort === 'string' ? { nativeEffort: variant.nativeEffort } : {}),
      ...(typeof variant.label === 'string' && variant.label.length <= 256 ? { label: variant.label } : {}),
      ...(typeof variant.reason === 'string' ? { reason: variant.reason.slice(0, 4096) } : {}),
      ...(typeof variant.isDefault === 'boolean' ? { isDefault: variant.isDefault } : {}),
      ...(typeof variant.contextTokens === 'number' && Number.isSafeInteger(variant.contextTokens) && variant.contextTokens > 0 ? { contextTokens: variant.contextTokens } : {}),
      ...(Array.isArray(variant.mediaInputMimeTypes) ? { mediaInputMimeTypes: variant.mediaInputMimeTypes.slice(0, 128).filter((mime): mime is string => typeof mime === 'string' && mime.length <= 256) } : {}),
    });
  }
  return variants.length ? { traeFamilyId: row.traeFamilyId, traeVariants: variants } : {};
}
export function traeVariant(model: TraeModelMetadata | null | undefined, selection: string): TraeModelVariant | undefined {
  const value = selection.startsWith('trae:') ? selection : `trae:${selection}`;
  return model?.traeVariants?.find(variant => variant.value === value);
}
export function traeThinkingLevel(model: TraeModelMetadata | null | undefined, selection: string): string | undefined {
  return traeVariant(model, selection)?.nativeEffort;
}
export function traeThinkingLevels(model: TraeModelMetadata | null | undefined): string[] {
  const levels = [...new Set((model?.traeVariants ?? []).map(variant => variant.nativeEffort).filter(isTraeNativeEffort))];
  const order = ['off', 'light', 'low', 'medium', 'high', 'extra_high', 'xhigh', 'max'];
  return levels.sort((left, right) => {
    const rank = (value: string) => { const index = order.indexOf(value); return index < 0 ? order.length : index; };
    return rank(left) - rank(right);
  });
}
export function traeVariantForThinking(model: TraeModelMetadata | null | undefined, selection: string, nativeEffort: string): TraeModelVariant | undefined {
  const current = traeVariant(model, selection);
  if (!current || !isTraeNativeEffort(nativeEffort)) return undefined;
  if (current.nativeEffort === nativeEffort) return current;
  const variants = model?.traeVariants?.filter(variant => variant.nativeEffort === nativeEffort) ?? [];
  return variants.find(variant => variant.value.includes('::effort=')) ?? variants[0];
}
export function traeThinkingLabel(model: TraeModelMetadata | null | undefined, nativeEffort: string): string {
  const label = model?.traeVariants?.find(variant => variant.nativeEffort === nativeEffort && variant.label)?.label;
  return label || nativeEffort.slice(0, 1).toUpperCase() + nativeEffort.slice(1);
}
export function traeModelOptionHasValue(option: unknown, selection: string): boolean {
  return traeVariant(pickTraeModelMetadata(option), selection) !== undefined;
}
export function traeModelOptionForValue<T>(option: T, selection: string): T | undefined {
  const metadata = pickTraeModelMetadata(option), variant = traeVariant(metadata, selection);
  if (!variant) return undefined;
  const row = record(option), selected: Record<string, unknown> = { ...row, ...metadata };
  if (typeof row.value === 'string') selected.value = variant.value;
  if (typeof row.modelId === 'string') selected.modelId = variant.value.slice(5);
  selected.available = variant.available;
  if (variant.reason) selected.reason = variant.reason; else delete selected.reason;
  selected.supportedThinkingLevels = traeThinkingLevels(metadata);
  if (variant.nativeEffort) selected.defaultThinkingLevel = variant.nativeEffort; else delete selected.defaultThinkingLevel;
  if (variant.mediaInputMimeTypes) selected.mediaInputMimeTypes = [...variant.mediaInputMimeTypes]; else delete selected.mediaInputMimeTypes;
  if (variant.contextTokens !== undefined) selected.contextTokens = variant.contextTokens;
  return selected as T;
}
