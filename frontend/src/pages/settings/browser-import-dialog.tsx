import { useEffect, useId, useRef, useState } from 'react'
import { BROWSER_IMPORT_CATEGORIES, type BrowserDiscoveryResult, type BrowserImportCategory, type BrowserImportRequest, type BrowserProfileCandidate } from '../../../../contracts/browser-import'
import type { BrowserImportJobHandle, BrowserImportJobSnapshot } from '../../../../contracts/browser-import-jobs'
import { ModalPortal } from '../../components/ModalPortal'
import { useT } from '../../i18n'
import { IMPORT_UI_DEFAULTS, importCategoryErrors, importIsTerminal, importRetrySelection, mergeImportSummary, type ImportSelection, type ImportSummary } from './browser-import-model'
import { RuntimeChoice } from './runtime-tab'
import styles from './browser-import.module.css'

export interface BrowserImportUiApi {
  discover(): Promise<BrowserDiscoveryResult>
  openPermissionSettings?(): Promise<void>
  start(request: BrowserImportRequest): Promise<BrowserImportJobHandle>
  cancel(jobId: string): Promise<unknown>
  subscribe(callback: (snapshot: BrowserImportJobSnapshot) => void): () => void
}

type ActiveRun = {
  token: number
  jobId: string | null
  revision: number
  selection: ImportSelection
  previous: ImportSummary | null
  terminal: boolean
  cancelRequested: boolean
  cancelSent: boolean
}

const profileKey = (profile: BrowserProfileCandidate) => JSON.stringify([profile.sourceId, profile.profileId])
const profileLabel = (profile: BrowserProfileCandidate) => `${profile.sourceLabel} — ${profile.displayName}`
const selectedCategories = (selection: ImportSelection) => BROWSER_IMPORT_CATEGORIES.filter(category => selection[category])

