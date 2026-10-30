import { type FastModeMetadata, type FastModeState } from '../../../../shared/model-fast-mode'
import { modelOptionIsAntigravity, modelOptionIsSelectable, cursorFastMode, cursorThinkingLevel, cursorThinkingLevels, modelOptionHasValue, modelOptionForValue, modelOptionsForValue, type CursorModelMetadata } from '../../../../shared/cursor-model-catalog'
import { antigravityThinkingLevel, antigravityThinkingLevels, type AntigravityModelMetadata } from '../../../../shared/antigravity-model-catalog'
import { traeThinkingLevel, traeThinkingLevels, traeThinkingLabel, type TraeModelMetadata } from '../../../../shared/trae-model-catalog'
import { isKiroRoutingAlias, kiroThinkingLevel, kiroThinkingLevels, kiroThinkingLabel, type KiroModelMetadata } from '../../../../shared/kiro-model-catalog'
// Composer model and reasoning picker. The trigger shows the selected model and
// thinking level; the panel lists models and opens a nested thinking-level menu.
// Main and side composers keep independent session selections and menu visibility
// state. React preserves row identity so submenu refs remain valid.
import { useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createPortal } from 'react-dom'
import { createStore, type StoreApi } from 'zustand/vanilla'
import { useStore } from 'zustand'
import { Icon, rawIconHtml } from '../../components/Icon'
import { claimOverlay, overlayIdForElement, registerOverlay } from '../../app/overlay-registry'
import { showToast } from '../../app/ui-shared'
import { escapeHtml } from '../transcript/factories'
import {
  ALL_THINKING_LEVELS,
  clampedThinkingLevelFor,
  isThinkingHidden,
  isThinkingLevelValue,
  isThinkingToggle,
  itemThinkingLevels,
  THINKING_LEVEL_ITEMS,
} from './thinking-ladder'
import styles from './composer.module.css'
import type { ComposerInferenceState } from '../model-inference'
import { createPreferenceSaver } from './preference-save'
import { createThinkingSelection, createUltraSelection, type UltraAccessDecision } from './ultra-selection'
import { UltraAccessDialog } from './ultra-access-dialog'
import { isAutomaticCursorSelection } from './model-selection-values'

export { isThinkingLevelValue, THINKING_LEVEL_ITEMS }

const w = () => window as any
const tt = (key: string): string => w().tt?.(key) || ''

export interface MainModelItem extends CursorModelMetadata, AntigravityModelMetadata, TraeModelMetadata, KiroModelMetadata, FastModeMetadata {
  value: string
  label?: string
  i18nKey?: string
  tooltip?: string
  tooltipKey?: string
  supportedThinkingLevels?: string[]
  defaultThinkingLevel?: string
  // Gateway-shipped row copy: the official selector paints the brand glyph,
  // this description and the credit multiplier beside the model name.
  description?: string
  available?: boolean
  reason?: string
  mediaInputMimeTypes?: string[]
  priceFactor?: number
  icon?: string
}

export function mainModelItemDisabled(item: MainModelItem, thinkingPending: boolean): boolean {
  return thinkingPending || (modelOptionIsAntigravity(item) && !modelOptionIsSelectable(item))
}

export function isMainModelValue(value: unknown): boolean {
  if (typeof value !== 'string' || isAutomaticCursorSelection(value)
    || value.startsWith('kiro:') && isKiroRoutingAlias(value)) return false
  if (['auto', 'high', 'medium', 'low'].includes(value)) return true
  return ['subscription:', 'custom:', 'codex:', 'cursor:', 'kimi:', 'bailian:', 'minimax:', 'zhipu:', 'ark:', 'deepseek:', 'qoder:', 'qwenwork:', 'qoderwork:', 'workbuddy:', 'antigravity:', 'trae:', 'kiro:']
    .some(prefix => value.startsWith(prefix) && value.length > prefix.length)
}

// The picker hides a missing, negative or zero multiplier and prints the rest
// with one decimal at most ("1.6x", "2x").
export function priceFactorLabel(factor: number | undefined): string {
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0) return ''
  return Number.isInteger(factor) ? String(factor) : factor.toFixed(1).replace(/\.0$/, '')
}

function thinkingLevelLabel(level: string, translate: (key: string) => string = tt): string {
  const item = THINKING_LEVEL_ITEMS.find(it => it.value === level) || THINKING_LEVEL_ITEMS[2]
  return item.i18nKey ? translate(item.i18nKey) : item.value
}

const QODER_MODEL_LABEL_KEYS: Record<string, string> = {
  'qoder:ultimate': 'qoder_model_ultimate',
  'qoder:performance': 'qoder_model_performance',
  'qoder:fast': 'qoder_model_fast',
  'qoder:efficient': 'qoder_model_efficient',
  'qoder:lite': 'qoder_model_lite',
}

export function mainModelItemLabel(
  item: MainModelItem | null,
  translate: (key: string) => string = tt,
): string {
  if (!item) return ''
  const i18nKey = item.i18nKey || QODER_MODEL_LABEL_KEYS[item.value]
  return (i18nKey ? translate(i18nKey) : '') || item.label || String(item.value || '')
}

// Rows stay name-only: catalog prose belongs to the source's own pages, and
// repeating it under every model made the list scan as documentation. Account
// and server-refusal notices still need the second line.
export function mainModelItemNote(
  item: MainModelItem,
  translate: (key: string) => string = tt,
): string | null {
  if (modelOptionIsAntigravity(item) || item.value.startsWith('trae:') || item.value.startsWith('kiro:')) return null
  const note = item.reason || (item.available === false ? translate('model_account_unavailable') : null)
  if (!note || note === mainModelItemLabel(item, translate)) return null
  return note
}

