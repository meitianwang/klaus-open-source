import { mountSettingsTab } from '../frontend/src/pages/settings/kv'
import { MultimodalSettingsTab } from '../frontend/src/pages/settings/multimodal-tab'
import { VoiceInputSettingsTab } from '../frontend/src/pages/settings/voice-tab'
import '../frontend/src/icons'
import '../frontend/src/app/ui-select'
import '../frontend/src/app/dialog'

const w = window as any
const sleep = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))
const stored = new Map<string, string>([['voice.input.experience', 'compatibility']])
const writes: string[] = [], checks: string[] = [], toasts: string[] = [], frames: string[] = [], readKeys: string[] = []
const words = [{ id: 'term', text: 'Klaus', enabled: true, source: 'manual' }, { id: 'learned', text: '示例项目', enabled: true, source: 'learned' }]
let nextWord = 0, failWords = false
let failSave = false, failCapabilities = false, writeDelay = 40, hotwordReads = 0
let workbuddyAvailable = false
let page: 'capability' | 'preferences' = 'preferences'
w.currentLang = 'zh'
w.showToast = (message: string) => toasts.push(message)
w.settingsApi = { kv: {
  get: async (key: string) => { readKeys.push(key); const value = stored.get(key); await sleep(50); return value },
  set: async (key: string, value: string) => {
    writes.push(key)
    const failed = failSave; failSave = false
    await sleep(writeDelay)
    if (failed) return { ok: false, error: 'Fixture save failed' }
    stored.set(key, value); mount(page); await sleep(30)
    return { ok: true }
  },
} }
w.klaus = { voice: {
  config: async () => {
    await sleep(180)
    if (failCapabilities) throw Error('Fixture capability failed')
    const experience = stored.get('voice.input.experience') || 'realtime'
    const source = stored.get('voice.input.source') || 'system'
    const streaming = experience === 'realtime' && ['system', 'qoder', 'qwenwork', 'antigravity'].includes(source)
    return { ok: true, experience, source, streaming, nativeStreaming: streaming && source !== 'system', systemAsr: true, availability: { workbuddy: workbuddyAvailable } }
  },
  hotwords: {
    list: async () => { hotwordReads++; await sleep(40); if (failWords) throw Error('Fixture dictionary failed'); return words.map(word => ({ ...word })) },
    add: async (text: string, id?: string) => {
      await sleep(30)
      if (!text.trim() || text.length > 100) return { ok: false }
      const word = id ? words.find(word => word.id === id) : words.find(word => word.text === text)
      if (word) word.text = text
      else words.push({ id: `new-${++nextWord}`, text, enabled: true, source: 'manual' })
      return { ok: true }
    },
    remove: async (id: string) => { await sleep(30); const index = words.findIndex(word => word.id === id); if (index < 0) return { ok: false }; words.splice(index, 1); return { ok: true } },
  },
  memories: { list: async () => { await sleep(40); return [{ id: 'memory', content: 'Fixture phrasing preference' }] } },
} }
w.settingsApi.models = {
  getTiers: async () => ({ ok: true, mapping: { version: 1, revision: 0, high: null, medium: null, low: null } }),
  tierOptions: async () => ({ ok: true, sources: [], tiers: {} }),
}
w.settingsApi.advisor = { get: async () => ({ enabled: false, model: '' }) }
w.settingsApi.featureModels = { get: async () => ({ ok: true, settings: {} }) }
w.settingsApi.webSearchSources = { get: async () => ({ availability: {} }) }
for (const kind of ['image', 'video', 'audio', 'music']) {
  const current = { source: 'custom', modelId: '' }
  w.settingsApi[`${kind}Selection`] = { get: async () => ({ ok: true, selection: 'custom', current,
    currentBySource: { custom: current }, options: [{ ...current, available: true }], availability: { custom: true } }) }
}
w.klaus.settings = w.settingsApi
const find = <T extends HTMLElement = HTMLElement,>(selector: string) => {
  const value = document.querySelector<T>(selector)
  if (!value) throw Error(`Missing ${selector}`)
  return value
}
const assert = (condition: unknown, label: string) => { if (!condition) throw Error(label); checks.push(label) }
async function until(check: () => unknown) {
  const end = Date.now() + 5000
  while (!check()) { if (Date.now() > end) throw Error(`Timed out: ${document.body.innerText}`); await sleep() }
}
function mount(next: typeof page) {
  page = next
  mountSettingsTab(find('#fixture-root'), page === 'capability' ? <MultimodalSettingsTab /> : <VoiceInputSettingsTab />)
}
const value = () => (find('#voice-source-select') as any).__klsSelect.getValue()
const disabled = () => find('#voice-source-select .kls-select-trigger').getAttribute('aria-disabled') === 'true'
const choose = (source: string) => {
  find('#voice-source-select .kls-select-trigger').click()
  find(`#voice-source-select [data-value="${source}"]`).click()
}
async function run() {
  mount('capability')
  await until(() => !!document.querySelector('[data-multimodal-kind="audio"] .settings-section-title'))
  assert(find('[data-multimodal-kind="audio"] .settings-section-title').textContent === '语音生成', 'speech generation has its own accurately named capability section')
  const mediaRows = [...document.querySelectorAll<HTMLElement>('[data-multimodal-kind]')]
  assert(mediaRows.map(row => row.dataset.multimodalKind).join(',') === 'image,audio,music,video', 'multimodal settings follow image, voice, music, video order')
  const mediaRects = mediaRows.map(row => row.getBoundingClientRect())
  assert(mediaRects.every((rect, index) => rect.left === mediaRects[0]!.left && (index === 0 || rect.top > mediaRects[index - 1]!.top)), 'each multimodal function occupies its own full-width row')
  assert(!document.querySelector('#voice-source-select'), 'capability settings no longer contain the speech recognition source selector')
  mount('preferences')
  assert(!!document.querySelector('[data-realtime-settings]'), 'voice preferences host realtime voice source, model and voice settings')
  assert(disabled(), 'an absent source waits for capabilities without guessing a default')
  assert(writes.length === 0, 'loading never writes a guessed source')
  await until(() => value() === 'system' && !disabled())
  assert(!document.querySelector('#voice-source-section-label'), 'the source row has no separate speech recognition heading')
  assert(find('#voice-source-row-label').textContent === '来源' && document.querySelectorAll('#voice-source-select').length === 1, 'the voice input page contains exactly one source row labeled 来源')
  assert(!!document.querySelector('[data-voice-input-card] #voice-personalization-toggle') && !!document.querySelector('[data-voice-input-card] #voice-source-select'), 'the source row is attached to the same pref-card as personalization')
  assert(!document.querySelector('[data-capability-voice-source] [id*="auth-login"], [data-capability-voice-source] [id*="auth-logout"]'), 'effective voice selection is a dropdown without duplicate credentials')
  choose('custom')
  await until(() => stored.get('voice.input.source') === 'custom' && !disabled())
  assert(toasts.length === 0 && writes.every(key => key === 'voice.input.source'), 'a source change persists only its own preference without a success toast')

  let sampling = true
  const sample = () => {
    if (page === 'preferences' && document.querySelector('#voice-source-select')) frames.push(value())
    if (sampling) requestAnimationFrame(sample)
  }
  requestAnimationFrame(sample)
  writeDelay = 350
  choose('system'); mount('preferences')
  assert(value() === 'system' && disabled(), 'pending selection and save lock survive a host-driven remount')
  await until(() => stored.get('voice.input.source') === 'system' && !disabled())
  failSave = true
  choose('custom'); await sleep(20); mount('preferences')
  await until(() => toasts.includes('Fixture save failed') && value() === 'system' && !disabled())
  assert(stored.get('voice.input.source') === 'system', 'a failed save settling after remount restores the confirmed source')
  assert(frames.length > 10 && frames.every(Boolean), 'saving and refreshing never render an empty source')
  sampling = false; writeDelay = 40

  choose('qwenwork'); await until(() => stored.get('voice.input.source') === 'qwenwork' && !disabled())
  mount('preferences'); await until(() => !!document.querySelector('[data-word-id="term"]'))
  assert(!!document.querySelector('#voice-source-select'), 'voice preferences now host the speech recognition source selector')
  assert(document.body.innerText.includes('个性化表达') && document.body.innerText.includes('词典') && document.body.innerText.includes('千问办公'), 'voice preferences expose personalization, the correction dictionary and the selected provider')

  mount('preferences'); await until(() => !disabled())
  choose('codex'); await until(() => stored.get('voice.input.source') === 'codex' && !disabled())
  mount('preferences'); await until(() => !!document.querySelector('#voice-dictionary-list'))
  assert(!!document.querySelector('#voice-source-select'), 'the source selector stays visible after switching providers within the same page')

  mount('preferences'); await until(() => !disabled())
  failCapabilities = true
  window.dispatchEvent(new Event('klaus:models-changed'))
  await until(() => document.body.innerText.includes('Fixture capability failed'))
  assert(value() === 'codex' && !disabled(), 'capability failures retain the saved selection')
  failCapabilities = false
  find('[role="alert"] button').click()
  await until(() => !document.body.innerText.includes('Fixture capability failed'))
  workbuddyAvailable = true
  window.dispatchEvent(new Event('klaus:models-changed')); await sleep(250)
  find('#voice-source-select .kls-select-trigger').click()
  assert(!!document.querySelector('#voice-source-select [data-value="workbuddy"]'), 'account changes refresh available transcription capabilities')
  find('#voice-source-select .kls-select-trigger').click()

  stored.set('voice.input.source', 'retired'); mount('preferences')
  await until(() => value() === 'retired')
  assert(!document.querySelector('[data-capability-voice-source] p') && stored.get('voice.input.source') === 'retired', 'unknown saved sources remain selected in the source card')
  choose('system'); await until(() => stored.get('voice.input.source') === 'system' && !disabled())
  assert(value() === 'system', 'explicit recovery persists the replacement source')
  choose('codex'); await until(() => stored.get('voice.input.source') === 'codex' && !disabled())
  stored.set('voice.input.experience', 'realtime')
  mount('preferences'); await until(() => !!document.querySelector('[data-word-id="term"]'))
  assert(!!document.querySelector('#voice-source-select'), 'real-time profiles keep the source selector on the voice input page')
  assert(!writes.includes('voice.input.experience') && stored.get('voice.input.source') === 'codex', 'opening preferences preserves transport and provider selection')
  const dialog = () => document.querySelector<HTMLElement>('.klaus-dialog-overlay.active')
  const dialogButton = (kind: 'confirm' | 'cancel') => find(`.klaus-dialog-overlay.active .klaus-dialog-${kind}`)
  const inputText = (text: string) => { const input = find<HTMLInputElement>('.klaus-dialog-overlay.active input'); input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })) }
  const menuItem = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(button => button.textContent === text)!
  const chooseTab = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(button => button.textContent === text)!.click()
  const search = (value: string) => { const input = find<HTMLInputElement>('#voice-dictionary-search'); const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })) }

  const personalization = () => find<HTMLInputElement>('#voice-personalization-toggle')
  await until(() => !personalization().disabled)
  assert(personalization().checked, 'personalization defaults to enabled and renders as a standard switch row')
  personalization().click(); await until(() => !!dialog())
  dialogButton('cancel').click(); await until(() => !dialog() && personalization().checked)
  assert(!stored.has('voice.learning.enabled'), 'cancelling personalization disable does not write a preference')
  personalization().click(); await until(() => !!dialog()); dialogButton('confirm').click()
  await until(() => stored.get('voice.learning.enabled') === 'off' && !personalization().checked && !personalization().disabled)
  personalization().click(); await until(() => stored.get('voice.learning.enabled') === 'on' && personalization().checked && !find<HTMLButtonElement>('#voice-dictionary-new').disabled)
  assert(!dialog(), 'enabling personalization is direct and needs no confirmation')
  chooseTab('自动添加'); await until(() => document.querySelectorAll('[data-word-id]').length === 1)
  assert(!!document.querySelector('[data-word-id="learned"]'), 'automatic dictionary entries have their own source filter')
  chooseTab('手动添加'); await until(() => document.querySelectorAll('[data-word-id]').length === 1)
  assert(!!document.querySelector('[data-word-id="term"]'), 'manual dictionary entries have their own source filter')
  chooseTab('全部'); await until(() => document.querySelectorAll('[data-word-id]').length === 2)
  assert(document.querySelectorAll('#voice-dictionary-list input[type="checkbox"]').length === 3 && !document.querySelector('#voice-dictionary-list input[role="switch"]'), 'word checkboxes select rows instead of enabling or disabling recognition')

  find('#voice-dictionary-new').click(); await until(() => !!dialog())
  inputText('x'.repeat(101)); dialogButton('confirm').click(); await until(() => toasts.some(text => text.includes('100')))
  assert(!!dialog() && words.length === 2, 'overlong terms stay in the add dialog without a partial write')
  inputText('NewName'); dialogButton('confirm').click(); await until(() => words.some(word => word.text === 'NewName') && !dialog())
  assert(words.find(word => word.text === 'NewName')?.source === 'manual', 'new words persist as manual dictionary entries')
  find('[data-word-id="learned"] button').click(); await until(() => !!menuItem('编辑词条')); menuItem('编辑词条').click(); await until(() => !!dialog())
  inputText('修正后的项目'); dialogButton('confirm').click(); await until(() => words.some(word => word.id === 'learned' && word.text === '修正后的项目') && !dialog())
  assert(words.find(word => word.id === 'learned')?.source === 'learned', 'editing a term keeps its stable id and automatic source')
  const added = words.find(word => word.text === 'NewName')!
  find(`[data-word-id="${added.id}"] button`).click(); await until(() => !!menuItem('删除')); menuItem('删除').click(); await until(() => !!dialog()); dialogButton('cancel').click(); await until(() => !dialog())
  assert(words.some(word => word.id === added.id), 'cancelling deletion preserves the selected word')
  find(`[data-word-id="${added.id}"] button`).click(); await until(() => !!menuItem('删除')); menuItem('删除').click(); await until(() => !!dialog()); dialogButton('confirm').click(); await until(() => !words.some(word => word.id === added.id) && !find<HTMLButtonElement>('#voice-dictionary-new').disabled)
  assert(!words.some(word => word.id === added.id), 'single-word deletion confirms before removing data')

  const fileInput = find<HTMLInputElement>('input[type="file"]'), transfer = new DataTransfer()
  transfer.items.add(new File(['\uFEFFterm\nCsvOne\nCsvTwo\nCsvOne'], 'words.csv', { type: 'text/csv' }))
  fileInput.files = transfer.files; fileInput.dispatchEvent(new Event('change', { bubbles: true })); await until(() => !!dialog())
  assert(dialog()!.textContent!.includes('3') && dialog()!.textContent!.includes('CsvOne'), 'CSV import previews valid new terms before any write')
  dialogButton('confirm').click(); await until(() => words.some(word => word.text === 'CsvTwo') && !dialog())
  assert(words.filter(word => word.text === 'CsvOne').length === 1 && words.some(word => word.text === 'term'), 'CSV imports exact distinct terms and does not consume the first row as a header')
  search('Csv'); await until(() => document.querySelectorAll('[data-word-id]').length === 2)
  find<HTMLInputElement>('input[aria-label="选择全部词条"]').click(); await until(() => !!document.querySelector('#voice-dictionary-delete-selected'))
  find('#voice-dictionary-delete-selected').click(); await until(() => !!dialog()); dialogButton('confirm').click(); await until(() => !words.some(word => word.text.startsWith('Csv')))
  assert(words.some(word => word.id === 'term'), 'batch deletion affects only selected filtered words')
  search(''); await until(() => !!document.querySelector('[data-word-id="term"]'))
  failWords = true; window.dispatchEvent(new Event('klaus:voice-dictionary-changed')); await until(() => document.body.innerText.includes('Fixture dictionary failed'))
  failWords = false; find('#voice-dictionary-list [role="alert"] button').click(); await until(() => !document.body.innerText.includes('Fixture dictionary failed') && !!document.querySelector('[data-word-id="term"]'))
  assert(true, 'dictionary fetch failures recover through the section retry without reloading the page')
  await sleep(40)
  w.settingsNavigationResults = { passed: checks.length, checks, pages: ['capability', 'preferences'], frameCount: frames.length, missingFrames: [], capture: true }
}
w.settingsNavigationReady = run().catch(error => { w.settingsNavigationError = error?.stack || String(error); throw error })
