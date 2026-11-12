// Real-component fixture for the four update surfaces. It mounts the shipped
// store, components and settings page, drives them through a synthetic host and
// measures the actual DOM: which surface owns each phase, what the numbers read,
// and what the two different user choices (collapse vs postpone) do.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { mountUpdateNotices } from '../frontend/src/app/update/mount'
import { applyUpdateStatus, checkForUpdate, updateSnapshot } from '../frontend/src/app/update/store'
import { DISMISS_STORAGE_KEY, PROGRESS_DIALOG_DELAY_MS } from '../frontend/src/app/update/model'
import { AboutTab } from '../frontend/src/pages/settings/about-tab'
import { I18N } from '../frontend/src/i18n/messages'

type Result = { name: string; ok: boolean; detail?: string }
const results: Result[] = []
const toasts: Array<{ message: string; tone?: string }> = []
const w = window as any

w.currentLang = 'en'
w.tt = (key: string) => (I18N.en as Record<string, string>)[key] ?? key
w.showToast = (message: string, options?: { tone?: string }) => { toasts.push({ message, tone: options?.tone }) }

const TOTAL = 170184704
const base = {
  supported: true, currentVersion: '0.7.4', availableVersion: '0.7.5',
  error: null, errorKind: null, explicit: false, progress: null,
}
const transferring = (percent: number, transferred: number) => ({
  ...base, state: 'downloading',
  progress: { percent, bytesPerSecond: 8105472, transferred, total: TOTAL, installing: false },
})

