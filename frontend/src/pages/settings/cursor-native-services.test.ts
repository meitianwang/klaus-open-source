import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import vectors from '../../../../contracts/vectors/cursor-native-service-ui-vectors.json'
import { SUBSCRIPTION_WEB_SEARCH_SOURCES, WEB_SEARCH_SOURCES, resolveWebSearchSettings } from '../../../../contracts/web-search-settings'
import { AUDIO_GENERATION_SOURCES, IMAGE_GENERATION_SOURCES, VIDEO_GENERATION_SOURCES, generationSourceItems, videoGenerationSourceItems } from './generation-sources'
import { sourceLabel } from './model-shared'
import { activateSubscriptionMode, SubscriptionCardBody } from './subscription-card'
import { I18N } from '../../i18n/messages'

const sources = { image: IMAGE_GENERATION_SOURCES, audio: AUDIO_GENERATION_SOURCES }

describe('Cursor native services in existing settings', () => {
  for (const row of vectors.cases) test(row.name, () => {
    const items = generationSourceItems(sources[row.kind as keyof typeof sources], row.availability as Record<string, boolean>, row.selection, source => sourceLabel(source, key => I18N.en[key]))
    expect(items.some(item => item.value === 'cursor')).toBe(row.cursorVisible)
    expect(items.find(item => item.value === row.selection)?.label).toBe(row.selection === 'cursor' ? 'Cursor' : I18N.en.sub_custom_mode_btn)
    if (row.cursorVisible) expect(items.find(item => item.value === 'cursor')?.label).toBe('Cursor')
  })

  test('account configuration tabs retain Cursor while disconnected and do not create another backend', () => {
    expect(generationSourceItems(AUDIO_GENERATION_SOURCES, {}, 'cursor', source => source).map(item => item.value)).toContain('cursor')
    expect(generationSourceItems(IMAGE_GENERATION_SOURCES, { cursor: false, custom: true }, 'cursor', source => source).map(item => item.value)).toContain('cursor')
    expect(generationSourceItems(IMAGE_GENERATION_SOURCES, { cursor: false }, 'cursor', source => source)[1]?.value).toBe('cursor')
    expect(generationSourceItems(IMAGE_GENERATION_SOURCES, { cursor: false }, 'custom', source => source, ['cursor']).map(item => item.value)).toContain('cursor')
  })

  test('the shared search source catalog preserves an explicit Cursor source', () => {
    expect(WEB_SEARCH_SOURCES).toContain('cursor')
    expect(SUBSCRIPTION_WEB_SEARCH_SOURCES).toContain('cursor')
    expect(resolveWebSearchSettings({ source: 'cursor', enabled: true })).toEqual({ source: 'cursor', enabled: true, mode: 'client' })
    for (const language of ['en', 'zh'] as const) {
      expect(I18N[language].klaus_websearch_source_cursor).toBe('Cursor')
      expect(I18N[language].klaus_websearch_source_cursor_desc).toBeTypeOf('string')
    }
  })

  for (const language of ['en', 'zh'] as const) test(`connected native service cards only offer sign-out without endpoint or model inputs in ${language}`, async () => {
    const target = globalThis as any
    const previous = target.window
    const changes: unknown[] = []
    target.window = { currentLang: language, dispatchEvent: () => true, klaus: { session: { setMainModel: async (...args: unknown[]) => { changes.push(args) } } } }
    try {
      await activateSubscriptionMode('cursor', () => {}, 'service-settings', { activateModel: false })
      expect(changes).toEqual([])
      const html = renderToStaticMarkup(createElement(SubscriptionCardBody, { mode: 'cursor', reloadSeq: 0, reload: () => {} }))
      for (const action of vectors.connectedAccountActions) expect(html).toContain(`cursor-auth-${action}-btn`)
      expect(html).not.toContain('cursor-auth-login-btn')
      expect(html).not.toContain('cursor-auth-import-btn')
      expect(html.match(/<button\b/g)).toHaveLength(vectors.connectedAccountActions.length)
      expect(html).not.toContain('<input')
      expect(html).not.toContain('<select')
      expect(html).not.toContain('title=')
    } finally { target.window = previous }
  })
})


test('a stale saved Cursor video choice does not add an unlisted source', () => {
  expect(VIDEO_GENERATION_SOURCES).not.toContain('cursor')
  expect(videoGenerationSourceItems({ cursor: true, minimax: true }, 'cursor', source => source).map(item => item.value)).toEqual(['minimax', 'workbuddy', 'qwenwork', 'trae'])
})
