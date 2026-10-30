import type { CursorModelVariant, CursorParameterDefinition } from '../../shared/cursor-model-catalog';
import { cursorMaxContextVariant, modelOptionForValue, type CursorModelMetadata } from '../../shared/cursor-model-catalog';
import { object, string, type JsonObject } from './service-types';

/** Group presentation only; every member retains its exact inference selection. */
export function cursorModelOptions(entries: JsonObject[], options: JsonObject[]): JsonObject[] {
  const byValue = new Map(options.map(option => [string(option.value), option]));
  const families = new Map<string, { name: string; variants: CursorModelVariant[]; definitions: CursorParameterDefinition[] }>();
  for (const entry of entries) {
    const key = string(entry.key), requested = object(entry.requestedModel);
    const modelId = string(entry.modelId) || string(requested.modelId), option = byValue.get(`cursor:${key}`);
    if (!modelId || !option) continue;
    let family = families.get(modelId);
    if (!family) {
      family = { name: string(entry.modelName) || modelId, variants: [], definitions: [] };
      families.set(modelId, family);
    }
    if (family.variants.length >= 512) throw new Error('cursor_model_variants_too_large');
    const parameters: Record<string, string> = {};
    if (Array.isArray(requested.parameters)) for (const raw of requested.parameters) {
      const parameter = object(raw);
      if (typeof parameter.id === 'string' && typeof parameter.value === 'string') parameters[parameter.id] = parameter.value;
    }
    const variant: CursorModelVariant = { value: string(option.value), label: string(option.label), parameters,
      maxMode: requested.maxMode === true, isDefault: entry.isDefault === true };
    if (typeof entry.max_input_tokens === 'number') variant.contextTokens = entry.max_input_tokens;
    if (Array.isArray(option.supportedThinkingLevels)) variant.supportedThinkingLevels = option.supportedThinkingLevels.filter((level): level is string => typeof level === 'string');
    if (typeof option.defaultThinkingLevel === 'string') variant.defaultThinkingLevel = option.defaultThinkingLevel;
    family.variants.push(variant);
    if (Array.isArray(entry.parameterDefinitions) && !family.definitions.length) family.definitions = entry.parameterDefinitions as unknown as CursorParameterDefinition[];
  }
  return [...families.entries()].map(([modelId, family]) => {
    const baseline = family.variants.find(variant => variant.isDefault) ?? family.variants[0]!;
    const representative = cursorMaxContextVariant({ cursorVariants: family.variants } as CursorModelMetadata, baseline)!;
    const row = byValue.get(representative.value)!;
    const grouped = { ...row, label: family.name,
      ...(row.description === representative.label ? { description: family.name } : {}), cursorModelId: modelId,
      cursorVariants: family.variants as unknown as JsonObject[],
      ...(family.definitions.length ? { cursorParameterDefinitions: family.definitions as unknown as JsonObject[] } : {}) };
    return modelOptionForValue([grouped], representative.value)!;
  });
}
