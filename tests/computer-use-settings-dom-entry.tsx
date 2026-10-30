import { mountSettingsTab, unmountSettingsTab } from '../frontend/src/pages/settings/kv'
import { ComputerUseSettingsTab } from '../frontend/src/pages/settings/computer-use-tab'
import '../frontend/src/icons'

const w = window as any
const checks: string[] = [], measurements: Record<string, number> = {}
const delay = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))
function assert(condition: unknown, message: string): asserts condition { if (!condition) throw Error(message); checks.push(message) }
async function until(check: () => unknown) {
  const end = performance.now() + 5000
  while (!check()) { if (performance.now() > end) throw Error(`Timed out: ${document.body.innerText}`); await delay() }
}
const root = document.getElementById('fixture-root')!
let stored = ['LM Studio', 'Shadowrocket'], reads = 0, metadata = 0, writes = 0, active = 0, peak = 0, failRead = false, failWrite = false
w.currentLang = 'zh'
w.settingsApi = { computerUse: {
  get: async () => { reads++; await delay(40); if (failRead) throw Error('fixture-load'); return { allowedApps: [...stored] } },
  appDetails: async (app: string) => {
    metadata++; active++; peak = Math.max(peak, active); await delay(40); active--
    return { name: app }
  },
  removeAllowedApp: async (app: string) => {
    writes++; await delay(100)
    if (failWrite) throw Error('fixture-save')
    stored = stored.filter(row => row !== app)
    return { ok: true, settings: { allowedApps: [...stored] } }
  },
  addAllowedApp: async (app: string) => {
    writes++; await delay(100)
    if (failWrite) throw Error('fixture-save')
    if (!stored.includes(app.trim())) stored.push(app.trim())
    return { ok: true, settings: { allowedApps: [...stored] } }
  },
} }
const rows = () => Array.from(root.querySelectorAll<HTMLElement>('[data-app]'))
const button = (app: string) => rows().find(row => row.dataset.app === app)!.querySelector<HTMLButtonElement>('button')!
const confirm = () => Array.from(document.querySelectorAll<HTMLButtonElement>('dialog button')).find(node => node.textContent === '移除')!
const addButton = () => document.getElementById('computer-use-add-app') as HTMLButtonElement
const submitAdd = () => Array.from(document.querySelectorAll<HTMLButtonElement>('dialog button')).find(node => node.textContent === '添加')!
function inputApp(value: string) {
  const input = document.getElementById('computer-use-app-input') as HTMLInputElement
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
function mount() { mountSettingsTab(root, <ComputerUseSettingsTab />) }
async function run() {
  mount()
  assert(root.textContent?.includes('loading') === false && root.querySelector('[role=status]'), 'first frame shows localized loading')
  assert(!root.textContent?.includes('暂无'), 'loading does not flash the empty state')
  await until(() => rows().length === 2)
  assert(!root.querySelector('input,[role=switch]'), 'settings page contains no connector or other switches')
  assert(root.querySelectorAll('[data-app] button').length === 2, 'rows offer only removal')
  assert(!root.querySelector('[title],[data-klaus-tip]'), 'list does not add hover tooltips')
  const rect = rows()[0]!.getBoundingClientRect()
  measurements.rowHeight = rect.height
  assert(rect.height >= 64 && rect.height <= 90, 'row height remains within the settings layout')
  assert(root.scrollWidth <= root.clientWidth, 'list fits the content width')
  button('LM Studio').focus(); button('LM Studio').click()
  await until(() => document.querySelector('dialog[open]'))
  assert(document.querySelector('dialog')!.textContent!.includes('重新询问'), 'removal explains the next app question')
  assert(writes === 0, 'opening the confirmation makes no write')
  document.querySelector<HTMLDialogElement>('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }))
  await until(() => !document.querySelector('dialog'))
  assert(document.activeElement === button('LM Studio'), 'cancelling restores focus to the row')
  assert(writes === 0, 'cancelling leaves approvals unchanged')
  failWrite = true; button('LM Studio').click(); await until(() => document.querySelector('dialog[open]'))
  confirm().click(); confirm().click()
  assert(rows().length === 2, 'row remains until persistence completes')
  await until(() => document.querySelector('dialog [role=alert]'))
  assert(writes === 1 && rows().length === 2, 'double click issues one write and failure preserves the row')
  assert(document.querySelectorAll('[role=alert]').length === 1, 'failed removal reports one accessible error')
  failWrite = false; confirm().click()
  await until(() => rows().length === 1 && !document.querySelector('dialog'))
  assert(document.querySelector('.toast-root[data-tone=success]')?.textContent?.includes('LM Studio'), 'successful removal names the app in a toast')
  assert(document.activeElement === button('Shadowrocket'), 'success moves focus to the next row')
  button('Shadowrocket').click(); await until(() => document.querySelector('dialog[open]'))
  confirm().click(); await until(() => !rows().length && !document.querySelector('dialog'))
  assert(root.textContent!.includes('暂无'), 'removing the last row shows the empty state')
  assert(document.activeElement?.id === 'computer-use-apps-title', 'last removal focuses the section heading')
  unmountSettingsTab(); failRead = true; mount()
  await until(() => root.querySelector('[role=alert]'))
  failRead = false
  Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find(node => node.textContent === '重试')!.click()
  await until(() => root.textContent?.includes('暂无'))
  assert(true, 'failed initial reads can be retried')
  addButton().focus(); addButton().click()
  await until(() => document.querySelector('dialog[open]'))
  assert(document.activeElement?.id === 'computer-use-app-input', 'add dialog focuses the labeled application field')
  assert(submitAdd().disabled, 'empty application input cannot be submitted')
  const beforeCancel = writes
  inputApp('Electron'); await delay()
  document.querySelector<HTMLDialogElement>('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }))
  await until(() => !document.querySelector('dialog'))
  assert(writes === beforeCancel && stored.length === 0, 'cancelling add leaves saved applications unchanged')
  assert(document.activeElement === addButton(), 'cancelling add returns focus to its entry')
  addButton().click(); await until(() => document.querySelector('dialog[open]'))
  inputApp('Electron'); await delay(); failWrite = true
  const beforeAdd = writes
  submitAdd().click(); submitAdd().click()
  await until(() => document.querySelector('dialog [role=alert]'))
  assert(writes === beforeAdd + 1 && !rows().length, 'failed add is serialized and does not change the saved list')
  assert((document.getElementById('computer-use-app-input') as HTMLInputElement).value === 'Electron', 'failed add preserves the application input')
  failWrite = false
  document.querySelector('dialog form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  await until(() => rows().length === 1 && !document.querySelector('dialog'))
  assert(stored[0] === 'Electron', 'submitting the add form persists the application before displaying it')
  assert(Array.from(document.querySelectorAll('.toast-root[data-tone=success]')).some(node => node.textContent?.includes('已添加')), 'successful add reports persistence')
  addButton().click(); await until(() => document.querySelector('dialog[open]'))
  inputApp('Electron'); await delay(); submitAdd().click()
  await until(() => !document.querySelector('dialog'))
  assert(rows().length === 1 && stored.length === 1, 'adding a saved application preserves a single entry')
  button('Electron').click(); await until(() => document.querySelector('dialog[open]'))
  confirm().click(); await until(() => !rows().length && !document.querySelector('dialog'))
  assert(addButton().isConnected, 'add entry remains available after removing all saved applications')
  unmountSettingsTab()
  stored = Array.from({ length: 1000 }, (_, index) => `App ${index}`)
  const beforeMetadata = metadata, started = performance.now()
  mount(); await until(() => rows().length === 1000)
  measurements.largeListLoadMs = performance.now() - started
  await delay(300)
  measurements.initialMetadataRequests = metadata - beforeMetadata
  measurements.peakMetadataConcurrency = peak
  assert(measurements.largeListLoadMs < 1000, 'one thousand saved rows load within one second')
  assert(metadata - beforeMetadata < 30, 'metadata resolves visible rows without scanning the app list')
  assert(peak <= 2, 'metadata work never exceeds two concurrent requests')
  const readsBefore = reads, metadataBefore = metadata
  await delay(300)
  assert(reads === readsBefore && metadata === metadataBefore, 'idle page performs no polling or repeated metadata reads')
  unmountSettingsTab(); stored = ['LM Studio', 'Shadowrocket']; mount()
  await until(() => rows().length === 2)
  await until(() => !document.querySelector('.toast-root'))
  w.settingsNavigationResults = { passed: checks.length, checks, measurements, pages: ['computerUse'], frameCount: 0, missingFrames: [], capture: true }
}
w.settingsNavigationReady = run().catch(error => { w.settingsNavigationError = error.stack; throw error })