let checkCalls: Array<{ explicit?: boolean } | undefined> = []
let installCalls = 0
let push: ((status: unknown) => void) | undefined
w.klaus = {
  updater: {
    status: async () => ({ ...base, state: 'idle', availableVersion: null }),
    check: async (args?: { explicit?: boolean }) => { checkCalls.push(args); return { ...base, state: 'idle', availableVersion: null, explicit: args?.explicit === true } },
    install: async () => { installCalls++; return { ok: false, error: 'fixture install refused' } },
  },
  on: { updaterStatus: (cb: (status: unknown) => void) => { push = cb; return () => { push = undefined } } },
  app: { distribution: async () => ({ productName: 'Klaus' }) },
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const settle = async () => { await sleep(0); await new Promise(resolve => requestAnimationFrame(() => resolve(null))); await sleep(0) }
const surface = (name: string) => document.querySelector(`[data-surface="${name}"]`)
const text = (name: string) => surface(name)?.textContent ?? ''
const action = (name: string, scope = '') => document.querySelector(`${scope}[data-action="${name}"]`) as HTMLButtonElement | null
const check = (name: string, ok: boolean, detail?: string) => { results.push({ name, ok, detail }) }

async function run() {
  localStorage.removeItem(DISMISS_STORAGE_KEY)
  const cardHost = document.getElementById('sidebar-update-card')!
  check('the sidebar owns a persistent card slot', !!cardHost)
  mountUpdateNotices()
  await settle()

  // Idle: nothing is announced.
  check('idle shows no surface', !surface('update-progress') && !surface('update-banner') && !surface('update-ready'))

  // A running transfer keeps the card immediately but gates the modal, so a
  // check that answers at once never flashes a dialog.
  applyUpdateStatus(transferring(6.6, 18758041) as never)
  await settle()
  check('a running transfer shows its card at once', !!surface('update-banner'))
  check('the detail waits for its delay gate', !surface('update-progress'), `gate=${PROGRESS_DIALOG_DELAY_MS}ms`)
  await sleep(PROGRESS_DIALOG_DELAY_MS + 120)
  await settle()
  check('the detail opens after the gate', !!surface('update-progress'))
  const detail = text('update-progress')
  check('the detail reports transferred and total bytes', detail.includes('17.89 MB') && detail.includes('162.3 MB'), detail.slice(0, 160))
  check('the detail reports the smoothed speed', detail.includes('7.73 MB/s'))
  check('the detail reports a remaining-time estimate', /1[89] s|20 s/.test(detail), detail.slice(0, 200))
  check('the detail exposes a progressbar with its value', surface('update-progress')?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') === '7')
  check('focus lands inside the detail', surface('update-progress')?.contains(document.activeElement) === true)

  // Collapse: the modal goes, the transfer and its card stay.
  action('update-minimize')!.click()
  await settle()
  check('collapse closes the detail', !surface('update-progress'))
  check('collapse keeps the card', !!surface('update-banner'))
  applyUpdateStatus(transferring(24, 68073881) as never)
  await settle()
  check('a progress tick never reopens a collapsed detail', !surface('update-progress'))
  check('the collapsed card keeps reporting live progress', text('update-banner').includes('24%'), text('update-banner'))
  action('update-show-progress')!.click()
  await settle()
  check('show progress recalls the detail', !!surface('update-progress'))
  check('the recalled detail shows the newer transfer', text('update-progress').includes('64.92 MB'))

  // A finished transfer asks before restarting.
  applyUpdateStatus({ ...base, state: 'downloaded' } as never)
  await settle()
  check('a finished transfer raises its decision', !!surface('update-ready'))
  check('the decision names the version', text('update-ready').includes('0.7.5'))
  check('the decision offers postpone and restart', !!action('update-later', '[data-surface="update-ready"] ') && !!action('update-install', '[data-surface="update-ready"] '))
  check('the card remains the install entry', !!surface('update-banner'))

  // Postpone stands the whole notice down and records the version.
  action('update-later', '[data-surface="update-ready"] ')!.click()
  await settle()
  check('postpone closes the decision and the card', !surface('update-ready') && !surface('update-banner'))
  const record = JSON.parse(localStorage.getItem(DISMISS_STORAGE_KEY) || 'null')
  check('postpone records the version it silenced', record?.version === '0.7.5' && typeof record?.timestamp === 'number', JSON.stringify(record))
  applyUpdateStatus({ ...base, state: 'downloaded' } as never)
  await settle()
  check('the same postponed version stays quiet', !surface('update-ready') && !surface('update-banner'))
  applyUpdateStatus({ ...base, state: 'downloaded', availableVersion: '0.8.0' } as never)
  await settle()
  check('a different version is a new offer', !!surface('update-ready'))

  // A refused install restores the action instead of stranding it busy.
  const installButton = action('update-install', '[data-surface="update-ready"] ')!
  installButton.click()
  await settle()
  check('a refused install reports a readable error', toasts.some(toast => /could not be installed/i.test(toast.message)), JSON.stringify(toasts))
  await settle()
  check('a refused install restores the action', action('update-install', '[data-surface="update-ready"] ')?.disabled === false)
  check('the install was requested exactly once', installCalls === 1, `calls=${installCalls}`)

  // Installation owns the screen and offers no way out.
  applyUpdateStatus({ ...base, state: 'installing', progress: { percent: 88, bytesPerSecond: 0, transferred: TOTAL, total: TOTAL, installing: true } } as never)
  await settle()
  check('installation raises its own overlay', !!surface('update-installing'))
  check('installation offers no postpone or collapse', !action('update-later', '[data-surface="update-installing"] ') && !action('update-minimize', '[data-surface="update-installing"] '))
  const installing = text('update-installing')
  check('installation states the wait and that work is saved', installing.includes('10–30') && /work is saved/i.test(installing), installing.slice(0, 220))
  check('installation shows three named steps', surface('update-installing')?.querySelectorAll('[class*="stepLabel"]').length === 3)
  check('installation hides the card and the decision', !surface('update-banner') && !surface('update-ready'))

  // A failure keeps its own reason.
  applyUpdateStatus({ ...base, state: 'error', error: 'fixture checksum mismatch', errorKind: 'check-rejected' } as never)
  await settle()
  check('a failure retracts every affordance', !surface('update-banner') && !surface('update-ready') && !surface('update-installing'))

  // A person-initiated check clears the postponed offer and reports its result.
  toasts.length = 0
  checkCalls = []
  localStorage.setItem(DISMISS_STORAGE_KEY, JSON.stringify({ version: '0.9.0', timestamp: Date.now() }))
  await checkForUpdate()
  await settle()
  check('a manual check marks itself explicit', checkCalls.length === 1 && checkCalls[0]?.explicit === true, JSON.stringify(checkCalls))
  check('a manual check clears the postponed offer', localStorage.getItem(DISMISS_STORAGE_KEY) === null)
  check('a manual check reports being up to date', toasts.some(toast => /up to date/i.test(toast.message) && toast.tone === 'success'), JSON.stringify(toasts))

  // A background check with the same outcome stays silent.
  toasts.length = 0
  applyUpdateStatus({ ...base, state: 'error', error: 'background failure', errorKind: 'download-failed', explicit: false } as never)
  await settle()
  applyUpdateStatus({ ...base, state: 'idle', availableVersion: null, explicit: false } as never)
  await settle()
  check('a background outcome produces no notice', toasts.length === 0, JSON.stringify(toasts))

  // The settings page: two equal cards, and every phase names itself.
  const settingsHost = document.getElementById('settings-root')!
  const settingsRoot = createRoot(settingsHost)
  const renderSettings = () => { flushSync(() => settingsRoot.render(<AboutTab />)) }
  applyUpdateStatus({ ...base, state: 'idle', availableVersion: null } as never)
  await settle(); renderSettings()
  check('the settings page carries two cards', settingsHost.querySelectorAll('.settings-card').length === 2, String(settingsHost.querySelectorAll('.settings-card').length))
  check('the settings page keeps a release-notes entry', !!settingsHost.querySelector('#about-open-changelog'))
  check('the settings page carries no diagnostics switch', !settingsHost.querySelector('#klaus-provider-trace'))
  check('the settings page shows the running version', settingsHost.textContent?.includes('0.7.4') === true)

  applyUpdateStatus(transferring(30, 85092352) as never)
  await settle(); renderSettings()
  const downloadButton = settingsHost.querySelector('#about-check-update') as HTMLButtonElement
  check('a transfer names downloading in the action, not checking', downloadButton.textContent === I18N.en.update_header_downloading, downloadButton.textContent)
  check('the settings explanation agrees with the action', settingsHost.querySelector('[data-hint="downloading"]') !== null)

  applyUpdateStatus({ ...base, state: 'error', error: 'fixture checksum mismatch', errorKind: 'check-rejected' } as never)
  await settle(); renderSettings()
  const hint = settingsHost.querySelector('[role="status"]') as HTMLElement
  check('a rejected offer keeps its own reason', hint.dataset.hint === 'check-rejected' && hint.textContent === I18N.en.update_check_rejected, `${hint.dataset.hint}: ${hint.textContent}`)
  applyUpdateStatus({ ...base, state: 'error', error: 'fixture network failure', errorKind: 'check-unavailable' } as never)
  await settle(); renderSettings()
  check('an unreachable service is not reported as unsupported', (settingsHost.querySelector('[role="status"]') as HTMLElement).textContent === I18N.en.update_check_unavailable)
  applyUpdateStatus({ ...base, supported: false, state: 'error', error: 'development build', errorKind: 'unsupported' } as never)
  await settle(); renderSettings()
  check('only a genuinely unsupported install says so', (settingsHost.querySelector('[role="status"]') as HTMLElement).textContent === I18N.en.updates_unavailable)
  check('an unsupported install disables the action', (settingsHost.querySelector('#about-check-update') as HTMLButtonElement).disabled === true)

  // An offer already cached at launch gets the card, not a modal.
  applyUpdateStatus({ ...base, state: 'idle', availableVersion: null } as never)
  await settle()
  applyUpdateStatus({ ...base, state: 'downloaded' } as never)
  await settle()
  check('a cached offer at launch shows the card without a modal', !!surface('update-banner') && !surface('update-ready'), JSON.stringify(updateSnapshot().surfaces))

  // Capture hooks: each puts the real components into one phase so the Electron
  // runner can photograph what a person actually sees.
  w.updateSurfacesFixture = {
    downloading: async () => {
      localStorage.removeItem(DISMISS_STORAGE_KEY)
      applyUpdateStatus({ ...base, state: 'idle', availableVersion: null } as never)
      await settle()
      applyUpdateStatus(transferring(6.6, 18758041) as never)
      await sleep(PROGRESS_DIALOG_DELAY_MS + 120)
      await settle()
    },
    collapse: async () => { action('update-minimize')?.click(); await settle() },
    ready: async () => { applyUpdateStatus({ ...base, state: 'downloaded' } as never); await settle() },
    installing: async () => {
      applyUpdateStatus({ ...base, state: 'installing', progress: { percent: 88, bytesPerSecond: 0, transferred: TOTAL, total: TOTAL, installing: true } } as never)
      await settle()
    },
    settings: async () => {
      applyUpdateStatus({ ...base, state: 'idle', availableVersion: null } as never)
      await settle(); renderSettings()
      settingsHost.scrollIntoView()
    },
  }

  const passed = results.filter(result => result.ok).length
  w.updateSurfacesResults = { passed, failed: results.length - passed, results }
  w.updateSurfacesReady = Promise.resolve(true)
}

run().catch(error => {
  w.updateSurfacesError = String(error?.stack ?? error)
  w.updateSurfacesResults = { passed: results.filter(result => result.ok).length, failed: results.length, results }
  w.updateSurfacesReady = Promise.resolve(true)
})