// The engine resolves defaults. Missing or stale selections remain visibly
// unavailable until the host resolves them or the user chooses another model.
export function mainModelMenuValue(items: MainModelItem[], resolvedMode: unknown): string {
  return typeof resolvedMode === 'string' && resolvedMode !== 'auto' && !isAutomaticCursorSelection(resolvedMode)
    && items.some(item => modelOptionHasValue(item, resolvedMode))
    ? resolvedMode
    : ''
}

export function mainModelSelectionLabel(
  items: MainModelItem[],
  value: string,
  translate: (key: string) => string = tt,
  unavailable = false,
): string {
  const selectedItem = modelOptionForValue(items, value) || null
  return selectedItem
    ? mainModelItemLabel(selectedItem, translate)
    : translate(unavailable || items.length > 0 ? 'model_selection_unavailable' : 'no_models')
}

export function concreteMainModelItems(items: MainModelItem[] | null | undefined): MainModelItem[] {
  return Array.isArray(items) ? items.filter(item => item?.value && item.value !== 'auto' && !isAutomaticCursorSelection(item.value)) : []
}

export function mainModelThinkingLevels(item: MainModelItem | null): string[] {
  if (item?.value.startsWith('kiro:') && item.kiroVariants?.length) return kiroThinkingLevels(item)
  if (item?.value.startsWith('trae:') && item.traeVariants?.length) return traeThinkingLevels(item)
  if (item?.value.startsWith('antigravity:') && item.antigravityVariants?.length) {
    return antigravityThinkingLevels(item, item.value)
  }
  if (!item?.value.startsWith('cursor:')) return itemThinkingLevels(item)
  return item.cursorVariants?.length ? cursorThinkingLevels(item, item.value)
    : (item.supportedThinkingLevels || []).filter(level => isThinkingLevelValue(level))
}

export function isThinkingLevelForModel(item: MainModelItem | null | undefined, value: unknown): value is string {
  return item?.value.startsWith('trae:') || item?.value.startsWith('kiro:') ? typeof value === 'string' && mainModelThinkingLevels(item).includes(value) : isThinkingLevelValue(value)
}

export function mainModelThinkingPresentation(
  item: MainModelItem | null,
  thinkingLevel: string,
  translate: (key: string) => string = tt,
): {
  titleKey: string
  label: string
  showBadge: boolean
  rows: Array<{ value: string; label: string; selected: boolean }>
} {
  const levels = mainModelThinkingLevels(item)
  if (item?.value.startsWith('kiro:') && item.kiroVariants?.length) {
    const native = kiroThinkingLevel(item, item.value)
    const labelFor = (level: string) => level === 'none' || level === 'disabled' ? translate('thinking_off')
      : level === 'adaptive' ? translate('thinking_on')
      : level === 'max' ? translate('kiro_thinking_max')
        : isThinkingLevelValue(level) ? thinkingLevelLabel(level, translate) : kiroThinkingLabel(item, level)
    return {
      titleKey: 'thinking_level_button_title',
      label: native ? labelFor(native) : '',
      showBadge: Boolean(native && native !== 'default' && levels.length),
      rows: levels.map(level => ({ value: level, label: labelFor(level), selected: level === native })),
    }
  }
  if (item?.value.startsWith('trae:') && item.traeVariants?.length) {
    const native = traeThinkingLevel(item, item.value)
    const labelFor = (level: string) => {
      const displayLevel = level === 'light' ? 'low' : level === 'extra_high' ? 'xhigh' : level
      return isThinkingLevelValue(displayLevel) ? thinkingLevelLabel(displayLevel, translate) : traeThinkingLabel(item, level)
    }
    return {
      titleKey: 'thinking_level_button_title',
      label: native ? labelFor(native) : '',
      showBadge: Boolean(native),
      rows: levels.map(level => ({ value: level, label: labelFor(level), selected: level === native })),
    }
  }
  if (item?.value.startsWith('antigravity:') && item.antigravityVariants?.length) {
    const selected = modelOptionForValue([item], item.value) || item
    const native = antigravityThinkingLevel(item, item.value)
      ?? (item.defaultThinkingLevel && levels.includes(item.defaultThinkingLevel) ? item.defaultThinkingLevel : undefined)
    const displayLevel = native
    const labelFor = (level: string) => selected.antigravityThinkingToggle
      ? translate(level === 'off' ? 'thinking_off' : 'thinking_on') : thinkingLevelLabel(level, translate)
    return {
      titleKey: 'thinking_level_button_title',
      label: displayLevel ? labelFor(displayLevel) : '',
      showBadge: Boolean(displayLevel),
      rows: levels.map(level => ({ value: level, label: labelFor(level), selected: level === displayLevel })),
    }
  }
  if (item?.value.startsWith('cursor:')) {
    const selected = modelOptionForValue([item], item.value) || item
    const native = cursorThinkingLevel(item, item.value) ?? item.defaultThinkingLevel
    const displayLevel = native
    const labelFor = (level: string) => selected.cursorThinkingToggle
      ? translate(level === 'off' ? 'thinking_off' : 'thinking_on') : thinkingLevelLabel(level, translate)
    return {
      titleKey: 'thinking_level_button_title',
      label: displayLevel ? labelFor(displayLevel) : '',
      showBadge: Boolean(displayLevel),
      rows: levels.map(level => ({ value: level, label: labelFor(level), selected: level === displayLevel })),
    }
  }
  const displayLevel = clampedThinkingLevelFor(item, thinkingLevel) ?? thinkingLevel
  const toggle = isThinkingToggle(levels)
  return {
    titleKey: 'thinking_level_button_title',
    label: toggle ? translate(displayLevel === 'off' ? 'thinking_off' : 'thinking_on') : thinkingLevelLabel(displayLevel, translate),
    showBadge: !isThinkingHidden(levels),
    rows: toggle ? [
      { value: 'off', label: translate('thinking_off'), selected: displayLevel === 'off' },
      { value: levels.find(level => level !== 'off')!, label: translate('thinking_on'), selected: displayLevel !== 'off' },
    ] : levels.map(level => ({ value: level, label: thinkingLevelLabel(level, translate), selected: level === displayLevel })),
  }
}