export function BrowserImportDialog({ api, onClose }: { api: BrowserImportUiApi; onClose: () => void }) {
  const t = useT()
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const mounted = useRef(false)
  const generation = useRef(0)
  const active = useRef<ActiveRun | null>(null)
  const earlyEvents = useRef(new Map<string, BrowserImportJobSnapshot>())
  const busyRef = useRef(false)
  const onCloseRef = useRef(onClose)
  const [discovery, setDiscovery] = useState<BrowserDiscoveryResult | null>(null)
  const [discoveryFailed, setDiscoveryFailed] = useState(false)
  const [permissionSettingsFailed, setPermissionSettingsFailed] = useState(false)
  const [discovering, setDiscovering] = useState(true)
  const [selectedKey, setSelectedKey] = useState('')
  const [selection, setSelection] = useState<ImportSelection>({ ...IMPORT_UI_DEFAULTS })
  const [confirmExtensions, setConfirmExtensions] = useState(false)
  const [pending, setPending] = useState(false)
  const [cancelling, setCancelling] = useState(false)
  const [cancelFailed, setCancelFailed] = useState(false)
  const [snapshot, setSnapshot] = useState<BrowserImportJobSnapshot | null>(null)
  const [summary, setSummary] = useState<ImportSummary | null>(null)
  const [submitFailed, setSubmitFailed] = useState(false)
  onCloseRef.current = () => { if (confirmExtensions) setConfirmExtensions(false); else onClose() }
  busyRef.current = pending

  const profile = discovery?.profiles.find(candidate => profileKey(candidate) === selectedKey) ?? discovery?.profiles[0] ?? null
  const discoveryIssues = discovery?.errors.filter(issue => !['local_state_missing', 'profile_cache_empty'].includes(issue.code)) ?? []
  const permissionDenied = !discoveryFailed && discoveryIssues.some(issue => issue.code === 'source_permission_denied' || issue.code === 'profile_permission_denied')
  const unavailable = discoveryFailed || (!profile && discoveryIssues.length > 0)
  const permissionMessage = t('browser_import_permission_denied')
  const effectiveSelection: ImportSelection = {
    cookies: Boolean(profile?.cookies && selection.cookies),
    passwords: Boolean(profile?.passwords && selection.passwords),
    history: Boolean(profile?.history && selection.history),
    extensions: Boolean(profile?.extensions && selection.extensions),
  }

  const refresh = async () => {
    const token = ++generation.current
    setDiscovering(true)
    setDiscoveryFailed(false)
    setPermissionSettingsFailed(false)
    try {
      const result = await api.discover()
      if (mounted.current && token === generation.current) setDiscovery(result)
    } catch {
      if (mounted.current && token === generation.current) setDiscoveryFailed(true)
    } finally {
      if (mounted.current && token === generation.current) setDiscovering(false)
    }
  }

  const openPermissionSettings = async () => {
    setPermissionSettingsFailed(false)
    try { await api.openPermissionSettings?.() }
    catch { if (mounted.current) setPermissionSettingsFailed(true) }
  }

  const accept = (value: BrowserImportJobSnapshot) => {
    const run = active.current
    if (!run || run.jobId !== value.jobId || value.revision <= run.revision) return
    run.revision = value.revision
    run.terminal = importIsTerminal(value)
    setSnapshot(value)
    if (run.terminal) {
      busyRef.current = false
      setPending(false)
      setCancelling(false)
      setCancelFailed(false)
      setSummary(mergeImportSummary(run.previous, run.selection, value))
    }
  }
  const acceptRef = useRef(accept)
  acceptRef.current = accept

  useEffect(() => {
    mounted.current = true
    // Subscribe before starting: a fast host can finish before start's reply.
    const unsubscribe = api.subscribe(value => {
      const run = active.current
      if (!run || !mounted.current) return
      if (run.jobId) { acceptRef.current(value); return }
      const earlier = earlyEvents.current.get(value.jobId)
      if (!earlier || value.revision > earlier.revision) earlyEvents.current.set(value.jobId, value)
      while (earlyEvents.current.size > 16) earlyEvents.current.delete(earlyEvents.current.keys().next().value!)
    })
    void refresh()
    return () => {
      mounted.current = false
      generation.current++
      unsubscribe()
      const run = active.current
      if (run?.jobId && !run.terminal && !run.cancelSent) void api.cancel(run.jobId).catch(() => {})
      earlyEvents.current.clear()
    }
  }, [api])

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    dialog?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        if (!busyRef.current) onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(element => element.getClientRects().length > 0)
      if (!focusable.length) { event.preventDefault(); dialog.focus(); return }
      const first = focusable[0]!
      const last = focusable[focusable.length - 1]!
      if (!dialog.contains(document.activeElement) || document.activeElement === dialog
        || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault()
        ;(event.shiftKey ? last : first).focus()
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => { document.removeEventListener('keydown', onKeyDown, true); if (previousFocus?.isConnected) previousFocus.focus() }
  }, [])

  const start = async (attempt: ImportSelection, previous: ImportSummary | null, extensionsConfirmed: boolean) => {
    if (busyRef.current || !profile || !selectedCategories(attempt).length) return
    busyRef.current = true
    setPending(true)
    setConfirmExtensions(false)
    setSubmitFailed(false)
    setCancelFailed(false)
    setCancelling(false)
    setSnapshot(null)
    const run: ActiveRun = { token: ++generation.current, jobId: null, revision: -1, selection: { ...attempt }, previous, terminal: false, cancelRequested: false, cancelSent: false }
    active.current = run
    earlyEvents.current.clear()
    try {
      const handle = await api.start({ sourceId: profile.sourceId, profileId: profile.profileId, categories: { ...attempt }, ...(attempt.extensions && extensionsConfirmed ? { allowUnverifiedExtensions: true } : {}) })
      if (!mounted.current || run.token !== generation.current || active.current !== run) {
        if (!run.cancelSent) void api.cancel(handle.jobId).catch(() => {})
        return
      }
      run.jobId = handle.jobId
      const early = earlyEvents.current.get(handle.jobId)
      const initial = early && early.revision > handle.snapshot.revision ? early : handle.snapshot
      earlyEvents.current.clear()
      if (run.cancelRequested && !run.cancelSent) {
        run.cancelSent = true
        void api.cancel(handle.jobId).catch(() => {
          if (!mounted.current || active.current !== run || run.terminal) return
          run.cancelRequested = false
          run.cancelSent = false
          setCancelling(false)
          setCancelFailed(true)
        })
      }
      acceptRef.current(initial)
    } catch {
      if (!mounted.current || active.current !== run) return
      active.current = null
      busyRef.current = false
      setPending(false)
      setCancelling(false)
      setSubmitFailed(true)
    }
  }

  const requestCancel = async () => {
    const run = active.current
    if (!run || run.terminal || run.cancelRequested) return
    run.cancelRequested = true
    setCancelFailed(false)
    setCancelling(true)
    if (!run.jobId || run.cancelSent) return
    run.cancelSent = true
    try {
      await api.cancel(run.jobId)
    } catch {
      if (!mounted.current || active.current !== run || run.terminal) return
      run.cancelRequested = false
      run.cancelSent = false
      setCancelling(false)
      setCancelFailed(true)
    }
  }

  const requestImport = () => {
    if (effectiveSelection.extensions) setConfirmExtensions(true)
    else void start(effectiveSelection, null, false)
  }
  const attempted = active.current?.selection
  const liveSummary: ImportSummary | null = attempted && snapshot && !importIsTerminal(snapshot)
    ? { selection: attempted, counts: snapshot.counts, errors: snapshot.errors }
    : null
  const displaySummary = pending ? (liveSummary ?? summary) : (summary ?? liveSummary)
  const rows = displaySummary ? selectedCategories(displaySummary.selection) : attempted ? selectedCategories(attempted) : []
  const failedRows = summary ? selectedCategories(importRetrySelection(summary)) : []
  const allFailed = summary && failedRows.length === rows.length && rows.every(category => summary.counts[category] === 0)
  const categoryLabel = (category: BrowserImportCategory) => t(`browser_import_${category}`)
  const issueDetails = discoveryIssues.length > 0 ? <ul className={styles['import-issues']}>
    {discoveryIssues.map((issue, index) => <li key={`${issue.sourceId}:${issue.code}:${index}`}>
      <span>{issue.code}</span>{issue.message ? `: ${issue.message}` : ''}
    </li>)}
  </ul> : null
  const terminal = snapshot ? importIsTerminal(snapshot) : false
  const cancelled = snapshot?.stage === 'cancelled'
  const formVisible = !pending && !summary
  const title = confirmExtensions ? t('browser_import_extensions_confirm_title')
    : pending ? t('browser_import_progress_title')
      : summary ? cancelled ? t('browser_import_cancelled_title') : t(allFailed ? 'browser_import_failed_title' : 'browser_import_complete_title') : t('browser_import_title')

  return <ModalPortal>
    <div className="kls-modal-overlay" onClick={event => { if (event.target === event.currentTarget && !busyRef.current) onCloseRef.current() }}>
      <div className={`kls-modal ${styles['import-modal']}`} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} aria-busy={pending}>
        {formVisible && !confirmExtensions && <button className={styles['import-close']} aria-label={t('cancel')} onClick={onClose}>×</button>}
        <h2 id={titleId}>{title}</h2>
        <p className={styles['import-description']}>{confirmExtensions ? t('browser_import_extensions_confirm_desc') : pending ? t('browser_import_progress_desc') : cancelled ? t('browser_import_cancelled_desc') : summary ? t(allFailed ? 'browser_import_failed_desc' : failedRows.length ? 'browser_import_partial_desc' : 'browser_import_complete_desc') : t('browser_import_desc')}</p>
        {confirmExtensions ? <div className={styles['import-actions']}>
          <button onClick={() => setConfirmExtensions(false)}>{t('cancel')}</button>
          <button className={styles['import-primary']} onClick={() => { void start(effectiveSelection, null, true) }}>{t('browser_import_extensions_confirm_action')}</button>
        </div> : formVisible ? <>
          {discovering ? <p role="status">{t('browser_import_discovering')}</p> : unavailable ? <div role="alert">
            <p>{permissionDenied ? permissionMessage : t('browser_import_discovery_failed')}</p>
            {issueDetails}
            {permissionDenied && api.openPermissionSettings && <button onClick={() => { void openPermissionSettings() }}>{t('browser_import_permission_settings')}</button>}
            <button onClick={() => { void refresh() }}>{t('browser_import_retry')}</button>
          </div> : !profile ? <p role="status">{t('browser_import_no_profiles')}</p> : <>
            {discoveryIssues.length > 0 && <div role="status"><p>{t('browser_import_discovery_partial')}</p>
              {permissionDenied && <p>{permissionMessage}</p>}
              {issueDetails}
              {permissionDenied && api.openPermissionSettings && <button onClick={() => { void openPermissionSettings() }}>{t('browser_import_permission_settings')}</button>}
            </div>}
            {discovery!.profiles.length > 1 ? <RuntimeChoice
              id="browser-import-profile"
              label={t('browser_import_source')}
              options={discovery!.profiles.map(candidate => ({ value: profileKey(candidate), label: profileLabel(candidate) }))}
              value={profileKey(profile)}
              onChange={setSelectedKey}
            /> : <p className={styles['import-source-name']}>{profileLabel(profile)}</p>}
            <div className={styles['import-categories']}>
              {BROWSER_IMPORT_CATEGORIES.filter(category => category === 'cookies' || category === 'passwords' || profile[category]).map(category => <label key={category}>
                <input type="checkbox" data-import-category={category} checked={effectiveSelection[category]} disabled={!profile[category]} onChange={event => setSelection(current => ({ ...current, [category]: event.target.checked }))} />
                <span>{categoryLabel(category)}</span>
              </label>)}
            </div>
            <p className={styles['import-guidance']}>{t('browser_import_close_source').replace('{source}', profile.sourceLabel)}</p>
          </>}
          {permissionSettingsFailed && <p role="alert" className={styles['import-error']}>{t('browser_import_permission_settings_failed')}</p>}
          {submitFailed && <p role="alert" className={styles['import-error']}>{t('browser_import_start_failed')}</p>}
          <div className={styles['import-actions']}>
            <button onClick={onClose}>{t('cancel')}</button>
            <button className={styles['import-primary']} disabled={discovering || discoveryFailed || !profile || !selectedCategories(effectiveSelection).length} onClick={requestImport}>{t('browser_import_action')}</button>
          </div>
        </> : <>
          <ul className={styles['import-results']} aria-live="polite" aria-relevant="text">
            {rows.map(category => {
              const finished = Boolean(summary)
              const errors = displaySummary ? importCategoryErrors(displaySummary, category) : []
              const count = displaySummary?.counts[category] ?? 0
              return <li key={category} data-category={category} data-state={finished ? errors.length ? 'failed' : 'complete' : 'pending'}>
                <span className={styles['import-status']} aria-hidden="true">{finished ? errors.length ? '!' : '✓' : '◌'}</span>
                <div><span>{categoryLabel(category)}</span>{displaySummary && <>
                  {(count > 0 || finished) && <small>{t('browser_import_count').replace('{count}', String(count))}</small>}
                  {errors.length > 0 && <small>{t(`browser_import_${category}_failed`)}</small>}
                  {errors.map((issue, index) => <small key={`${issue.code}:${index}`}>{issue.code === 'app_bound_encryption_unsupported' ? t('browser_import_app_bound_unsupported') : issue.message} ({issue.code})</small>)}
                </>}</div>
              </li>
            })}
          </ul>
          {submitFailed && <p role="alert" className={styles['import-error']}>{t('browser_import_start_failed')}</p>}
          {cancelFailed && <p role="alert" className={styles['import-error']}>{t('browser_import_cancel_failed')}</p>}
          <div className={styles['import-actions']}>
            {pending && <button type="button" disabled={cancelling || terminal} onClick={() => { void requestCancel() }}>{cancelling ? t('browser_import_cancelling') : t('cancel')}</button>}
            {!pending && !cancelled && failedRows.length > 0 && <button onClick={() => { if (summary) void start(importRetrySelection(summary), summary, true) }}>{t('browser_import_retry')}</button>}
            {!pending && <button className={styles['import-primary']} onClick={onClose}>{t('browser_import_done')}</button>}
          </div>
        </>}
      </div>
    </div>
  </ModalPortal>
}
