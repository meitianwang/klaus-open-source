import { describe, expect, test } from 'bun:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { I18N } from '../../i18n/messages'
import selectionVectors from '../../../../contracts/vectors/model-selection-display-vectors.json'
import fastModeVectors from '../../../../contracts/vectors/codex-fast-mode-vectors.json'
import antigravityVectors from '../../../../contracts/vectors/antigravity-model-variants.json'
import cursorVectors from '../../../../contracts/vectors/cursor-grouped-parameters-vectors.json'
import catalogVectors from '../../../../contracts/vectors/model-catalog-selection-vectors.json'
import { cursorFastMode, cursorVariantForFast, cursorVariantForThinking, modelOptionForValue, modelOptionIsAntigravity, modelOptionIsSelectable, type CursorModelMetadata } from '../../../../shared/cursor-model-catalog'
import { createThinkingSelection, createUltraSelection } from './ultra-selection'
import type { MainModelItem } from './model-select'

// The icon registry and the i18n store both touch `window` at module load. Test
// files that run earlier in the same invocation replace that global with a
// partial stand-in of their own, and some leave a window without the event API
// behind — this file's import chain then died at load with
// "window.addEventListener is not a function" whenever no complete shim happened
// to load first in that scope, and with no shim at all it died on the icon
// registry. Merging the missing event API into whatever window already exists
// (rather than replacing it) keeps fields earlier files installed, and the
// dynamic imports below guarantee the shim runs before the import chain; the
// same shim-then-import shape is what the queue row tests use for the same
// reason.
const shimWindow = (() => {
  const existing = (globalThis as Record<string, unknown>).window
  const target = (existing && typeof existing === 'object' ? existing : {}) as Record<string, unknown>
  if (typeof target.addEventListener !== 'function') target.addEventListener = () => {}
  if (typeof target.removeEventListener !== 'function') target.removeEventListener = () => {}
  ;(globalThis as Record<string, unknown>).window = target
  return target
})()
void shimWindow

const { Icon } = await import('../../components/Icon')
const {
  catalogNeedsLoading,
  concreteMainModelItems,
  hasConfiguredMainModel,
  isMainModelValue,
  mainModelItemLabel,
  mainModelItemDisabled,
  mainModelItemNote,
  mainModelMenuValue,
  mainModelSelectionLabel,
  mainModelThinkingPresentation,
  mainModelThinkingLevels,
  modelSelectSessionId,
  modelSelectSubmenuVisible,
  modelSelectTriggerAction,
  priceFactorLabel,
  modelUpdateFailureText,
  modelUpdateAnnounceable,
  preferenceSaveFailureText,
  FastModeToggle,
  fastModeIconName,
} = await import('./model-select')

const configuredItems = [{ value: 'custom:model-1', label: 'Model 1' }]

const qoderLabels = [
  ['qoder:ultimate', 'Ultimate', '旗舰'],
  ['qoder:performance', 'Performance', '性能'],
  ['qoder:fast', 'Fast', '快速'],
  ['qoder:efficient', 'Efficient', '高效'],
  ['qoder:lite', 'Lite', '轻量'],
] as const

const translate = (language: 'en' | 'zh') => (key: string) => I18N[language][key] || ''

describe('Codex Fast mode entry', () => {
  for (const row of fastModeVectors.cases) {
    test(row.name, () => {
      const html = renderToStaticMarkup(createElement(FastModeToggle, {
        supported: row.visible, enabled: row.enabled, onChange: () => {}, translate: translate('zh'),
      }))
      if (!row.visible) {
        expect(html).toBe('')
        return
      }
      expect(html).toContain('role="switch"')
      expect(html).toContain(`aria-checked="${row.effective}"`)
      expect(html).toContain('快速模式')
      expect(html).toContain('响应更快，用量更高')
      expect(html).not.toContain('title=')
      const iconName = fastModeIconName(row.effective)
      expect(iconName).toBe(row.indicatorIcon)
      expect(html).toContain(renderToStaticMarkup(createElement(Icon, { name: iconName, size: 16 })))
    })
  }

  test('localizes the control and hides an unresolved Codex selection', () => {
    const props = { supported: true, enabled: true, onChange: () => {}, translate: translate('en') }
    expect(renderToStaticMarkup(createElement(FastModeToggle, props))).toContain('Faster responses, higher usage')
    expect(renderToStaticMarkup(createElement(FastModeToggle, { ...props, supported: false }))).toBe('')
    expect(renderToStaticMarkup(createElement(FastModeToggle, { ...props, supported: undefined }))).toBe('')
  })
})