interface ModelSelectState {
  items: MainModelItem[]
  value: string
  unavailable: boolean
  loading: boolean
  disabled: boolean
  thinkingLevel: string
  thinkingPending: boolean
  ultraMode: boolean
  ultraPending: boolean
  ultraConfirmation: ((decision: UltraAccessDecision) => void) | null
  fastMode: boolean
  fastModeSupported: boolean
  fastModeBilling?: FastModeState['billing']
  fastModePending: boolean
  open: boolean
  // 子菜单只存开关：锚点是主面板里的「推理强度」行，定位时按 ref 现取。
  submenuOpen: boolean
  runtime: ComposerInferenceState | null
}

export interface ModelSelectApi {
  close(): void
  setDisabled(disabled: boolean): void
  setItems(next: MainModelItem[] | null | undefined, opts?: { value?: string; thinkingLevel?: string; ultraMode?: boolean; fastMode?: boolean; fastModeSupported?: boolean; fastModeBilling?: FastModeState['billing']; unavailable?: boolean; loading?: boolean }): void
  setValue(next: string): void
  setRuntime(next: ComposerInferenceState | null): void
  refresh(): void
}

export function modelSelectSessionId(sessionId: string | null | undefined): string | undefined {
  const normalized = String(sessionId || '').trim()
  return normalized || undefined
}

export function hasConfiguredMainModel(items: MainModelItem[]): boolean {
  return items.length > 0
}

// The trigger shows "loading" only while NO usable rows exist for this source.
// A cached catalog for the same source keeps the picker live while a refresh
// revalidates it in the background: host stalls (engine reconnects, frozen I/O)
// must not blank a draft composer that already knows its models.
export function catalogNeedsLoading(
  source: string,
  cachedSource: string | null | undefined,
  cachedItems: MainModelItem[] | null | undefined,
): boolean {
  return !source || cachedSource !== source || !Array.isArray(cachedItems) || cachedItems.length === 0
}

export function modelSelectTriggerAction(items: MainModelItem[], open: boolean): 'empty' | 'open' | 'close' {
  if (!hasConfiguredMainModel(items)) return 'empty'
  return open ? 'close' : 'open'
}

/**
 * Whether the reasoning-level submenu may be on screen.
 *
 * It is anchored to the "reasoning level" row INSIDE the main panel, so it has no
 * anchor unless the panel is open AND that row exists. The row disappears when the
 * selected model offers fewer than two rungs, which a background preferences push
 * can do while both surfaces are open — testing only the two open flags left an
 * empty submenu panel parked next to the model list (measured: a 128×10 box with
 * zero rows in it).
 */
export function modelSelectSubmenuVisible(
  open: boolean,
  submenuOpen: boolean,
  rowVisible: boolean,
): boolean {
  // The reasoning row also hosts the local Ultra pick, so a narrow native
  // ladder no longer hides it; only the caller's row gate takes it away.
  return open && submenuOpen && rowVisible
}

interface MountModelSelectOptions {
  onEmptyClick?: () => void
  onFastModeChange?: () => void
  getSessionId?: () => string | null | undefined
}

/**
 * A sign-out-driven preparation failure is expected, not a model fault: the
 * user removed the credential on purpose and the settings surface already
 * shows the signed-out state. Announcing it as a failure would report the
 * logout itself as broken.
 */
export function modelUpdateAnnounceable(update: { status?: string; quiet?: boolean } | null | undefined): boolean {
  return update?.status === 'failed' && update.quiet !== true
}

/**
 * Model failures are transient toasts, never a standing line inside the
 * composer: the input box stays free of status chrome, and a failure the user
 * has already seen does not occupy space on every later visit to the thread.
 * Model switches themselves still apply silently — only a failed publication
 * or preference write speaks, because silence there would leave the selector
 * claiming a pick that never landed.
 */
export function modelUpdateFailureText(update: { error?: string } | null | undefined, translate: (key: string) => string = tt): string {
  const detail = update?.error?.trim() ? update.error.trim() : translate('model_update_failed_unknown')
  return `${translate('model_update_failed')} ${detail}`
}

export function preferenceSaveFailureText(message: string, translate: (key: string) => string = tt): string {
  const detail = message.trim() ? ` ${message}` : ''
  return `${translate('model_preference_save_failed')}${detail}`
}

