import type { ModelTierReference } from '../../../bridge/types'
import { modelOptionForValue } from '../../../../shared/cursor-model-catalog'

// One row per auxiliary task that can ride its own model. The slot names match
// the host storage keys (feature_models.<slot>); the field names match the
// settings bridge reply. Rows shown inline on feature pages are exposed
// separately so the provider page keeps only the capabilities it owns.
export const PREDICTION_FEATURE_MODEL_ROW = {
  slot: 'prediction',
  field: 'prediction',
  labelKey: 'feature_model_prediction',
} as const

export const TITLE_FEATURE_MODEL_ROW = {
  slot: 'title',
  field: 'title',
  labelKey: 'feature_model_title',
} as const

export const MEMORY_FEATURE_MODEL_ROW = {
  slot: 'memory',
  field: 'memory',
  labelKey: 'feature_model_memory',
} as const

export const VOICE_REFINEMENT_FEATURE_MODEL_ROW = {
  slot: 'voice_refinement',
  field: 'voiceRefinement',
  labelKey: 'feature_model_voice_refinement',
} as const

export const FEATURE_MODEL_ROWS = [TITLE_FEATURE_MODEL_ROW] as const

export const ALL_FEATURE_MODEL_ROWS = [
  TITLE_FEATURE_MODEL_ROW,
  PREDICTION_FEATURE_MODEL_ROW,
  MEMORY_FEATURE_MODEL_ROW,
  VOICE_REFINEMENT_FEATURE_MODEL_ROW,
] as const

export type FeatureModelRow = (typeof ALL_FEATURE_MODEL_ROWS)[number]
export type FeatureModelSlot = FeatureModelRow['slot']
export type FeatureModelField = FeatureModelRow['field']
export type FeatureModelValues = Record<FeatureModelField, string>

export const EMPTY_FEATURE_MODEL_VALUES: FeatureModelValues = { title: '', prediction: '', memory: '', voiceRefinement: '' }

/** Parse a stored "source:modelId" pick; anything else means "follow the chat model". */
export function parseFeatureModelReference(stored: string): ModelTierReference | null {
  const separator = stored.indexOf(':')
  if (separator < 1) return null
  return { source: stored.slice(0, separator), modelId: stored.slice(separator + 1) }
}

/** A catalog row list contains the stored model when any single row matches its id. */
export function featureModelInCatalog(options: readonly unknown[], modelId: string): boolean {
  return modelOptionForValue(options, modelId) !== undefined
}

/** A row saves one qualified reference; either half missing clears the slot. */
export function composeFeatureModelValue(source: string, modelId: string): string {
  return source && modelId ? `${source}:${modelId}` : ''
}

/** Coerce a settings reply into the four stored strings. */
export function normalizedFeatureModelValues(settings: unknown): FeatureModelValues {
  const raw = (settings && typeof settings === 'object' ? settings : {}) as Record<string, unknown>
  const values: FeatureModelValues = { ...EMPTY_FEATURE_MODEL_VALUES }
  for (const row of ALL_FEATURE_MODEL_ROWS) {
    if (typeof raw[row.field] === 'string') values[row.field] = raw[row.field] as string
  }
  return values
}

/** The source a row shows: a fresh local choice while it is known, else the stored reference, else follow-main. */
export function effectiveRowSource(stored: string, choice: string | undefined, knownSources: readonly string[]): string {
  if (choice !== undefined && (choice === '' || knownSources.includes(choice))) return choice
  return parseFeatureModelReference(stored)?.source ?? ''
}