describe('engine resolved model display', () => {
  for (const row of selectionVectors.cases) {
    test(row.name, () => {
      const value = mainModelMenuValue(row.items, row.resolvedMode)
      expect(value).toBe(row.selectedValue)
      expect(mainModelSelectionLabel(row.items, value, translate('en'))).toBe(row.label)
    })
  }

  test('does not treat an unscoped auto marker as a visible model', () => {
    expect(mainModelMenuValue([{ value: 'auto' }], 'auto')).toBe('')
  })

  test('localizes the unavailable selection without marking a configured model', () => {
    expect(mainModelSelectionLabel(configuredItems, '', translate('zh'))).toBe('模型不可用')
    expect(mainModelSelectionLabel([], '', translate('zh'))).toBe('未配置模型')
  })

  test('does not report missing configuration when the catalog read failed', () => {
    expect(mainModelSelectionLabel([], '', translate('en'), true)).toBe('Model unavailable')
    expect(mainModelSelectionLabel([], '', translate('zh'), true)).toBe('模型不可用')
  })
})

describe('model selector trigger', () => {
  test('targets only the active session and leaves a new-chat pick unscoped', () => {
    expect(modelSelectSessionId('session-1')).toBe('session-1')
    expect(modelSelectSessionId('  session-1  ')).toBe('session-1')
    expect(modelSelectSessionId(null)).toBeUndefined()
    expect(modelSelectSessionId('   ')).toBeUndefined()
  })

  test('rejects retired official and on-device model values', () => {
    expect(isMainModelValue('klaus:klaus-standard')).toBe(false)
    expect(isMainModelValue('local:installed')).toBe(false)
    expect(isMainModelValue('klaus:')).toBe(false)
    expect(isMainModelValue('local:')).toBe(false)
  })

  test('accepts scoped Qoder models and keeps the QwenWork catalog separate', () => {
    expect(isMainModelValue('qoder:qwork-auto')).toBe(true)
    expect(isMainModelValue('qwenwork:qwork-auto')).toBe(true)
    expect(isMainModelValue('qoder:')).toBe(false)
    expect(isMainModelValue('qoder')).toBe(false)
    const items = [
      { value: 'qwenwork:qwork-auto', label: 'QwenWork Auto' },
      { value: 'qoder:qwork-auto', label: 'Qoder Auto' },
    ]
    const selected = mainModelMenuValue(items, 'qoder:qwork-auto')
    expect(selected).toBe('qoder:qwork-auto')
    expect(mainModelSelectionLabel(items, selected, translate('zh'))).toBe('Qoder Auto')
  })

  test('routes an empty model list to configuration', () => {
    expect(hasConfiguredMainModel([])).toBe(false)
    expect(modelSelectTriggerAction([], false)).toBe('empty')
    expect(modelSelectTriggerAction([], true)).toBe('empty')
  })

  test('keeps normal menu behavior when a model exists', () => {
    expect(hasConfiguredMainModel(configuredItems)).toBe(true)
    expect(modelSelectTriggerAction(configuredItems, false)).toBe('open')
    expect(modelSelectTriggerAction(configuredItems, true)).toBe('close')
  })
})

describe('gateway credit multiplier', () => {
  test('prints one decimal at most for a positive multiplier', () => {
    expect(priceFactorLabel(1.6)).toBe('1.6')
    expect(priceFactorLabel(0.1)).toBe('0.1')
    expect(priceFactorLabel(2)).toBe('2')
    expect(priceFactorLabel(2.0)).toBe('2')
  })

  test('hides a missing, non-finite or non-positive multiplier', () => {
    expect(priceFactorLabel(undefined)).toBe('')
    expect(priceFactorLabel(Number.NaN)).toBe('')
    expect(priceFactorLabel(0)).toBe('')
    expect(priceFactorLabel(-1)).toBe('')
  })
})

