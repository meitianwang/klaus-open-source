import { expect, test } from 'bun:test'
import type { EffectiveMediaModelCatalog } from '../../../../contracts/effective-media-models'
import { effectiveMediaModeItems, effectiveMediaModelItems, effectiveMediaModelStaticText, hasMultipleMediaModels } from './effective-media-models'

const catalog: EffectiveMediaModelCatalog = { ok: true, selection: 'qwenwork', current: { source: 'qwenwork', modelId: 'video-one' }, currentBySource: { qwenwork: { source: 'qwenwork', modelId: 'video-one' }, workbuddy: { source: 'workbuddy', modelId: 'video-one' }, none: { source: 'none', modelId: '' } }, options: [
  { source: 'qwenwork', modelId: 'video-one', available: true }, { source: 'qwenwork', modelId: 'video-two', available: true },
  { source: 'workbuddy', modelId: 'video-one', available: true }, { source: 'none', modelId: '', available: true },
] }

test('mode selection stays separate from concrete models and does not duplicate modes', () => {
  expect(effectiveMediaModeItems(catalog, source => source)).toEqual([
    { value: 'qwenwork', label: 'qwenwork' }, { value: 'workbuddy', label: 'workbuddy' }, { value: 'none', label: 'none' },
  ])
  const qwenwork = catalog.options.filter(option => option.source === 'qwenwork')
  expect(hasMultipleMediaModels(qwenwork)).toBe(true)
  expect(effectiveMediaModelItems(qwenwork, 'Service default', 'Unavailable').map(item => item.value)).toEqual(['video-one', 'video-two'])
  expect(hasMultipleMediaModels(catalog.options.filter(option => option.source === 'workbuddy'))).toBe(false)
})

test('saved unavailable models remain visible and can be replaced through the second selector', () => {
  const options = [{ source: 'qwenwork', modelId: 'saved-model', available: false }, { source: 'qwenwork', modelId: 'ready-model', available: true }]
  expect(hasMultipleMediaModels(options)).toBe(true)
  expect(effectiveMediaModelItems(options, 'Service default', 'Unavailable')).toEqual([
    { value: 'saved-model', label: 'saved-model (Unavailable)', disabled: true },
    { value: 'ready-model', label: 'ready-model', disabled: false },
  ])
})

test('single-model and service-managed modes do not offer a model choice', () => {
  expect(hasMultipleMediaModels([{ source: 'qwenwork', modelId: 'music-one', available: true }])).toBe(false)
  expect(hasMultipleMediaModels([{ source: 'cursor', modelId: '', available: true }])).toBe(false)
  expect(hasMultipleMediaModels([{ source: 'qwenwork', modelId: 'music-one', available: false }])).toBe(false)
  expect(hasMultipleMediaModels([{ source: 'qwenwork', modelId: 'music-one', available: true }, { source: 'qwenwork', modelId: 'music-one', available: true }])).toBe(false)
  expect(effectiveMediaModelItems([{ source: 'qwenwork', modelId: 'music-one', available: true }], 'Service default', 'Unavailable')).toEqual([
    { value: 'music-one', label: 'music-one', disabled: false },
  ])
  expect(effectiveMediaModelItems([{ source: 'cursor', modelId: '', available: true, selectable: true }], 'Service default', 'Unavailable')).toEqual([
    { value: '', label: 'Service default', disabled: false },
  ])
  const futureMusic = [{ source: 'qwenwork', modelId: 'music-one', available: true }, { source: 'qwenwork', modelId: 'music-two', available: true }]
  expect(hasMultipleMediaModels(futureMusic)).toBe(true)
  expect(effectiveMediaModelItems(futureMusic, 'Service default', 'Unavailable')).toEqual([
    { value: 'music-one', label: 'music-one', disabled: false }, { value: 'music-two', label: 'music-two', disabled: false },
  ])
})

test('verified music modes remain visible and selectable before account connection', () => {
  const none = { source: 'none', modelId: '' }
  const music = { source: 'qwenwork', modelId: 'minimax-music-2.5' }
  const options = [{ ...none, available: true, selectable: true, connected: true }, { ...music, available: false, selectable: true, connected: false }]
  expect(effectiveMediaModeItems({ ok: true, selection: 'none', current: none, currentBySource: { none, qwenwork: music }, options }, source => source)).toEqual([
    { value: 'none', label: 'none' }, { value: 'qwenwork', label: 'qwenwork' },
  ])
  expect(effectiveMediaModelItems([options[1]!], 'Service default', 'Unavailable')).toEqual([
    { value: 'minimax-music-2.5', label: 'minimax-music-2.5', disabled: false },
  ])
  expect(effectiveMediaModeItems({ ...catalog, options: [{ ...music, available: false }] }, source => source)).toEqual([{ value: 'qwenwork', label: 'qwenwork' }])
})

test('function layout includes unselected and disconnected multi-model modes', () => {
  const options = catalog.options.map(option => ({ ...option, available: option.source === 'workbuddy' }))
  const selected = options.filter(option => option.source === 'workbuddy')
  expect(hasMultipleMediaModels(selected)).toBe(false)
  expect(hasMultipleMediaModels(options)).toBe(true)
  expect(hasMultipleMediaModels(options.filter(option => option.source !== 'none'))).toBe(true)
})

test('different single-model modes do not imply a model choice within a mode', () => {
  expect(hasMultipleMediaModels([
    { source: 'none', modelId: '', available: true },
    { source: 'qwenwork', modelId: 'music-one', available: true },
    { source: 'managed', modelId: '', available: false },
  ])).toBe(false)
})


test('Antigravity account image models use the central mode and concrete model selectors', () => {
  const options = [{ source: 'antigravity', modelId: 'image-one', label: 'Image One', available: true }, { source: 'antigravity', modelId: 'saved-image', available: false }]
  const current = { source: 'antigravity', modelId: 'saved-image' }
  const imageCatalog = { ok: true, selection: 'antigravity', current, currentBySource: { antigravity: current }, options }
  expect(effectiveMediaModeItems(imageCatalog, source => source)).toEqual([{ value: 'antigravity', label: 'antigravity' }])
  expect(hasMultipleMediaModels(options)).toBe(true)
  expect(effectiveMediaModelItems(options, 'Service default', 'Unavailable')).toEqual([
    { value: 'image-one', label: 'Image One', disabled: false },
    { value: 'saved-image', label: 'saved-image (Unavailable)', disabled: true },
  ])
})

test('sources without a model choice state their effective model', () => {
  expect(effectiveMediaModelStaticText('cursor', [{ source: 'cursor', modelId: '', available: true }], '', 'Service default', 'Disabled')).toBe('Service default')
  const single = [{ source: 'codex', modelId: 'gpt-image-2', label: 'gpt-image-2', available: true }]
  expect(effectiveMediaModelStaticText('codex', single, 'gpt-image-2', 'Service default', 'Disabled')).toBe('gpt-image-2')
  const labeled = [{ source: 'workbuddy', modelId: 'tts-one', label: 'TTS One', available: true }]
  expect(effectiveMediaModelStaticText('workbuddy', labeled, 'tts-one', 'Service default', 'Disabled')).toBe('TTS One')
  const savedMissing = [{ source: 'codex', modelId: 'retired', available: false }]
  expect(effectiveMediaModelStaticText('codex', savedMissing, 'retired', 'Service default', 'Disabled')).toBe('retired')
  expect(effectiveMediaModelStaticText('none', single, '', 'Service default', 'Disabled')).toBe('Disabled')
})
