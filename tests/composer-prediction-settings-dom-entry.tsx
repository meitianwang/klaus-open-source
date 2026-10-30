import { createRoot, type Root } from 'react-dom/client'
import type { PowerSaveSnapshot } from '../contracts/power-save'
import '../frontend/src/app/ui-select'

const w = window as any
const key = 'composer_predictions_enabled'
const stored = new Map<string, string>()
const writes: Array<{ key: string; value: string }> = []
const toasts: string[] = []
const listeners = new Set<(event: { key: string }) => void>()
const powerListeners = new Set<(snapshot: PowerSaveSnapshot) => void>()
const powerSnapshot: PowerSaveSnapshot = {
  revision: 0, platform: 'darwin',
  preferences: { preventSleepWhileRunning: false, keepRemoteControlAwakeWhilePluggedIn: false },
  context: { localExecutionAllowed: true, hasActiveLocalConversation: false, remoteControlEnabled: false, realtimeVoicePhase: 'inactive' },
}
let availability: { available: boolean; reason?: string } = { available: true }
let failNext = false
let finishFailedWrite: (() => void) | undefined
let root: Root | undefined
w.currentLang = 'en'
const publish = () => { for (const listener of [...listeners]) listener({ key }) }
w.showToast = (message: string) => { toasts.push(message) }
w.klsLoading = { render: () => '<div role="status">Loading preferences...</div>' }
w.settingsApi = {
  kv: {
    get: async (name: string) => stored.get(name),
    set: async (name: string, value: string) => {
      writes.push({ key: name, value })
      if (failNext) {
        failNext = false
        await new Promise<void>(resolve => { finishFailedWrite = resolve })
        finishFailedWrite = undefined
        return { ok: false, error: 'Simulated preference save failure' }
      }
      stored.set(name, value)
      queueMicrotask(publish)
      return { ok: true }
    },
  },
  outputStyles: { list: async () => ({ defaultStyle: 'default', current: 'default', styles: [{ id: 'default', isDefault: true }] }), set: async () => ({ ok: true }) },
  runtimeConfig: {
    get: async (scope: unknown) => ({ scope, version: '1', values: {}, effective: {
      'klaus.approvalPolicy': 'on-request', 'klaus.sandboxMode': 'read-only',
      'klaus.sandbox.networkAllowed': 'off', 'klaus.modelVerbosity': null,
      'klaus.reasoningSummary': 'auto', 'klaus.subagentModelCatalog': 'off',
    } }),
    open: async () => ({ ok: true }),
  },
  workspaceDependencies: { get: async () => ({ enabled: false, state: 'ready' }) },
  models: {
    tierOptions: async () => ({
      ok: true,
      sources: [{ source: 'codex', status: 'ready', options: [{ modelId: 'gpt-5', label: 'GPT-5', value: 'gpt-5' }] }],
    }),
  },
}
const featureModels: Record<string, string> = { title: '', prediction: '', memory: '', voiceRefinement: '' }
const featureModelWrites: Array<Record<string, string>> = []
w.klaus = {
  powerSave: {
    snapshot: async () => structuredClone(powerSnapshot),
    subscribe: (listener: (snapshot: PowerSaveSnapshot) => void) => { powerListeners.add(listener); return () => powerListeners.delete(listener) },
    setPreference: async (name: keyof PowerSaveSnapshot['preferences'], value: boolean) => {
      powerSnapshot.preferences[name] = value
      powerSnapshot.revision++
      for (const listener of [...powerListeners]) listener(structuredClone(powerSnapshot))
      return { ok: true, snapshot: structuredClone(powerSnapshot) }
    },
  },
  app: { loginItem: { get: async () => ({ enabled: false }), set: async () => ({ ok: true }) } },
  workspace: { getExcludes: async () => ({ patterns: [] }), setExcludes: async () => ({ ok: true }) },
  projects: { list: async () => ({ roots: [], labels: {} }) },
  workspaces: { list: async () => ({ workspaces: [] }) },
  composerPredictions: { availability: async () => ({ ...availability }) },
  settings: {
    featureModels: {
      get: async () => ({ ok: true, settings: { ...featureModels } }),
      set: async (patch: Record<string, string>) => {
        Object.assign(featureModels, patch)
        featureModelWrites.push({ ...patch })
        return { ok: true, settings: { ...featureModels } }
      },
    },
  },
  on: { appPreferencesChanged: (listener: (event: { key: string }) => void) => { listeners.add(listener); return () => listeners.delete(listener) } },
}