export function FastModeToggle({ enabled, supported = false, billing, busy = false, onChange, translate = tt }: {
  enabled: boolean
  supported?: boolean
  billing?: FastModeState['billing']
  busy?: boolean
  onChange: (enabled: boolean) => void
  translate?: (key: string) => string
}) {
  if (!supported) return null
  return (
    <button
      type="button"
      className={`kls-select-item ${styles['main-model-fast-row']}`}
      role="switch"
      aria-checked={enabled}
      disabled={busy}
      aria-busy={busy}
      aria-label={translate('codex_fast_mode')}
      onClick={event => {
        event.stopPropagation()
        onChange(!enabled)
      }}
    >
      <Icon name={fastModeIconName(enabled)} size={16} />
      <span className="kls-select-item-copy">
        <span className="kls-select-item-label">{translate('codex_fast_mode')}</span>
        <span className="kls-select-item-desc">{translate(billing === 'extraCredits' ? 'fast_mode_extra_credits_description' : 'codex_fast_mode_description')}</span>
      </span>
      <span className={styles['main-model-fast-switch']} aria-hidden="true" />
    </button>
  )
}

export function fastModeIconName(enabled: boolean): 'tc-lightning' | 'tc-lightning-fill' {
  return enabled ? 'tc-lightning-fill' : 'tc-lightning'
}

