import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { EffectiveMediaModels } from '../frontend/src/pages/settings/effective-media-models'
import { SUBSCRIPTION_MEDIA_MODELS, SUBSCRIPTION_MUSIC_SOURCES, type EffectiveMediaModelCatalog } from '../contracts/effective-media-models'
import '../frontend/src/icons'
import '../frontend/src/app/ui-select'

const w = window as any
const checks: string[] = [], toasts: string[] = [], writes: unknown[] = []
let selection = 'none', connected = false, failNext = false
const modelId = SUBSCRIPTION_MEDIA_MODELS.music.qwenwork[0]
const wait = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))
function assert(value: unknown, label: string): asserts value { if (!value) throw Error(label); checks.push(label) }
async function until(check: () => unknown) {
  const end = Date.now() + 5000
  while (!check()) { if (Date.now() > end) throw Error(`Timed out: ${document.body.innerText}`); await wait() }
}
function catalog(): EffectiveMediaModelCatalog {
  const none = { source: 'none', modelId: '' }, qwenwork = { source: 'qwenwork', modelId }
  return { ok: true, selection, current: selection === 'none' ? none : qwenwork, currentBySource: { none, qwenwork }, options: [
    { ...none, available: true, connected: true, selectable: true },
    { ...qwenwork, available: connected, connected, selectable: true },
  ] }
}
w.klaus = { settings: { musicSelection: {
  get: async () => { await wait(); return catalog() },
  set: async (source: string, model?: string) => {
    writes.push({ source, model })
    await wait(80)
    if (failNext) { failNext = false; return { ok: false, error: 'Fixture save failed' } }
    selection = source
    return { ok: true }
  },
} } }
w.currentLang = 'zh'
w.showToast = (text: string) => toasts.push(text)
const host = document.querySelector('#fixture-root')!
const root = createRoot(host)
const render = () => flushSync(() => root.render(<div style={{ maxWidth: 360, margin: '40px auto', padding: 16 }}>
  <h2>音乐模型</h2><EffectiveMediaModels kind="music" id="fixture-music" label="音乐模型" />
</div>))
const get = (selector: string) => document.querySelector<HTMLElement>(selector)!
const value = () => (get('#fixture-music') as any).__klsSelect?.getValue()
const idle = () => get('[data-effective-media-model="music"]')?.getAttribute('aria-busy') === 'false'
function choose(source: string) { get('#fixture-music .kls-select-trigger').click(); get(`#fixture-music [data-value="${source}"]`).click() }
async function run() {
  render(); await until(() => value() === 'none')
  get('#fixture-music .kls-select-trigger').click()
  const sources = [...document.querySelectorAll<HTMLElement>('#fixture-music [data-value]')].map(node => node.dataset.value)
  assert(sources.includes('qwenwork'), 'A verified subscription is visible before connecting its account')
  assert(!sources.includes('custom'), 'Music has no custom endpoint option')
  assert(SUBSCRIPTION_MUSIC_SOURCES.every(source => sources.includes(source)), 'The menu includes every verified music subscription')
  get('#fixture-music [data-value="qwenwork"]').click()
  assert(value() === 'qwenwork', 'A disconnected selection is immediately visible')
  await until(() => selection === 'qwenwork' && idle())
  assert(toasts.length === 1 && toasts[0]!.includes('尚未连接 千问办公 订阅'), 'A saved disconnected choice shows one localized toast')
  assert(!get('[data-media-connection-required]'), 'The settings column has no inline connection notice')
  assert(JSON.stringify(writes) === JSON.stringify([{ source: 'qwenwork', model: modelId }]), 'Source and concrete model are saved without a credential')
  flushSync(() => root.render(null)); render()
  await until(() => idle())
  assert(toasts.length === 1, 'Remounting does not repeat the connection toast')
  connected = true; window.dispatchEvent(new Event('klaus:models-changed'))
  await wait(100)
  assert(value() === 'qwenwork', 'Connecting the account preserves the selection')
  connected = false; window.dispatchEvent(new Event('klaus:models-changed'))
  await wait(100)
  assert(toasts.length === 1, 'Account refreshes do not repeat the connection toast')
  failNext = true; choose('none')
  await until(() => get('[role="alert"]') && idle())
  assert(value() === 'qwenwork' && toasts.length === 1, 'A failed save restores the source without a connection toast')
  choose('none'); await until(() => selection === 'none' && idle())
  assert(toasts.length === 1, 'Disabling music does not show a connection toast')
  choose('qwenwork'); await until(() => selection === 'qwenwork' && idle())
  assert(toasts.length === 2, 'Explicitly selecting the disconnected source again shows a new toast')
  assert(!get('[data-media-connection-required]'), 'Repeated selections never create an inline notice')
  let retiredReads = 0
  w.klsLoading = { render: () => '<div role="status">Loading</div>' }
  w.settingsApi = {
    kv: { get: async () => 'custom' },
    models: { list: async () => [], getTiers: async () => ({ ok: true, mapping: { revision: 0, high: null, medium: null, low: null } }) },
    audioGen: { get: async () => { retiredReads++; return { provider: 'openai-compatible', model: 'gpt-4o-mini-tts', apiKey: 'legacy-fixture-key' } } },
  }
  const { ModelsTab } = await import('../frontend/src/pages/settings/models-tab')
  flushSync(() => root.render(<ModelsTab />))
  await until(() => get('#custom-model-add'))
  assert(!document.querySelector('[name="model-settings-page"]') && document.body.innerText.includes('模型来源'), 'Model sources has no capability tab bar')
  assert(!get('#ag-endpoint-list') && retiredReads === 0, 'A retained custom speech configuration has no source card or read')
  get('#custom-model-add').click()
  await until(() => get('[data-add-model-modal] #mf-name'))
  assert(!get('[data-add-kind="audio"]') && !get('[data-gen-endpoint-modal]'), 'Adding a model opens the language form without a custom speech entry')
  assert(document.querySelectorAll('.kls-modal-overlay').length === 1, 'The language model form has one dialog overlay')
  get('[data-add-model-modal] [data-model-form-cancel]').click()
  await until(() => !get('[data-add-model-modal]'))
  assert(retiredReads === 0, 'Closing the model dialog never loads the retired speech endpoint')
  w.settingsApi.advisor = { get: async () => ({ enabled: false, model: '' }), set: async (value: unknown) => ({ ok: true, settings: value }) }
  w.settingsApi.models.tierOptions = async () => ({ ok: true, sources: [] })
  w.klaus.settings = w.settingsApi
  const { ModelTiersSettingsTab } = await import('../frontend/src/pages/settings/model-tiers-tab')
  flushSync(() => root.render(<ModelTiersSettingsTab />))
  await until(() => get('#advisor-enabled'))
  assert(document.querySelectorAll('[data-model-tier]').length === 3 && !!get('[data-advisor-models]'), 'Model tiers keeps high, medium, low and the advisor together')
  assert(!document.querySelector('[data-multimodal-models], [data-realtime-settings], [data-feature-models]'), 'Model tiers excludes multimodal, realtime voice and title settings')
  w.settingsNavigationResults = { passed: checks.length, checks, pages: ['music-source', 'model-sources', 'model-tiers'], frameCount: 0, missingFrames: [], writes, toasts, capture: true }
}
w.settingsNavigationReady = run().catch(error => { w.settingsNavigationError = error?.stack || String(error); throw error })