const checks: string[] = []
const settle = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))
function assert(value: unknown, label: string): asserts value { if (!value) throw Error(label); checks.push(label) }
function find<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw Error(`Missing ${selector}`)
  return element
}
const toggle = () => find<HTMLInputElement>('#pref-predictions')
async function until(check: () => unknown, label: string) {
  const deadline = Date.now() + 5000
  while (!check()) { if (Date.now() > deadline) throw Error(`Timed out: ${label}`); await settle() }
}
async function native(request: { capture?: string; key?: string }) {
  await new Promise<void>((resolve, reject) => { w.predictionSettingsNativeDone = resolve; w.predictionSettingsNativeFail = reject; w.predictionSettingsNativeRequest = request })
  await settle(60)
}
async function mount() {
  root?.unmount()
  root = createRoot(find('#fixture-root'))
  const { PreferencesTab } = await import('../frontend/src/pages/settings/prefs-tabs')
  w.showToast = (message: string) => { toasts.push(message) }
  root.render(<PreferencesTab />)
  await until(() => document.querySelector('#pref-predictions') && !toggle().disabled, 'preferences loaded')
  await until(() => (document.querySelector('#feature-model-prediction-source') as any)?.__klsSelect, 'prediction model row bound')
  await settle()
}
async function notice(reason: string, expected: string) {
  availability = { available: false, reason }
  publish()
  await until(() => document.querySelector('[role="status"]')?.textContent === expected, reason)
  assert(toggle().checked && !toggle().disabled, `${reason} leaves the persisted editor preference enabled and editable`)
  assert(document.querySelector('[role="status"]')?.textContent === expected, `${reason} has an explicit localized availability notice`)
}
async function run() {
  await mount()
  assert(toggle().checked, 'An absent editor preference defaults to enabled')
  assert(find('#pref-predictions-label').textContent === 'Show predictions', 'English prediction label is exact')
  assert(find('#pref-predictions-desc').textContent === 'Predict your next message based on the conversation.', 'English prediction description is exact')
  assert(toggle().getAttribute('aria-labelledby') === 'pref-predictions-label' && toggle().getAttribute('aria-describedby') === 'pref-predictions-desc', 'The production switch exposes its visible label and description accessibly')
  assert(find('#feature-model-prediction-label').textContent === 'Message predictions', 'The prediction model row lives in Preferences → Editor')
  assert(find('#feature-model-prediction-source').closest('.settings-section')?.querySelector('.settings-section-title')?.textContent === 'Editor', 'The prediction model row is inside the Editor section')
  assert(find('#feature-model-title-label').closest('.settings-section')?.querySelector('.settings-section-title')?.textContent === 'Conversation', 'The title model row lives in Preferences → Conversation')
  assert(find('#feature-model-title-source').closest('.pref-row')?.previousElementSibling?.querySelector('#pref-output-style'), 'The title model row follows the reply style row')
  assert(!document.querySelector('#runtime-search'), 'Merged runtime settings omit the web search row')
  assert(writes.length === 0, 'Opening preferences does not write the default')
  await native({ capture: 'prediction-settings-en' })
  w.currentLang = 'zh'
  document.documentElement.lang = 'zh'
  window.dispatchEvent(new Event('klaus:lang-change'))
  await until(() => find('#pref-predictions-label').textContent === '显示预测内容', 'Chinese preference label')
  assert(find('#pref-predictions-label').textContent === '显示预测内容', 'Chinese prediction label is exact')
  assert(find('#pref-predictions-desc').textContent === '根据对话内容预测你的下一条消息', 'Chinese prediction description is exact')
  assert(find('#feature-model-prediction-label').textContent === '消息推荐', 'The prediction model row uses the Chinese label')
  await native({ capture: 'prediction-settings-zh' })

  toggle().focus()
  await native({ key: 'Space' })
  await until(() => stored.get(key) === 'off' && !toggle().checked && !toggle().disabled, 'saved disabled preference')
  assert(JSON.stringify(writes.at(-1)) === JSON.stringify({ key, value: 'off' }), 'Native keyboard toggling persists the exact disabled preference')
  await mount()
  assert(!toggle().checked, 'Reopening preferences restores the disabled value')
  assert(listeners.size === 3, 'Reopening replaces prediction, runtime, and dependency subscriptions without leaking listeners')
  assert(powerListeners.size === 1, 'Reopening preserves the power lifecycle subscription without leaking listeners')

  failNext = true
  toggle().click()
  await until(() => finishFailedWrite && toggle().checked && toggle().disabled, 'pending save')
  assert(toggle().checked && toggle().disabled, 'An in-flight toggle is optimistic and disabled until persistence settles')
  finishFailedWrite!()
  await until(() => !toggle().checked && !toggle().disabled, 'failed save rollback')
  assert(stored.get(key) === 'off' && !toggle().checked, 'A failed save restores the previously persisted checkbox state')
  assert(toasts.includes('Simulated preference save failure'), 'A failed save exposes the original error')

  const priorWrites = writes.length
  stored.set(key, 'on')
  publish()
  await until(() => toggle().checked && !toggle().disabled, 'external enabled preference')
  assert(writes.length === priorWrites, 'An external preference notification refreshes the checkbox without writing it back')
  await notice('engine_unavailable', '当前运行的应用暂不支持预测内容，请更新后重新启动。')
  await native({ capture: 'prediction-settings-engine-unavailable' })
  // Only a covered subscription reads provider configuration, so these two reach
  // the page for that account alone.
  await notice('configuration_unavailable', '无法获取订阅服务的预测配置，请稍后重试。')
  await native({ capture: 'prediction-settings-configuration-unavailable' })
  await notice('configuration_disabled', '订阅服务暂未启用预测内容。')
  await native({ capture: 'prediction-settings-configuration-disabled' })
  await notice('unavailable', '预测内容暂不可用，请检查模型来源是否已连接。')
  await native({ capture: 'prediction-settings-unavailable' })
  // availability() never reads conversation context, so per-turn reasons such as
  // plan_mode cannot reach this page; an unrecognized reason still needs copy.
  await notice('some_future_reason', '预测内容暂不可用，请检查模型来源是否已连接。')
  await native({ capture: 'prediction-settings-unknown-reason' })
  availability = { available: true }
  publish()
  await until(() => !document.querySelector('[role="status"]'), 'available configuration clears notice')
  assert(toggle().checked && !document.querySelector('[role="status"]'), 'Restored availability removes the notice and retains the editor preference')
  w.predictionSettingsResults = { passed: checks.length, checks, writes, toasts }
}
w.predictionSettingsReady = run().catch(error => { w.predictionSettingsError = error?.stack || String(error); throw error })
