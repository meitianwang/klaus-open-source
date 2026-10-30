// Sources configures provider accounts and endpoints.
import { useEffect, useRef, useState } from 'react'
import { useT, t as tGlobal } from '../../i18n'
import { ModalPortal } from '../../components/ModalPortal'
import type { GlobalModelTierMapping } from '../../../bridge/types'
import {
  activateModelSource, AUTH_MODE_ORDER, CONTEXT_TIER_CUSTOM, CONTEXT_TIER_OPTIONS,
  contextTierForTokens, MODEL_TIERS, ModelSourceTabs,
  compactTokens, loadGlobalModelTierMappings, mappedModelTiers, KlsSelect,
  normalizeAuthMode,
  sourceLabel,
} from './model-shared'
import { SettingsPage } from './kv'
import { Loading, SUBSCRIPTION_SOURCES, SubscriptionCardBody } from './subscription-card'
import styles from './settings.module.css'

const w = () => window as any

// Browsing a provider tab does not select a global media backend.
const SETTINGS_MODEL_CATEGORY_ORDER = AUTH_MODE_ORDER

// 模型设置当前看的那一档（不等于生效的 auth_mode：未连接的来源只能看，不能生效）。
// 模块级跨挂载保留；聊天页模型来源菜单经 setModelSettingsCategory 预设落点。
let modelSettingsCategory: string | null = null

// The tier-mapping snapshot survives remounts for the same reason the category
// does: a host settings write remounts the whole settings tab, and a remounted
// page that drops to skeletons while it re-reads what it was already showing
// reads as the page flashing. The cache only seeds the first paint; the reads
// below still refresh it on every mount and change event.
let modelTierMappingCache: GlobalModelTierMapping | null = null

// Same rationale for the custom model list: it is what the custom source's body
// shows, and a remount must not blank it while the list is re-read.
let customModelsCache: { models: any[] } | null = null

// 外部入口（聊天页模型来源菜单）指定模型页落在哪一档：不写它就只能停在生效中的 auth_mode。
export function setModelSettingsCategory(category: string): void {
  if (!category) return
  modelSettingsCategory = normalizeAuthMode(category)
  window.dispatchEvent(new CustomEvent('klaus:model-settings-source', { detail: modelSettingsCategory }))
}

// ==================== Subscription sources ====================
// Every external subscription uses the same account card. Provider-specific APIs,
// labels, optional local import, and login flows live in these descriptors.
// Auxiliary tier mappings are shared across all sources.
// ==================== 共用小件 ====================

function LoadFailure({ message, retry }: { message?: string; retry: () => void }) {
  const t = useT()
  return (
    <div className="settings-card" role="alert">
      <div className="card-meta">{message || t('settings_section_load_failed')}</div>
      <div className="card-actions"><button type="button" className="btn-sm" onClick={retry}>{t('auth_status_retry')}</button></div>
    </div>
  )
}

// ==================== 自定义档（层级映射 + 模型 CRUD） ====================

// Provider presets: picking one fills the form with that vendor's endpoint and
// model id (all still editable), so the user only has to paste an API key.
// Kimi API is the open-platform pay-as-you-go service
// (api.moonshot.cn|ai/anthropic, model kimi-k3). These are all Anthropic-compatible
// endpoints: the provider value is stored as-is and session assembly's catch-all
// treats them as anthropic.
//
// Two former presets no longer appear in the dropdown. Kimi Code
// (api.kimi.com/coding/) has its own first-class source, where its key and
// quota are managed in one place; keeping a second copy here would let users
// paste the same key again outside that source. The Bailian Coding Plan preset
// (coding.dashscope.aliyuncs.com/apps/anthropic) is gone by product decision:
// it is a separate subscription whose keys are not interchangeable with the
// Token Plan source's, and a preset row that quietly accepted either key
// produced unexplained 401s; a Coding Plan subscriber can still reach the
// gateway through a plain Anthropic entry with the base URL filled in by hand.
// Custom models saved with those provider values keep working: editing one
// shows the stored provider as a disabled read-only row, see
// LEGACY_PROVIDER_LABELS.
type ProviderPreset = {
  model: string
  // 端点只认这一个模型：选中即落值，不当"空着才给的建议值"处理。
  singleModel?: boolean
  baseUrl?: string
  // 有国内/国际两个站的服务商：下拉切换区域，选中的区域决定 baseUrl。
  regions?: Array<{ value: string; i18nKey: string; baseUrl: string }>
  name?: string
  maxContextTokens?: number
  // 该模型真实支持的能力（引擎不再按模型名猜，由这里声明）。
  reasoningEffort?: string
  supportsThinking?: boolean
  supportsVision?: boolean
}

