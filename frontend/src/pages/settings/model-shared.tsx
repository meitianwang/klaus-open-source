import { modelOptionForValue } from '../../../../shared/cursor-model-catalog'
// Shared model-source presentation, global tier references and source sections.
// Historical source maps remain readable for compatibility, but have no writer.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import type { GlobalModelTierMapping, GlobalModelTierOptions, ModelTierName, ModelTierReference } from '../../../bridge/types'
import { t as tGlobal } from '../../i18n'
import { rawIconHtml } from '../../components/Icon'
import styles from './settings.module.css'

const w = () => window as any

export interface ModelTier {
  tier: ModelTierName
  selectId: string
  labelKey: string
  hintKey: string
  badgeKey: string
}

// 档位词汇全产品统一为高中低；存储键与引擎档位名同源。
export const MODEL_TIERS: ModelTier[] = [
  { tier: 'high', selectId: 'model-map-high', labelKey: 'model_map_high', hintKey: 'model_map_high_hint', badgeKey: 'model_map_badge_high' },
  { tier: 'medium', selectId: 'model-map-medium', labelKey: 'model_map_medium', hintKey: 'model_map_medium_hint', badgeKey: 'model_map_badge_medium' },
  { tier: 'low', selectId: 'model-map-low', labelKey: 'model_map_low', hintKey: 'model_map_low_hint', badgeKey: 'model_map_badge_low' },
]

// 自带订阅与自定义源：官方云端与端侧来源已退役，默认落在自定义源。
export const AUTH_MODE_ORDER = ['subscription', 'codex', 'cursor', 'qoder', 'qwenwork', 'qoderwork', 'workbuddy', 'antigravity', 'trae', 'kiro', 'kimi', 'bailian', 'minimax', 'zhipu', 'ark', 'custom']

export function normalizeAuthMode(mode: string): string {
  return AUTH_MODE_ORDER.includes(mode) ? mode : 'custom'
}

function normalizedSessionId(sessionId: string | null | undefined): string | undefined {
  const normalized = String(sessionId || '').trim()
  return normalized || undefined
}

// The host owns both the conversation source and the next-conversation default.
// An unresolved model still has a persisted source; never infer it from global
// preferences or another conversation's selection.
export async function effectiveModelSource(
  sessionId: string | null | undefined = w().currentSessionId,
): Promise<string> {
  const saved = await w().klaus.session.getMainModel(normalizedSessionId(sessionId), { resolve: false })
  return normalizeAuthMode(saved.source)
}

// Persist the source and its default selection together. The host updates only
// this conversation and the defaults used for future conversations.
export async function activateModelSource(
  source: string,
  sessionId: string | null | undefined = w().currentSessionId,
): Promise<void> {
  const normalized = normalizeAuthMode(source)
  await w().klaus.session.setMainModel('auto', normalizedSessionId(sessionId), normalized)
  window.dispatchEvent(new Event('klaus:auth-mode-changed'))
}

// 模型来源的名字：设置页的档位行、生图「跟随来源」文案用同一份，避免两处各叫一名。
export function sourceLabel(source: string, translate: (key: string) => string = tGlobal): string {
  if (source === 'subscription') return translate('auth_subscription')
  if (source === 'codex') return translate('auth_codex')
  if (source === 'cursor') return translate('auth_cursor')
  if (source === 'qoder') return translate('auth_qoder')
  if (source === 'qwenwork') return translate('auth_qwenwork')
  if (source === 'qoderwork') return translate('auth_qoderwork')
  if (source === 'workbuddy') return translate('auth_workbuddy')
  if (source === 'antigravity') return translate('auth_antigravity')
  if (source === 'trae') return translate('auth_trae')
  if (source === 'kiro') return translate('auth_kiro')
  if (source === 'kimi') return translate('auth_kimi')
  if (source === 'bailian') return translate('auth_bailian')
  if (source === 'minimax') return translate('auth_minimax')
  if (source === 'zhipu') return translate('auth_zhipu')
  if (source === 'ark') return translate('auth_ark')
  if (source === 'custom') return translate('sub_custom_mode_btn')
  return source
}

// Brand marks for model-source rows, shared by every settings surface that
// picks a source. Provider tiles keep their official logos; unbranded entries
// (the Claude subscription glyph, the custom endpoint globe, the built-in
// network globe and the system voice input mic) use neutral glyphs so every
// row reads at the same visual weight as the chat source menu.
const SOURCE_LOGO_FILES: Record<string, string> = {
  codex: 'codex-logo.png',
  cursor: 'cursor-logo.png',
  qoder: 'qoder-logo.png',
  qwenwork: 'qwenwork-logo.png',
  qoderwork: 'qoderwork-logo.png',
  workbuddy: 'import-workbuddy-logo.svg',
  antigravity: 'antigravity-logo.svg',
  trae: 'trae-logo.svg',
  kiro: 'kiro-logo.png',
  kimi: 'kimi-icon-rounded-corner.png',
  bailian: 'bailian-logo.svg',
  minimax: 'minimax-logo.svg',
  zhipu: 'zhipu-logo.png',
  ark: 'ark-logo.png',
}

