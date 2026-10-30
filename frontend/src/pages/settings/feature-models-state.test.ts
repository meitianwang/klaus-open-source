import { describe, expect, test } from 'bun:test'
import {
  EMPTY_FEATURE_MODEL_VALUES, FEATURE_MODEL_ROWS, MEMORY_FEATURE_MODEL_ROW, PREDICTION_FEATURE_MODEL_ROW,
  VOICE_REFINEMENT_FEATURE_MODEL_ROW, composeFeatureModelValue, effectiveRowSource, featureModelInCatalog,
  normalizedFeatureModelValues, parseFeatureModelReference,
} from './feature-models-state'

describe('feature model row state', () => {
  test('provider-page rows keep only the capabilities it owns', () => {
    expect(FEATURE_MODEL_ROWS.map(row => row.slot)).toEqual(['title'])
    expect(FEATURE_MODEL_ROWS.map(row => row.field)).toEqual(['title'])
    expect(FEATURE_MODEL_ROWS.every(row => row.labelKey.startsWith('feature_model_'))).toBe(true)
  })

  test('rows moved to feature pages are exposed separately', () => {
    expect(PREDICTION_FEATURE_MODEL_ROW).toEqual({ slot: 'prediction', field: 'prediction', labelKey: 'feature_model_prediction' })
    expect(MEMORY_FEATURE_MODEL_ROW).toEqual({ slot: 'memory', field: 'memory', labelKey: 'feature_model_memory' })
    expect(VOICE_REFINEMENT_FEATURE_MODEL_ROW).toEqual({ slot: 'voice_refinement', field: 'voiceRefinement', labelKey: 'feature_model_voice_refinement' })
  })

  test('a stored pick parses at the first colon and anything else means follow-main', () => {
    expect(parseFeatureModelReference('codex:gpt-5')).toEqual({ source: 'codex', modelId: 'gpt-5' })
    expect(parseFeatureModelReference('custom:provider:model')).toEqual({ source: 'custom', modelId: 'provider:model' })
    expect(parseFeatureModelReference('')).toBeNull()
    expect(parseFeatureModelReference('opus')).toBeNull()
    expect(parseFeatureModelReference(':model')).toBeNull()
  })

  test('a value composes only from both halves', () => {
    expect(composeFeatureModelValue('codex', 'gpt-5')).toBe('codex:gpt-5')
    expect(composeFeatureModelValue('', 'gpt-5')).toBe('')
    expect(composeFeatureModelValue('codex', '')).toBe('')
  })

  test('replies normalize to four strings', () => {
    expect(normalizedFeatureModelValues(undefined)).toEqual(EMPTY_FEATURE_MODEL_VALUES)
    expect(normalizedFeatureModelValues({ title: 'codex:gpt-5', memory: 42 })).toEqual({ title: 'codex:gpt-5', prediction: '', memory: '', voiceRefinement: '' })
    expect(normalizedFeatureModelValues({ voiceRefinement: 'qoder:asr-polish', extra: 'x' })).toEqual({ title: '', prediction: '', memory: '', voiceRefinement: 'qoder:asr-polish' })
  })

  test('the shown source prefers a fresh local choice, then the stored pick, then follow-main', () => {
    expect(effectiveRowSource('', undefined, ['codex'])).toBe('')
    expect(effectiveRowSource('codex:gpt-5', undefined, ['codex'])).toBe('codex')
    expect(effectiveRowSource('codex:gpt-5', '', ['codex'])).toBe('')
    expect(effectiveRowSource('codex:gpt-5', 'qoder', ['codex', 'qoder'])).toBe('qoder')
    expect(effectiveRowSource('codex:gpt-5', 'retired', ['codex'])).toBe('codex')
  })

  test('a stored model is matched against each catalog row, including custom provider ids', () => {
    const options = [{ modelId: 'f51ffcb9-fca4-4b5f-a978-943fa0c5a72f', label: 'qwen3.8-max' }]
    expect(featureModelInCatalog(options, 'f51ffcb9-fca4-4b5f-a978-943fa0c5a72f')).toBe(true)
    expect(featureModelInCatalog(options, 'removed-model')).toBe(false)
  })
})
