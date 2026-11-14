// Real-component fixture for the update surfaces. It mounts the shipped store,
// sidebar card, installation overlay and settings page, drives them through a
// synthetic host and measures the actual DOM: only the sidebar card appears for
// available, downloading and ready offers, while the centered modal opens only
// when installation is requested or running, and the settings page owns the
// automatic-download switch.
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { mountUpdateNotices } from '../frontend/src/app/update/mount'
import { applyUpdateStatus, checkForUpdate, updateSnapshot } from '../frontend/src/app/update/store'
import { DISMISS_STORAGE_KEY } from '../frontend/src/app/update/model'
import { UPDATER_AUTO_DOWNLOAD_KEY } from '../shared/updater-preferences'
import { AboutTab } from '../frontend/src/pages/settings/about-tab'
import { I18N } from '../frontend/src/i18n/messages'

type Result = { name: string; ok: boolean; detail?: string }
const results: Result[] = []
const toasts: Array<{ message: string; tone?: string }> = []
const kv = new Map<string, string>()
const w = window as any

w.currentLang = 'en'
w.tt = (key: string) => (I18N.en as Record<string, string>)[key] ?? key
w.showToast = (message: string, options?: { tone?: string }) => { toasts.push({ message, tone: options?.tone }) }
w.settingsApi = {
  kv: {
    get: async (key: string) => kv.get(key) ?? null,
    set: async (key: string, value: string) => {
      kv.set(key, value)
      prefListener?.({ key })
      return { ok: true }
    },
  },
}

const TOTAL = 170184704
const base = {
  supported: true, currentVersion: '0.7.4', availableVersion: '0.7.5',
  error: null, errorKind: null, explicit: false, progress: null,
}
const transferring = (percent: number, transferred: number) => ({
  ...base, state: 'downloading',
  progress: { percent, bytesPerSecond: 8105472, transferred, total: TOTAL, installing: false },
})