const MODEL_FORM_PROVIDER_PRESETS: Record<string, ProviderPreset> = {
  // 模型名以 Kimi API 文档为准：枚举就是 kimi-k3（K3 本身即 1M 上下文）。
  // Claude Code 接入指南里的 kimi-k3[1m] 是 Claude Code 客户端私有语法（发送时剥掉
  // 后缀换 1M beta header），引擎原样透传模型名，抄过来上游直接报 model not found。
  'kimi-api': {
    model: 'kimi-k3',
    singleModel: true,
    name: 'Kimi K3',
    maxContextTokens: 1_048_576,
    reasoningEffort: 'max',
    supportsThinking: true,
    // K3 官方模型参考：支持 1M 上下文与视觉理解。
    supportsVision: true,
    regions: [
      { value: 'cn', i18nKey: 'model_region_cn', baseUrl: 'https://api.moonshot.cn/anthropic' },
      { value: 'global', i18nKey: 'model_region_global', baseUrl: 'https://api.moonshot.ai/anthropic' },
    ],
  },
  deepseek: { baseUrl: 'https://api.deepseek.com/anthropic', model: 'deepseek-v4-flash' },
}

// Providers that used to be form presets and may still be stored on existing
// custom models. They are not offered to new models (each product has its own
// first-class source now), but an edit form must still name the stored provider
// instead of showing an empty trigger, so the row renders disabled and
// unselectable.
const LEGACY_PROVIDER_LABELS: Record<string, string> = {
  kimi: 'Kimi Code',
  bailian: 'Bailian Coding Plan',
}

// 编辑态的接入区域从已存的 baseUrl 反推，不额外存字段：认不出来就落在第一个区域。
function presetRegionOf(provider: string | undefined, baseUrl: string | undefined): string {
  const regions = MODEL_FORM_PROVIDER_PRESETS[provider || '']?.regions
  if (!regions) return ''
  return (regions.find(item => item.baseUrl === (baseUrl || '')) || regions[0]).value
}