describe('Qoder model labels', () => {
  for (const [value, english, chinese] of qoderLabels) {
    test(`localizes ${value} without changing its value`, () => {
      const item = { value, label: 'Server label' }

      expect(mainModelItemLabel(item, translate('en'))).toBe(english)
      expect(mainModelItemLabel(item, translate('zh'))).toBe(chinese)
      expect(item.value).toBe(value)
    })
  }

  test('keeps the server label for unknown Qoder models', () => {
    expect(mainModelItemLabel(
      { value: 'qoder:future-tier', label: 'Future Tier' },
      translate('zh'),
    )).toBe('Future Tier')
  })

  test('keeps the server label for non-Qoder models', () => {
    expect(mainModelItemLabel(
      { value: 'custom:model-1', label: 'Model 1' },
      translate('zh'),
    )).toBe('Model 1')
  })
})

describe('catalogNeedsLoading', () => {
  const rows = [{ value: 'custom:model-1', label: 'Model 1' }]

  test('shows loading with no cache for the source', () => {
    expect(catalogNeedsLoading('custom', null, null)).toBe(true)
    expect(catalogNeedsLoading('custom', 'qoder', rows)).toBe(true)
    expect(catalogNeedsLoading('custom', 'custom', [])).toBe(true)
  })

  test('keeps a cached catalog live while the refresh revalidates', () => {
    expect(catalogNeedsLoading('custom', 'custom', rows)).toBe(false)
  })

  test('shows loading when the draft has no model source', () => {
    expect(catalogNeedsLoading('', 'custom', rows)).toBe(true)
  })
})

describe('reasoning submenu visibility', () => {
  test('follows its anchor row inside the main panel', () => {
    // Both surfaces open and the anchor row on screen.
    expect(modelSelectSubmenuVisible(true, true, true)).toBe(true)
    // Closed panel, or a submenu nobody asked for: no anchor to hang off.
    expect(modelSelectSubmenuVisible(false, true, true)).toBe(false)
    expect(modelSelectSubmenuVisible(true, false, true)).toBe(false)
  })

  test('collapses when the anchor row is hidden', () => {
    // The row also hosts the local Ultra pick, so a narrow native ladder no
    // longer hides it; only the loading placeholder takes the anchor away, and
    // a submenu left open before that must go with it.
    expect(modelSelectSubmenuVisible(true, true, false)).toBe(false)
  })
})

describe('model failure notices are transient toast text', () => {

  test('a failed publication names the engine reason', () => {
    expect(modelUpdateFailureText({ error: 'unknown session: e40c' }, translate('zh')))
      .toBe('模型准备失败。 unknown session: e40c')
    expect(modelUpdateFailureText({ error: 'unknown session: e40c' }, translate('en')))
      .toBe('Model preparation failed. unknown session: e40c')
  })

  test('a failed publication without a reason asks for a reselection', () => {
    expect(modelUpdateFailureText({}, translate('zh'))).toBe('模型准备失败。 请重新选择模型重试。')
    expect(modelUpdateFailureText({ error: '   ' }, translate('zh'))).toBe('模型准备失败。 请重新选择模型重试。')
  })

  test('a sign-out failure stays out of the announcement surface', () => {
    expect(modelUpdateAnnounceable({ status: 'failed', quiet: true })).toBe(false)
    expect(modelUpdateAnnounceable({ status: 'failed' })).toBe(true)
    expect(modelUpdateAnnounceable({ status: 'preparing' })).toBe(false)
    expect(modelUpdateAnnounceable({ status: 'ready' })).toBe(false)
    expect(modelUpdateAnnounceable(null)).toBe(false)
  })

  test('a preference-write failure names the write error', () => {
    expect(preferenceSaveFailureText('write denied', translate('zh'))).toBe('模型偏好保存失败。 write denied')
    expect(preferenceSaveFailureText('', translate('zh'))).toBe('模型偏好保存失败。')
  })

  test('maps engine model-source sign-in and configuration verdicts to localized desktop copy without CLI commands', () => {
    expect(modelUpdateFailureText({ error: 'not signed in to a Qoder subscription — run `klaus login qoder`' }, translate('zh')))
      .toBe('模型准备失败。 尚未登录 Qoder，请先在「设置 → 模型来源」中登录。')
    expect(modelUpdateFailureText({ error: 'not signed in to a Qoder subscription — run `klaus login qoder`' }, translate('en')))
      .toBe('Model preparation failed. Not signed in to Qoder. Sign in in Settings → Model Sources first.')
    expect(modelUpdateFailureText({ error: 'not signed in to a Claude subscription — run `klaus login claude`' }, translate('zh')))
      .toBe('模型准备失败。 尚未登录 Claude Code，请先在「设置 → 模型来源」中登录。')
    expect(modelUpdateFailureText({ error: 'not signed in to a ChatGPT/Codex subscription (/tmp/auth.json is missing) — run `klaus login codex`' }, translate('zh')))
      .toBe('模型准备失败。 尚未登录 Codex，请先在「设置 → 模型来源」中登录。')
    expect(modelUpdateFailureText({ error: 'not signed in to a QwenWork subscription' }, translate('zh')))
      .toBe('模型准备失败。 尚未登录 千问办公，请先在「设置 → 模型来源」中登录。')
    expect(modelUpdateFailureText({ error: 'the Claude subscription credential has expired and cannot be renewed — run `klaus login claude`' }, translate('zh')))
      .toBe('模型准备失败。 Claude Code 登录已过期，请前往「设置 → 模型来源」重新登录。')
    expect(modelUpdateFailureText({ error: 'app-server rpc error -32000: antigravity_not_signed_in' }, translate('zh')))
      .toBe('模型准备失败。 Antigravity 未登录，请登录后重试。')
    expect(modelUpdateFailureText({ error: 'app-server rpc error -32602: cannot resolve model auto: no models are configured in [modelProviders]' }, translate('zh')))
      .toBe('模型准备失败。 自定义模式需要先在设置中添加一个含 API Key 的模型。')
  })
})


