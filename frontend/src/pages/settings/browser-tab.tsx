// Browser settings: plugin capability, URL routing, browsing data, site
// policies, download history and the Chrome extension connection. The page is
// driven by the flat BrowserSettingsSnapshot returned by settingsApi.browserUse.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { ModalPortal } from '../../components/ModalPortal'
import { BrowserCapabilityModal } from '../mcp/browser-connect'
import { BROWSER_DEFAULT_POLICY, BROWSER_RESOURCES, browserOriginPattern, type BrowserAccess, type BrowserResource, type BrowserSettingsSnapshot } from '../../../../contracts/browser-settings'
import type { SiteOpenTargetId } from '../../../../contracts/browser-sites'
import { CapabilityRow, CapabilitySwitch } from './capability-tabs'
import { PrefToggleRow, SettingsPage } from './kv'
import styles from './browser-settings.module.css'
import settingsStyles from './settings.module.css'

const w = () => window as any

type BrowserSource = 'all' | 'agent' | 'other'
type SitePermissionSetting = 'granted' | 'denied' | 'prompt'
type HistoryRow = { id: string; url: string; title: string; visitTime: number; isActorVisit: boolean }
type DownloadRow = {
  id: string; url: string; filename: string; path: string; state: string
  receivedBytes: number; totalBytes: number; startedAt: number
  canPause: boolean; canResume: boolean; canCancel: boolean; exists: boolean
}
type DownloadEvent = { id: string; state?: string; receivedBytes?: number; totalBytes?: number; exists?: boolean; filename?: string; path?: string; url?: string }
type Page<T> = { ok?: boolean; items: T[]; nextCursor?: string | null; error?: string }
type BrowserUseApi = {
  get(): Promise<BrowserSettingsSnapshot | { ok?: boolean; settings?: BrowserSettingsSnapshot; error?: string }>
  setEnabled(enabled: boolean): Promise<any>
  setChromeEnabled(enabled: boolean): Promise<any>
  setPreferences(patch: Record<string, unknown>): Promise<any>
  setOriginPolicy(input: { pattern?: string; resource: BrowserResource; setting: BrowserAccess | 'inherit' }): Promise<any>
  removeOriginPolicy(pattern: string): Promise<any>
  setSitePermission(input: { origin: string; permission: string; setting: SitePermissionSetting }): Promise<any>
  history(input?: { query?: string; source?: BrowserSource; cursor?: string | null; limit?: number }): Promise<Page<HistoryRow>>
  removeHistory(ids: string[]): Promise<any>
  downloads(input?: { query?: string; cursor?: string | null; limit?: number }): Promise<Page<DownloadRow>>
  subscribeDownloads?(callback: (event: DownloadEvent) => void): () => void
  downloadAction(action: string, id: string): Promise<any>
  chooseDownloadDirectory(): Promise<{ ok?: boolean; settings?: BrowserSettingsSnapshot; path?: string | null; error?: string }>
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
const SITE_PERMISSIONS = ['notifications', 'geolocation', 'camera', 'microphone', 'clipboard-read', 'clipboard-write', 'fullscreen', 'midi', 'pointerLock', 'screen-wake-lock'] as const

function siteOrigin(input: string): string {
  const value = input.trim()
  if (!value) return ''
  try {
    const parsed = new URL(/^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`)
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.origin : ''
  } catch { return '' }
}

// Native password, contact and extension surfaces are host capabilities. Do not
// fake them with embedded browser pages; render them only when the host exposes
// a supported surface.
export interface BrowserSettingsViewProps {
  snapshot: BrowserSettingsSnapshot
  busy: string
  onToggleEnabled: (enabled: boolean) => void
  onPatch: (patch: Record<string, unknown>) => void
  onClearData: (kinds: string[]) => void
  onOpenHistory: () => void
  onOpenDownloads: () => void
  onChooseDownloadDirectory: () => void
  onSetChromeEnabled: (enabled: boolean) => void
  onAddOrigin: (pattern: string) => Promise<boolean>
  onSetDefaultPolicy: (resource: BrowserResource, setting: BrowserAccess) => void
  onSetOriginPolicy: (pattern: string, resource: BrowserResource, setting: BrowserAccess | 'inherit') => void
  onRemoveOrigin: (pattern: string) => void
  onSetSitePermission: (origin: string, permission: string, setting: SitePermissionSetting) => void
  onOpenChromeSetup: () => void
}

/** Pure presentation of the main settings page; the data owner passes a snapshot. */
export function BrowserSettingsView({
  snapshot, busy, onToggleEnabled, onPatch, onClearData, onOpenHistory, onOpenDownloads,
  onChooseDownloadDirectory, onSetChromeEnabled, onAddOrigin, onSetDefaultPolicy,
  onSetOriginPolicy, onRemoveOrigin, onSetSitePermission, onOpenChromeSetup,
}: BrowserSettingsViewProps) {
  const t = useT()
  const disabled = !snapshot.enabled
  const [clearKinds, setClearKinds] = useState<string[]>(['history', 'downloads', 'cookies', 'cache', 'siteData'])
  const [originDraft, setOriginDraft] = useState('')
  const [originError, setOriginError] = useState('')
  const [siteOriginDraft, setSiteOriginDraft] = useState('')
  const [sitePermissionDraft, setSitePermissionDraft] = useState<string>('notifications')
  const [sitePermissionError, setSitePermissionError] = useState('')
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

  const submitSitePermission = (event: React.FormEvent) => {
    event.preventDefault()
    const origin = siteOrigin(siteOriginDraft)
    if (!origin) { setSitePermissionError(t('browser_settings_site_permission_invalid')); return }
    setSitePermissionError('')
    onSetSitePermission(origin, sitePermissionDraft, 'granted')
    setSiteOriginDraft('')
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
        <div className="settings-section-title">{t('browser_settings_general')}</div>
        <div className={styles['browser-card']}>
          <BrowserSelectRow id="browser-web-target" label={t('browser_settings_open_web')} desc={t('browser_settings_open_web_desc')} value={snapshot.webUrlTarget} options={webTargets} disabled={disabled} onChange={value => onPatch({ webUrlTarget: value as SiteOpenTargetId })} />
          <BrowserSelectRow id="browser-local-target" label={t('browser_settings_open_local')} desc={t('browser_settings_open_local_desc')} value={snapshot.localUrlTarget} options={localTargets} disabled={disabled} onChange={value => onPatch({ localUrlTarget: value as SiteOpenTargetId })} />
          <PrefToggleRow id="browser-show-full-url" label={t('browser_settings_show_full_url')} desc={t('browser_settings_show_full_url_desc')} checked={snapshot.showFullUrl} disabled={disabled} onChange={checked => onPatch({ showFullUrl: checked })} />
          <BrowserSelectRow id="browser-annotation-screenshots" label={t('browser_settings_annotation')} desc={t('browser_settings_annotation_desc')} value={snapshot.annotationScreenshots} options={annotationOptions} disabled={disabled} onChange={value => onPatch({ annotationScreenshots: value })} />
          <div className={`pref-row ${styles['browser-clear-row']}`}>
            <div className={styles['browser-copy']}>
              <div className={settingsStyles['pref-row-label']}>{t('browser_settings_clear_data')}</div>
              <div className={settingsStyles['pref-row-desc']}>{t('browser_settings_clear_data_desc')}</div>
              <div className={styles['browser-checkboxes']}>
                {CLEAR_KINDS.map(kind => (
                  <label key={kind} className={styles['browser-checkbox']}>
                    <input type="checkbox" checked={clearKinds.includes(kind)} onChange={event => setClearKinds(current => event.target.checked ? [...current, kind] : current.filter(value => value !== kind))} />
                    <span>{t(`browser_settings_data_${kind}`)}</span>
                  </label>
                ))}
              </div>
            </div>
            <button type="button" id="browser-clear-data" className={styles['browser-action-btn']} disabled={disabled || !clearKinds.length || busy === 'clear'} onClick={() => onClearData(clearKinds)}>{t('browser_settings_clear_selected')}</button>
          </div>
          <div className="pref-row">
            <div className={styles['browser-copy']}>
              <div className={settingsStyles['pref-row-label']}>{t('browser_settings_history_label')}</div>
              <div className={settingsStyles['pref-row-desc']}>{t('browser_settings_history_desc')}</div>
            </div>
            <button type="button" id="browser-history-manage" className={styles['browser-action-btn']} disabled={disabled} onClick={onOpenHistory}>{t('browser_settings_manage')}</button>
          </div>
        </div>
      </div>

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
            <button type="button" className={styles['browser-action-btn']} disabled={disabled} onClick={onOpenDownloads}>{t('browser_settings_manage')}</button>
          </div>
        </div>
      </div>

      <div className="settings-section">
        <div className="settings-section-title">{t('browser_settings_sites')}</div>
        <div className={styles['browser-card']}>
          <div className={styles['browser-section-copy']}>{t('browser_settings_sites_desc')}</div>
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
          <div className={styles['browser-subsection-title']}>{t('browser_settings_site_permissions')}</div>
          <div className={styles['browser-section-copy']}>{t('browser_settings_site_permissions_desc')}</div>
          <form className={styles['browser-add-form']} onSubmit={submitSitePermission}>
            <input className={styles['browser-input']} value={siteOriginDraft} placeholder={t('browser_settings_site_permission_origin_placeholder')} aria-label={t('browser_settings_site_permission_origin')} disabled={disabled} onChange={event => setSiteOriginDraft(event.target.value)} />
            <select className={styles['browser-select']} value={sitePermissionDraft} aria-label={t('browser_settings_site_permission_permission')} disabled={disabled} onChange={event => setSitePermissionDraft(event.target.value)}>
              {SITE_PERMISSIONS.map(permission => <option key={permission} value={permission}>{permission}</option>)}
            </select>
            <button type="submit" className={`${styles['browser-action-btn']} ${styles['is-primary']}`} disabled={disabled}>{t('browser_settings_site_permission_add')}</button>
          </form>
          {sitePermissionError && <div className={styles['browser-error']} role="alert">{sitePermissionError}</div>}
          {snapshot.sitePermissions.length === 0
            ? <div className={styles['browser-empty']}>{t('browser_settings_no_site_permissions')}</div>
            : (
              <div className={styles['browser-table']}>
                <div className={`${styles['browser-table-row']} ${styles['browser-table-row-compact']} ${styles['browser-table-head']}`}>
                  <span>{t('browser_settings_origin')}</span><span>{t('browser_settings_permission')}</span><span>{t('browser_settings_setting')}</span>
                </div>
                {snapshot.sitePermissions.map(row => (
                  <div className={`${styles['browser-table-row']} ${styles['browser-table-row-compact']}`} key={`${row.origin}:${row.permission}`}>
                    <span className={styles['browser-pattern']}>{row.origin}</span>
                    <span>{row.permission}</span>
                    <select className={styles['browser-select']} aria-label={`${row.origin} ${row.permission}`} value={row.setting} disabled={disabled} onChange={event => onSetSitePermission(row.origin, row.permission, event.target.value as SitePermissionSetting)}>
                      <option value="granted">{t('browser_settings_granted')}</option>
                      <option value="denied">{t('browser_settings_denied')}</option>
                      <option value="prompt">{t('browser_settings_prompt')}</option>
                    </select>
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
      const page = await service.history({ query: debounced, source, cursor: reset ? null : cursor, limit: 50 })
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
      const page = await service.downloads({ query: debounced, cursor: reset ? null : cursor, limit: 50 })
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
        const page = await service.downloads({ query: debounced, cursor: null, limit: 50 })
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
  const [view, setView] = useState<'main' | 'history' | 'downloads'>('main')
  const [chromeSetupOpen, setChromeSetupOpen] = useState(false)
  const readSequence = useRef(0)
  const mutationSequence = useRef(0)
  const pendingMutations = useRef(0)
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

  const toggleEnabled = useCallback((enabled: boolean) => {
    void mutate('enabled', { enabled }, () => api()?.setEnabled?.(enabled))
  }, [mutate])

  const setChromeEnabled = useCallback((enabled: boolean) => {
    void mutate('chrome', { chromeEnabled: enabled }, () => api()?.setChromeEnabled?.(enabled))
  }, [mutate])

  const chooseDownloadDirectory = useCallback(() => {
    void mutate('choose-download-dir', null, () => api()?.chooseDownloadDirectory?.())
  }, [mutate])

  const clearData = useCallback(async (kinds: string[]) => {
    readSequence.current++
    pendingMutations.current++
    setBusy('clear')
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
    } finally {
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

  const setSitePermission = useCallback((origin: string, permission: string, setting: SitePermissionSetting) => {
    void mutate('origin', null, () => api()?.setSitePermission?.({ origin, permission, setting }))
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
        onSetChromeEnabled={setChromeEnabled}
        onAddOrigin={addOrigin}
        onSetDefaultPolicy={setDefaultPolicy}
        onSetOriginPolicy={setOriginPolicy}
        onRemoveOrigin={removeOrigin}
        onSetSitePermission={setSitePermission}
        onOpenChromeSetup={() => setChromeSetupOpen(true)}
      />
      {chromeSetupOpen && (
        <ModalPortal>
          <BrowserCapabilityModal enabled={snapshot.enabled} onClose={() => { setChromeSetupOpen(false); void load() }} />
        </ModalPortal>
      )}
    </>
  )
}
