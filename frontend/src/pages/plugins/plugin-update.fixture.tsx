import { createRoot } from 'react-dom/client'
import { PluginsPage } from './PluginsPage'
import { pluginStore, type PluginItem, type PluginOperation } from './plugin-store'
import { initializePluginNavigation } from './plugin-navigation'
import '../../app/ui-topbar'
import '../../app/ui-page-header'
import '../settings/market-tables'
import { t } from '../../i18n'
import { localizePluginName, localizePluginDescription, localizePluginBadge, getPluginIconName } from '../skills/localize'

type PluginRow = PluginItem & { id: string; name: string; description: string; installed: boolean; enabled: boolean; availableVersion: string; version: string; marketplace: string; category: string; author: string; contributions: { skills: string[] } }
const originalRows = (): PluginRow[] => [
  { id: 'model3d@klaus-official', name: 'model3d', description: 'Local sculpting, texture painting, rigging and rendering.', installed: true, enabled: false, installedVersion: '1.0.0', availableVersion: '1.1.0', updateAvailable: true, version: '1.1.0', marketplace: 'klaus-official', source: 'marketplace:klaus-official', category: 'design', author: 'Klaus', contributions: { skills: ['model3d'] }, readme: '# 3D tools\nCreate, edit and render local models.', releaseNotes: 'Improved sculpting and texture editing.' },
  { id: 'digram@klaus-official', name: 'digram', description: 'Create diagrams.', installed: true, enabled: true, installedVersion: '1.0.0', availableVersion: '1.2.0', updateAvailable: true, version: '1.2.0', marketplace: 'klaus-official', source: 'marketplace:klaus-official', category: 'design', author: 'Klaus', contributions: { skills: ['digram'] } },
  { id: 'prototype-studio@klaus-official', name: 'prototype-studio', description: 'Build interactive prototypes.', installed: false, enabled: false, availableVersion: '1.0.0', updateAvailable: false, version: '1.0.0', marketplace: 'klaus-official', source: 'marketplace:klaus-official', category: 'design', author: 'Klaus', contributions: { skills: ['prototype-studio'] } },
]
let rows = originalRows(), restartRequired = false
let pending: { id: string; options: { version: string; installedVersion: string }; resolve(value: unknown): void } | null = null
let installGate = false
let pendingInstall: { id: string; resolve(value: unknown): void } | null = null
let dialogAnswer = true
const dialogCalls: unknown[] = []
const FAILURE_LOG = '/tmp/klaus-plugin-fixture-failure.log'
const calls: Array<{ method: string; id?: string; options?: unknown }> = [], toasts: string[] = []
const listeners = new Set<(payload: { key: string }) => void>()
const progressListeners = new Set<(payload: unknown) => void>()
let invalidations = 0, checkCalls = 0, readFailure = false, checkFailure = false, checkedAt = 0
const esc = (value: unknown): string => String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

Object.assign(window, {
  currentLang: 'zh', currentSessionId: 'plugin-update-fixture', tt: t, esc,
  localizePluginName, localizePluginDescription, localizePluginBadge, getPluginIconName,
  KLAUS_GLYPH_LIBRARY: { sparkles: '' },
  filterTextMatches: (query: string, values: unknown[]) => !query || values.some(value => String(value ?? '').toLowerCase().includes(query.toLowerCase())),
  getPluginSearchValues: (plugin: PluginRow) => [plugin.name, localizePluginName(plugin), localizePluginDescription(plugin)],
  showToast: (text: string) => { toasts.push(text) },
  invalidatePluginMentionCache: () => { invalidations++ },
  klsLoading: { render: () => '<p role="status">Loading fixture</p>' },
  klsPageViews: { scrollViewToTop: () => {} },
  klausDialog: { confirm: async (options: unknown) => { dialogCalls.push(options); return dialogAnswer }, prompt: async () => null },
  klausComposer: { startNewChat: () => calls.push({ method: 'newChat' }), insertReference: (reference: unknown) => calls.push({ method: 'mention', options: reference }), setText: (text: string) => calls.push({ method: 'setText', options: text }), submit: async (text: string) => { calls.push({ method: 'submit', options: text }) } },
  klaus: {
    plugins: {
      market: async () => { if (readFailure) throw new Error('Catalog unavailable'); return { plugins: structuredClone(rows), restartRequired, updateCheck: { checking: false, checkedAt, ...(checkFailure ? { error: 'Network connection failed' } : {}) } } },
      update: (id: string, options: { version: string; installedVersion: string }) => {
        calls.push({ method: 'update', id, options: structuredClone(options) })
        if (pending) return Promise.reject(new Error('A fixture update is already pending'))
        return new Promise(resolve => { pending = { id, options, resolve } })
      },
      toggle: async (id: string, enabled: boolean) => { calls.push({ method: 'toggle', id, options: enabled }); const row = rows.find(row => row.id === id)!; row.enabled = enabled; return { ok: true } },
      uninstall: async (id: string) => { calls.push({ method: 'uninstall', id }); return { ok: true } },
      install: (id: string) => {
        calls.push({ method: 'install', id })
        const persist = () => {
          const row = rows.find(row => row.id === id)!
          row.installed = true; row.enabled = true; row.installedVersion = row.installedVersion || row.availableVersion
          return row.installedVersion
        }
        if (!installGate) return Promise.resolve({ ok: true, version: persist(), activationScope: 'next_turn' })
        if (pendingInstall) return Promise.reject(new Error('A fixture install is already pending'))
        return new Promise(resolve => { pendingInstall = { id, resolve } })
      },
      cancel: async (id: string) => {
        calls.push({ method: 'cancel', id })
        if (pending && pending.id === id) {
          const tx = pending; pending = null
          tx.resolve({ ok: false, cancelled: true })
          return { ok: true, cancelled: true }
        }
        if (pendingInstall && pendingInstall.id === id) {
          const tx = pendingInstall; pendingInstall = null
          tx.resolve({ ok: false, cancelled: true })
          return { ok: true, cancelled: true }
        }
        return { ok: false, cancelled: false }
      },
      refresh: async () => { checkCalls++; checkedAt = Date.now(); if (checkFailure) throw new Error('Network connection failed'); return { ok: true } }, addMarketplace: async () => ({ ok: true }),
    },
    on: {
      appPreferencesChanged: (callback: (payload: { key: string }) => void) => { listeners.add(callback); return () => listeners.delete(callback) },
      pluginProgress: (callback: (payload: unknown) => void) => { progressListeners.add(callback); return () => progressListeners.delete(callback) },
    },
    systemPermissions: { restartApp: async () => { calls.push({ method: 'restart' }) } },
  },
})

