/** Native Kiro effort members retain their exact identity independently of global reasoning. */
export interface KiroModelVariant {
  value: string;
  nativeEffort?: string;
  label?: string;
  available: boolean;
  reason?: string;
  isDefault?: boolean;
  mediaInputMimeTypes?: string[];
  contextTokens?: number;
}
export interface KiroModelMetadata {
  kiroFamilyId?: string;
  kiroVariants?: KiroModelVariant[];
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function isKiroRoutingAlias(value: string): boolean {
  return value.replace(/^kiro:/, '').split('::effort=')[0]?.toLowerCase() === 'auto';
}
export function isKiroNativeEffort(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value);
}
export function pickKiroModelMetadata(value: unknown): KiroModelMetadata {
  const row = record(value);
  if (typeof row.kiroFamilyId !== 'string' || !row.kiroFamilyId || row.kiroFamilyId.length > 512
    || row.kiroFamilyId !== row.kiroFamilyId.trim() || /[\u0000-\u001f\u007f]/.test(row.kiroFamilyId) || !Array.isArray(row.kiroVariants)) return {};
  const variants: KiroModelVariant[] = [], seen = new Set<string>();
  for (const raw of row.kiroVariants.slice(0, 128)) {
    const variant = record(raw);
    if (typeof variant.value !== 'string' || !variant.value.startsWith('kiro:') || variant.value.length <= 5 || variant.value.length > 1024
      || seen.has(variant.value) || typeof variant.available !== 'boolean' || variant.nativeEffort != null && !isKiroNativeEffort(variant.nativeEffort)) continue;
    const base = `kiro:${row.kiroFamilyId}`;
    if (variant.value !== base && (!isKiroNativeEffort(variant.nativeEffort) || variant.value !== `${base}::effort=${encodeURIComponent(variant.nativeEffort)}`)) continue;
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
  return variants.length ? { kiroFamilyId: row.kiroFamilyId, kiroVariants: variants } : {};
}
export function kiroVariant(model: KiroModelMetadata | null | undefined, selection: string): KiroModelVariant | undefined {
  const value = selection.startsWith('kiro:') ? selection : `kiro:${selection}`;
  return model?.kiroVariants?.find(variant => variant.value === value);
}
export function kiroThinkingLevel(model: KiroModelMetadata | null | undefined, selection: string): string | undefined {
  return kiroVariant(model, selection)?.nativeEffort;
}
export function kiroThinkingLevels(model: KiroModelMetadata | null | undefined): string[] {
  const levels = [...new Set((model?.kiroVariants ?? []).map(variant => variant.nativeEffort).filter(isKiroNativeEffort).filter(value => value !== 'default'))];
  const order = ['none', 'off', 'disabled', 'adaptive', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  return levels.sort((left, right) => {
    const rank = (value: string) => { const index = order.indexOf(value); return index < 0 ? order.length : index; };
    return rank(left) - rank(right);
  });
}
export function kiroVariantForThinking(model: KiroModelMetadata | null | undefined, selection: string, nativeEffort: string): KiroModelVariant | undefined {
  const current = kiroVariant(model, selection);
  if (!current || !isKiroNativeEffort(nativeEffort)) return undefined;
  if (current.nativeEffort === nativeEffort) return current;
  const variants = model?.kiroVariants?.filter(variant => variant.nativeEffort === nativeEffort) ?? [];
  return variants.find(variant => variant.value.includes('::effort=')) ?? variants[0];
}
export function kiroThinkingLabel(model: KiroModelMetadata | null | undefined, nativeEffort: string): string {
  return model?.kiroVariants?.find(variant => variant.nativeEffort === nativeEffort && variant.label)?.label
    || nativeEffort.slice(0, 1).toUpperCase() + nativeEffort.slice(1);
}
export function kiroModelOptionHasValue(option: unknown, selection: string): boolean {
  return kiroVariant(pickKiroModelMetadata(option), selection) !== undefined;
}
export function kiroModelOptionForValue<T>(option: T, selection: string): T | undefined {
  const metadata = pickKiroModelMetadata(option), variant = kiroVariant(metadata, selection);
  if (!variant) return undefined;
  const row = record(option), selected: Record<string, unknown> = { ...row, ...metadata };
  if (typeof row.value === 'string') selected.value = variant.value;
  if (typeof row.modelId === 'string') selected.modelId = variant.value.slice(5);
  selected.available = variant.available;
  if (variant.reason) selected.reason = variant.reason; else delete selected.reason;
  selected.supportedThinkingLevels = kiroThinkingLevels(metadata);
  if (variant.nativeEffort) selected.defaultThinkingLevel = variant.nativeEffort; else delete selected.defaultThinkingLevel;
  if (variant.mediaInputMimeTypes) selected.mediaInputMimeTypes = [...variant.mediaInputMimeTypes]; else delete selected.mediaInputMimeTypes;
  if (variant.contextTokens !== undefined) selected.contextTokens = variant.contextTokens;
  return selected as T;
}
