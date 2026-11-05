// Browser settings: plugin capability, URL routing, browsing data, site
// policies, download history and the Chrome extension connection. The page is
// driven by the flat BrowserSettingsSnapshot returned by settingsApi.browserUse.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { ModalPortal } from '../../components/ModalPortal'
import { BrowserCapabilityModal } from '../mcp/browser-connect'
import { BROWSER_DEFAULT_POLICY, BROWSER_RESOURCES, browserOriginPattern, type BrowserAccess, type BrowserManagerBounds, type BrowserManagerOptions, type BrowserManagerState, type BrowserManagerTheme, type NativeManagerSurface, type BrowserResource, type BrowserSettingsSnapshot } from '../../../../contracts/browser-settings'
import type { SiteOpenTargetId } from '../../../../contracts/browser-sites'
import { BrowserImportDialog, type BrowserImportUiApi } from './browser-import-dialog'
import { CapabilityRow, CapabilitySwitch } from './capability-tabs'
import { pluginActivationNote } from '../plugins/activation-note'
import { PrefToggleRow, SettingsPage } from './kv'
import styles from './browser-settings.module.css'
import settingsStyles from './settings.module.css'

const w = () => window as any

type BrowserSource = 'all' | 'agent' | 'other'
type HistoryRow = { id: string; url: string; title: string; visitTime: number; isActorVisit: boolean }
type DownloadRow = {
  id: string; url: string; filename: string; path: string; state: string
  receivedBytes: number; totalBytes: number; startedAt: number
  canPause: boolean; canResume: boolean; canCancel: boolean; exists: boolean
}
type DownloadEvent = { id: string; state?: string; receivedBytes?: number; totalBytes?: number; exists?: boolean; filename?: string; path?: string; url?: string; canPause?: boolean; canResume?: boolean; canCancel?: boolean }
type Page<T> = { ok?: boolean; items: T[]; nextCursor?: string | null; error?: string }
type BrowserUseApi = {
  get(): Promise<BrowserSettingsSnapshot | { ok?: boolean; settings?: BrowserSettingsSnapshot; error?: string }>
  setEnabled(enabled: boolean): Promise<any>
  setChromeEnabled(enabled: boolean): Promise<any>
  setPreferences(patch: Record<string, unknown>): Promise<any>
  setOriginPolicy(input: { pattern?: string; resource: BrowserResource; setting: BrowserAccess | 'inherit' }): Promise<any>
  removeOriginPolicy(pattern: string): Promise<any>
  history(input?: { query?: string; source?: BrowserSource; cursor?: string | null; limit?: number }): Promise<Page<HistoryRow>>
  removeHistory(ids: string[]): Promise<any>
  downloads(input?: { query?: string; cursor?: string | null; limit?: number }): Promise<Page<DownloadRow>>
  subscribeDownloads?(callback: (event: DownloadEvent) => void): () => void
  downloadAction(action: string, id: string): Promise<any>
  chooseDownloadDirectory(): Promise<{ ok?: boolean; settings?: BrowserSettingsSnapshot; path?: string | null; error?: string }>
  openManager(surface: NativeManagerSurface, options?: BrowserManagerOptions): Promise<any>
  onManagerState?(listener: (state: BrowserManagerState) => void): () => void
  clearData(kind: string): Promise<any>
  subscribe?(callback: (snapshot: BrowserSettingsSnapshot) => void): () => void
}

const api = (): BrowserUseApi | undefined => w().settingsApi?.browserUse

export function snapshotOf(value: any): BrowserSettingsSnapshot | null {
  const candidate = value?.settings ?? value?.value ?? value
  return candidate && typeof candidate.enabled === 'boolean' ? candidate as BrowserSettingsSnapshot : null
}

function failed(reply: any): string | null {
  if (!reply || reply.ok === false) return String(reply?.error || 'settings_failed')
  return reply.error ? String(reply.error) : null
}

function showError(t: (key: string) => string, message: string): void {
  w().showToast?.(message === 'settings_failed' ? t('browser_settings_save_failed') : message)
}

export function browserTargetOptions(t: (key: string) => string, saved: SiteOpenTargetId) {
  const options = [
    { value: 'in-app', label: t('browser_settings_target_in_app') },
    ...(saved === 'chrome' ? [{ value: 'chrome', label: t('browser_settings_target_chrome') }] : []),
    { value: 'system-default', label: t('browser_settings_target_system') },
  ]
  return options
}

function BrowserSelectRow({ id, label, desc, value, options, disabled, onChange }: {
  id: string
  label: string
  desc: string
  value: string
  options: Array<{ value: string; label: string }>
  disabled?: boolean
  onChange: (value: string) => void
}) {
  return (
    <div className="pref-row" aria-disabled={disabled || undefined}>
      <div className={styles['browser-copy']}>
        <div className={settingsStyles['pref-row-label']} id={`${id}-label`}>{label}</div>
        <div className={settingsStyles['pref-row-desc']} id={`${id}-desc`}>{desc}</div>
      </div>
      <select id={id} className={styles['browser-select']} aria-labelledby={`${id}-label`} aria-describedby={`${id}-desc`} value={value} disabled={disabled} onChange={event => onChange(event.target.value)}>
        {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </div>
  )
}

function resourceLabel(t: (key: string) => string, resource: BrowserResource): string {
  return t(`browser_settings_resource_${resource}`)
}

function accessLabel(t: (key: string) => string, access: BrowserAccess | 'inherit'): string {
  return t(access === 'inherit' ? 'browser_settings_inherit' : `browser_settings_${access}`)
}

function formatTime(value: number): string {
  return Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString() : ''
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return ''
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function downloadStateLabel(t: (key: string) => string, state: string): string {
  const normalized = state.toLowerCase().replace(/[^a-z]/g, '')
  const key = normalized === 'inprogress' || normalized === 'progressing' ? 'progressing'
    : normalized === 'cancelled' ? 'canceled'
    : normalized
  return t(`browser_settings_download_state_${key}`) === `browser_settings_download_state_${key}` ? state : t(`browser_settings_download_state_${key}`)
}

function downloadFlags(state: string, row: DownloadRow) {
  const normalized = state.toLowerCase().replace(/[^a-z]/g, '')
  const terminal = ['completed', 'failed', 'canceled', 'cancelled'].includes(normalized)
  if (!normalized) return { canPause: row.canPause, canResume: row.canResume, canCancel: row.canCancel }
  return {
    canPause: normalized === 'progressing' || normalized === 'inprogress' || normalized === 'active',
    canResume: normalized === 'paused' || normalized === 'interrupted',
    canCancel: !terminal,
  }
}

function applyDownloadEvent(row: DownloadRow, event: DownloadEvent): DownloadRow {
  const state = typeof event.state === 'string' ? event.state : row.state
  return {
    ...row,
    state,
    ...(typeof event.receivedBytes === 'number' ? { receivedBytes: event.receivedBytes } : {}),
    ...(typeof event.totalBytes === 'number' ? { totalBytes: event.totalBytes } : {}),
    ...(typeof event.exists === 'boolean' ? { exists: event.exists } : {}),
    ...(typeof event.filename === 'string' ? { filename: event.filename } : {}),
    ...(typeof event.path === 'string' ? { path: event.path } : {}),
    ...(typeof event.url === 'string' ? { url: event.url } : {}),
    ...downloadFlags(state, row),
    ...(typeof event.canPause === 'boolean' ? { canPause: event.canPause } : {}),
    ...(typeof event.canResume === 'boolean' ? { canResume: event.canResume } : {}),
    ...(typeof event.canCancel === 'boolean' ? { canCancel: event.canCancel } : {}),
  }
}

function mergeFirstDownloadPage(current: DownloadRow[], firstPage: DownloadRow[]): DownloadRow[] {
  const firstIds = new Set(firstPage.map(row => row.id))
  return [...firstPage, ...current.filter(row => !firstIds.has(row.id))]
}

function useDebounced<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delay)
    return () => window.clearTimeout(timer)
  }, [value, delay])
  return debounced
}