test('Cursor concrete variants retain their exact key and label without an Auto selection', () => {
  const items = [
    { value: 'cursor:grok-high-fast', label: 'Grok 4.7 High Fast' },
    { value: 'cursor:claude-medium', label: 'Claude Opus 5.5 Medium' },
  ]
  for (const item of items) {
    expect(isMainModelValue(item.value)).toBe(true)
    expect(mainModelMenuValue(items, item.value)).toBe(item.value)
    expect(mainModelItemLabel(item)).toBe(item.label)
  }
  expect(isMainModelValue('cursor:')).toBe(false)
  expect(isMainModelValue('cursor:auto')).toBe(false)
  expect(concreteMainModelItems([{ value: 'auto', label: 'Auto' }, { value: 'cursor:auto', label: 'Auto' }, ...items])).toEqual(items)
  expect(mainModelMenuValue([{ value: 'cursor:auto', label: 'Auto' }], 'cursor:auto')).toBe('')
  expect(mainModelMenuValue(items, 'auto')).toBe('')
  expect(mainModelSelectionLabel(items, 'auto', key => key)).toBe('model_selection_unavailable')
})


test('Cursor reserved routing selectors stay hidden in legacy and canonical form regardless of case', () => {
  for (const model of ['auto', 'auto-smart', 'default']) {
    for (const selector of [model, `${model}[]`, `${model}[reasoning=high]@max`]) {
      const lower = `cursor:${selector}`
      for (const value of [lower, lower.toUpperCase(), `cursor:${selector.toUpperCase()}`]) {
        const items = [{ value, label: value }, { value: 'cursor:grok-high-fast', label: 'Grok 4.7 High Fast' }]
        expect(isMainModelValue(value)).toBe(false)
        expect(mainModelMenuValue(items, value)).toBe('')
        expect(concreteMainModelItems(items)).toEqual([items[1]])
      }
    }
  }
  const concrete = [{ value: 'cursor:default-model[]', label: 'Account model' }]
  expect(isMainModelValue(concrete[0].value)).toBe(true)
  expect(mainModelMenuValue(concrete, concrete[0].value)).toBe(concrete[0].value)
  expect(concreteMainModelItems(concrete)).toEqual(concrete)
})