/** Icon markup for one source value ('' for rows without a mark). */
export function modelSourceIconHtml(source: string): string {
  const bare = source.startsWith('subscription:') ? source.slice('subscription:'.length) : source
  const logo = SOURCE_LOGO_FILES[bare]
  if (logo) return `<img src="${logo}" alt="" class="kls-select-source-logo" />`
  if (bare === 'subscription' || bare === 'claude') return rawIconHtml('auth-mode')
  if (bare === 'custom') return rawIconHtml('auth-mode-2')
  if (bare === 'builtin') return rawIconHtml('settings-nav-engine-web')
  if (bare === 'system') return rawIconHtml('settings-nav-voice-input')
  return ''
}

// Every surface that picks a model source renders the same rows: a provider
// mark in front of the label, mirrored onto the closed trigger. Wrapping
// KlsSelect here keeps the icon mapping and the narrow panel in one place
// instead of re-deriving it per page.
export function ModelSourceSelect({ className, items, ...rest }: {
  id?: string
  className: string
  items: any[]
  value: string
  disabled?: boolean
  bindKey: string
  labelId?: string
  ariaLabel?: string
  onChange: (value: string) => void
}) {
  const withIcons = items.map(item => ({ ...item, iconHtml: item.iconHtml ?? modelSourceIconHtml(String(item.value ?? '')) }))
  // Source menus keep the selected row in the list with its check mark — the
  // same shape as the chat source menu — instead of hiding it.
  return <KlsSelect className={`kls-select--source ${className}`} items={withIcons} hideSelected={false} {...rest} />
}

export async function loadGlobalModelTierMappings(): Promise<GlobalModelTierMapping> {
  const result = await w().settingsApi.models.getTiers()
  if (result?.ok !== true || !result.mapping) throw new Error(result?.error || tGlobal('settings_section_load_failed'))
  return result.mapping
}

export async function loadGlobalModelTierOptions(): Promise<GlobalModelTierOptions> {
  const result = await w().settingsApi.models.tierOptions()
  if (result?.ok !== true || !Array.isArray(result.sources)) throw new Error(result?.error || tGlobal('settings_section_load_failed'))
  return result
}

export async function saveGlobalModelTier(tier: ModelTierName, target: ModelTierReference | null, expectedRevision: number): Promise<GlobalModelTierMapping> {
  const result = await w().settingsApi.models.setTier(tier, target, expectedRevision)
  if (result?.ok !== true || !result.mapping) throw new Error(result?.error || tGlobal('settings_failed'))
  return result.mapping
}

export function modelReferenceLabel(reference: ModelTierReference | null, options: GlobalModelTierOptions | null): string {
  if (!reference) return tGlobal('model_mapping_follow_default')
  const model = modelOptionForValue(options?.sources.find(row => row.source === reference.source)?.options || [], reference.modelId)
  return model?.label || reference.modelId
}

export function mappedModelTiers(mapping: GlobalModelTierMapping | null, source: string, modelId: string): ModelTierName[] {
  return MODEL_TIERS.filter(row => mapping?.[row.tier]?.source === source && mapping[row.tier]?.modelId === modelId).map(row => row.tier)
}

export function modelOptionLabel(model: any): string {
  return model?.name || model?.model || tGlobal('model_mapping_unknown')
}

// The engine answers a per-source model catalog request for a source with no
// stored login with a human sentence, not an error code. That is an expected
// state the account card above already shows with its login button, so
// sections fed by the catalog hide instead of rendering a failure card.
// The sentence comes in two word orders depending on which engine module
// builds it — "not signed in to a … subscription" from the shared source
// table, "… subscription is not signed in" from the per-source catalogs
// (WorkBuddy, Qoder, QwenWork, Kimi membership) — so the check matches the
// bare "not signed in" phrase both share. The other catalog refusals
// ("expired and cannot be renewed", "not reachable from this build") do not
// contain that phrase, so a real outage still surfaces as a failure.
export function isSourceNotSignedIn(error: unknown): boolean {
  return typeof error === 'string' && error.includes('not signed in')
}

// ---- Per-source tier mappings (every source stores the same tier-keyed map) ----
// `model_tiers:<source>` 存 JSON {"high": ..., "medium": ..., "low": ...}，值是
// 该来源自己的 id 空间（订阅别名 / Codex 目录 id / Qoder key / 端侧已装模型 id /
// 自定义提供方条目 id）。
const TIER_STORAGE_PREFIX = 'model_tiers:'