const CLEAR_KINDS = ['history', 'downloads', 'cookies', 'cache', 'siteData'] as const
const MANAGER_META: Record<NativeManagerSurface, { label: string; desc: string }> = {
  passwords: { label: 'browser_settings_passwords', desc: 'browser_settings_passwords_desc' },
  autofill: { label: 'browser_settings_autofill', desc: 'browser_settings_autofill_desc' },
  extensions: { label: 'browser_settings_extensions', desc: 'browser_settings_extensions_desc' },
  siteSettings: { label: 'browser_settings_site_settings', desc: 'browser_settings_site_settings_desc' },
}

const MANAGER_ROUTES: Record<NativeManagerSurface, { initialUrl: string; roots: string[] }> = {
  passwords: { initialUrl: 'chrome://password-manager/passwords', roots: ['chrome://password-manager', 'chrome://settings/passwords'] },
  autofill: { initialUrl: 'chrome://settings/contactInfo', roots: ['chrome://settings/addresses', 'chrome://settings/autofill', 'chrome://settings/contactInfo'] },
  extensions: { initialUrl: 'chrome://extensions', roots: ['chrome://extensions'] },
  siteSettings: { initialUrl: 'chrome://settings/content', roots: ['chrome://settings/content', 'chrome://settings/cookies', 'chrome://settings/handlers'] },
}

function managerAllowedUrl(surface: NativeManagerSurface, url: string): boolean {
  return MANAGER_ROUTES[surface].roots.some(root => url === root || url.startsWith(`${root}/`) || url.startsWith(`${root}?`))
}

function managerTheme(): BrowserManagerTheme {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

function BrowserManagerRow({ surface, disabled, busy, onOpenManager }: {
  surface: NativeManagerSurface
  disabled: boolean
  busy: string
  onOpenManager: (surface: NativeManagerSurface) => void
}) {
  const t = useT()
  const meta = MANAGER_META[surface]
  return (
    <div className="pref-row">
      <div className={styles['browser-copy']}>
        <div className={settingsStyles['pref-row-label']} id={`browser-manager-${surface}-label`}>{t(meta.label)}</div>
        <div className={settingsStyles['pref-row-desc']} id={`browser-manager-${surface}-desc`}>{t(meta.desc)}</div>
      </div>
      <button
        type="button"
        id={`browser-open-${surface}`}
        className={styles['browser-action-btn']}
        data-surface={surface}
        aria-labelledby={`browser-manager-${surface}-label`}
        aria-describedby={`browser-manager-${surface}-desc`}
        disabled={disabled || busy === `manager:${surface}`}
        aria-busy={busy === `manager:${surface}` || undefined}
        onClick={() => onOpenManager(surface)}
      >
        {t('browser_settings_manage')}
      </button>
    </div>
  )
}

type ManagerRequest = (surface: NativeManagerSurface, options: BrowserManagerOptions & { viewId: string }, generation: number) => Promise<any>
type ManagerStateListener = (listener: (state: BrowserManagerState) => void) => () => void

let managerViewSequence = 0

/** A view token is unique across pane remounts and retries. */
function newManagerViewId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  managerViewSequence += 1
  return `manager-${Date.now().toString(36)}-${managerViewSequence.toString(36)}-${Math.random().toString(36).slice(2)}`
}

function managerBounds(node: HTMLElement): BrowserManagerBounds | null {
  const rect = node.getBoundingClientRect()
  if (!(rect.width > 0) || !(rect.height > 0)) return null
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  }
}