describe('Shared reasoning and Fast controls select native account models', () => {
  const family = cursorVectors.model as typeof cursorVectors.model & CursorModelMetadata
  const selected = (value: string) => modelOptionForValue([family], value)!

  test('one family row recognizes a saved non-default member without replacing its exact selection', () => {
    expect(mainModelMenuValue([family], cursorVectors.savedSelection)).toBe(cursorVectors.savedSelection)
    expect(mainModelSelectionLabel([family], cursorVectors.savedSelection, translate('en'))).toBe('Fixture Model')
    expect(family.value).toBe(cursorVectors.model.cursorVariants[0]!.value)
  })

  for (const language of ['en', 'zh'] as const) {
    test(`shows the exact native effort instead of the stale global value in ${language}`, () => {
      const presentation = mainModelThinkingPresentation(selected(family.value), 'medium', translate(language))
      expect(presentation.titleKey).toBe('thinking_level_button_title')
      expect(presentation.label).toBe(I18N[language].thinking_high)
      expect(presentation.showBadge).toBe(true)
      expect(presentation.rows.map(row => row.value)).toEqual(['high'])
      expect(presentation.rows.find(row => row.selected)?.value).toBe('high')
      expect(selected(family.value).value).toBe(family.cursorVariants[4]!.value)
      expect(mainModelThinkingPresentation(selected(family.cursorVariants[2]!.value), 'high', translate(language)).label).toBe(I18N[language].thinking_medium)
    })
  }

  test('only compatible native levels are available and context is retained when Fast changes', () => {
    const max = family.cursorVariants[5]!.value
    expect(mainModelThinkingLevels(selected(max))).toEqual(['high'])
    expect(mainModelThinkingPresentation(selected(max), 'low', translate('en')).rows.map(row => row.value)).not.toContain('off')
    const fast = cursorVariantForFast(family, family.value, true)!
    expect(fast.value).toBe(cursorVectors.savedSelection)
    expect(fast.parameters.context).toBe(family.cursorVariants[0]!.parameters.context)
    const medium = cursorVariantForThinking(family, fast.value, 'medium')!
    expect(medium.parameters.fast).toBe('true')
    expect(medium.parameters.context).toBe(fast.parameters.context)
  })

  test('boolean native reasoning keeps the existing On and Off labels', () => {
    const variants = [false, true].map(enabled => ({ value: `cursor:boolean[thinking=${enabled}]`, label: 'Boolean model', parameters: { thinking: String(enabled) }, maxMode: false }))
    const item = { value: variants[1]!.value, label: 'Boolean model', cursorModelId: 'boolean', cursorVariants: variants }
    const presentation = mainModelThinkingPresentation(item, 'low', translate('en'))
    expect(presentation.label).toBe(I18N.en.thinking_on)
    expect(presentation.rows.map(row => row.label)).toEqual([I18N.en.thinking_off, I18N.en.thinking_on])
    const fixed = { ...item, cursorVariants: [variants[1]!] }
    expect(mainModelThinkingPresentation(fixed, 'off', translate('en')).rows.map(row => row.value)).toEqual(['high'])
  })

  test('Fast uses the common switch and is absent when the exact variant has no compatible speed change', () => {
    const mode = cursorFastMode(family, cursorVectors.savedSelection)
    expect(mode).toEqual({ enabled: true, supported: true })
    const html = renderToStaticMarkup(createElement(FastModeToggle, { ...mode, onChange: () => {}, translate: translate('en') }))
    expect(html).toContain('role="switch"')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain(I18N.en.codex_fast_mode)
    expect(html).not.toContain('title=')
    expect(renderToStaticMarkup(createElement(FastModeToggle, { enabled: false, supported: false, onChange: () => {}, translate: translate('en') }))).toBe('')
    expect(renderToStaticMarkup(createElement(FastModeToggle, { enabled: false, onChange: () => {}, translate: translate('en') }))).toBe('')
  })

  test('Ultra preserves the exact native variant and reasoning level', async () => {
    let model = cursorVectors.savedSelection
    let level = 'high'
    let enabled = false
    const writes: unknown[] = []
    const ultra = createUltraSelection({
      getSelection: () => ({ model, enabled, sessionId: 'cursor-session' }),
      save: async (next, sessionId, permissionMode) => { writes.push({ next, sessionId, permissionMode }); enabled = next },
      onError: error => { throw error },
    })
    await ultra.choose(true)
    expect(model).toBe(cursorVectors.savedSelection)
    expect(level).toBe('high')
    const native = createThinkingSelection({
      getSelection: () => ({ model, level, sessionId: 'cursor-session' }),
      save: async next => { model = cursorVariantForThinking(family, model, next)!.value; level = next },
      onError: error => { throw error },
    })
    await native.choose('medium')
    expect(model).toBe(family.cursorVariants[3]!.value)
    expect(enabled).toBe(true)
    expect(writes).toEqual([{ next: true, sessionId: 'cursor-session', permissionMode: undefined }])
  })

  test('other model sources retain their declared native effort choices and badge', () => {
    const presentation = mainModelThinkingPresentation({ value: 'custom:fixture', supportedThinkingLevels: ['low', 'high'], defaultThinkingLevel: 'high' }, 'high', translate('en'))
    expect(presentation.titleKey).toBe('thinking_level_button_title')
    expect(presentation.label).toBe(I18N.en.thinking_high)
    expect(presentation.showBadge).toBe(true)
    expect(presentation.rows.map(row => row.value)).toEqual(['low', 'high'])
  })
})


