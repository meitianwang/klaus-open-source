import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import vector from '../../../../contracts/vectors/voice-input-source-vectors.json'
import { I18N } from '../../i18n/messages'
import { VoiceInputSourceRow, voiceSourceItems } from './voice-source-settings'
import { filterNavEntries, NAV_ENTRIES } from './settings-nav-entries'
import { PREFERENCES } from '../../../../main/services/klaus-control/preferences'

const renderRow = (source: string, availability: Record<string, boolean> = {}) => renderToStaticMarkup(createElement(VoiceInputSourceRow, {
  source, availability, disabled: false, onChange: () => {},
}))

describe('voice input source row', () => {
  for (const language of ['en', 'zh'] as const) test(`source row uses one dropdown and shared provider credentials in ${language}`, () => {
    const target = globalThis as any, previous = target.window
    target.window = { currentLang: language }
    try {
      const html = renderRow('system')
      const items = voiceSourceItems('system', {}, key => I18N[language][key])
      expect(items.map(item => item.value)).toEqual(vector.sources)
      expect(html).toContain(`id="${vector.settingsUi.name}"`)
      expect(html).toContain(I18N[language].model_tiers_source)
      expect(html).toContain('data-capability-voice-source')
      expect(html).not.toContain(language === 'zh' ? '语音识别' : 'Speech recognition')
      expect(html).not.toContain('role="tab"')
      expect(html).not.toContain('auth-login-btn')
      expect(html).not.toContain('auth-logout-btn')
      for (const source of vector.sources) expect(items.find(item => item.value === source)?.label).toBe(I18N[language][`voice_source_${source}`])
    } finally { target.window = previous }
  })

  test('unavailable choices stay hidden unless saved, and saved choices remain explicit', () => {
    const items = voiceSourceItems('workbuddy', { workbuddy: false, antigravity: false }, key => key)
    expect(items).toContainEqual({ value: 'workbuddy', label: 'voice_source_workbuddy', disabled: true })
    expect(items.some(item => item.value === 'antigravity')).toBe(false)
    expect(voiceSourceItems('retired', {}, key => key).at(-1)?.value).toBe('retired')
  })

  test('the retired custom transcription route is no longer offered while a saved choice stays visible', () => {
    expect(voiceSourceItems('system', {}, key => key).some(item => item.value === 'custom')).toBe(false)
    expect(voiceSourceItems('codex', {}, key => key).some(item => item.value === 'custom')).toBe(false)
    expect(voiceSourceItems('custom', {}, key => key).at(-1)).toEqual({ value: 'custom', label: 'voice_source_custom', disabled: false })
  })

  test('source cards omit explanatory and passive availability paragraphs', () => {
    const target = globalThis as any, previous = target.window
    target.window = { currentLang: 'en' }
    try {
      for (const source of ['', 'system', 'custom', 'codex', 'retired', 'workbuddy']) {
        expect(renderRow(source, { workbuddy: false })).not.toContain('<p')
      }
    } finally { target.window = previous }
  })

  for (const language of ['en', 'zh'] as const) test(`provider navigation remains searchable by the previous model name and capability names in ${language}`, () => {
    const provider = NAV_ENTRIES.find(entry => entry.stab === 'models')!
    const label = (key: string) => I18N[language][key]
    expect(label(provider.i18n)).toBe(language === 'en' ? 'Model Sources' : '模型来源')
    for (const key of ['models', 'model_defaults_tab', 'voice_engine_label']) expect(filterNavEntries(NAV_ENTRIES, label(key), label)).toContain(provider)
    expect(NAV_ENTRIES.some(entry => entry.stab === 'voiceInput')).toBe(true)
    expect(PREFERENCES.find(pref => pref.name === 'voiceInputSource')?.place).toBe(vector.settingsUi.page)
    expect(PREFERENCES.some(pref => pref.name === 'voiceLanguage')).toBe(false)
    expect(PREFERENCES.some(pref => pref.name === 'voiceInputExperience')).toBe(false)
    expect(vector.settingsUi.recognitionModeControl).toBe(false)
    expect(vector.settingsUi.currentRecognizerVisible).toBe(false)
    expect(PREFERENCES.some(pref => pref.name === 'voiceRealtimePolish' || pref.name === 'voicePolish')).toBe(false)
    expect(PREFERENCES.find(pref => pref.name === 'voiceLearning')?.place).toBe('voiceInput')
    expect(vector.voicePreferences.memoryList).toBe(false)
  })
})
