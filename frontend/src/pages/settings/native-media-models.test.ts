import { expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { providerCapabilities } from '../../../../contracts/provider-capabilities'
import { WEB_FETCH_SOURCES, WEB_SEARCH_SOURCES, resolveWebSearchSettings } from '../../../../contracts/web-search-settings'
import { SubscriptionCardBody } from './subscription-card'
import { AUTH_MODE_ORDER } from './model-shared'
import { AUDIO_GENERATION_SOURCES, MUSIC_GENERATION_SOURCES, audioGenerationSourceItems, IMAGE_GENERATION_SOURCES, VIDEO_GENERATION_SOURCES, generationSourceItems } from './generation-sources'
import { nativeMediaModelOptions } from './native-media-models'

test('native model metadata contains only bounded concrete account rows', () => {
  const value = providerCapabilities({ image: { available: true, defaultModel: 'valid', models: [
    { id: 'auto', label: 'Auto' }, { id: 'valid', label: 'Actual model' }, { id: 'valid', label: 'Duplicate' },
    { id: 'invalid\0id', label: 'Invalid' }, { id: 'oversized', label: 'x'.repeat(513) },
  ], reason: 'private-internal-value' } })
  expect(value.image).toEqual({ available: true, models: [{ id: 'valid', label: 'Actual model' }], defaultModel: 'valid' })
  expect(value.audio).toEqual({ available: false })
  expect(JSON.stringify(value)).not.toContain('private-internal-value')
})

test('native model menus retain saved unavailable identities without selecting a replacement', () => {
  const capability = { available: true, models: [{ id: 'available', label: 'Available' }], defaultModel: 'available' }
  expect(nativeMediaModelOptions(capability, 'saved')).toEqual([
    { id: 'saved', label: 'saved', unavailable: true }, { id: 'available', label: 'Available' },
  ])
  expect(nativeMediaModelOptions(capability, '')).toEqual(capability.models)
  expect(nativeMediaModelOptions({ available: false }, 'saved')).toEqual([{ id: 'saved', label: 'saved', unavailable: true }])
})

test('native generation sources retain a disconnected explicit WorkBuddy backend', () => {
  for (const sources of [IMAGE_GENERATION_SOURCES, VIDEO_GENERATION_SOURCES, AUDIO_GENERATION_SOURCES]) {
    expect(sources as readonly string[]).toContain('workbuddy')
    expect(generationSourceItems(sources, { workbuddy: false, custom: true }, 'workbuddy', value => value).some(row => row.value === 'workbuddy')).toBe(true)
  }
  expect(WEB_SEARCH_SOURCES).toContain('workbuddy')
  expect(resolveWebSearchSettings({ source: 'workbuddy', enabled: false })).toEqual({ source: 'workbuddy', enabled: false, mode: 'off' })
})

test('provider account sections contain no effective model selectors or custom credentials', () => {
  ;(globalThis as any).window = { currentLang: 'en', settingsApi: {}, klsLoading: { render: () => '<span data-account-loading>Loading</span>' } }
  try {
    for (const source of ['workbuddy', 'qwenwork']) {
      const html = renderToStaticMarkup(createElement(SubscriptionCardBody, { mode: source, reloadSeq: 0, reload: () => {} }))
      expect(html).toMatch(/data-account-loading|class="settings-card"/)
      expect(html).not.toContain('type="password"')
      expect(html).not.toContain('ig-base-url')
      expect(html).not.toContain('data-native-media-models')
    }
  } finally { delete (globalThis as any).window }
})


test('QwenWork creative model rows remain concrete and fetch has a separate supported-source contract', () => {
  const capabilities = providerCapabilities({ music: { available: true, models: ['minimax-music-2.5', 'auto'], defaultModel: 'minimax-music-2.5' }, fetch: { available: false } })
  expect(capabilities.music.models).toEqual([{ id: 'minimax-music-2.5', label: 'minimax-music-2.5' }])
  expect(capabilities.music.defaultModel).toBe('minimax-music-2.5')
  expect(capabilities.fetch.available).toBe(false)
  expect(WEB_SEARCH_SOURCES).toContain('qwenwork')
  expect(WEB_FETCH_SOURCES).toEqual(['builtin'])
  for (const sources of [IMAGE_GENERATION_SOURCES, VIDEO_GENERATION_SOURCES]) {
    expect(generationSourceItems(sources, { qwenwork: false, custom: true }, 'qwenwork', value => value).some(row => row.value === 'qwenwork')).toBe(true)
  }
})


test('speech sources exclude music even when a legacy music choice is retained', () => {
  expect(AUDIO_GENERATION_SOURCES as readonly string[]).not.toContain('qwenwork')
  expect(MUSIC_GENERATION_SOURCES).toEqual(['qwenwork'])
  const items = audioGenerationSourceItems({ qwenwork: true }, 'qwenwork', value => value)
  expect(items.some(item => item.value === 'qwenwork')).toBe(false)
  expect(items.some(item => item.value === 'none')).toBe(true)
})


test('the shared provider catalog retains media subscriptions before connecting an account', () => {
  const previous = (globalThis as any).window
  ;(globalThis as any).window = { currentLang: 'en' }
  try {
    for (const source of IMAGE_GENERATION_SOURCES) expect(AUTH_MODE_ORDER).toContain(source)
  } finally { (globalThis as any).window = previous }
})


test('Antigravity image selection excludes unsupported output kinds', () => {
  expect(IMAGE_GENERATION_SOURCES as readonly string[]).toContain('antigravity')
  for (const sources of [VIDEO_GENERATION_SOURCES, AUDIO_GENERATION_SOURCES, MUSIC_GENERATION_SOURCES]) expect(sources as readonly string[]).not.toContain('antigravity')
  expect(generationSourceItems(IMAGE_GENERATION_SOURCES, { antigravity: false }, 'antigravity', value => value).some(row => row.value === 'antigravity')).toBe(true)
})