initializePluginNavigation()
let root = createRoot(document.getElementById('root')!)
root.render(<PluginsPage />)

const fixtureApi = {
  snapshot: () => ({ rows: structuredClone(rows), calls: structuredClone(calls), toasts: toasts.slice(), pending: pending?.id ?? null, invalidations, restartRequired, checkCalls, state: pluginStore.getSnapshot() }),
  settle: (ok: boolean, activationScope = 'next_turn') => {
    if (!pending) throw new Error('No fixture update is pending')
    const transaction = pending; pending = null
    if (ok) {
      const row = rows.find(row => row.id === transaction.id)!
      row.installedVersion = transaction.options.version; row.updateAvailable = false; restartRequired = activationScope === 'endpoint_restart'
      transaction.resolve({ ok: true, version: row.installedVersion, restartRequired, activationScope })
    } else transaction.resolve({ ok: false, error: 'Network connection failed', diagnosticLog: FAILURE_LOG })
  },
  settleInstall: (ok: boolean) => {
    if (!pendingInstall) throw new Error('No fixture install is pending')
    const transaction = pendingInstall; pendingInstall = null
    const row = rows.find(row => row.id === transaction.id)!
    if (ok) { row.installed = true; row.enabled = true; row.installedVersion = row.availableVersion }
    transaction.resolve(ok ? { ok: true, version: row.installedVersion, activationScope: 'next_turn' } : { ok: false, error: 'Network connection failed', diagnosticLog: FAILURE_LOG })
  },
  gateInstall: (gate: boolean) => { installGate = gate },
  emitProgress: (event: unknown) => { for (const cb of progressListeners) cb(event) },
  dialog: () => dialogCalls.slice(),
  setDialogAnswer: (answer: boolean) => { dialogAnswer = answer },
  reset: async () => { if (pending) throw new Error('Cannot reset a pending fixture'); if (pendingInstall) throw new Error('Cannot reset a pending install'); installGate = false; dialogAnswer = true; dialogCalls.length = 0; rows = originalRows(); restartRequired = false; calls.length = 0; toasts.length = 0; invalidations = 0; readFailure = false; checkFailure = false; for (const row of rows) pluginStore.dismiss(row.id); await pluginStore.load() },
  remount: () => { root.unmount(); root = createRoot(document.getElementById('root')!); root.render(<PluginsPage />) },
  failRead: (fail: boolean) => { readFailure = fail },
  failCheck: (fail: boolean) => { checkFailure = fail },
  publish: (id: string, version: string) => { const row = rows.find(row => row.id === id)!; row.availableVersion = version; row.updateAvailable = row.installedVersion !== version },
  operation: (id: string): PluginOperation | undefined => pluginStore.getSnapshot().operations[id],
  language: (lang: 'en' | 'zh') => { (window as any).currentLang = lang; window.dispatchEvent(new Event('klaus:lang-change')) },
  close: () => root.unmount(),
}

window.pluginUpdateFixture = fixtureApi
declare global { interface Window { pluginUpdateFixture: typeof fixtureApi } }