let checkCalls: Array<{ explicit?: boolean; download?: boolean } | undefined> = []
let installCalls = 0
let resolvePendingInstall: ((value: { ok: boolean; error?: string }) => void) | null = null
let push: ((status: unknown) => void) | undefined
let prefListener: ((payload: { key: string }) => void) | undefined
w.klaus = {
  updater: {
    status: async () => ({ ...base, state: 'idle', availableVersion: null }),
    check: async (args?: { explicit?: boolean; download?: boolean }) => {
      checkCalls.push(args)
      if (args?.download) return transferring(0, 0)
      return { ...base, state: 'idle', availableVersion: null, explicit: args?.explicit === true }
    },
    install: async () => {
      installCalls++
      if (resolvePendingInstall) {
        return await new Promise(resolve => { resolvePendingInstall = resolve })
      }
      return { ok: false, error: 'fixture install refused' }
    },
  },
  on: {
    updaterStatus: (cb: (status: unknown) => void) => { push = cb; return () => { push = undefined } },
    appPreferencesChanged: (cb: (payload: { key: string }) => void) => { prefListener = cb; return () => { prefListener = undefined } },
  },
  app: { distribution: async () => ({ productName: 'Klaus' }) },
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const settle = async () => { await sleep(0); await new Promise(resolve => requestAnimationFrame(() => resolve(null))); await sleep(0) }
const surface = (name: string) => document.querySelector(`[data-surface="${name}"]`)
const anyModal = () => document.querySelector('[role="dialog"]')
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
  check('idle shows no surface', !surface('update-banner') && !surface('update-installing') && !anyModal())

  // Available (when automatic downloads are off): shows only the sidebar card.
  applyUpdateStatus({ ...base, state: 'available' } as never)
  await settle()
  check('an available update shows the sidebar card without any modal', !!surface('update-banner') && !anyModal())
  check('the available card names the version and offers download + later',
    text('update-banner').includes('0.7.5') && !!action('update-download', '[data-surface="update-banner"] ') && !!action('update-later', '[data-surface="update-banner"] '),
    text('update-banner'))
  action('update-later', '[data-surface="update-banner"] ')!.click()
  await settle()
  check('postponing an available update silences the sidebar card', !surface('update-banner'))
  applyUpdateStatus({ ...base, state: 'available', availableVersion: '0.7.6' } as never)
  await settle()
  check('a newer available version reappears in the sidebar card', !!surface('update-banner'))
  checkCalls = []
  action('update-download', '[data-surface="update-banner"] ')!.click()
  await settle()
  check('clicking download requests an explicit transfer from the host',
    checkCalls.length === 1 && checkCalls[0]?.explicit === true && checkCalls[0]?.download === true,
    JSON.stringify(checkCalls))

  // Downloading: ONLY the bottom-left sidebar card appears, never a centered modal.
  applyUpdateStatus(transferring(6.6, 18758041) as never)
  await settle()
  await sleep(650)
  await settle()
  check('a running transfer shows only the sidebar card and never opens a centered modal',
    !!surface('update-banner') && !surface('update-progress') && !anyModal())
  const banner = text('update-banner')
  check('the downloading card names the version and percent', banner.includes('0.7.5') && banner.includes('7%'), banner)
  check('the downloading card reports transferred/total bytes and remaining time',
    banner.includes('17.89 MB / 162.3 MB') && /1[89] s left|20 s left/.test(banner), banner)
  check('the downloading card exposes a progressbar with its value',
    surface('update-banner')?.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow') === '7')
  check('the downloading card carries no postpone or modal-expand button',
    !action('update-later', '[data-surface="update-banner"] ') && !action('update-show-progress', '[data-surface="update-banner"] '))
  applyUpdateStatus(transferring(24, 68073881) as never)
  await settle()
  check('progress ticks update the sidebar card without raising any modal',
    text('update-banner').includes('24%') && text('update-banner').includes('64.92 MB') && !anyModal())

  // Downloaded: stays in the sidebar card without popping a centered modal.
  applyUpdateStatus({ ...base, state: 'downloaded' } as never)
  await settle()
  check('a finished transfer stays in the sidebar card with no centered modal',
    !!surface('update-banner') && !surface('update-ready') && !surface('update-installing') && !anyModal(),
    JSON.stringify(updateSnapshot().surfaces))
  check('the ready card names the version and offers restart + later',
    text('update-banner').includes('0.7.5') && !!action('update-install', '[data-surface="update-banner"] ') && !!action('update-later', '[data-surface="update-banner"] '))

  // Postponing a ready offer silences the card per version.
  action('update-later', '[data-surface="update-banner"] ')!.click()
  await settle()
  check('postpone closes the ready card', !surface('update-banner') && !anyModal())
  const record = JSON.parse(localStorage.getItem(DISMISS_STORAGE_KEY) || 'null')
  check('postpone records the version it silenced', record?.version === '0.7.5' && typeof record?.timestamp === 'number', JSON.stringify(record))
  applyUpdateStatus({ ...base, state: 'downloaded' } as never)
  await settle()
  check('the same postponed version stays quiet', !surface('update-banner'))
  applyUpdateStatus({ ...base, state: 'downloaded', availableVersion: '0.8.0' } as never)
  await settle()
  check('a different version is a new offer in the sidebar card without a modal', !!surface('update-banner') && !anyModal())

  // Clicking install immediately opens the centered installation modal; refusal retracts it and restores the card.
  resolvePendingInstall = () => {}
  action('update-install', '[data-surface="update-banner"] ')!.click()
  await settle()
  check('clicking install immediately raises the centered installation modal and hides the sidebar card',
    !!surface('update-installing') && !surface('update-banner'))
  check('focus lands inside the installation modal', surface('update-installing')?.contains(document.activeElement) === true)
  resolvePendingInstall?.({ ok: false, error: 'fixture install refused' })
  resolvePendingInstall = null
  await settle()
  check('a refused install retracts the modal, reports a readable error, and restores the sidebar card',
    !surface('update-installing') && !!surface('update-banner') && toasts.some(toast => /could not be installed/i.test(toast.message)),
    JSON.stringify(toasts))
  check('the install was requested exactly once', installCalls === 1, `calls=${installCalls}`)

  // Installation owns the centered modal and offers no way out.
  applyUpdateStatus({ ...base, state: 'installing', progress: { percent: 88, bytesPerSecond: 0, transferred: TOTAL, total: TOTAL, installing: true } } as never)
  await settle()
  check('installation raises its centered overlay', !!surface('update-installing'))
  check('installation offers no postpone or collapse', !action('update-later', '[data-surface="update-installing"] ') && !action('update-minimize', '[data-surface="update-installing"] '))
  const installing = text('update-installing')
  check('installation states the wait and that work is saved', installing.includes('10–30') && /work is saved/i.test(installing), installing.slice(0, 220))
  check('installation shows three named steps', surface('update-installing')?.querySelectorAll('[class*="stepLabel"]').length === 3)
  check('installation hides the sidebar card', !surface('update-banner'))

  // A failure keeps its own reason and retracts overlays.
  applyUpdateStatus({ ...base, state: 'error', error: 'fixture checksum mismatch', errorKind: 'check-rejected' } as never)
  await settle()
  check('a failure retracts every affordance', !surface('update-banner') && !surface('update-installing'))

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

  // The settings page: two cards, aligned auto-download switch, and every phase names itself.
  const settingsHost = document.getElementById('settings-root')!
  const settingsRoot = createRoot(settingsHost)
  const renderSettings = () => { flushSync(() => settingsRoot.render(<AboutTab />)) }
  applyUpdateStatus({ ...base, state: 'idle', availableVersion: null } as never)
  renderSettings()
  await settle()
  check('the settings page carries two cards', settingsHost.querySelectorAll('.settings-card').length === 2, String(settingsHost.querySelectorAll('.settings-card').length))
  check('the settings page keeps a release-notes entry', !!settingsHost.querySelector('#about-open-changelog'))
  check('the settings page carries no diagnostics switch', !settingsHost.querySelector('#klaus-provider-trace'))
  check('the settings page shows the running version', settingsHost.textContent?.includes('0.7.4') === true)

  const autoSwitch = settingsHost.querySelector('#about-auto-download') as HTMLInputElement | null
  check('the settings page renders the automatic-download toggle enabled by default',
    !!autoSwitch && autoSwitch.checked === true && autoSwitch.disabled === false)
  const versionRow = settingsHost.querySelector('.settings-card [class*="about-version-row"]') as HTMLElement
  const prefRow = settingsHost.querySelector('.settings-card .pref-row') as HTMLElement
  const rowRect = versionRow.getBoundingClientRect()
  const prefRect = prefRow.getBoundingClientRect()
  check('the automatic-download row aligns flush with the version row inside the card',
    Math.abs(rowRect.left - prefRect.left) <= 1 && Math.abs(rowRect.right - prefRect.right) <= 1,
    `deltaLeft=${rowRect.left - prefRect.left}, deltaRight=${rowRect.right - prefRect.right}`)

  autoSwitch!.click()
  await settle()
  check('turning automatic downloads off writes off to kv and updates the idle hint',
    kv.get(UPDATER_AUTO_DOWNLOAD_KEY) === 'off'
      && autoSwitch!.checked === false
      && (settingsHost.querySelector('[role="status"]') as HTMLElement).textContent === I18N.en.update_action_manual_hint,
    `kv=${kv.get(UPDATER_AUTO_DOWNLOAD_KEY)}, hint=${(settingsHost.querySelector('[role="status"]') as HTMLElement).textContent}`)

  applyUpdateStatus({ ...base, state: 'available' } as never)
  await settle(); renderSettings()
  const availableBtn = settingsHost.querySelector('#about-download-update') as HTMLButtonElement | null
  check('an available update offers a primary Download update button in settings',
    !!availableBtn && availableBtn.textContent === I18N.en.update_download_action && availableBtn.classList.contains('btn-primary')
      && (settingsHost.querySelector('[role="status"]') as HTMLElement).dataset.hint === 'available')

  autoSwitch!.click()
  await settle()
  check('turning automatic downloads back on writes on to kv', kv.get(UPDATER_AUTO_DOWNLOAD_KEY) === 'on' && autoSwitch!.checked === true)

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
  check('an unsupported install disables both the action and the auto-download switch',
    (settingsHost.querySelector('#about-check-update') as HTMLButtonElement).disabled === true
      && (settingsHost.querySelector('#about-auto-download') as HTMLInputElement).disabled === true)

  // Capture hooks: each puts the real components into one phase so the Electron
  // runner can photograph what a person actually sees.
  w.updateSurfacesFixture = {
    available: async () => {
      localStorage.removeItem(DISMISS_STORAGE_KEY)
      kv.set(UPDATER_AUTO_DOWNLOAD_KEY, 'off')
      prefListener?.({ key: UPDATER_AUTO_DOWNLOAD_KEY })
      applyUpdateStatus({ ...base, state: 'available' } as never)
      await settle(); renderSettings()
    },
    downloading: async () => {
      localStorage.removeItem(DISMISS_STORAGE_KEY)
      kv.set(UPDATER_AUTO_DOWNLOAD_KEY, 'on')
      prefListener?.({ key: UPDATER_AUTO_DOWNLOAD_KEY })
      applyUpdateStatus(transferring(24, 68073881) as never)
      await settle(); renderSettings()
    },
    ready: async () => {
      applyUpdateStatus({ ...base, state: 'downloaded' } as never)
      await settle(); renderSettings()
    },
    installing: async () => {
      applyUpdateStatus({ ...base, state: 'installing', progress: { percent: 88, bytesPerSecond: 0, transferred: TOTAL, total: TOTAL, installing: true } } as never)
      await settle(); renderSettings()
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