// Add/edit 二合一：editing=null 是 add，带 model 是 edit（后端 upsert 支持带 id 更新）。
// `embedded` hosts the form inside the unified add dialog, which owns the
// overlay and head; the form then contributes only its body and foot.
export function ModelFormModal({ existing, onClose, onSaved, embedded }: { existing: any; onClose: () => void; onSaved: () => void; embedded?: boolean }) {
  const t = useT()
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [provider, setProvider] = useState<string>(existing?.provider || 'anthropic')
  const [region, setRegion] = useState<string>(presetRegionOf(existing?.provider, existing?.baseUrl))
  const nameRef = useRef<HTMLInputElement>(null)
  const modelRef = useRef<HTMLInputElement>(null)
  const apiKeyRef = useRef<HTMLInputElement>(null)
  const baseUrlRef = useRef<HTMLInputElement>(null)
  const tokensRef = useRef<HTMLInputElement>(null)
  // 上下文窗口走档位下拉：厂商公布的窗口就那几个固定值，让用户背数字没有意义。
  // 档位是 state 因为它决定「自定义」数字输入行的显隐；入库值仍是 maxContextTokens。
  const [contextTier, setContextTier] = useState<string>(contextTierForTokens(existing?.maxContextTokens ?? 200000))
  // 自定义行的种子值：编辑老模型时是已存值；从固定档切到自定义时继承该档的 token
  // 数，用户在那个数字上微调，而不是被重置回默认值。
  const [customSeed, setCustomSeed] = useState<number>(Number(existing?.maxContextTokens) || 200000)
  const openaiApiRef = useRef(existing?.openaiApi || 'chat')
  // Anthropic wire key carrier: gateways in front of the Messages surface
  // sometimes validate only the bearer scheme. The stored default stays the
  // native header, so an untouched form changes nothing.
  const authSchemeRef = useRef(existing?.authScheme === 'bearer' ? 'bearer' : 'x-api-key')
  // Declared capabilities (the engine reads these instead of guessing from the
  // model id): a reasoning tier + an extended-thinking toggle.
  const reasoningRef = useRef(existing?.reasoningEffort || 'none')
  const thinkingRef = useRef<HTMLInputElement>(null)
  const visionRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onSave = async () => {
    if (saving) return
    // New model MUST have an API key; edit without re-typing keeps the existing one.
    const keyValue = apiKeyRef.current?.value?.trim() || ''
    if (!existing && !keyValue) {
      apiKeyRef.current?.focus()
      return
    }
    const now = Date.now()
    // 编辑时保留 createdAt / role / cost_* 等未暴露字段。
    const base = existing ? { ...existing } : { id: crypto.randomUUID(), isDefault: false, createdAt: now }
    // openaiApi 仅对 OpenAI 端点有意义；非 openai 时清掉（避免编辑切换后残留）。
    const openaiApi = provider === 'openai' ? (openaiApiRef.current || 'chat') : undefined
    // authScheme 只对 Anthropic wire 有意义；其他端点清掉避免切换后残留。
    const authScheme = provider === 'anthropic' && authSchemeRef.current === 'bearer' ? 'bearer' : undefined
    setSaving(true)
    setSaveError('')
    try {
      const result = await w().settingsApi.models.upsert({
        ...base,
        name: nameRef.current?.value?.trim() || 'Untitled',
        provider,
        model: modelRef.current?.value?.trim() || 'claude-sonnet-4-20250514',
        apiKey: apiKeyRef.current?.value?.trim() || undefined,
        baseUrl: baseUrlRef.current?.value?.trim() || undefined,
        openaiApi,
        authScheme,
        maxContextTokens: contextTier === CONTEXT_TIER_CUSTOM
          ? parseInt(tokensRef.current?.value?.trim() || '') || 200000
          : Number(contextTier),
        thinking: base.thinking || 'off',
        // Client-declared capability set for this model system.
        reasoningEffort: reasoningRef.current || 'none',
        supportsThinking: thinkingRef.current?.checked === true,
        supportsVision: visionRef.current?.checked === true,
        updatedAt: now,
      })
      if (result?.ok === false || result?.error) throw new Error(result.error || t('settings_failed'))
      window.dispatchEvent(new Event('klaus:models-changed'))
      onSaved()
    } catch (error: any) {
      const message = error?.message || t('settings_failed')
      setSaveError(message)
      w().showToast(message)
    } finally {
      setSaving(false)
    }
  }

  // 预置写进表单：端点、模型 id、上下文与该模型真实的推理/思考能力一起落下去，
  // 用户只剩 API Key 要填。能力两项走 ref + 重新 bind（下拉靠 bindKey 换值重绑）。
  const applyPreset = (preset: ProviderPreset, nextRegion: string) => {
    const baseUrl = preset.regions?.find(item => item.value === nextRegion)?.baseUrl ?? preset.baseUrl
    if (baseUrl && baseUrlRef.current) baseUrlRef.current.value = baseUrl
    if (modelRef.current && (preset.singleModel || !modelRef.current.value.trim())) {
      modelRef.current.value = preset.model
    }
    if (preset.name && nameRef.current && !nameRef.current.value.trim()) nameRef.current.value = preset.name
    // 预置的上下文窗口跟着档位走：命中固定档就选中它，preset 里将来若出现表外
    // 的值则落「自定义」并把数字交给输入行种子，不丢精度。
    if (preset.maxContextTokens) {
      const tier = contextTierForTokens(preset.maxContextTokens)
      setContextTier(tier)
      if (tier === CONTEXT_TIER_CUSTOM) setCustomSeed(preset.maxContextTokens)
    }
    if (preset.reasoningEffort) reasoningRef.current = preset.reasoningEffort
    if (preset.supportsThinking !== undefined && thinkingRef.current) {
      thinkingRef.current.checked = preset.supportsThinking
    }
    if (preset.supportsVision !== undefined && visionRef.current) {
      visionRef.current.checked = preset.supportsVision
    }
  }

  const applyProviderChange = (next: string) => {
    setProvider(next)
    const preset = MODEL_FORM_PROVIDER_PRESETS[next]
    const nextRegion = preset?.regions?.[0]?.value || ''
    setRegion(nextRegion)
    if (preset) applyPreset(preset, nextRegion)
  }

  const applyRegionChange = (next: string) => {
    setRegion(next)
    const preset = MODEL_FORM_PROVIDER_PRESETS[provider]
    if (preset) applyPreset(preset, next)
  }

  const regions = MODEL_FORM_PROVIDER_PRESETS[provider]?.regions

  const formBody = (
    <>
      <div className="kls-modal-body">
            <div className="form-row"><label>{t('model_field_name')}</label><input id="mf-name" placeholder={t('model_placeholder_name')} defaultValue={existing?.name ?? ''} ref={nameRef} /></div>
            <div className="form-row"><label>{t('model_field_model_id')}</label><input id="mf-model" placeholder="claude-sonnet-4-20250514" defaultValue={existing?.model ?? ''} ref={modelRef} /></div>
            <div className="form-row"><label>{t('model_field_api_key')}</label><input id="mf-apikey" type="password" autoComplete="off" data-1p-ignore data-lpignore="true" placeholder={existing ? t('model_api_key_keep_hint') : 'sk-ant-...'} defaultValue="" ref={apiKeyRef} /></div>
            <div className="form-row">
              <label>{t('model_field_provider')}</label>
              <KlsSelect
                id="mf-provider" className="kls-select kls-select-block"
                items={[
                  // A stored provider that is no longer offered to new models:
                  // keep it as a disabled row so the edit form still names it.
                  // The closed trigger renders its label; the open panel hides
                  // the selected row, so it never looks pickable.
                  ...(existing && LEGACY_PROVIDER_LABELS[existing.provider]
                    ? [{ value: existing.provider, label: LEGACY_PROVIDER_LABELS[existing.provider], disabled: true }]
                    : []),
                  { value: 'anthropic', label: 'Anthropic' },
                  { value: 'openai', label: 'OpenAI Compatible' },
                  { value: 'kimi-api', label: 'Kimi API' },
                  { value: 'deepseek', label: 'DeepSeek' },
                  { value: 'gemini', label: 'Google Gemini' },
                  { value: 'bedrock', label: 'AWS Bedrock' },
                  { value: 'vertex', label: 'Google Vertex' },
                ]}
                value={existing?.provider || 'anthropic'} bindKey="provider"
                onChange={applyProviderChange}
              />
            </div>
            {/* 接入区域：同一家服务商的国内/国际站是两个域名，选哪个就填哪个
                baseUrl。只在该服务商真的有两个站时出现。 */}
            {regions && (
              <div className="form-row" id="mf-region-row">
                <label>{t('model_field_region')}</label>
                <KlsSelect
                  id="mf-region" className="kls-select kls-select-block"
                  items={regions.map(item => ({ value: item.value, i18nKey: item.i18nKey }))}
                  value={region} bindKey={`region-${provider}`}
                  onChange={applyRegionChange}
                />
              </div>
            )}
            {/* OpenAI 接口面：Chat Completions（默认兼容）/ Responses API（原生，解锁
                thinking/webSearch/nativePdf）。仅 provider==='openai' 时显示。 */}
            <div className="form-row" id="mf-openai-api-row" style={{ display: provider === 'openai' ? '' : 'none' }}>
              <label>{t('model_field_openai_api')}</label>
              <KlsSelect
                id="mf-openai-api" className="kls-select kls-select-block"
                items={[
                  { value: 'chat', i18nKey: 'model_openai_api_chat' },
                  { value: 'responses', i18nKey: 'model_openai_api_responses' },
                ]}
                value={existing?.openaiApi || 'chat'} bindKey="openai-api"
                onChange={(value) => { openaiApiRef.current = value }}
              />
            </div>
            {/* Anthropic wire 的密钥载体：网关只校验 Authorization: Bearer 时选
                Bearer，否则保持原生的 x-api-key。仅 Anthropic 端点有意义。 */}
            <div className="form-row" id="mf-auth-scheme-row" style={{ display: provider === 'anthropic' ? '' : 'none' }}>
              <label>{t('model_field_auth_scheme')}</label>
              <KlsSelect
                id="mf-auth-scheme" className="kls-select kls-select-block"
                items={[
                  { value: 'x-api-key', i18nKey: 'model_auth_scheme_x_api_key' },
                  { value: 'bearer', i18nKey: 'model_auth_scheme_bearer' },
                ]}
                value={existing?.authScheme === 'bearer' ? 'bearer' : 'x-api-key'} bindKey="auth-scheme"
                onChange={(value) => { authSchemeRef.current = value }}
              />
            </div>
            <div className="form-row"><label>{t('model_field_base_url')}</label><input id="mf-baseurl" defaultValue={existing?.baseUrl ?? ''} ref={baseUrlRef} /></div>
            <div className="form-row">
              <label>{t('model_field_max_tokens')}</label>
              <KlsSelect
                id="mf-context-tier" className="kls-select kls-select-block"
                items={[
                  ...CONTEXT_TIER_OPTIONS.map(item => ({ value: item.value, label: item.label })),
                  { value: CONTEXT_TIER_CUSTOM, i18nKey: 'model_context_custom' },
                ]}
                value={contextTier} bindKey={`context-tier-${provider}-${region}`}
                onChange={(value) => {
                  // 切进自定义时把当前档的 token 数带过去，用户在那个数字上微调。
                  if (value === CONTEXT_TIER_CUSTOM && contextTier !== CONTEXT_TIER_CUSTOM) {
                    setCustomSeed(Number(contextTier) || 200000)
                  }
                  setContextTier(value)
                }}
              />
            </div>
            {/* 自定义档才要用户填数字：固定档的读数就是入库值，多一个输入框只会
                让两处状态打架。编辑老模型时值不在档位表里也会落到这一行原样回显。 */}
            {contextTier === CONTEXT_TIER_CUSTOM && (
              <div className="form-row" id="mf-custom-tokens-row">
                <label>{t('model_field_custom_tokens')}</label>
                <input id="mf-tokens" type="number" min={1} defaultValue={customSeed} ref={tokensRef} />
              </div>
            )}
            {/* Declared reasoning tier: the engine no longer guesses whether a
                model reasons or which levels it honors — the client states it. */}
            <div className="form-row">
              <label>{t('model_field_reasoning')}</label>
              <KlsSelect
                id="mf-reasoning" className="kls-select kls-select-block"
                items={[
                  { value: 'none', i18nKey: 'model_reasoning_none' },
                  { value: 'std', i18nKey: 'model_reasoning_std' },
                  { value: 'xhigh', i18nKey: 'model_reasoning_xhigh' },
                  { value: 'max', i18nKey: 'model_reasoning_max' },
                ]}
                value={reasoningRef.current} bindKey={`reasoning-${provider}-${region}`}
                onChange={(value) => { reasoningRef.current = value }}
              />
            </div>
            <div className={styles['model-toggle-row']}>
              <label htmlFor="mf-thinking">{t('model_field_thinking')}</label>
              <label className={styles['pref-switch']}>
                <input id="mf-thinking" type="checkbox" defaultChecked={existing?.supportsThinking === true} ref={thinkingRef} />
                <span className={styles['pref-switch-track']} />
              </label>
            </div>
            {/* 识图开关：引擎据此门禁图片输入；不开时发图/读图会被提前拒绝并提示换模型。 */}
            <div className={styles['model-toggle-row']}>
              <label htmlFor="mf-vision">{t('model_field_vision')}</label>
              <label className={styles['pref-switch']}>
                <input id="mf-vision" type="checkbox" defaultChecked={existing?.supportsVision === true} ref={visionRef} />
                <span className={styles['pref-switch-track']} />
              </label>
            </div>
      </div>
      <div className="kls-modal-foot">
        {saveError ? <span role="alert" className={styles['settings-status-text']}>{saveError}</span> : null}
        <button className="btn-sm" data-model-form-cancel disabled={saving} onClick={onClose}>{t('cancel')}</button>
        <button className="btn-sm btn-primary" disabled={saving} onClick={() => { void onSave() }}>{t('save')}</button>
      </div>
    </>
  )

  // Embedded mode hosts the form inside the unified add dialog: that dialog owns
  // the overlay and the head, so the form contributes only body and foot. The
  // wrapper keeps this form's marker addressable from either shell.
  if (embedded) {
    return <div data-model-form style={{ display: 'contents' }}>{formBody}</div>
  }

  return (
    <ModalPortal>
      <div
        className="kls-modal-overlay" id="model-form-overlay"
        onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}
      >
        <div className="kls-modal">
          <div className="kls-modal-head">
            <div><h3 className="kls-modal-title">{existing ? t('edit_model_title') : t('add_model_title')}</h3></div>
            <button
              type="button" className="kls-modal-close" data-model-form-cancel aria-label={t('cancel')} onClick={onClose}
              dangerouslySetInnerHTML={{ __html: w().KlausIcons?.icon ? w().KlausIcons.icon('close', { size: 18 }) : '×' }}
            />
          </div>
          {formBody}
        </div>
      </div>
    </ModalPortal>
  )
}

function UnifiedAddModelModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const t = useT()
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <ModalPortal>
      <div className="kls-modal-overlay" data-add-model-modal onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
        <div className={`kls-modal ${styles['tier-modal']}`} role="dialog" aria-modal="true" aria-labelledby="add-model-unified-title">
          <div className="kls-modal-head">
            <div className={styles['modal-head-title-row']}>
              <h3 className="kls-modal-title" id="add-model-unified-title">{t('add_model_title')}</h3>
            </div>
            <button
              type="button" className="kls-modal-close" aria-label={t('cancel')} onClick={onClose}
              dangerouslySetInnerHTML={{ __html: w().KlausIcons?.icon ? w().KlausIcons.icon('close', { size: 18 }) : '×' }}
            />
          </div>
          <ModelFormModal existing={null} onClose={onClose} onSaved={onSaved} embedded />
        </div>
      </div>
    </ModalPortal>
  )
}

function modelTierBadges(t: (key: string) => string, tiers: string[]) {
  return tiers.map(name => {
    const tier = MODEL_TIERS.find(item => item.tier === name)
    return tier ? <span className="s-badge s-badge-blue" key={name}>{t(tier.badgeKey)}</span> : null
  })
}

function CustomModelsBody({ reloadSeq, reload, mapping, form, setForm }: { reloadSeq: number; reload: () => void; mapping: GlobalModelTierMapping | null; form: { existing: any } | null; setForm: (next: { existing: any } | null) => void }) {
  const t = useT()
  // Seeded from the cross-remount cache so a remounted page keeps showing the
  // model list it had; the read below refreshes it on every mount and reload.
  const [data, setData] = useState<{ models: any[] } | null>(customModelsCache)
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoadError('')
      try {
        const models = await w().settingsApi.models.list()
        if (!Array.isArray(models)) throw new Error(t('settings_section_load_failed'))
        if (!cancelled) {
          customModelsCache = { models }
          setData({ models })
        }
      } catch (error: any) {
        if (!cancelled) setLoadError(error?.message || t('settings_section_load_failed'))
      }
    })()
    return () => { cancelled = true }
  }, [reloadSeq])

  if (loadError) return <LoadFailure message={loadError} retry={reload} />
  if (!data) return <Loading />
  const { models } = data

  const onEdit = async (modelId: string) => {
    try {
      const list = await w().settingsApi.models.list()
      const existing = Array.isArray(list) ? list.find((m: any) => m.id === modelId) : null
      if (!existing) throw new Error(t('settings_section_load_failed'))
      setForm({ existing })
    } catch (error: any) {
      w().showToast(error?.message || t('settings_failed'))
    }
  }

  const onDelete = async (id: string) => {
    if (!(await w().klausDialog.confirm({ message: t('delete_model'), danger: true }))) return
    try {
      const result = await w().settingsApi.models.delete(id)
      if (result?.ok === false || result?.error) throw new Error(result.error || t('settings_failed'))
      window.dispatchEvent(new Event('klaus:models-changed'))
      reload()
    } catch (error: any) {
      w().showToast(error?.message || t('settings_failed'))
    }
  }

  return (
    <>
      <div id="models-list" className={styles['model-card-list']}>
        {models.length === 0
          ? <p className="empty-text">{t('no_models')}</p>
          : models.map((m: any) => (
              <div className="settings-card" key={m.id}>
                <div className="card-header">
                  <strong>{m.name}</strong>
                  {modelTierBadges(t, mappedModelTiers(mapping, 'custom', m.id))}
                </div>
                <div className="card-meta">{`${m.provider || 'anthropic'} / ${m.model} · ${m.maxContextTokens.toLocaleString()} tokens`}</div>
                <div className="card-actions">
                  <button className="btn-xs" onClick={() => { void onEdit(m.id) }}>{t('model_edit')}</button>
                  <button className="btn-xs btn-danger" onClick={() => { void onDelete(m.id) }}>{t('delete_title')}</button>
                </div>
              </div>
            ))}
      </div>
      {form ? (
        <ModelFormModal
          existing={form.existing}
          onClose={() => setForm(null)}
          onSaved={() => { setForm(null); reload() }}
        />
      ) : null}
    </>
  )
}