function parseStoredTierMap(raw: string | undefined | null): Record<string, string> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, string> = {}
    for (const tier of ['high', 'medium', 'low']) {
      const value = typeof parsed[tier] === 'string' ? parsed[tier].trim() : ''
      if (value) out[tier] = value
    }
    return out
  } catch {
    return {}
  }
}

// Read-only compatibility for historical source maps. New settings never write them.
export async function loadSourceTierMappings(source: string): Promise<Record<string, string>> {
  const settingsApi = w().settingsApi
  return parseStoredTierMap(await settingsApi.kv.get(`${TIER_STORAGE_PREFIX}${source}`))
}

export function KlsSelect({ id, className, items, value, disabled, bindKey, labelId, ariaLabel, hideSelected = true, onChange }: {
  id?: string
  className: string
  items: any[]
  value: string
  disabled?: boolean
  bindKey: string
  labelId?: string
  ariaLabel?: string
  /** Keep the selected row visible with its check mark instead of hiding it. */
  hideSelected?: boolean
  onChange: (value: string) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange
  useLayoutEffect(() => {
    if (!hostRef.current) return
    w().klsSelect.bind(hostRef.current, {
      items, value, disabled, hideSelected,
      onChange: (next: string) => onChangeRef.current(next),
    })
    const trigger = hostRef.current.querySelector('[role="combobox"], button')
    if (labelId) trigger?.setAttribute('aria-labelledby', labelId)
    if (ariaLabel) trigger?.setAttribute('aria-label', ariaLabel)
  }, [bindKey, labelId])
  useEffect(() => {
    const host = hostRef.current
    return () => { (host as any)?.__klsSelect?.destroy?.() }
  }, [])
  return <div id={id} className={className} ref={hostRef} onKeyDown={event => {
    if (!labelId || disabled) return
    const host = event.currentTarget
    const item = (event.target as HTMLElement).closest<HTMLButtonElement>('.kls-select-item')
    if ((event.key === 'Enter' || event.key === ' ') && item) {
      event.preventDefault()
      if (item.getAttribute('aria-disabled') !== 'true') item.click()
      host.querySelector<HTMLElement>('.kls-select-trigger')?.focus()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    ;(host as any).__klsSelect?.open()
    const choices = Array.from(host.querySelectorAll<HTMLButtonElement>('.kls-select-item:not([aria-disabled="true"])'))
    const index = choices.indexOf(document.activeElement as HTMLButtonElement)
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1
      : event.key === 'ArrowDown' ? (index + 1) % choices.length
        : index < 0 ? choices.length - 1 : (index - 1 + choices.length) % choices.length
    choices[next]?.focus()
  }} />
}

// ---- 模型来源分区骨架（语言模型 / 生图 / 生视频 三处同一实现） ----
// 一个分区 = 标题 + （可选）档位分段控件 + 当前档正文，三段的纵向节奏由本组件给定。
// 过去三处各写一遍：段控件和正文卡是彼此无关的两个块，间距靠各自的 margin 叠出来，
// 正文卡里还重复一遍分区标题，于是同一种结构在三个分区里长出三种样子。
// 正文只负责填内容，标题只出现在分区头，间距只由这里控制。
export interface ModelSourceTab {
  value: string
  label: string
}

// 档位分段控件本体。单独导出是因为模型页顶部的「选哪一套模型配置」不属于任何
// 一个分区：它管着整页（语言模型/生图/生视频/顾问四个分区都跟着它走）。
export function ModelSourceTabs({ name, tabs, value, onChange, disabled, ariaLabel }: {
  name: string
  tabs: ModelSourceTab[]
  value: string
  onChange: (next: string) => void
  disabled?: boolean
  ariaLabel?: string
}) {
  return (
    // 选中态由 aria-selected 单独表达：可访问性与样式同一个真相源，不再靠外挂 active 类。
    <div className={styles['source-tabs']} role="tablist" aria-label={ariaLabel} data-source-tabs={name}>
      {tabs.map(tab => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={value === tab.value}
          disabled={disabled}
          className={styles['source-tab']}
          data-source-tab={tab.value}
          onClick={() => { onChange(tab.value) }}
        >{tab.label}</button>
      ))}
    </div>
  )
}

export function ModelSourceSection({ name, title, desc, tabs, value, onChange, disabled, action, children }: {
  name: string
  title: string
  /** Optional one-line description under the title; same 6px title-to-desc
   *  rhythm as the page header and the routed section headings. */
  desc?: string
  tabs?: ModelSourceTab[]
  value?: string
  onChange?: (next: string) => void
  disabled?: boolean
  /** A control that sits on the section title row, right-aligned — the place
   *  the "+ add model" button lives so every model section reads the same. */
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="settings-section">
      <div className={styles['settings-section-heading']}>
        <div className={styles['settings-section-title-row']}>
          <div className="settings-section-title">{title}</div>
          {action ? <div className={styles['settings-section-title-action']}>{action}</div> : null}
        </div>
        {desc ? <p className={styles['settings-section-hint']}>{desc}</p> : null}
      </div>
      {tabs && tabs.length > 0 ? (
        <ModelSourceTabs name={name} tabs={tabs} value={value || ''} onChange={onChange || (() => {})} disabled={disabled} ariaLabel={title} />
      ) : null}
      <div className={styles['source-section-body']}>{children}</div>
    </section>
  )
}

// ---- 端侧下载展示件（models tab 的语言模型档与 gen-tabs 的本地推理档共用） ----
// 大文件起步阶段百分比 <0.5% 会被取整抹零，条看不见：宽度保留小数，且有字节就给最小可见宽。

export function localDlWidth(dl: any): string {
  if (!dl || !(dl.totalBytes > 0)) return '0%'
  const pct = Math.min(100, dl.receivedBytes / dl.totalBytes * 100)
  return `${Math.max(dl.receivedBytes > 0 ? 0.4 : 0, pct).toFixed(2)}%`
}

export function localFormatBytes(bytes: unknown): string {
  const n = Number(bytes || 0)
  if (n >= 1024 * 1024 * 1024) {
    const gb = n / (1024 * 1024 * 1024)
    return gb >= 10 ? `${Math.round(gb)} GB` : `${gb.toFixed(1)} GB`
  }
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MB`
  return `${Math.max(0, Math.round(n / 1024))} KB`
}

// 上下文窗口的读法：200000 → 200K，1048576 → 1M。模型卡片不能显示模型 id（那是
// 上游模型名），上下文容量是剩下的那个既能区分模型、又不透露供应商的事实。
// 厂商的计数习惯分两派：二进制窗口（32768、262144、1048576，即 1024 的整数幂倍）
// 按 Ki 读，十进制窗口（200000、1000000）按千读。单一除数会把 200000 读成 195K
// 或把 32768 读成 33K，所以按值本身属于哪一派选除数。
function isPowerOfTwo(n: number): boolean {
  return n >= 1 && (n & (n - 1)) === 0
}

export function compactTokens(tokens: unknown): string {
  const n = Number(tokens || 0)
  if (!Number.isFinite(n)) return '0K'
  const binary = n % 1024 === 0 && isPowerOfTwo(n / 1024)
  if (n >= 1000 * 1000) {
    const m = binary ? n / (1024 * 1024) : n / (1000 * 1000)
    return Math.abs(m - Math.round(m)) < 0.05 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`
  }
  return `${Math.round(n / (binary ? 1024 : 1000))}K`
}