describe('model row notes stay name-only', () => {
  test('catalog descriptions never become row subtext in either language', () => {
    const item = { value: 'qwenwork:mode-1', label: 'Qwen3.8-Max', description: '【高可信模型】软件工程与深度推理，可处理L1-L4数据' } as MainModelItem
    for (const language of ['en', 'zh'] as const) {
      expect(mainModelItemNote(item, translate(language))).toBe(null)
    }
  })
  test('account and server notices keep the second line', () => {
    expect(mainModelItemNote({ value: 'kimi:k1', label: 'K1', available: false } as MainModelItem, translate('en'))).toBe(I18N.en.model_account_unavailable)
    expect(mainModelItemNote({ value: 'kimi:k1', label: 'K1', reason: 'quota exhausted' } as MainModelItem, translate('zh'))).toBe('quota exhausted')
    expect(mainModelItemNote({ value: 'antigravity:gemini', label: 'Gemini', reason: 'quota exhausted' } as MainModelItem, translate('zh'))).toBe(null)
  })
})

describe('native Fast capability presentation', () => {
  test('uses authoritative eligibility and discloses extra credit billing in both languages', () => {
    for (const language of ['en', 'zh'] as const) {
      const html = renderToStaticMarkup(createElement(FastModeToggle, { supported: true, enabled: false, billing: 'extraCredits', onChange: () => {}, translate: translate(language) }))
      expect(html).toContain(I18N[language].fast_mode_extra_credits_description)
      expect(html).toContain('role="switch"')
      expect(html).not.toContain('title=')
      expect(renderToStaticMarkup(createElement(FastModeToggle, { supported: false, enabled: true, onChange: () => {}, translate: translate(language) }))).toBe('')
    }
  })
})