// ==================== 主组件 ====================

/** Configure provider credentials once, with effective choices on the defaults page. */
export function ModelsTab() {
  const t = useT()
  const [mapping, setMapping] = useState<GlobalModelTierMapping | null>(modelTierMappingCache)
  useEffect(() => {
    const openSource = (event: Event) => {
      setCategory(normalizeAuthMode((event as CustomEvent<string>).detail))
    }
    window.addEventListener('klaus:model-settings-source', openSource)
    return () => window.removeEventListener('klaus:model-settings-source', openSource)
  }, [])
  // Seeded from the module-level category: a remount (a host settings write
  // remounts this whole tab) keeps showing the source the user was looking at
  // instead of dropping to the page skeleton while auth_mode is re-read.
  const [category, setCategory] = useState<string | null>(modelSettingsCategory)
  // The custom source owns the add action and its form state.
  const [customForm, setCustomForm] = useState<{ existing: any } | null>(null)
  // The add dialog configures a language model directly.
  const [addOpen, setAddOpen] = useState(false)
  // body 数据重载信号（登录/保存/移除后重拉当前档，档位行不重建、不闪 loading 壳）。
  const [reloadSeq, setReloadSeq] = useState(0)
  // 会员权限快照：只用来画锁与余量。拦截在宿主，所以这里拿不到也不影响安全。
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    let cancelled = false
    let sequence = 0
    const refresh = () => {
      const current = ++sequence
      void loadGlobalModelTierMappings().then(value => {
        if (!cancelled && current === sequence) {
          modelTierMappingCache = value
          setMapping(previous => previous && previous.revision > value.revision ? previous : value)
        }
      }, () => { if (!cancelled && current === sequence) setMapping(null) })
    }
    refresh()
    window.addEventListener('klaus:models-changed', refresh)
    window.addEventListener('klaus:auth-mode-changed', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('klaus:models-changed', refresh)
      window.removeEventListener('klaus:auth-mode-changed', refresh)
    }
  }, [reloadSeq])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      setLoadError('')
      try {
        const rawAuthMode = await w().settingsApi.kv.get('auth_mode')
        const authMode = normalizeAuthMode(rawAuthMode || '')
        if (cancelled) return
        // Preserve the category selected by another entry point; first load follows the active source.
        const next = normalizeAuthMode(modelSettingsCategory || authMode)
        modelSettingsCategory = next
        setCategory(next)
      } catch (error: any) {
        if (!cancelled) setLoadError(error?.message || tGlobal('settings_section_load_failed'))
      }
    })()
    return () => { cancelled = true }
  }, [reloadSeq])

  // 冷启动壳：档位行本身还画不出来（要先知道当前 auth_mode），先给品牌标加载态。
  if (!category && loadError) {
    return (
      <SettingsPage title={tGlobal('providers_settings')} subtitle={tGlobal('models_settings_desc')}>
        <LoadFailure message={loadError} retry={() => setReloadSeq(seq => seq + 1)} />
      </SettingsPage>
    )
  }
  if (!category) {
    return (
      <SettingsPage title={tGlobal('providers_settings')} subtitle={tGlobal('models_settings_desc')}>
        <Loading />
      </SettingsPage>
    )
  }

  const reload = () => setReloadSeq(seq => seq + 1)

  // 纯浏览：只换本页看哪一档，不动 auth_mode。切换生效来源只有输入区的模型菜单
  // 一个入口（auth-pill.tsx）——它还带就绪态门控（未配置的档不切，直接把人带到这页来
  // 配）。以前这里一点就写 auth_mode：用户只是想看一眼 Codex 怎么配，结果默默把跑对话的
  // 来源换成了 Codex。登录/导入成功后的 activateSubscriptionMode 不在此列：那是明确的
  // “我刚接上它，就用它”，也是输入区菜单因未配置而跳过来的那条流程的终点。
  const viewCategory = (next: string) => {
    if (category === next) return
    modelSettingsCategory = next
    setCategory(next)
  }
  return (
    <SettingsPage title={t('providers_settings')} subtitle={t('models_settings_desc')}>
      {/* Source tabs browse account configuration without choosing a media backend. */}
      <section className="settings-section" data-model-source-settings>
      <ModelSourceTabs
        name="model-sources"
        ariaLabel={t('model_sources_tab')}
        tabs={SETTINGS_MODEL_CATEGORY_ORDER.map(item => ({
          value: item,
          label: sourceLabel(item),
        }))}
        value={category}
        onChange={viewCategory}
      />
      <div className={styles['source-section-body']}>
        {SUBSCRIPTION_SOURCES[category]
          ? <SubscriptionCardBody key={category} mode={category} reloadSeq={reloadSeq} reload={reload} />
          : <>
            <div className={styles['model-list-header-actions']}>
              <button className="btn-sm" id="custom-model-add" onClick={() => setAddOpen(true)}>{t('add_model')}</button>
            </div>
            <CustomModelsBody key="custom" reloadSeq={reloadSeq} reload={reload} mapping={mapping} form={customForm} setForm={setCustomForm} />
            {addOpen ? (
              <UnifiedAddModelModal
                onClose={() => setAddOpen(false)}
                onSaved={() => {
                  setAddOpen(false)
                  window.dispatchEvent(new Event('klaus:models-changed'))
                  reload()
                }}
              />
            ) : null}
          </>}
      </div>
      </section>
    </SettingsPage>
  )
}