// 自定义模型表单的上下文档位：厂商公布的窗口都是这几个固定值，让用户背数字没有
// 意义。value 是入库的 maxContextTokens 原值（十进制计数），label 直接写死而不走
// i18n——「128K / 1M」这类读数两种语言同形，翻译反而引入分叉。
export const CONTEXT_TIER_CUSTOM = 'custom'

export const CONTEXT_TIER_OPTIONS: Array<{ value: string; tokens: number; label: string }> = [
  { value: '131072', tokens: 131_072, label: '128K' },
  { value: '200000', tokens: 200_000, label: '200K' },
  { value: '262144', tokens: 262_144, label: '256K' },
  { value: '1048576', tokens: 1_048_576, label: '1M' },
]

export const CONTEXT_TIER_DEFAULT = '200000'

// 已存的窗口值落到档位：命中固定档就选中它，其余（老数据、端侧模型的 8192 等）
// 一律归到「自定义」，数字输入行原样回显，不替用户改值。
export function contextTierForTokens(tokens: unknown): string {
  const n = Number(tokens)
  if (!Number.isFinite(n) || n <= 0) return CONTEXT_TIER_DEFAULT
  const hit = CONTEXT_TIER_OPTIONS.find(item => item.tokens === n)
  return hit ? hit.value : CONTEXT_TIER_CUSTOM
}

export function LocalDlBar({ id, dl, onCancel }: { id: string; dl: any; onCancel: (id: string) => void }) {
  return (
    <div className={styles['local-dl']} data-local-progress={id}>
      <div className={styles['local-dl-bar']}><span style={{ width: localDlWidth(dl) }} /></div>
      <span className={styles['local-dl-text']}>{`${localFormatBytes(dl.receivedBytes)}${dl.totalBytes > 0 ? ` / ${localFormatBytes(dl.totalBytes)}` : ''}`}</span>
      <button className="btn-xs" data-local-cancel={id} onClick={() => onCancel(id)}>{tGlobal('cancel')}</button>
    </div>
  )
}