describe('Antigravity families retain native selections in the shared model picker', () => {
  const family: MainModelItem = {
    value: 'antigravity:gemini-3.8-flash-high', label: 'Gemini 3.8 Flash',
    antigravityFamilyId: 'gemini-3.8-flash', defaultThinkingLevel: 'high',
    supportedThinkingLevels: ['low', 'medium', 'high'],
    antigravityVariants: [
      { value: 'antigravity:gemini-3.8-flash-low', thinkingLevel: 'low', available: true, mediaInputMimeTypes: ['audio/wav'] },
      { value: 'antigravity:gemini-3.8-flash-medium', thinkingLevel: 'medium', available: true },
      { value: 'antigravity:gemini-3.8-flash-high', thinkingLevel: 'high', available: true },
    ],
  }
  const saved = 'antigravity:gemini-3.8-flash-low'
  const selected = (value: string) => modelOptionForValue([family], value)!

  test('a saved non-default member remains selected under one base model label', () => {
    expect(concreteMainModelItems([family])).toHaveLength(1)
    expect(mainModelMenuValue([family], saved)).toBe(saved)
    expect(mainModelSelectionLabel([family], saved, translate('en'))).toBe('Gemini 3.8 Flash')
    expect(selected(saved).value).toBe(saved)
    expect(selected(saved).mediaInputMimeTypes).toEqual(['audio/wav'])
    expect(family.value).toBe('antigravity:gemini-3.8-flash-high')
    expect(mainModelMenuValue([family], 'antigravity:removed-flash-member')).toBe('')
  })

  for (const language of ['en', 'zh'] as const) {
    test(`the native reasoning selection overrides a stale stored preference in ${language}`, () => {
      const presentation = mainModelThinkingPresentation(selected(saved), 'high', translate(language))
      expect(presentation.label).toBe(I18N[language].thinking_low)
      expect(presentation.rows.map(row => row.value)).toEqual(['low', 'medium', 'high'])
      expect(presentation.rows.find(row => row.selected)?.value).toBe('low')
      expect(presentation.rows.map(row => row.value)).not.toContain('off')
      expect(presentation.showBadge).toBe(true)
    })
  }

  test('legacy orchestration spelling cannot replace the selected native reasoning member', () => {
    const member = selected(saved)
    const presentation = mainModelThinkingPresentation(member, 'ultra', translate('en'))
    expect(presentation.label).toBe(I18N.en.thinking_low)
    expect(presentation.rows.find(row => row.selected)?.value).toBe('low')
    expect(member.value).toBe(saved)
  })

  test('an undeclared native reasoning capability never invents an Off choice', () => {
    const unknown: MainModelItem = {
      value: 'antigravity:unreasoned-member', label: 'Other model', defaultThinkingLevel: 'off', antigravityFamilyId: 'unreasoned',
      antigravityVariants: [{ value: 'antigravity:unreasoned-member', available: true }],
    }
    expect(mainModelThinkingLevels(unknown)).toEqual([])
    const presentation = mainModelThinkingPresentation(unknown, 'off', translate('en'))
    expect(presentation.rows.map(row => row.value)).toEqual([])
    expect(presentation.label).toBe('')
    expect(presentation.showBadge).toBe(false)
  })

  test('boolean thinking shows On and Off only for declared native members', () => {
    const thinking: MainModelItem = {
      value: 'antigravity:fixture-thinking', label: 'Optional thinking model', antigravityFamilyId: 'fixture-toggle', antigravityThinkingToggle: true,
      antigravityVariants: [
        { value: 'antigravity:fixture-plain', thinkingLevel: 'off', available: true },
        { value: 'antigravity:fixture-thinking', thinkingLevel: 'high', available: true },
      ],
    }
    const presentation = mainModelThinkingPresentation(thinking, 'low', translate('en'))
    expect(presentation.label).toBe(I18N.en.thinking_on)
    expect(presentation.rows.map(row => row.label)).toEqual([I18N.en.thinking_off, I18N.en.thinking_on])
    const fixed = { ...thinking, antigravityVariants: [thinking.antigravityVariants![1]] }
    expect(mainModelThinkingPresentation(fixed, 'off', translate('en')).rows.map(row => row.value)).toEqual(['high'])
  })

  test('fixed Claude thinking and GPT OSS expose only their declared native reasoning', () => {
    const claude: MainModelItem = {
      value: 'antigravity:claude-opus-4-6-thinking', label: 'Claude Opus 4.6', antigravityFamilyId: 'claude-opus-4-6', antigravityThinkingToggle: true,
      antigravityVariants: [{ value: 'antigravity:claude-opus-4-6-thinking', thinkingLevel: 'high', available: true }],
    }
    const claudePresentation = mainModelThinkingPresentation(claude, 'off', translate('en'))
    expect(claudePresentation.label).toBe(I18N.en.thinking_on)
    expect(claudePresentation.rows.map(row => row.label)).toEqual([I18N.en.thinking_on])
    expect(claudePresentation.rows.map(row => row.value)).toEqual(['high'])
    const oss: MainModelItem = {
      value: 'antigravity:gpt-oss-120b', label: 'GPT OSS 120B', antigravityFamilyId: 'gpt-oss-120b',
      antigravityVariants: [{ value: 'antigravity:gpt-oss-120b', thinkingLevel: 'medium', available: true }],
    }
    const ossPresentation = mainModelThinkingPresentation(oss, 'high', translate('en'))
    expect(ossPresentation.label).toBe(I18N.en.thinking_medium)
    expect(ossPresentation.rows.map(row => row.value)).toEqual(['medium'])
  })

  test('models without family metadata keep generic declared reasoning behavior', () => {
    const ungrouped: MainModelItem = { value: 'antigravity:unknown', supportedThinkingLevels: ['medium', 'high'], defaultThinkingLevel: 'medium' }
    expect(mainModelThinkingLevels(ungrouped)).toEqual(['medium', 'high'])
    expect(mainModelThinkingPresentation(ungrouped, 'high', translate('en')).label).toBe(I18N.en.thinking_high)
  })

  test('a saved restricted member retains its restriction instead of inheriting the family default', () => {
    const restricted: MainModelItem = {
      ...family, antigravityVariants: family.antigravityVariants!.map(member => member.value === saved
        ? { ...member, available: false, reason: 'Unavailable for this account' } : member),
    }
    const member = modelOptionForValue([restricted], saved)!
    expect(member.value).toBe(saved)
    expect(member.available).toBe(false)
    expect(member.reason).toBe('Unavailable for this account')
    expect(mainModelSelectionLabel([restricted], saved, translate('en'))).toBe('Gemini 3.8 Flash')
  })
})