function ModelSelectMenu({ store, onEmptyClick, saveModel, saveThinkingLevel, saveUltraMode, saveFastMode, rootEl, titleKey, title }: {
  store: StoreApi<ModelSelectState>
  onEmptyClick?: () => void
  saveModel: (mode: string) => Promise<void>
  saveThinkingLevel: (level: string) => Promise<void>
  saveUltraMode: (enabled: boolean) => Promise<void>
  saveFastMode: (enabled: boolean) => Promise<void>
  rootEl: HTMLElement
  titleKey: string
  title: string
}) {
  const items = useStore(store, s => s.items)
  const value = useStore(store, s => s.value)
  const unavailable = useStore(store, s => s.unavailable)
  const loading = useStore(store, s => s.loading)
  const disabled = useStore(store, s => s.disabled)
  const thinkingLevel = useStore(store, s => s.thinkingLevel)
  const thinkingPending = useStore(store, s => s.thinkingPending)
  const ultraMode = useStore(store, s => s.ultraMode)
  const ultraPending = useStore(store, s => s.ultraPending)
  const ultraConfirmation = useStore(store, s => s.ultraConfirmation)
  const fastMode = useStore(store, s => s.fastMode)
  const fastModePending = useStore(store, s => s.fastModePending)
  const fastModeSupported = useStore(store, s => s.fastModeSupported)
  const fastModeBilling = useStore(store, s => s.fastModeBilling)
  const open = useStore(store, s => s.open)
  const submenuOpen = useStore(store, s => s.submenuOpen)
  const runtime = useStore(store, s => s.runtime)
  // A failed publication is announced ONCE per change: the toast is the whole
  // surface now, and re-announcing on every re-render or session switch would
  // stack duplicates for a failure the user already saw.
  const announcedFailure = useRef<string | null>(null)
  useEffect(() => {
    const update = runtime?.modelUpdate
    if (!modelUpdateAnnounceable(update)) return
    if (announcedFailure.current === update!.changeId) return
    announcedFailure.current = update!.changeId
    showToast(modelUpdateFailureText(update))
  }, [runtime])
  const panelRef = useRef<HTMLDivElement>(null)
  const submenuRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const thinkingRowRef = useRef<HTMLButtonElement>(null)
  // refresh() 强制重渲（语言切换后 tt 输出变化）。
  const [, force] = useState(0)
  ;(store as any).__forceRender = () => force(v => v + 1)

  const selectedItem = modelOptionForValue(items, value) || null
  const visibleItems = modelOptionsForValue(items, value)
  const cursorFast = cursorFastMode(selectedItem, value)
  const shownFastMode = value.startsWith('cursor:') && !fastModePending ? cursorFast.enabled : fastMode
  const supportsFastMode = value.startsWith('cursor:') ? cursorFast.supported : fastModeSupported && selectedItem?.supportsFastMode === true
  const levels = mainModelThinkingLevels(selectedItem)
  const thinkingPresentation = mainModelThinkingPresentation(selectedItem, thinkingLevel)
  // Ultra is picked from inside the reasoning menu, so the anchor row stays
  // reachable even when the selected model declares no native rungs; only the
  // loading placeholder hides it.
  const thinkingRowVisible = !loading

  const close = () => store.setState({ open: false, submenuOpen: false })
  const submenuVisible = modelSelectSubmenuVisible(open, submenuOpen, thinkingRowVisible)

  // A pending conversation has no model to name yet. Remove the trigger from
  // the composer instead of keeping a placeholder where the previous
  // conversation's model used to sit, and close any menu it left open.
  useEffect(() => {
    if (loading) store.setState({ open: false, submenuOpen: false })
  }, [loading, store])

  const chooseModel = async (mode: string) => {
    if (!isMainModelValue(mode)) return
    if (!items.some(item => modelOptionHasValue(item, mode))) return
    await saveModel(mode)
  }

  const chooseThinkingLevel = async (level: string) => {
    if (!isThinkingLevelForModel(selectedItem, level) || thinkingPending) return
    // The host saves the native rung and exit from Ultra as one selection.
    await saveThinkingLevel(level)
  }

  // 外点/Escape/滚动关闭（对齐旧版三监听；root 内滚动不关）。
  useEffect(() => {
    if (!open) return
    const onDocClick = (event: MouseEvent) => {
      if (!rootEl.contains(event.target as Node)) close()
    }
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    const onScroll = (event: globalThis.Event) => {
      if (event.target instanceof Node && rootEl.contains(event.target)) return
      close()
    }
    document.addEventListener('click', onDocClick)
    document.addEventListener('keydown', onKeydown)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('click', onDocClick)
      document.removeEventListener('keydown', onKeydown)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  // Position above the trigger like the other composer pickers. Fall back below
  // only when the viewport does not leave enough room above. Measure in the same
  // commit so the reasoning submenu reads the final panel geometry.
  useEffect(() => {
    if (!open || !panelRef.current || !triggerRef.current) return
    const targetPanel = panelRef.current
    const rect = triggerRef.current.getBoundingClientRect()
    targetPanel.style.left = `${rect.left}px`
    targetPanel.style.right = 'auto'
    const pr = targetPanel.getBoundingClientRect()
    const above = rect.top - pr.height - 4
    targetPanel.style.top = `${above >= 8 ? above : Math.min(rect.bottom + 4, Math.max(8, window.innerHeight - pr.height - 8))}px`
    if (pr.right > window.innerWidth - 8) {
      targetPanel.style.left = `${Math.max(8, rect.right - pr.width)}px`
    }
    // 打开时让选中模型在固定高度列表里可见。
    targetPanel.querySelector(`.${styles['main-model-list']} .kls-select-item.is-selected`)?.scrollIntoView({ block: 'nearest' })
  }, [open, items, value])

  // 子菜单定位：右侧优先，放不下翻左；纵向对齐锚点行并 clamp 视口。
  // 锚点每次都从 ref 现取——面板内容随 items/档位重渲，缓存下来的节点会被换掉，
  // 拿它测 rect 会得到全 0 而把子菜单甩到视口左上角。
  // 子菜单在本次提交里已可见，尺寸直接同步测量，不留 rAF 期间状态漂移的窗口。
  useEffect(() => {
    const submenu = submenuRef.current
    const panel = panelRef.current
    const anchor = thinkingRowRef.current
    if (!submenuVisible || !submenu || !panel || !anchor) return
    const anchorRect = anchor.getBoundingClientRect()
    const panelRect = panel.getBoundingClientRect()
    const sr = submenu.getBoundingClientRect()
    const rightLeft = panelRect.right + 6
    const leftLeft = panelRect.left - sr.width - 6
    submenu.style.left = `${rightLeft + sr.width <= window.innerWidth - 8 ? rightLeft : Math.max(8, leftLeft)}px`
    submenu.style.top = `${Math.min(Math.max(8, anchorRect.top), Math.max(8, window.innerHeight - sr.height - 8))}px`
    submenu.style.right = 'auto'
  }, [submenuVisible, items, value, thinkingLevel])

  // While Ultra is on, the menu reports it as the active pick; the preserved
  // native rung stays stored underneath and takes the label back on leaving.
  const thinkingRowLabel = ultraMode
    ? tt('thinking_ultra')
    : (thinkingPresentation.showBadge ? thinkingPresentation.label : '')

  if (loading) return null

  const modelLabel = mainModelSelectionLabel(items, value, tt, unavailable)
  // 触发器只显示模型 + 当前档位；含义由面板内「推理强度」行自解释。
  // 模型无任何可推理档（如 qoder 非 reasoning 模型）时不挂档位角标。
  const triggerHtml = (supportsFastMode || cursorFast.enabled
      ? `<span class="${styles['main-model-trigger-fast']}" role="img" aria-label="${escapeHtml(tt('codex_fast_mode'))}">${rawIconHtml(fastModeIconName(shownFastMode), { size: 12 })}</span>`
      : '')
    + `<span class="${styles['main-model-trigger-model']}">${escapeHtml(modelLabel)}</span>`
    + (!thinkingRowLabel ? '' : `<span class="${styles['main-model-trigger-thinking']}">${escapeHtml(thinkingRowLabel)}</span>`)


  return (
    <>
      {ultraConfirmation ? createPortal(<UltraAccessDialog onDecision={ultraConfirmation} translate={tt} />, document.body) : null}
      <button
        type="button" className="kls-select-trigger" aria-haspopup="menu" aria-expanded={open ? 'true' : 'false'}
        disabled={disabled}
        ref={triggerRef}
        {...(titleKey ? { 'data-i18n-title': titleKey } : {})}
        {...(title ? { title } : {})}
        onClick={(event) => {
          event.stopPropagation()
          const action = modelSelectTriggerAction(items, open)
          if (action === 'empty') {
            onEmptyClick?.()
            return
          }
          if (action === 'close') close()
          else {
            // Opening claims the app-wide overlay registry: every other open
            // popover (permission picker, plus menu, slash menu, sidebar quota
            // popover, user menu, page dropdowns) closes first.
            claimOverlay(overlayIdForElement(rootEl, 'model-select'))
            rootEl.classList.add('open')
            store.setState({ open: true })
          }
        }}
        dangerouslySetInnerHTML={{ __html: `<span class="kls-select-text ${styles['main-model-trigger-text']}">${triggerHtml}</span>${rawIconHtml('chevron-down', { cls: 'kls-select-caret', size: 12 })}` }}
      />
      <div className={`kls-select-panel ${styles['main-model-menu-panel']}`} hidden={!open} ref={panelRef}>
        {/* 主面板：模型列表固定高度内滚动，底部常驻「推理强度 当前值 ›」一行。
            选中模型无可推理档时整行隐藏，不留死控件。 */}
        <div className={styles['main-model-list']}>
          {visibleItems.length > 0 ? visibleItems.map(item => (
            <button
              key={item.antigravityFamilyId ? `antigravity:${item.antigravityFamilyId}` : item.cursorModelId || String(item.value)}
              data-model-value={item.value}
              data-cursor-model-id={item.cursorModelId}
              data-antigravity-family-id={item.antigravityFamilyId}
              type="button"
              disabled={mainModelItemDisabled(item, thinkingPending)}
              className={`kls-select-item${modelOptionHasValue(item, value) ? ' is-selected' : ''}`}
              onClick={(event) => {
                event.stopPropagation()
                void chooseModel(String(item.value))
              }}
            >
              {item.icon ? <img className={styles['main-model-item-icon']} src={item.icon} alt="" aria-hidden="true" /> : null}
              <span className="kls-select-item-copy">
                <span className="kls-select-item-label">{mainModelItemLabel(item)}</span>
                {mainModelItemNote(item)
                  ? <span className="kls-select-item-desc">{mainModelItemNote(item)}</span>
                  : null}
              </span>
              {priceFactorLabel(item.priceFactor)
                ? <span className={styles['main-model-item-factor']}>{priceFactorLabel(item.priceFactor)}x</span>
                : null}
            </button>
          )) : (
            <div className="kls-select-item" aria-disabled="true">
              <span className="kls-select-item-copy">
                <span className="kls-select-item-label">{tt('no_models')}</span>
              </span>
            </div>
          )}
        </div>
        {supportsFastMode && (
          <>
            <div className={styles['main-model-menu-separator']} />
            <FastModeToggle supported={supportsFastMode} billing={fastModeBilling}
              enabled={shownFastMode}
              busy={fastModePending} onChange={enabled => { void saveFastMode(enabled) }} />
          </>
        )}
        {thinkingRowVisible && (
          <>
            <div className={styles['main-model-menu-separator']} />
            {/* hover 已可能把子菜单带出来，点击若再 toggle 会把它关掉
                （hover-开 → click-关的反直觉序列）；点击始终展开。 */}
            <button
              type="button"
              className={`kls-select-item ${styles['main-model-submenu-row']}`}
              ref={thinkingRowRef}
              aria-haspopup="menu"
              aria-expanded={submenuVisible ? 'true' : 'false'}
              onClick={(event) => {
                event.stopPropagation()
                store.setState({ submenuOpen: true })
              }}
              onMouseEnter={() => store.setState({ submenuOpen: true })}
            >
              <span className="kls-select-item-copy">
                <span className="kls-select-item-label">{tt(thinkingPresentation.titleKey)}</span>
                {thinkingRowLabel ? <span className="kls-select-item-desc">{thinkingRowLabel}</span> : null}
              </span>
              <span className={styles['main-model-submenu-caret']} aria-hidden="true">›</span>
            </button>
          </>
        )}
      </div>
      <div
        className={`kls-select-panel ${styles['main-model-submenu-panel']}`}
        hidden={!submenuVisible}
        ref={submenuRef}
        role="menu"
      >
        {thinkingPresentation.rows.length === 0 && (
          <button type="button" role="menuitemradio" aria-checked={!ultraMode}
            disabled={ultraPending || thinkingPending} data-ultra-off-row="true"
            className={`kls-select-item${ultraMode ? '' : ' is-selected'}`}
            onClick={event => { event.stopPropagation(); void saveUltraMode(false) }}>
            <span className="kls-select-item-copy">
              <span className="kls-select-item-label">{tt('klaus_default')}</span>
            </span>
          </button>
        )}
        {thinkingPresentation.rows.map(row => {
          // Ultra owns the single check while it is on; the native rung keeps
          // its stored value underneath and takes the check back on leaving.
          const selected = !ultraMode && row.selected
          return (
            <button
              key={row.value}
              type="button"
              disabled={thinkingPending || ultraPending}
              role="menuitemradio"
              aria-checked={selected}
              className={`kls-select-item${selected ? ' is-selected' : ''}`}
              onClick={(event) => {
                event.stopPropagation()
                void chooseThinkingLevel(row.value)
              }}
            >
              <span className="kls-select-item-copy">
                <span className="kls-select-item-label">{row.label}</span>
              </span>
            </button>
          )
        })}
        {/* The local orchestration mode is a member of this menu: one radio row
            after the native rungs, checked while the mode is on. */}
        <button
          type="button"
          disabled={ultraPending || thinkingPending}
          aria-busy={ultraPending}
          role="menuitemradio"
          aria-checked={ultraMode}
          data-ultra-row="true"
          className={`kls-select-item${ultraMode ? ' is-selected' : ''}`}
          onClick={(event) => {
            event.stopPropagation()
            void saveUltraMode(true)
          }}
        >
          <span className="kls-select-item-copy">
            <span className="kls-select-item-label">{tt('thinking_ultra')}</span>
          </span>
        </button>
      </div>
    </>
  )
}

const modelSelectRoots = new Map<HTMLElement, Root>()

/**
 * 挂载模型菜单到 root（对齐 bindMainModelMenu 签名与返回 api）。root 的
 * title/data-i18n-title 迁到 trigger（旧版同款处理）；open 类经 store 订阅
 * 同步到 root（样式钩子）。
 */
export function mountModelSelect(
  root: HTMLElement | null,
  { onEmptyClick, onFastModeChange, getSessionId }: MountModelSelectOptions = {},
): ModelSelectApi | null {
  if (!root) return null
  const titleKey = root.dataset.i18nTitle || ''
  const title = titleKey ? tt(titleKey) : (root.getAttribute('title') || '')
  root.removeAttribute('title')
  root.removeAttribute('data-i18n-title')

  const store = createStore<ModelSelectState>(() => ({
    items: [],
    value: '',
    unavailable: false,
    loading: false,
    disabled: false,
    thinkingLevel: 'medium',
    thinkingPending: false,
    ultraMode: false,
    ultraPending: false,
    ultraConfirmation: null,
    fastMode: false,
    fastModeSupported: false,
    fastModePending: false,
    open: false,
    submenuOpen: false,
    runtime: null,
  })) as StoreApi<ModelSelectState>
  const sessionId = () => modelSelectSessionId(getSessionId?.())
  let scope = sessionId()
  let fastModeSaveRevision = 0
  let thinkingSaveRevision = 0
  let thinkingPersistencePending = false
  let thinkingPersistenceToken: symbol | null = null
  const modelSaver = createPreferenceSaver({
    getSessionId: sessionId,
    getValue: () => store.getState().value,
    setValue: value => store.setState({ value, open: false, submenuOpen: false }),
    onError: error => {
      console.warn('[main-model] set failed:', error)
      showToast(preferenceSaveFailureText(error instanceof Error ? error.message : String(error)))
      w().refreshComposerPreferences?.()
      w().refreshSideModelButton?.()
    },
  })
  const thinkingSaver = createPreferenceSaver({
    getSessionId: sessionId,
    getValue: () => ({ level: store.getState().thinkingLevel, ultraMode: store.getState().ultraMode }),
    isEqual: (left, right) => left.level === right.level && left.ultraMode === right.ultraMode,
    setValue: selection => store.setState({ thinkingLevel: selection.level, ultraMode: selection.ultraMode, open: false, submenuOpen: false }),
    onError: error => {
      console.warn('[thinking-level] set failed:', error)
      showToast(preferenceSaveFailureText(error instanceof Error ? error.message : String(error)))
      w().refreshComposerPreferences?.()
      w().refreshSideModelButton?.()
    },
  })
  const fastModeSaver = createPreferenceSaver({
    getSessionId: sessionId,
    getValue: () => store.getState().fastMode,
    setValue: fastMode => store.setState({ fastMode }),
    onError: error => {
      console.warn('[codex-fast-mode] set failed:', error)
      showToast(preferenceSaveFailureText(error instanceof Error ? error.message : String(error)))
      w().refreshComposerPreferences?.()
      w().refreshSideModelButton?.()
    },
  })
  const thinkingSelection = createThinkingSelection({
    getSelection: () => ({ sessionId: sessionId(), level: store.getState().thinkingLevel, model: store.getState().value }),
    save: async (level, id) => {
      const token = Symbol()
      thinkingPersistenceToken = token
      thinkingPersistencePending = true
      try {
        await thinkingSaver.save({ level, ultraMode: false }, async value => {
          await w().klaus.session.setThinkingLevel(value.level, id, { ultraMode: false })
          await Promise.all([w().refreshComposerPreferences?.(), w().refreshSideModelButton?.()])
        })
      } finally {
        if (thinkingPersistenceToken === token) {
          thinkingPersistencePending = false
          thinkingPersistenceToken = null
        }
      }
    },
    onError: error => {
      showToast(preferenceSaveFailureText(error instanceof Error ? error.message : String(error)))
    },
  })
  const ultraSaver = createPreferenceSaver({
    getSessionId: sessionId,
    getValue: () => store.getState().ultraMode,
    setValue: ultraMode => store.setState({ ultraMode, open: false, submenuOpen: false }),
    onError: error => {
      console.warn('[ultra-mode] set failed:', error)
      showToast(preferenceSaveFailureText(error instanceof Error ? error.message : String(error)))
      w().refreshComposerPreferences?.()
      w().refreshSideModelButton?.()
    },
  })
  const ultraSelection = createUltraSelection({
    getSelection: () => ({ sessionId: sessionId(), enabled: store.getState().ultraMode, model: store.getState().value }),
    getPermission: () => w().klaus.session.getPermissionMode(sessionId()),
    confirm: () => new Promise(resolve => {
      store.setState({ open: false, submenuOpen: false, ultraConfirmation: decision => {
        store.setState({ ultraConfirmation: null })
        resolve(decision)
      } })
    }),
    save: async (enabled, id, permissionMode) => {
      await ultraSaver.save(enabled, async value => {
        await w().klaus.session.setUltraMode(value, id, permissionMode ? { permissionMode } : undefined)
        await Promise.all([w().refreshComposerPreferences?.(), w().refreshSideModelButton?.()])
      })
    },
    onError: error => {
      showToast(preferenceSaveFailureText(error instanceof Error ? error.message : String(error)))
    },
  })
  const syncScope = () => {
    const next = sessionId()
    if (next === scope) return
    scope = next
    thinkingSelection.invalidate()
    ultraSelection.invalidate()
    store.getState().ultraConfirmation?.('cancel')
    thinkingSaveRevision++
    thinkingPersistencePending = false
    thinkingPersistenceToken = null
    modelSaver.invalidate()
    thinkingSaver.invalidate()
    fastModeSaver.invalidate()
    ultraSaver.invalidate()
    fastModeSaveRevision++
    ultraSaveRevision++
    store.setState({ runtime: null, thinkingLevel: 'medium', ultraMode: false, fastMode: false, fastModePending: false, thinkingPending: false, ultraPending: false, open: false, submenuOpen: false })
  }
  store.subscribe((state) => {
    root.classList.toggle('open', state.open)
  })
  registerOverlay(overlayIdForElement(root, 'model-select'), () => {
    store.setState({ open: false, submenuOpen: false })
  })

  let reactRoot = modelSelectRoots.get(root)
  let ultraSaveRevision = 0
  if (!reactRoot) {
    reactRoot = createRoot(root)
    modelSelectRoots.set(root, reactRoot)
  }
  reactRoot.render(
    <ModelSelectMenu
      store={store}
      onEmptyClick={onEmptyClick}
      saveModel={mode => {
        syncScope()
        return modelSaver.save(mode, (value, id) => w().klaus.session.setMainModel(value, id))
      }}
      saveThinkingLevel={async level => {
        syncScope()
        if (store.getState().thinkingPending) return
        const revision = ++thinkingSaveRevision
        store.setState({ thinkingPending: true })
        try { await thinkingSelection.choose(level) }
        finally { if (revision === thinkingSaveRevision) store.setState({ thinkingPending: false }) }
      }}
      saveUltraMode={async enabled => {
        syncScope()
        if (store.getState().ultraPending) return
        const revision = ++ultraSaveRevision
        store.setState({ ultraPending: true })
        try { await ultraSelection.choose(enabled) }
        finally { if (revision === ultraSaveRevision) store.setState({ ultraPending: false }) }
      }}
      saveFastMode={enabled => {
        syncScope()
        if (store.getState().fastModePending) return Promise.resolve()
        const revision = ++fastModeSaveRevision
        store.setState({ fastModePending: true })
        onFastModeChange?.()
        return fastModeSaver.save(enabled, async (value, id) => {
          await w().klaus.session.setFastMode(value, id)
          await Promise.all([w().refreshComposerPreferences?.(), w().refreshSideModelButton?.()])
        }).finally(() => {
          if (revision === fastModeSaveRevision) store.setState({ fastModePending: false })
        })
      }}
      rootEl={root}
      titleKey={titleKey}
      title={title}
    />,
  )

  return {
    close() { store.setState({ open: false, submenuOpen: false }) },
    setDisabled(disabled) { store.setState({ disabled, ...(disabled ? { open: false, submenuOpen: false } : {}) }) },
    setItems(next, { value: nextValue, thinkingLevel: nextThinkingLevel, ultraMode: nextUltraMode, fastMode: nextFastMode, fastModeSupported: nextFastSupported, fastModeBilling: nextFastBilling, unavailable = false, loading = false } = {}) {
      syncScope()
      modelSaver.invalidate()
      if (!thinkingPersistencePending) thinkingSaver.invalidate()
      const items = concreteMainModelItems(next)
      const value = mainModelMenuValue(items, nextValue ?? store.getState().value)
      const previous = store.getState()
      const fastSource = (selection: string) => selection.split(':', 1)[0]
      const sourceChanged = !loading && fastSource(previous.value) !== fastSource(value)
      const fastModePending = previous.fastModePending && !sourceChanged
      // A catalog seed or a read started before this save cannot supersede its
      // optimistic value or suppress its eventual failure. Scope/source changes
      // still invalidate the pending save's UI callbacks.
      if (!fastModePending) fastModeSaver.invalidate()
      if (sourceChanged) fastModeSaveRevision++
      const nativeFast = value.startsWith('cursor:') ? cursorFastMode(modelOptionForValue(items, value), value).enabled : nextFastMode
      const fastMode = fastModePending ? previous.fastMode : nativeFast ?? (sourceChanged ? false : previous.fastMode)
      let thinkingLevel = store.getState().thinkingLevel
      if (!thinkingPersistencePending && isThinkingLevelForModel(modelOptionForValue(items, value), nextThinkingLevel)) thinkingLevel = nextThinkingLevel
      if (!thinkingPersistencePending && (value !== previous.value || thinkingLevel !== previous.thinkingLevel)) {
        thinkingSelection.invalidate()
        ultraSelection.invalidate()
        store.getState().ultraConfirmation?.('cancel')
      }
      const ultraMode = thinkingPersistencePending || previous.ultraPending ? previous.ultraMode : nextUltraMode ?? previous.ultraMode
      // The stored level goes into state UNCLAMPED. What the control shows is
      // derived from it per model at render time (displayLevel), so a level the
      // current model cannot honor displays as the rung it will use while the
      // pick itself stays intact for the next model that can honor it. Clamping
      // here used to bake the downgrade into the state, which is what made it
      // survive the return trip and misreport the pick.
      const selected = modelOptionForValue(items, value)
      const fastModeSupported = value.startsWith('cursor:') ? cursorFastMode(selected, value).supported
        : nextFastSupported ?? selected?.supportsFastMode === true
      const fastModeBilling = nextFastBilling ?? selected?.fastBilling
      store.setState({ items, value, thinkingLevel, ultraMode, fastMode, fastModeSupported, fastModeBilling, fastModePending, unavailable, loading, ...(loading ? { open: false, submenuOpen: false } : {}) })
    },
    setValue(nextValue) {
      syncScope()
      modelSaver.invalidate()
      store.setState(state => ({ value: mainModelMenuValue(state.items, nextValue) }))
    },
    setRuntime(next) {
      syncScope()
      const previous = store.getState().runtime
      if (previous?.modelUpdate === next?.modelUpdate && previous?.currentInference === next?.currentInference
        && previous?.running === next?.running && previous?.streamMode === next?.streamMode) return
      store.setState({ runtime: next ? {
        running: next.running,
        streamMode: next.streamMode,
        currentInference: next.currentInference,
        modelUpdate: next.modelUpdate,
      } : null })
    },
    refresh() {
      syncScope()
      ;(store as any).__forceRender?.()
    },
  }
}
