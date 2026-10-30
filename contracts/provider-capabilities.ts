export const PROVIDER_CAPABILITIES = ['image', 'imageEdit', 'video', 'audio', 'music', 'transcription', 'search', 'fetch'] as const;
export type ProviderCapabilityKind = typeof PROVIDER_CAPABILITIES[number];
export interface ProviderCapability {
  available: boolean;
  models?: Array<{ id: string; label: string }>;
  defaultModel?: string;
  referenceImages?: boolean;
  voice?: boolean;
  speed?: boolean;
}
export type ProviderCapabilities = Record<ProviderCapabilityKind, ProviderCapability>;

/** Only bounded, public capability metadata may reach settings. */
export function providerCapabilities(value: unknown): ProviderCapabilities {
  const object = (entry: unknown): Record<string, unknown> => entry !== null && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : {};
  const string = (entry: unknown): string | undefined => typeof entry === 'string' && entry.length > 0 && entry.length <= 512 && !/[\u0000-\u001f\u007f]/u.test(entry) ? entry : undefined;
  const raw = object(value);
  return Object.fromEntries(PROVIDER_CAPABILITIES.map(kind => {
    const row = object(raw[kind]);
    const models = Array.isArray(row.models) ? row.models.slice(0, 256).flatMap(item => {
      const model = object(item), id = string(typeof item === 'string' ? item : model.id), label = string(typeof item === 'string' ? item : model.label);
      return id && label && !/^(?:auto|default)$/i.test(id) ? [{ id, label }] : [];
    }).filter((model, index, rows) => rows.findIndex(other => other.id === model.id) === index) : undefined;
    const preferred = string(row.defaultModel);
    return [kind, { available: row.available === true, ...(models ? { models } : {}),
      ...(preferred && models?.some(model => model.id === preferred) ? { defaultModel: preferred } : {}),
      ...Object.fromEntries(['referenceImages', 'voice', 'speed'].flatMap(key => typeof row[key] === 'boolean' ? [[key, row[key]]] : key === 'referenceImages' && typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] > 0 ? [[key, true]] : [])) }];
  })) as ProviderCapabilities;
}