describe('account-independent Antigravity selection', () => {
  test('known restricted rows are selectable without changing their account metadata', () => {
    const restricted = { value: 'antigravity:restricted', label: 'Restricted model', available: false, reason: 'Account restricted' }
    expect(modelOptionIsSelectable(restricted)).toBe(antigravityVectors.selectionPolicy.knownRestrictedMemberSelectable)
    expect(restricted.available).toBe(antigravityVectors.selectionPolicy.reportedAvailable)
    expect(restricted.reason).toBe('Account restricted')
    expect(modelOptionIsSelectable({ modelId: 'restricted', available: false }, 'antigravity')).toBe(true)
    expect(modelOptionIsAntigravity({ modelId: 'restricted' }, 'antigravity')).toBe(true)
    expect(modelOptionIsSelectable({ value: 'custom:restricted', available: false })).toBe(true)
    expect(modelOptionIsSelectable({ modelId: 'restricted', available: false }, 'codex')).toBe(true)
    expect(modelOptionIsSelectable({ value: 'codex:other' }, 'antigravity')).toBe(false)
    for (const missing of [undefined, null, {}, { value: '' }]) expect(modelOptionIsSelectable(missing, 'antigravity')).toBe(false)
    expect(modelOptionIsAntigravity(undefined, 'antigravity')).toBe(false)
  })

  test('restricted native thinking remains available while undeclared choices remain absent', () => {
    const restricted: MainModelItem = { value: 'antigravity:fixture-high', label: 'Fixture', available: false, antigravityFamilyId: 'fixture',
      antigravityVariants: [{ value: 'antigravity:fixture-low', thinkingLevel: 'low', available: false }, { value: 'antigravity:fixture-high', thinkingLevel: 'high', available: false }] }
    expect(mainModelThinkingLevels(restricted)).toEqual(['low', 'high'])
    expect(modelOptionIsSelectable(modelOptionForValue([restricted], 'antigravity:removed'))).toBe(antigravityVectors.selectionPolicy.unknownMemberSelectable)
    expect(modelOptionForValue([restricted], 'antigravity:fixture-low')?.available).toBe(false)
  })
})

describe('account-independent model catalog selection', () => {
  for (const source of catalogVectors.sources) {
    test(`${source} retains restricted catalog choices`, () => {
      const row = { value: `${source}:restricted`, ...catalogVectors.accountMetadata }
      expect(modelOptionIsSelectable(row, source)).toBe(catalogVectors.knownModelSelectable)
      expect(modelOptionIsSelectable({ modelId: 'restricted', ...catalogVectors.accountMetadata }, source)).toBe(catalogVectors.knownModelSelectable)
      expect(row.available).toBe(false)
      expect(modelOptionIsSelectable(modelOptionForValue([row], `${source}:removed`), source)).toBe(catalogVectors.unknownModelSelectable)
    })
  }

  test('declared native variants remain selectable when account metadata restricts a parameter', () => {
    const model: CursorModelMetadata = {
      cursorVariants: [
        { value: 'cursor:fixture-low', label: 'Low', parameters: { effort: 'low', fast: 'false' }, maxMode: false },
        { value: 'cursor:fixture-high', label: 'High', parameters: { effort: 'high', fast: 'false' }, maxMode: false },
        { value: 'cursor:fixture-fast', label: 'Fast', parameters: { effort: 'low', fast: 'true' }, maxMode: false },
      ],
      cursorParameterDefinitions: [
        { id: 'effort', name: 'Effort', type: 'enum', values: [{ value: 'high', blockedByAdminAllowlist: true }] },
        { id: 'fast', name: 'Fast', type: 'boolean', values: [{ value: 'true', blockedByAdminAllowlist: true }] },
      ],
    }
    expect(Boolean(cursorVariantForThinking(model, 'fixture-low', 'high'))).toBe(catalogVectors.declaredRestrictedVariantSelectable)
    expect(Boolean(cursorVariantForFast(model, 'fixture-low', true))).toBe(catalogVectors.declaredRestrictedVariantSelectable)
  })
})


test('ordinary picker rows keep their selection contract independently of native source eligibility', () => {
  for (const source of ['custom', 'codex', 'cursor', 'kimi', 'qoder', 'qwenwork', 'workbuddy']) {
    const row = { value: `${source}:known`, available: false }
    expect(mainModelItemDisabled(row, false)).toBe(false)
    expect(mainModelItemDisabled(row, true)).toBe(true)
  }
  expect(mainModelItemDisabled({ value: 'antigravity:known', available: false }, false)).toBe(false)
  expect(mainModelItemDisabled({ value: 'antigravity:known' }, true)).toBe(true)
})