/** A settings-pane subpage whose measured rectangle hosts the native manager. */
export function NativeManagementPane({ surface, generation, onBack, openManager, onClose, onManagerState }: {
  surface: NativeManagerSurface
  generation: number
  onBack: () => void
  openManager: ManagerRequest
  onClose: (surface: NativeManagerSurface, generation: number, viewId: string) => void
  onManagerState?: ManagerStateListener
}) {
  const t = useT()
  const hostRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [viewId, setViewId] = useState<string | null>(null)
  const [navigation, setNavigation] = useState<BrowserManagerState | null>(null)
  const meta = MANAGER_META[surface]
  const route = MANAGER_ROUTES[surface]

  useEffect(() => {
    const node = hostRef.current
    if (!node) return
    let disposed = false
    let frame: number | undefined
    let opened = false
    let opening = false
    let requested = false
    let failed = false
    let lastBounds = ''
    const viewId = newManagerViewId()
    setViewId(viewId)
    setNavigation(null)

    const run = async (): Promise<void> => {
      if (disposed || failed) return
      const bounds = managerBounds(node)
      if (!bounds) return
      const key = `${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}`
      if (key === lastBounds) return
      if (!opened && opening) return
      lastBounds = key
      const action: 'open' | 'bounds' = opened ? 'bounds' : 'open'
      if (action === 'open') {
        opening = true
        requested = true
        setStatus('loading')
        setError('')
      }
      try {
        const result = await openManager(surface, {
          action,
          bounds,
          viewId,
          ...(action === 'open' ? { theme: managerTheme() } : {}),
        }, generation)
        if (disposed) return
        if (!result || result.ok === false || result.error) {
          failed = true
          setStatus('error')
          setError(String(result?.error || t('browser_settings_open_failed')))
          return
        }
        if (action === 'open') {
          opened = true
          setStatus('ready')
        }
      } catch (cause: any) {
        if (disposed) return
        failed = true
        setStatus('error')
        setError(cause?.message || t('browser_settings_open_failed'))
      } finally {
        if (action === 'open') opening = false
      }
    }

    const schedule = (): void => {
      if (disposed || failed || frame !== undefined) return
      frame = window.requestAnimationFrame(() => {
        frame = undefined
        void run()
      })
    }

    schedule()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule)
    observer?.observe(node)
    const update = (): void => schedule()
    window.addEventListener('resize', update)
    document.addEventListener('scroll', update, true)
    return () => {
      disposed = true
      if (frame !== undefined) window.cancelAnimationFrame(frame)
      observer?.disconnect()
      window.removeEventListener('resize', update)
      document.removeEventListener('scroll', update, true)
      if (requested) onClose(surface, generation, viewId)
    }
  }, [surface, generation, attempt, openManager, onClose, t])

  useEffect(() => {
    if (!viewId || !onManagerState) return
    return onManagerState(state => {
      if (state.surface !== surface || state.viewId !== viewId) return
      if (!managerAllowedUrl(surface, state.url)) return
      setNavigation(state)
    })
  }, [surface, viewId, onManagerState])

  useEffect(() => {
    if (!viewId || status !== 'ready') return
    const sendTheme = (): void => {
      void openManager(surface, { action: 'theme', theme: managerTheme(), viewId }, generation).catch(() => {})
    }
    const observer = typeof MutationObserver === 'undefined' ? null : new MutationObserver(sendTheme)
    observer?.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    window.addEventListener('klaus:theme-change', sendTheme)
    return () => {
      observer?.disconnect()
      window.removeEventListener('klaus:theme-change', sendTheme)
    }
  }, [surface, generation, viewId, status, openManager])

  const sendAction = async (action: 'back' | 'forward' | 'navigate', extra: { url?: string } = {}): Promise<void> => {
    if (!viewId) return
    try {
      const result = await openManager(surface, { action, viewId, ...extra }, generation)
      if (result?.ok === false || result?.error) {
        setStatus('error')
        setError(String(result?.error || t('browser_settings_open_failed')))
      }
    } catch (cause: any) {
      setStatus('error')
      setError(cause?.message || t('browser_settings_open_failed'))
    }
  }

  const goBack = (): void => {
    if (navigation?.canGoBack) void sendAction('back')
    else onBack()
  }
  const resetSection = (): void => {
    const initialUrl = navigation?.initialUrl ?? route.initialUrl
    if (navigation?.url && navigation.url !== initialUrl && managerAllowedUrl(surface, initialUrl)) void sendAction('navigate', { url: initialUrl })
  }

  const sectionLabel = t(meta.label)
  const title = navigation?.title?.trim() || sectionLabel
  return (
    <SettingsPage
      title={sectionLabel}
      subtitle={t(meta.desc)}
      actions={<button type="button" id="browser-native-back" className={styles['browser-action-btn']} onClick={onBack}>{t('browser_settings_back')}</button>}
    >
      <div className={styles['browser-native-shell']}>
        <div className={styles['browser-native-toolbar']}>
          <div className={styles['browser-native-nav']}>
            <button type="button" data-native-nav="back" aria-label={t('browser_settings_back')} disabled={!navigation?.canGoBack} onClick={goBack}>←</button>
            <button type="button" data-native-nav="forward" aria-label={t('browser_settings_forward')} disabled={!navigation?.canGoForward} onClick={() => { if (navigation?.canGoForward) void sendAction('forward') }}>→</button>
          </div>
          <nav className={styles['browser-native-breadcrumb']} aria-label={t('browser_settings_location')}>
            <button type="button" className={styles['browser-native-crumb']} data-native-crumb="root" onClick={onBack}>{t('browser_use_title')}</button>
            <span aria-hidden="true">/</span>
            <button type="button" className={styles['browser-native-crumb']} data-native-crumb="section" disabled={!navigation?.url || navigation.url === route.initialUrl} onClick={resetSection}>{sectionLabel}</button>
            {title !== sectionLabel && <><span aria-hidden="true">/</span><span className={styles['browser-native-title']} aria-current="page">{title}</span></>}
          </nav>
        </div>
        <div ref={hostRef} className={styles['browser-native-pane']} data-native-management-pane={surface} aria-busy={status === 'loading' || undefined}>
          {status === 'loading' && <div role="status" className={styles['browser-native-state']}>{t('browser_settings_loading')}</div>}
          {status === 'error' && (
            <div role="alert" className={styles['browser-native-state']}>
              <span>{error}</span>
              <button type="button" className={styles['browser-action-btn']} onClick={() => { setStatus('loading'); setError(''); setAttempt(value => value + 1) }}>{t('browser_settings_retry')}</button>
            </div>
          )}
        </div>
      </div>
    </SettingsPage>
  )
}

export interface BrowserSettingsViewProps {
  snapshot: BrowserSettingsSnapshot
  busy: string
  onToggleEnabled: (enabled: boolean) => void
  onPatch: (patch: Record<string, unknown>) => void
  onClearData: (kinds: string[]) => void
  onOpenHistory: () => void
  onOpenDownloads: () => void
  onChooseDownloadDirectory: () => void
  onOpenManager: (surface: NativeManagerSurface) => void
  onOpenImport: () => void
  onSetChromeEnabled: (enabled: boolean) => void
  onAddOrigin: (pattern: string) => Promise<boolean>
  onSetDefaultPolicy: (resource: BrowserResource, setting: BrowserAccess) => void
  onSetOriginPolicy: (pattern: string, resource: BrowserResource, setting: BrowserAccess | 'inherit') => void
  onRemoveOrigin: (pattern: string) => void
  onOpenChromeSetup: () => void
}

