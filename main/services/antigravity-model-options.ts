import { antigravityModelOptionForValue, type AntigravityModelVariant } from '../../shared/antigravity-model-catalog';
import { object, string, type JsonObject } from './service-types';

interface Member { family: string; label: string; level: string; budget?: number; nativeLevel?: number; toggle?: boolean }

// Families absent from the tables above still declare their effort in the
// label suffix; grouping by the stripped base keeps newly offered models
// menu-ready without a code change. Unknown suffix tokens fall through and
// stay visible as plain rows.
const EFFORT_SUFFIX = /\s*\((extra\s+low|extra\s+high|low|medium|high|xhigh|max)(?:\s+thinking)?\)\s*$/i;
const SUFFIX_LEVELS: Record<string, string> = { 'extra low': 'low', low: 'low', medium: 'medium', high: 'high', 'extra high': 'xhigh', xhigh: 'xhigh', max: 'max' };

/** Protocol identities declare these variants; suffixes do not define effort. */
function member(key: string, entry: JsonObject, row: JsonObject): Member | undefined {
  const fixed: Record<string, Member> = {
    'gemini-3.8-flash-low': { family: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', level: 'low', budget: 1000, nativeLevel: 1 },
    'gemini-3.8-flash-medium': { family: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', level: 'medium', budget: 4000, nativeLevel: 2 },
    'gemini-3.8-flash-high': { family: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', level: 'high', budget: -1, nativeLevel: 3 },
    'gemini-3.5-flash-extra-low': { family: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', level: 'low', budget: 1000 },
    'gemini-3.5-flash-low': { family: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', level: 'medium', budget: 4000 },
    'gemini-3-flash-agent': { family: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash', level: 'high', budget: -1 },
    // These concrete selections share the service's user-facing model name.
    'gemini-2.5-flash': { family: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', level: 'low', nativeLevel: 1 },
    'gemini-2.5-flash-lite': { family: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', level: 'low', nativeLevel: 1 },
    'gemini-2.5-flash-thinking': { family: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite', level: 'low', nativeLevel: 1 },
    'gpt-oss-120b-medium': { family: 'gpt-oss-120b', label: 'GPT-OSS 120B', level: 'medium', budget: 8192 },
    // The enabled value is a local boolean representation, not a provider effort.
    'claude-sonnet-4-6': { family: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', level: 'high', budget: 1024, toggle: true },
    'claude-opus-4-6-thinking': { family: 'claude-opus-4-6', label: 'Claude Opus 4.6', level: 'high', budget: 1024, toggle: true },
  };
  if (fixed[key]) return fixed[key];
  for (const [family, label, levels] of [
    ['gemini-4-argon', 'Gemini 4 Argon', ['low', 'medium', 'high']],
    ['claude-sonnet-5-5', 'Claude Sonnet 5.5', ['low', 'medium', 'high', 'max']],
    ['claude-opus-5-5', 'Claude Opus 5.5', ['low', 'medium', 'high', 'max']],
  ] as const) {
    const index = levels.findIndex(level => key === `${family}-${level}`);
    if (index >= 0) return { family, label, level: levels[index]!, nativeLevel: levels[index] === 'max' ? 200 : index + 1 };
  }
  const label = string(row.label) || string(entry.display_name) || string(entry.displayName);
  const suffix = label ? EFFORT_SUFFIX.exec(label) : null;
  if (suffix) {
    const base = label.slice(0, suffix.index).trim();
    const level = SUFFIX_LEVELS[suffix[1]!.toLowerCase().replace(/\s+/g, ' ')];
    if (base && level) {
      const nativeLevel = object(entry.providerMetadata).thinkingLevel ?? entry.thinkingLevel;
      const budget = object(entry.providerMetadata).thinkingBudget ?? entry.thinkingBudget;
      return { family: base.toLowerCase().replace(/\s+/g, '-'), label: base, level,
        ...(typeof nativeLevel === 'number' ? { nativeLevel } : {}),
        ...(typeof budget === 'number' ? { budget } : {}) };
    }
  }
  const native = object(entry.providerMetadata).thinkingLevel ?? entry.thinkingLevel;
  const levels: Record<number, string> = { 1: 'low', 2: 'medium', 3: 'high', 4: 'low', 5: 'xhigh', 6: 'max', 200: 'max' };
  if (typeof native === 'number' && levels[native]) return { family: key, label: string(row.label), level: levels[native]!, nativeLevel: native };
  return undefined;
}

function matches(entry: JsonObject, definition: Member): boolean {
  const details = { ...object(entry.providerMetadata), ...entry };
  const label = string(entry.display_name) || string(entry.displayName);
  if (label && label !== definition.label && label.replace(/\s+\((?:Extra Low|Extra High|Low|Medium|High|Xhigh|Max|Thinking)\)$/, '') !== definition.label) return false;
  if (details.supportsThinking === false) return false;
  const provider = string(details.modelProvider);
  if (provider && (definition.family.startsWith('claude-') ? provider !== 'MODEL_PROVIDER_ANTHROPIC'
    : definition.family.startsWith('gpt-') ? provider !== 'MODEL_PROVIDER_OPENAI' : provider !== 'MODEL_PROVIDER_GOOGLE')) return false;
  // A declared native level takes precedence over the legacy budget form.
  if (details.thinkingLevel !== undefined) return definition.nativeLevel !== undefined && details.thinkingLevel === definition.nativeLevel;
  return definition.budget !== undefined && details.thinkingBudget === definition.budget;
}

/** A validated concrete model supplies its effective native thinking selection. */
export function antigravityModelThinkingLevel(entry: JsonObject): string | undefined {
  const definition = member(string(entry.key), entry, { label: string(entry.display_name) || string(entry.displayName) || string(entry.key) });
  return definition && matches(entry, definition) ? definition.level : undefined;
}

/** The conversation catalog groups known variants without changing wire IDs. */
export function antigravityModelOptions(entries: JsonObject[], options: JsonObject[]): JsonObject[] {
  const byValue = new Map(options.map(row => [string(row.value), row]));
  const families = new Map<string, { definition: Member; members: AntigravityModelVariant[]; rows: JsonObject[] }>();
  const order: Array<{ family: string } | { row: JsonObject }> = [];
  for (const entry of entries) {
    const key = string(entry.key), row = byValue.get(`antigravity:${key}`);
    if (!row) continue;
    if (entry.purpose !== undefined && entry.purpose !== 'chat') continue;
    const definition = member(key, entry, row);
    if (!definition || !matches(entry, definition)) { order.push({ row }); continue; }
    let family = families.get(definition.family);
    if (!family) { family = { definition, members: [], rows: [] }; families.set(definition.family, family); order.push({ family: definition.family }); }
    const variant: AntigravityModelVariant = { value: string(row.value), thinkingLevel: definition.level, available: row.available !== false,
      ...(entry.isDefault === true ? { isDefault: true } : {}),
      ...(typeof row.reason === 'string' ? { reason: row.reason } : {}),
      ...(Array.isArray(row.mediaInputMimeTypes) ? { mediaInputMimeTypes: row.mediaInputMimeTypes.filter((value): value is string => typeof value === 'string') } : {}),
      ...(typeof entry.contextWindow === 'number' ? { contextTokens: entry.contextWindow } : {}) };
    family.members.push(variant); family.rows.push(row);
  }
  return order.map(item => {
    if ('row' in item) return item.row;
    const family = families.get(item.family)!;
    // A lone declared variant is the model itself; keep its service label.
    if (family.members.length === 1 && !family.definition.toggle) return family.rows[0]!;
    const representative = family.members.find(variant => variant.isDefault && variant.available)
      ?? family.members.find(variant => variant.available) ?? family.members[0]!;
    const row = family.rows.find(row => row.value === representative.value)!;
    const grouped: JsonObject = { ...row, label: family.definition.label,
      ...(row.description === row.label ? { description: family.definition.label } : {}),
      antigravityFamilyId: item.family, antigravityVariants: family.members as unknown as JsonObject[],
      ...(family.definition.toggle ? { antigravityThinkingToggle: true } : {}),
      ...(family.rows.some(member => member.inRecommendedSort === true) ? { inRecommendedSort: true } : {}) };
    return antigravityModelOptionForValue(grouped, representative.value)!;
  });
}