/** Pure presentation of the main settings page; the data owner passes a snapshot. */
export function BrowserSettingsView({
  snapshot, busy, onToggleEnabled, onPatch, onClearData, onOpenHistory, onOpenDownloads,
  onChooseDownloadDirectory, onOpenManager, onOpenImport, onSetChromeEnabled, onAddOrigin, onSetDefaultPolicy,
  onSetOriginPolicy, onRemoveOrigin, onOpenChromeSetup,
}: BrowserSettingsViewProps) {
  const t = useT()
  const disabled = snapshot.browserAvailable === false
  const [clearExpanded, setClearExpanded] = useState(false)
  const clearing = busy.startsWith('clear:')
  const [originDraft, setOriginDraft] = useState('')
  const [originError, setOriginError] = useState('')
  const webTargets = browserTargetOptions(t, snapshot.webUrlTarget)
  const localTargets = browserTargetOptions(t, snapshot.localUrlTarget)
  const annotationOptions = [
    { value: 'always', label: t('browser_settings_annotation_always') },
    { value: 'necessary', label: t('browser_settings_annotation_necessary') },
  ]
  const accessOptions = (includeInherit: boolean) => [
    ...(includeInherit ? [{ value: 'inherit', label: accessLabel(t, 'inherit') }] : []),
    { value: 'allow', label: accessLabel(t, 'allow') },
    { value: 'ask', label: accessLabel(t, 'ask') },
    { value: 'deny', label: accessLabel(t, 'deny') },
  ]

  const submitOrigin = async (event: React.FormEvent) => {
    event.preventDefault()
    const pattern = browserOriginPattern(originDraft)
    if (!pattern) { setOriginError(t('browser_settings_invalid_domain')); return }
    setOriginError('')
    if (await onAddOrigin(pattern)) setOriginDraft('')
  }

  return (
    <SettingsPage title={t('browser_use_title')} subtitle={t('browser_use_desc')}>
      {disabled && <div className={styles['browser-notice']} role="status">{t('browser_settings_disabled_notice')}</div>}
      <div className="settings-section">
        <div className={styles['browser-card']}>
          <CapabilityRow
            title={t('browser_use_title')}
            desc={t('browser_settings_enable_desc')}
            iconName="browser"
            action={<CapabilitySwitch id="browser-settings-enabled" checked={snapshot.enabled} ariaLabel={t('browser_use_title')} disabled={busy === 'enabled'} onChange={onToggleEnabled} />}
          />
        </div>
      </div>

      <div className="settings-section">
        <div className={settingsStyles['settings-section-title-row']}>
          <div className="settings-section-title">{t('browser_settings_general')}</div>
          {snapshot.nativeManagementAvailable === true && (
            <div className={settingsStyles['settings-section-title-action']}>
              <button
                type="button"
                id="browser-open-import"
                className={styles['browser-action-btn']}
                data-surface="import"
                aria-label={`${t('browser_settings_import')}: ${t('browser_settings_import_action')}`}
                disabled={disabled}
                onClick={onOpenImport}
              >
                {t('browser_settings_import_action')}
              </button>
            </div>
          )}
        </div>
        <div className={styles['browser-card']}>
          <BrowserSelectRow id="browser-web-target" label={t('browser_settings_open_web')} desc={t('browser_settings_open_web_desc')} value={snapshot.webUrlTarget} options={webTargets} disabled={disabled} onChange={value => onPatch({ webUrlTarget: value as SiteOpenTargetId })} />
          <BrowserSelectRow id="browser-local-target" label={t('browser_settings_open_local')} desc={t('browser_settings_open_local_desc')} value={snapshot.localUrlTarget} options={localTargets} disabled={disabled} onChange={value => onPatch({ localUrlTarget: value as SiteOpenTargetId })} />
          <PrefToggleRow id="browser-show-full-url" label={t('browser_settings_show_full_url')} desc={t('browser_settings_show_full_url_desc')} checked={snapshot.showFullUrl} disabled={disabled} onChange={checked => onPatch({ showFullUrl: checked })} />
          <BrowserSelectRow id="browser-annotation-screenshots" label={t('browser_settings_annotation')} desc={t('browser_settings_annotation_desc')} value={snapshot.annotationScreenshots} options={annotationOptions} disabled={disabled} onChange={value => onPatch({ annotationScreenshots: value })} />
          <div className="pref-row">
            <div className={styles['browser-copy']}>
              <div className={settingsStyles['pref-row-label']}>{t('browser_settings_clear_data')}</div>
              <div className={settingsStyles['pref-row-desc']}>{t('browser_settings_clear_data_desc')}</div>
            </div>
            <div className={styles['browser-row-actions']}>
              <button type="button" id="browser-clear-data" className={styles['browser-action-btn']} disabled={disabled || clearing} aria-busy={busy === 'clear:all' || undefined} onClick={() => onClearData([...CLEAR_KINDS])}>{t(busy === 'clear:all' ? 'browser_settings_clearing' : 'browser_settings_clear_all')}</button>
              <button type="button" className={styles['browser-disclosure']} aria-controls="browser-clear-data-options" aria-expanded={clearExpanded} aria-label={t('browser_settings_clear_options')} disabled={disabled || clearing} onClick={() => setClearExpanded(value => !value)}>
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true" className={clearExpanded ? styles['browser-disclosure-open'] : undefined}><path d="m4 6 4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            </div>
          </div>
          {clearExpanded && <div id="browser-clear-data-options" className={styles['browser-clear-options']}>
            {CLEAR_KINDS.map(kind => <div key={kind} className={`pref-row ${styles['browser-clear-option']}`}>
              <div className={settingsStyles['pref-row-label']}>{t(`browser_settings_data_${kind}`)}</div>
              <button type="button" className={styles['browser-action-btn']} disabled={disabled || clearing} aria-busy={busy === `clear:${kind}` || undefined} onClick={() => onClearData([kind])}>{t(busy === `clear:${kind}` ? 'browser_settings_clearing' : 'browser_settings_clear_one')}</button>
            </div>)}
          </div>}
          <div className="pref-row">
            <div className={styles['browser-copy']}>
              <div className={settingsStyles['pref-row-label']}>{t('browser_settings_history_label')}</div>
              <div className={settingsStyles['pref-row-desc']}>{t('browser_settings_history_desc')}</div>
            </div>
            <button type="button" id="browser-history-manage" className={styles['browser-action-btn']} disabled={disabled} onClick={onOpenHistory}>{t('browser_settings_manage')}</button>
          </div>
        </div>
      </div>

      {snapshot.nativeManagementAvailable === true && (
        <div className="settings-section">
          <div className="settings-section-title">{t('browser_settings_autofill_and_passwords')}</div>
          <div className={styles['browser-card']}>
            <BrowserManagerRow surface="passwords" disabled={disabled} busy={busy} onOpenManager={onOpenManager} />
            <BrowserManagerRow surface="autofill" disabled={disabled} busy={busy} onOpenManager={onOpenManager} />
          </div>
        </div>
      )}

      {snapshot.nativeManagementAvailable === true && (
        <div className="settings-section">
          <div className="settings-section-title">{t('browser_settings_extensions')}</div>
          <div className={styles['browser-card']}>
            <BrowserManagerRow surface="extensions" disabled={disabled} busy={busy} onOpenManager={onOpenManager} />
          </div>
        </div>
      )}

      <div className="settings-section">
        <div className="settings-section-title">{t('browser_settings_downloads')}</div>
        <div className={styles['browser-card']}>
          <div className="pref-row">
            <div className={styles['browser-copy']}>
              <div className={settingsStyles['pref-row-label']}>{t('browser_settings_download_location')}</div>
              <div className={settingsStyles['pref-row-desc']}>{t('browser_settings_download_location_desc')}</div>
              <div className={styles['browser-path']}>{snapshot.downloadDirectory || t('browser_settings_system_default')}</div>
            </div>
            <div className={styles['browser-row-actions']}>
              <button type="button" className={styles['browser-action-btn']} disabled={disabled || busy === 'choose-download-dir'} onClick={onChooseDownloadDirectory}>{t('browser_settings_change')}</button>
              {snapshot.downloadDirectory && <button type="button" className={styles['browser-action-btn']} disabled={disabled} onClick={() => onPatch({ downloadDirectory: null })}>{t('browser_settings_reset')}</button>}
            </div>
          </div>
          <PrefToggleRow id="browser-prompt-downloads" label={t('browser_settings_prompt_downloads')} desc={t('browser_settings_prompt_downloads_desc')} checked={snapshot.promptForDownloads} disabled={disabled} onChange={checked => onPatch({ promptForDownloads: checked })} />
          <div className="pref-row">
            <div className={styles['browser-copy']}>
              <div className={settingsStyles['pref-row-label']}>{t('browser_settings_download_history')}</div>
              <div className={settingsStyles['pref-row-desc']}>{t('browser_settings_download_history_desc')}</div>
            </div>
            <button type="button" id="browser-download-history-manage" className={styles['browser-action-btn']} disabled={disabled} onClick={onOpenDownloads}>{t('browser_settings_manage')}</button>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">{t('browser_settings_sites')}</div>
        <div className={styles['browser-card']}>
          <div className={styles['browser-section-copy']}>{t('browser_settings_sites_desc')}</div>
          {snapshot.nativeManagementAvailable === true && (
            <BrowserManagerRow surface="siteSettings" disabled={disabled} busy={busy} onOpenManager={onOpenManager} />
          )}
          <div className={`${styles['browser-table']} ${styles['browser-default-policy']}`}>
            <div className={`${styles['browser-table-row']} ${styles['browser-default-policy-row']}`}>
              <span>{t('browser_settings_default_policy')}</span>
              {BROWSER_RESOURCES.map(resource => (
                <label key={resource} className={styles['browser-policy-cell']}>
                  <span className={styles['browser-policy-label']}>{resourceLabel(t, resource)}</span>
                  <select className={styles['browser-select']} aria-label={`${t('browser_settings_default_policy')} ${resourceLabel(t, resource)}`} value={snapshot.defaultPolicy[resource]} disabled={disabled} onChange={event => onSetDefaultPolicy(resource, event.target.value as BrowserAccess)}>
                    {accessOptions(false).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                  </select>
                </label>
              ))}
            </div>
          </div>
          <div className={styles['browser-section-copy']}>{t('browser_settings_site_rules_desc')}</div>
          <form className={styles['browser-add-form']} onSubmit={event => { void submitOrigin(event) }}>
            <input className={styles['browser-input']} value={originDraft} placeholder={t('browser_settings_domain_placeholder')} aria-label={t('browser_settings_add_domain')} disabled={disabled} onChange={event => setOriginDraft(event.target.value)} />
            <button type="submit" className={`${styles['browser-action-btn']} ${styles['is-primary']}`} disabled={disabled}>{t('browser_settings_add_domain')}</button>
          </form>
          {originError && <div className={styles['browser-error']} role="alert">{originError}</div>}
          {snapshot.originRules.length === 0
            ? <div className={styles['browser-empty']}>{t('browser_settings_no_site_rules')}</div>
            : (
              <div className={styles['browser-table']}>
                <div className={`${styles['browser-table-row']} ${styles['browser-table-head']}`}>
                  <span>{t('browser_settings_site_rules')}</span>
                  {BROWSER_RESOURCES.map(resource => <span key={resource}>{resourceLabel(t, resource)}</span>)}
                  <span />
                </div>
                {snapshot.originRules.map(rule => (
                  <div className={styles['browser-table-row']} key={rule.pattern}>
                    <span className={styles['browser-pattern']}>{rule.pattern}</span>
                    {BROWSER_RESOURCES.map(resource => (
                      <span key={resource} className={styles['browser-policy-cell']}>
                        <select className={styles['browser-select']} aria-label={`${rule.pattern} ${resourceLabel(t, resource)}`} value={rule.policy[resource] ?? 'inherit'} disabled={disabled} onChange={event => onSetOriginPolicy(rule.pattern, resource, event.target.value as BrowserAccess | 'inherit')}>
                          {accessOptions(true).map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                        </select>
                      </span>
                    ))}
                    <button type="button" className={styles['browser-icon-action']} aria-label={`${t('browser_settings_remove')} ${rule.pattern}`} disabled={disabled} onClick={() => onRemoveOrigin(rule.pattern)}>{t('browser_settings_remove')}</button>
                  </div>
                ))}
              </div>
            )}

        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">{t('browser_settings_chrome')}</div>
        <div className={styles['browser-card']}>
          <PrefToggleRow id="browser-chrome-enabled" label={t('browser_settings_chrome')} desc={t('browser_settings_chrome_desc')} checked={snapshot.chromeEnabled} disabled={disabled || busy === 'chrome'} onChange={onSetChromeEnabled} />
          <div className="pref-row">
            <div className={styles['browser-copy']}><div className={settingsStyles['pref-row-desc']}>{t('browser_settings_chrome_setup_desc')}</div></div>
            <button type="button" className={styles['browser-action-btn']} disabled={disabled} onClick={onOpenChromeSetup}>{t('browser_settings_chrome_setup')}</button>
          </div>
        </div>
      </div>
    </SettingsPage>
  )
}

function BrowserHistoryPanel({ onBack }: { onBack: () => void }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [source, setSource] = useState<BrowserSource>('all')
  const [items, setItems] = useState<HistoryRow[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [removing, setRemoving] = useState(false)
  const removingRef = useRef(false)
  const sequence = useRef(0)
  const sentinel = useRef<HTMLDivElement | null>(null)
  const debounced = useDebounced(query, 300)

  const load = useCallback(async (reset: boolean) => {
    const service = api()
    if (!service?.history) { setError(t('browser_settings_history_load_failed')); return }
    const seq = ++sequence.current
    setLoading(true)
    setError('')
    try {
      const page = await service.history({ query: debounced, source, cursor: reset ? null : cursor, limit: 100 })
      if (seq !== sequence.current) return
      if (failed(page)) { setError(t('browser_settings_history_load_failed')); return }
      const next = Array.isArray(page.items) ? page.items : []
      setItems(current => reset ? next : [...current, ...next.filter(row => !current.some(existing => existing.id === row.id))])
      setCursor(page.nextCursor ?? null)
    } catch (loadError: any) {
      if (seq === sequence.current) setError(loadError?.message || t('browser_settings_history_load_failed'))
    } finally {
      if (seq === sequence.current) setLoading(false)
    }
  }, [debounced, source, cursor, t])

  useEffect(() => { void load(true) }, [debounced, source])
  useEffect(() => { setSelected(new Set()) }, [debounced, source])
  useEffect(() => () => { sequence.current++ }, [])

  useEffect(() => {
    const node = sentinel.current
    if (!node || !cursor || loading || error) return
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void load(false) }, { rootMargin: '240px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [cursor, loading, error, load])

  const openRow = async (row: HistoryRow) => {
    const open = w().klausOpenExternalUrl || w().klaus?.app?.openExternal
    if (typeof open !== 'function') { showError(t, t('browser_settings_open_failed')); return }
    try { await open(row.url) } catch (openError: any) { showError(t, openError?.message || t('browser_settings_open_failed')) }
  }

  const removeRows = async (ids: string[]) => {
    const service = api()
    if (!service?.removeHistory || ids.length === 0 || removingRef.current) return
    removingRef.current = true
    setRemoving(true)
    try {
      const result = await service.removeHistory(ids)
      const failure = failed(result)
      if (failure) { showError(t, failure); return }
      const removed = new Set(ids)
      setItems(current => current.filter(row => !removed.has(row.id)))
      setSelected(current => new Set([...current].filter(id => !removed.has(id))))
      w().showToast?.(t('browser_settings_history_removed').replace('{count}', String(ids.length)))
    } catch (removeError: any) {
      showError(t, removeError?.message || t('browser_settings_save_failed'))
    } finally {
      removingRef.current = false
      setRemoving(false)
    }
  }

  const retry = () => { void load(items.length > 0 && cursor ? false : true) }

  return (
    <SettingsPage title={t('browser_settings_history_title')} subtitle={t('browser_settings_history_desc')} actions={<button type="button" className={styles['browser-action-btn']} onClick={onBack}>{t('browser_settings_back')}</button>}>
      <div className={styles['browser-card']}>
        <div className={styles['browser-toolbar']}>
          <input className={styles['browser-input']} type="search" value={query} placeholder={t('browser_settings_history_search')} aria-label={t('browser_settings_history_search')} onChange={event => setQuery(event.target.value)} />
          <select className={styles['browser-select']} value={source} aria-label={t('browser_settings_history_source')} onChange={event => setSource(event.target.value as BrowserSource)}>
            <option value="all">{t('browser_settings_history_source_all')}</option>
            <option value="agent">{t('browser_settings_history_source_agent')}</option>
            <option value="other">{t('browser_settings_history_source_other')}</option>
          </select>
          <button type="button" className={styles['browser-action-btn']} disabled={!selected.size || removing} onClick={() => { void removeRows([...selected]) }}>{t('browser_settings_history_remove_selected')}</button>
        </div>
        {error && (
          <div className={styles['browser-error']} role="alert">
            <span>{error}</span>
            <button type="button" className={styles['browser-icon-action']} onClick={retry}>{t('browser_settings_retry')}</button>
          </div>
        )}
        {!items.length && !loading && !error && <div className={styles['browser-empty']}>{(debounced || source !== 'all') ? t('browser_settings_history_no_results') : t('browser_settings_history_empty')}</div>}
        <div className={styles['browser-list']}>
          {items.map(row => (
            <div className={styles['browser-list-row']} key={row.id}>
              <input type="checkbox" checked={selected.has(row.id)} aria-label={`${t('browser_settings_select')} ${row.title || row.url}`} onChange={event => setSelected(current => {
                const next = new Set(current)
                if (event.target.checked) next.add(row.id); else next.delete(row.id)
                return next
              })} />
              <div className={styles['browser-list-copy']}>
                <button type="button" className={styles['browser-list-title']} onClick={() => { void openRow(row) }}>{row.title || row.url}</button>
                <div className={styles['browser-list-url']}>{row.url}</div>
                <div className={styles['browser-list-meta']}>{formatTime(row.visitTime)}{row.isActorVisit ? <span className={styles['browser-badge']}>{t('browser_settings_agent_badge')}</span> : null}</div>
              </div>
              <div className={styles['browser-row-actions']}>
                <button type="button" className={styles['browser-action-btn']} onClick={() => { void openRow(row) }}>{t('browser_settings_history_open')}</button>
                <button type="button" className={styles['browser-action-btn']} disabled={removing} onClick={() => { void removeRows([row.id]) }}>{t('browser_settings_remove')}</button>
              </div>
            </div>
          ))}
        </div>
        {loading && <div className={styles['browser-loading']} role="status">{t('browser_settings_loading')}</div>}
        <div ref={sentinel} className={styles['browser-sentinel']} aria-hidden="true" />
      </div>
    </SettingsPage>
  )
}

function BrowserDownloadsPanel({ onBack }: { onBack: () => void }) {
  const t = useT()
  const [query, setQuery] = useState('')
  const [items, setItems] = useState<DownloadRow[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [acting, setActing] = useState<string | null>(null)
  const itemsRef = useRef<DownloadRow[]>([])
  const actingRef = useRef<string | null>(null)
  const liveEvents = useRef(new Map<string, DownloadEvent>())
  const refreshTimer = useRef<number | null>(null)
  const mounted = useRef(true)
  const sequence = useRef(0)
  const sentinel = useRef<HTMLDivElement | null>(null)
  const debounced = useDebounced(query, 300)

  useEffect(() => { itemsRef.current = items }, [items])

  const mergeLive = useCallback((row: DownloadRow) => {
    const event = liveEvents.current.get(row.id)
    return event ? applyDownloadEvent(row, event) : row
  }, [])

  const load = useCallback(async (reset: boolean) => {
    const service = api()
    if (!service?.downloads) { setError(t('browser_settings_downloads_load_failed')); return }
    const seq = ++sequence.current
    setLoading(true)
    setError('')
    try {
      const page = await service.downloads({ query: debounced, cursor: reset ? null : cursor, limit: 100 })
      if (seq !== sequence.current) return
      if (failed(page)) { setError(t('browser_settings_downloads_load_failed')); return }
      const next = (Array.isArray(page.items) ? page.items : []).map(mergeLive)
      setItems(current => reset ? next : [...current, ...next.filter(row => !current.some(existing => existing.id === row.id))])
      setCursor(page.nextCursor ?? null)
    } catch (loadError: any) {
      if (seq === sequence.current) setError(loadError?.message || t('browser_settings_downloads_load_failed'))
    } finally {
      if (seq === sequence.current) setLoading(false)
    }
  }, [debounced, cursor, t, mergeLive])

  useEffect(() => { void load(true) }, [debounced])
  useEffect(() => () => {
    mounted.current = false
    sequence.current++
    if (refreshTimer.current != null) window.clearTimeout(refreshTimer.current)
  }, [])

  const scheduleFirstPageRefresh = useCallback(() => {
    if (refreshTimer.current != null) return
    refreshTimer.current = window.setTimeout(async () => {
      refreshTimer.current = null
      const service = api()
      if (!mounted.current || !service?.downloads) return
      try {
        const page = await service.downloads({ query: debounced, cursor: null, limit: 100 })
        if (!mounted.current || failed(page)) return
        const firstPage = (Array.isArray(page.items) ? page.items : []).map(mergeLive)
        setItems(current => mergeFirstDownloadPage(current, firstPage))
      } catch { /* keep the loaded page; a retry is user initiated */ }
    }, 200)
  }, [debounced, mergeLive])

  useEffect(() => {
    const off = api()?.subscribeDownloads?.(event => {
      if (!mounted.current || !event || typeof event.id !== 'string') return
      const previous = liveEvents.current.get(event.id)
      liveEvents.current.set(event.id, { ...previous, ...event })
      const known = itemsRef.current.some(row => row.id === event.id)
      if (known) {
        setItems(current => current.map(row => row.id === event.id ? applyDownloadEvent(row, event) : row))
      } else {
        scheduleFirstPageRefresh()
      }
    })
    return () => off?.()
  }, [scheduleFirstPageRefresh])

  useEffect(() => {
    const node = sentinel.current
    if (!node || !cursor || loading || error) return
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void load(false) }, { rootMargin: '240px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [cursor, loading, error, load])

  const act = async (action: string, id: string) => {
    if (actingRef.current) return
    const service = api()
    if (!service?.downloadAction) return
    actingRef.current = `${action}:${id}`
    setActing(actingRef.current)
    try {
      const result = await service.downloadAction(action, id)
      const failure = failed(result)
      if (failure) { showError(t, failure); return }
      await load(true)
    } catch (actionError: any) {
      showError(t, actionError?.message || t('browser_settings_save_failed'))
    } finally {
      actingRef.current = null
      setActing(null)
    }
  }

  const retry = () => { void load(items.length > 0 && cursor ? false : true) }

  return (
    <SettingsPage title={t('browser_settings_downloads_title')} subtitle={t('browser_settings_download_history_desc')} actions={<button type="button" className={styles['browser-action-btn']} onClick={onBack}>{t('browser_settings_back')}</button>}>
      <div className={styles['browser-card']}>
        <div className={styles['browser-toolbar']}>
          <input className={styles['browser-input']} type="search" value={query} placeholder={t('browser_settings_downloads_search')} aria-label={t('browser_settings_downloads_search')} onChange={event => setQuery(event.target.value)} />
        </div>
        {error && (
          <div className={styles['browser-error']} role="alert">
            <span>{error}</span>
            <button type="button" className={styles['browser-icon-action']} onClick={retry}>{t('browser_settings_retry')}</button>
          </div>
        )}
        {!items.length && !loading && !error && <div className={styles['browser-empty']}>{debounced ? t('browser_settings_downloads_no_results') : t('browser_settings_downloads_empty')}</div>}
        <div className={styles['browser-list']}>
          {items.map(row => {
            const terminal = !row.canPause && !row.canResume && !row.canCancel
            return (
              <div className={styles['browser-list-row']} key={row.id}>
                <div className={styles['browser-list-copy']}>
                  <div className={styles['browser-list-title']}>{row.filename || row.url}</div>
                  <div className={styles['browser-list-url']}>{row.path || row.url}</div>
                  <div className={styles['browser-list-meta']}>
                    <span>{downloadStateLabel(t, row.state)}</span>
                    {row.totalBytes > 0 ? <span>{formatBytes(row.receivedBytes)} / {formatBytes(row.totalBytes)}</span> : null}
                    {row.exists === false && <span>{t('browser_settings_download_deleted')}</span>}
                  </div>
                </div>
                <div className={styles['browser-row-actions']}>
                  {row.canPause && <button type="button" className={styles['browser-action-btn']} disabled={Boolean(acting)} onClick={() => { void act('pause', row.id) }}>{t('browser_settings_download_pause')}</button>}
                  {row.canResume && <button type="button" className={styles['browser-action-btn']} disabled={Boolean(acting)} onClick={() => { void act('resume', row.id) }}>{t('browser_settings_download_resume')}</button>}
                  {row.canCancel && <button type="button" className={styles['browser-action-btn']} disabled={Boolean(acting)} onClick={() => { void act('cancel', row.id) }}>{t('browser_settings_download_cancel')}</button>}
                  {terminal && row.exists === true && <button type="button" className={styles['browser-action-btn']} disabled={Boolean(acting)} onClick={() => { void act('open', row.id) }}>{t('browser_settings_download_open')}</button>}
                  {terminal && row.exists === true && <button type="button" className={styles['browser-action-btn']} disabled={Boolean(acting)} onClick={() => { void act('reveal', row.id) }}>{t('browser_settings_download_reveal')}</button>}
                  {terminal && <button type="button" className={styles['browser-action-btn']} disabled={Boolean(acting)} onClick={() => { void act('remove', row.id) }}>{t('browser_settings_download_remove')}</button>}
                </div>
              </div>
            )
          })}
        </div>
        <div className={styles['browser-hint']}>{t('browser_settings_download_remove_hint')}</div>
        {loading && <div className={styles['browser-loading']} role="status">{t('browser_settings_loading')}</div>}
        <div ref={sentinel} className={styles['browser-sentinel']} aria-hidden="true" />
      </div>
    </SettingsPage>
  )
}

export function BrowserSettingsTab() {
  const t = useT()
  const [snapshot, setSnapshot] = useState<BrowserSettingsSnapshot | null>(null)
  const snapshotRef = useRef<BrowserSettingsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [view, setView] = useState<'main' | 'history' | 'downloads' | 'native'>('main')
  const [nativeSurface, setNativeSurface] = useState<NativeManagerSurface>('passwords')
  const [nativeGenerationId, setNativeGenerationId] = useState(0)
  const [importOpen, setImportOpen] = useState(false)
  const nativeGeneration = useRef(0)
  const [chromeSetupOpen, setChromeSetupOpen] = useState(false)
  const readSequence = useRef(0)
  const mutationSequence = useRef(0)
  const pendingMutations = useRef(0)
  const clearingRef = useRef(false)
  const queue = useRef<Promise<void>>(Promise.resolve())

  const apply = useCallback((next: BrowserSettingsSnapshot) => {
    snapshotRef.current = next
    setSnapshot(next)
  }, [])

  const enqueue = useCallback((work: () => Promise<any> | undefined): Promise<any> => {
    const run = queue.current.then(work, work)
    queue.current = run.then(() => undefined, () => undefined)
    return run
  }, [])

  const load = useCallback(async () => {
    const sequence = ++readSequence.current
    try {
      const result = await api()?.get?.()
      if (sequence !== readSequence.current || pendingMutations.current > 0) return
      const next = snapshotOf(result)
      if (!next) throw new Error((result as any)?.error || t('browser_settings_load_failed'))
      apply(next)
      setError('')
    } catch (loadError: any) {
      if (sequence === readSequence.current && pendingMutations.current === 0) setError(loadError?.message || t('browser_settings_load_failed'))
    } finally {
      if (sequence === readSequence.current) setLoading(false)
    }
  }, [apply, t])

  useEffect(() => { void load() }, [load])
  useEffect(() => {
    const off = api()?.subscribe?.(next => {
      readSequence.current++
      setLoading(false)
      if (pendingMutations.current > 0) return
      const normalized = snapshotOf(next)
      if (normalized) apply(normalized)
    })
    return () => { readSequence.current++; off?.() }
  }, [apply])

  const mutate = useCallback(async (label: string, optimistic: Partial<BrowserSettingsSnapshot> | null, work: () => Promise<any> | undefined): Promise<boolean> => {
    const sequence = ++mutationSequence.current
    readSequence.current++
    pendingMutations.current++
    const previous = snapshotRef.current
    if (previous && optimistic) apply({ ...previous, ...optimistic } as BrowserSettingsSnapshot)
    setBusy(label)
    let ok = false
    try {
      const result = await enqueue(work)
      const failure = failed(result)
      if (failure) {
        if (sequence === mutationSequence.current && previous) apply(previous)
        showError(t, failure)
      } else {
        ok = true
        const next = snapshotOf(result)
        if (next && sequence === mutationSequence.current) apply(next)
      }
    } catch (workError: any) {
      if (sequence === mutationSequence.current && previous) apply(previous)
      showError(t, workError?.message || t('browser_settings_save_failed'))
    } finally {
      pendingMutations.current--
      if (pendingMutations.current === 0) {
        setBusy('')
        void load()
      }
    }
    return ok
  }, [apply, enqueue, load, t])

  const patch = useCallback((value: Record<string, unknown>) => {
    void mutate('patch', value as Partial<BrowserSettingsSnapshot>, () => api()?.setPreferences?.(value))
  }, [mutate])

  const toggleEnabled = useCallback(async (enabled: boolean) => {
    let receipt: any
    const ok = await mutate('enabled', { enabled }, async () => {
      receipt = await api()?.setEnabled?.(enabled)
      return receipt
    })
    if (!ok) return
    const message = t(enabled ? 'browser_settings_plugin_enabled' : 'browser_settings_plugin_disabled')
    const note = pluginActivationNote(receipt, t)
    w().showToast?.(note ? `${message} ${note}` : message, { tone: 'success' })
  }, [mutate, t])

  const setChromeEnabled = useCallback((enabled: boolean) => {
    void mutate('chrome', { chromeEnabled: enabled }, () => api()?.setChromeEnabled?.(enabled))
  }, [mutate])

  const chooseDownloadDirectory = useCallback(() => {
    void mutate('choose-download-dir', null, () => api()?.chooseDownloadDirectory?.())
  }, [mutate])

  const openManager = useCallback((surface: NativeManagerSurface) => {
    const generation = ++nativeGeneration.current
    setNativeSurface(surface)
    setNativeGenerationId(generation)
    setView('native')
  }, [])

  const managerRequest = useCallback(async (surface: NativeManagerSurface, options: BrowserManagerOptions & { viewId: string }, generation: number) => {
    if (nativeGeneration.current !== generation) return { ok: false, error: 'stale' }
    const service = api()?.openManager
    if (!service) throw new Error('settings_failed')
    return service(surface, options)
  }, [])

  const closeManager = useCallback((surface: NativeManagerSurface, generation: number, viewId: string) => {
    if (nativeGeneration.current !== generation) return
    void managerRequest(surface, { action: 'close', viewId }, generation).catch(() => {})
  }, [managerRequest])

  const subscribeManagerState = useCallback((listener: (state: BrowserManagerState) => void) => {
    const off = api()?.onManagerState?.(listener)
    return () => off?.()
  }, [])

  const importApi = useMemo<BrowserImportUiApi>(() => ({
    ...(/Mac/i.test(navigator.platform || '') && w().klaus?.systemPermissions?.openSettings ? {
      fileAccessStatus: async () => {
        const result = await w().klaus.systemPermissions.check()
        const status = result?.permissions?.fullDiskAccess
        return status === 'granted' || status === 'denied' ? status : 'unknown'
      },
      openPermissionSettings: async () => {
        const result = await w().klaus.systemPermissions.openSettings('fullDiskAccess')
        if (result?.ok !== true) throw new Error(t('browser_import_permission_settings_failed'))
      },
    } : {}),
    discover: async () => {
      const service = w().settingsApi?.browserProfileImport
      if (!service?.discover) throw new Error(t('browser_import_unavailable'))
      return service.discover()
    },
    start: async request => {
      const service = w().settingsApi?.browserProfileImport
      if (!service?.start) throw new Error(t('browser_import_unavailable'))
      return service.start(request)
    },
    cancel: async jobId => {
      const service = w().settingsApi?.browserProfileImport
      if (!service?.cancel) throw new Error(t('browser_import_unavailable'))
      return service.cancel(jobId)
    },
    subscribe: callback => {
      const service = w().settingsApi?.browserProfileImport
      return service?.subscribe?.(callback) ?? (() => {})
    },
  }), [t])

  const openImport = useCallback(() => {
    if (!w().settingsApi?.browserProfileImport?.discover) {
      w().showToast?.(t('browser_import_unavailable'))
      return
    }
    setImportOpen(true)
  }, [t])

  const clearData = useCallback(async (kinds: string[]) => {
    if (clearingRef.current) return
    clearingRef.current = true
    readSequence.current++
    pendingMutations.current++
    setBusy(`clear:${kinds.length === CLEAR_KINDS.length ? 'all' : kinds[0]}`)
    try {
      const requests = kinds.length === CLEAR_KINDS.length ? ['all'] : kinds
      let cleared = 0
      let firstError = ''
      for (const kind of requests) {
        const result = await enqueue(() => api()?.clearData?.(kind))
        const failure = failed(result)
        if (failure) firstError = failure
        else cleared += kind === 'all' ? kinds.length : 1
      }
      if (cleared) w().showToast?.(t('browser_settings_clear_done').replace('{count}', String(cleared)))
      if (firstError) showError(t, firstError)
    } catch (clearError: any) {
      showError(t, clearError?.message || t('browser_settings_save_failed'))
    } finally {
      clearingRef.current = false
      pendingMutations.current--
      if (pendingMutations.current === 0) {
        setBusy('')
        void load()
      }
    }
  }, [enqueue, load, t])

  const addOrigin = useCallback((pattern: string) => mutate('origin', null, () => api()?.setOriginPolicy?.({ pattern, resource: 'browsing', setting: 'inherit' })), [mutate])

  const setDefaultPolicy = useCallback((resource: BrowserResource, setting: BrowserAccess) => {
    const previous = snapshotRef.current
    const optimistic = previous ? { defaultPolicy: { ...previous.defaultPolicy, [resource]: setting } } : null
    void mutate('origin', optimistic as Partial<BrowserSettingsSnapshot> | null, () => api()?.setOriginPolicy?.({ resource, setting }))
  }, [mutate])

  const setOriginPolicy = useCallback((pattern: string, resource: BrowserResource, setting: BrowserAccess | 'inherit') => {
    void mutate('origin', null, () => api()?.setOriginPolicy?.({ pattern, resource, setting }))
  }, [mutate])

  const removeOrigin = useCallback((pattern: string) => {
    void mutate('origin', null, () => api()?.removeOriginPolicy?.(pattern))
  }, [mutate])

  if (loading) {
    return (
      <SettingsPage title={t('browser_use_title')} subtitle={t('browser_use_desc')}>
        <div dangerouslySetInnerHTML={{ __html: w().klsLoading?.render?.() || '' }} />
      </SettingsPage>
    )
  }
  if (error || !snapshot) {
    return (
      <SettingsPage title={t('browser_use_title')} subtitle={t('browser_use_desc')}>
        <div className="empty-text sk-empty" role="alert">
          <p>{error || t('browser_settings_load_failed')}</p>
          <button type="button" className="btn-sm" onClick={() => { setLoading(true); void load() }}>{t('browser_settings_retry')}</button>
        </div>
      </SettingsPage>
    )
  }
  if (view === 'history') return <BrowserHistoryPanel onBack={() => setView('main')} />
  if (view === 'downloads') return <BrowserDownloadsPanel onBack={() => setView('main')} />
  if (view === 'native') return (
    <NativeManagementPane
      key={`${nativeSurface}:${nativeGenerationId}`}
      surface={nativeSurface}
      generation={nativeGenerationId}
      onBack={() => setView('main')}
      openManager={managerRequest}
      onClose={closeManager}
      onManagerState={subscribeManagerState}
    />
  )
  return (
    <>
      <BrowserSettingsView
        snapshot={snapshot}
        busy={busy}
        onToggleEnabled={toggleEnabled}
        onPatch={patch}
        onClearData={kinds => { void clearData(kinds) }}
        onOpenHistory={() => setView('history')}
        onOpenDownloads={() => setView('downloads')}
        onChooseDownloadDirectory={chooseDownloadDirectory}
        onOpenManager={openManager}
        onOpenImport={openImport}
        onSetChromeEnabled={setChromeEnabled}
        onAddOrigin={addOrigin}
        onSetDefaultPolicy={setDefaultPolicy}
        onSetOriginPolicy={setOriginPolicy}
        onRemoveOrigin={removeOrigin}
        onOpenChromeSetup={() => setChromeSetupOpen(true)}
      />
      {chromeSetupOpen && (
        <ModalPortal>
          <BrowserCapabilityModal enabled={snapshot.enabled} onClose={() => { setChromeSetupOpen(false); void load() }} />
        </ModalPortal>
      )}
      {importOpen && <BrowserImportDialog api={importApi} onClose={() => setImportOpen(false)} />}
    </>
  )
}
