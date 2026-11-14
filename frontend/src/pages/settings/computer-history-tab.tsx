import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { intlLocale, useT } from '../../i18n'
import { showToast } from '../../app/ui-shared'
import { CapabilityRow, CapabilitySwitch } from './capability-tabs'
import { SettingsPage } from './kv'
import { loadSettingsTab } from './shell'
import { StorageButton, StorageDialog } from './storage-dialog'
import {
  entryDomain,
  entrySource,
  formatEntryTime,
  groupTimelineByDay,
  normalizeDomainInput,
  parseEntriesPayload,
  parseHistorySnapshot,
  splitPolicyGroups,
  subdomainPreviewExample,
  type HistoryEntry,
  type HistorySnapshot,
  type ObservationEntry,
} from './computer-history-model'
import styles from './computer-history.module.css'

interface InstalledApp {
  name: string
  path: string
  bundleId?: string
  running?: boolean
  iconDataUrl?: string
}

type ClearInterval = 'last-hour' | 'last-day' | 'all'
const PAGE_SIZE = 200

const historyApi = () => (window as any).settingsApi?.computerHistory
const computerUseApi = () => (window as any).settingsApi?.computerUse

const iconSource = (value: unknown) => typeof value === 'string' && value.length < 90_000
  && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(value) ? value : undefined

function parseInstalledApps(value: any): InstalledApp[] {
  return (Array.isArray(value?.apps) ? value.apps : []).flatMap((app: any): InstalledApp[] =>
    typeof app?.name === 'string' && typeof app?.path === 'string' && app.path.length > 0 && app.path.length <= 4096
      ? [{
        name: app.name,
        path: app.path,
        iconDataUrl: iconSource(app.iconDataUrl),
        ...(typeof app.bundleId === 'string' && app.bundleId.trim() ? { bundleId: app.bundleId.trim() } : {}),
        ...(app.running === true ? { running: true } : {}),
      }]
      : [])
}

export function ComputerHistorySettingsTab() {
  const t = useT()
  const locale = intlLocale()
  const [snapshot, setSnapshot] = useState<HistorySnapshot | null>(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)

  // Installed apps catalog for resolving bundleId -> app name + icon, and for the rule picker
  const [installed, setInstalled] = useState<InstalledApp[] | null>(null)
  const [catalogError, setCatalogError] = useState(false)

  // Add-rule dialog state
  const [ruleDialogOpen, setRuleDialogOpen] = useState(false)
  const [scope, setScope] = useState<'app' | 'url'>('app')
  const [observe, setObserve] = useState<'exclude' | 'include'>('exclude')
  const [appQuery, setAppQuery] = useState('')
  const [selectedBundleId, setSelectedBundleId] = useState('')
  const [urlDraft, setUrlDraft] = useState('')
  const [urlTouched, setUrlTouched] = useState(false)
  const [ruleError, setRuleError] = useState('')

  // Clear-history dialog state
  const [clearDialogOpen, setClearDialogOpen] = useState(false)
  const [clearChoice, setClearChoice] = useState<ClearInterval>('last-hour')

  // Timeline state
  const [timelineOpen, setTimelineOpen] = useState(false)
  const [timeline, setTimeline] = useState<HistoryEntry[] | null>(null)
  const [timelineLoading, setTimelineLoading] = useState(false)
  const [timelineHasMore, setTimelineHasMore] = useState(false)
  const [timelineError, setTimelineError] = useState(false)

  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => { alive.current = false }
  }, [])

  const load = useCallback(async () => {
    setError(false)
    try {
      const api = historyApi()
      if (!api?.get) throw new Error('Computer History API unavailable')
      const next = parseHistorySnapshot(await api.get())
      if (alive.current) setSnapshot(next)
      return next
    } catch {
      if (alive.current) setError(true)
      return null
    }
  }, [])

  const loadInstalledCatalog = useCallback(async () => {
    const cu = computerUseApi()
    if (!cu?.listApps) {
      if (alive.current) setInstalled([])
      return
    }
    setCatalogError(false)
    try {
      const result = await cu.listApps()
      if (alive.current) setInstalled(parseInstalledApps(result))
    } catch {
      if (alive.current) {
        setInstalled([])
        setCatalogError(true)
      }
    }
  }, [])

  useEffect(() => {
    void load()
    void loadInstalledCatalog()
  }, [load, loadInstalledCatalog])

  const appsByBundleId = useMemo(() => {
    const map = new Map<string, InstalledApp>()
    for (const app of installed ?? []) {
      if (app.bundleId) map.set(app.bundleId.toLowerCase(), app)
    }
    return map
  }, [installed])

  const normalizedUrl = useMemo(() => normalizeDomainInput(urlDraft), [urlDraft])

  const dayGroups = useMemo(() => groupTimelineByDay(timeline ?? [], Date.now(), locale, {
    today: t('computer_history_day_today'),
    yesterday: t('computer_history_day_yesterday'),
  }), [timeline, locale, t])

  const oldestCursor = useMemo(() => {
    if (!timeline?.length) return undefined
    return timeline.reduce((min, item) => Math.min(min, item.at), timeline[0]!.at)
  }, [timeline])

  const guarded = async (run: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    try { await run() } finally { if (alive.current) setBusy(false) }
  }

  const report = (result: any, fallback: string) => {
    if (result?.ok === false) {
      if (result.error !== 'macos-accessibility-permission-required') {
        showToast(result.error || fallback)
      }
      return false
    }
    return true
  }

  const loadTimeline = useCallback(async (more: boolean, currentOldest?: number) => {
    const api = historyApi()
    if (!api?.entries) return
    setTimelineError(false)
    setTimelineLoading(true)
    try {
      const raw = await api.entries(PAGE_SIZE, more ? currentOldest : undefined)
      const batch = parseEntriesPayload(raw)
      if (!alive.current) return
      setTimelineHasMore(batch.length >= PAGE_SIZE)
      setTimeline(prev => more && prev ? [...batch, ...prev] : batch)
    } catch {
      if (alive.current) setTimelineError(true)
    } finally {
      if (alive.current) setTimelineLoading(false)
    }
  }, [])

  const toggle = async (enabled: boolean) => guarded(async () => {
    const result = await historyApi().setEnabled(enabled).catch((err: any) => ({ ok: false, error: err?.message || String(err) }))
    const ok = report(result, t('settings_failed'))
    await load()
    if (!ok) return
    showToast(enabled ? t('computer_history_started_toast') : t('computer_history_stopped_toast'), { tone: 'success' })
    if (timelineOpen) void loadTimeline(false)
  })

  const pauseResume = async (pause: boolean) => guarded(async () => {
    const result = await (pause ? historyApi().pause() : historyApi().resume()).catch((err: any) => ({ ok: false, error: err?.message || String(err) }))
    const ok = report(result, t('settings_failed'))
    await load()
    if (!ok) return
  })

  const urlInvalid = scope === 'url' && urlTouched && urlDraft.trim().length > 0 && !normalizedUrl

  const openRuleDialog = () => {
    setScope('app')
    setObserve('exclude')
    setAppQuery('')
    setSelectedBundleId('')
    setUrlDraft('')
    setUrlTouched(false)
    setRuleError('')
    setRuleDialogOpen(true)
    if (installed === null || catalogError) void loadInstalledCatalog()
  }

  const submitRule = async (explicitTarget?: string) => {
    const chosenTarget = explicitTarget ?? (scope === 'app' ? selectedBundleId : (normalizedUrl ?? ''))
    if (!chosenTarget || busy) {
      if (scope === 'url') setUrlTouched(true)
      return
    }
    setRuleError('')
    await guarded(async () => {
      try {
        const result = await historyApi().updateObservation({ observe, scope, target: chosenTarget })
        if (!alive.current) return
        if (result?.ok === false) {
          setRuleError(result.error || t('settings_failed'))
          return
        }
        setSnapshot(current => current ? {
          ...current,
          settings: { ...current.settings, policy: result?.policy ?? current.settings.policy },
        } : current)
        setRuleDialogOpen(false)
        showToast(t('computer_history_policy_added'), { tone: 'success' })
      } catch {
        if (alive.current) setRuleError(t('computer_history_target_error'))
      }
    })
  }

  const removeRule = async (entry: ObservationEntry) => guarded(async () => {
    try {
      const result = await historyApi().removeObservationEntry(entry.scope, entry.target)
      if (!alive.current) return
      setSnapshot(current => current ? {
        ...current,
        settings: { ...current.settings, policy: result?.policy ?? current.settings.policy },
      } : current)
    } catch {
      showToast(t('settings_failed'))
    }
  })

  const confirmClear = async () => guarded(async () => {
    try {
      const result = await historyApi().clearHistory(clearChoice)
      if (!alive.current) return
      setClearDialogOpen(false)
      if (result && typeof result.removed === 'number') {
        showToast(t('computer_history_cleared').replace('{count}', result.removed.toLocaleString(locale)), { tone: 'success' })
      }
      if (timelineOpen) await loadTimeline(false)
      await load()
    } catch {
      showToast(t('settings_failed'))
    }
  })

  const toggleTimeline = () => {
    if (timelineOpen) {
      setTimelineOpen(false)
      return
    }
    setTimelineOpen(true)
    void loadTimeline(false)
  }

  if (error) {
    return <SettingsPage title={t('computer_history_title')} subtitle={t('computer_history_settings_desc')}>
      <div className={styles.card}>
        <div className={styles.errorRow} role="alert">
          <span>{t('computer_history_load_error')}</span>
          <StorageButton onClick={() => void load()}>{t('computer_use_retry')}</StorageButton>
        </div>
      </div>
    </SettingsPage>
  }

  const status = snapshot?.status
  const settings = snapshot?.settings
  const managedBlocked = status?.managedDisabled === true || settings?.managedDisabled === true
  const enabled = settings?.enabled === true
  const running = status?.state === 'running'
  const paused = status?.state === 'paused'
  const unavailableReason = status?.unavailableReason
  const needsAccessibility = unavailableReason === 'macos-accessibility-permission-required'
  const policy = settings?.policy ?? []
  const { includeEntries, excludeEntries } = splitPolicyGroups(policy)

  const existingAppTargets = new Set(policy.filter(item => item.scope === 'app').map(item => item.target.toLowerCase()))
  const needle = appQuery.trim().toLowerCase()
  const filteredApps = (installed ?? []).filter(app => !needle
    || app.name.toLowerCase().includes(needle)
    || app.path.toLowerCase().includes(needle)
    || (app.bundleId ?? '').toLowerCase().includes(needle))
    .sort((left, right) => Number(!!right.running) - Number(!!left.running)
      || left.name.localeCompare(right.name, undefined, { sensitivity: 'base' }))
  const firstPickableApp = filteredApps.find(app => app.bundleId && !existingAppTargets.has(app.bundleId.toLowerCase()))

  const renderRuleRow = (entry: ObservationEntry) => {
    const appInfo = entry.scope === 'app' ? appsByBundleId.get(entry.target.toLowerCase()) : undefined
    const displayName = entry.scope === 'app' ? (appInfo?.name ?? entry.target) : entry.target
    const subLabel = entry.scope === 'url'
      ? t('computer_history_scope_url_sub')
      : appInfo || installed === null
        ? t('computer_history_scope_app')
        : t('computer_history_app_missing_sub')
    return (
      <div className={styles.ruleRow} key={`${entry.scope}:${entry.target}`} data-rule-row={`${entry.scope}:${entry.target}`}>
        <span className={styles.ruleIcon} aria-hidden="true">
          {entry.scope === 'url'
            ? <Icon name="settings-nav-engine-web" size={20} />
            : appInfo?.iconDataUrl
              ? <img src={appInfo.iconDataUrl} width={32} height={32} alt="" />
              : <Icon name="computer-use-pip" size={22} />}
        </span>
        <div className={styles.rowCopy}>
          <span className={styles.rowTitle}>{displayName}</span>
          <span className={styles.rowDesc}>{subLabel}</span>
        </div>
        <span className={entry.observe === 'include' ? styles.pillInclude : styles.pillExclude}>
          {entry.observe === 'include' ? t('computer_history_observe_include') : t('computer_history_observe_exclude')}
        </span>
        <button
          type="button"
          className={styles.removeBtn}
          disabled={busy}
          aria-label={t('computer_history_remove').replace('{target}', displayName)}
          onClick={() => void removeRule(entry)}
        >
          <Icon name="trash" size={17} />
        </button>
      </div>
    )
  }

  return (
    <SettingsPage title={t('computer_history_title')} subtitle={t('computer_history_settings_desc')}>
      <div className={styles.sections}>
        {/* (a) Recording switch & live status */}
        <section aria-labelledby="computer-history-switch-heading" className={styles.section}>
          <h2 id="computer-history-switch-heading" hidden>{t('computer_history_capture_title')}</h2>
          <div className={styles.card} aria-busy={snapshot === null || busy}>
            {snapshot === null ? (
              <div className={styles.loadingRow} role="status">{t('loading')}</div>
            ) : (
              <>
                <div className={styles.capabilityWrap}>
                  <CapabilityRow
                    title={t('computer_history_capture_title')}
                    desc={t('computer_history_capture_desc')}
                    iconName="computer-history-logo"
                    action={
                      <CapabilitySwitch
                        id="computer-history-enabled"
                        checked={enabled}
                        disabled={busy || managedBlocked}
                        ariaLabel={t('computer_history_capture_title')}
                        onChange={checked => void toggle(checked)}
                      />
                    }
                  />
                </div>
                {managedBlocked && (
                  <div className={styles.noticeRow} role="status">
                    <span className={styles.noticeText}>{t('computer_history_managed_blocked')}</span>
                  </div>
                )}
                {!managedBlocked && needsAccessibility && (
                  <div className={styles.noticeRow} role="alert">
                    <span className={styles.noticeText}>{t('computer_history_permission_required')}</span>
                    <StorageButton onClick={() => loadSettingsTab('systemAuth')}>
                      {t('computer_history_open_permissions')}
                    </StorageButton>
                  </div>
                )}
                {!managedBlocked && unavailableReason && !needsAccessibility && (
                  <div className={styles.noticeRow} role="alert">
                    <span className={styles.noticeText}>{t('computer_history_unavailable').replace('{reason}', unavailableReason)}</span>
                    <StorageButton disabled={busy} onClick={() => void toggle(true)}>
                      {t('computer_use_retry')}
                    </StorageButton>
                  </div>
                )}
                {enabled && (
                  <div className={styles.statusRow}>
                    <div className={styles.statusInfo}>
                      <div className={styles.statusMain}>
                        <span className={running ? styles.dotRunning : styles.dotPaused} aria-hidden="true" />
                        <span>
                          {running ? t('computer_history_state_running') : t('computer_history_state_paused')}
                          {status?.entryCount !== undefined
                            ? ` · ${t('computer_history_entry_count').replace('{count}', status.entryCount.toLocaleString(locale))}`
                            : ''}
                        </span>
                      </div>
                      {paused && <div className={styles.statusSub}>{t('computer_history_paused_resume_note')}</div>}
                    </div>
                    <StorageButton
                      disabled={busy || (paused && managedBlocked)}
                      onClick={() => void pauseResume(running)}
                    >
                      {running ? t('computer_history_pause') : t('computer_history_resume')}
                    </StorageButton>
                  </div>
                )}
              </>
            )}
          </div>
          <p className={styles.footnote}>{t('computer_history_retention_note')}</p>
        </section>

        {/* (b) Recording scope */}
        <section aria-labelledby="computer-history-policy-title" className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 id="computer-history-policy-title">{t('computer_history_policy_title')}</h2>
            <StorageButton
              id="computer-history-add-rule"
              disabled={snapshot === null || busy}
              onClick={openRuleDialog}
            >
              {t('computer_history_add_rule')}
            </StorageButton>
          </div>
          <div className={styles.card}>
            {!policy.length ? (
              <div className={styles.emptyScopeRow}>
                <span className={styles.scopeTile} aria-hidden="true">
                  <Icon name="settings-nav-engine-web" size={20} />
                </span>
                <div className={styles.rowCopy}>
                  <span className={styles.rowTitle}>{t('computer_history_policy_empty')}</span>
                  <span className={styles.rowDesc}>{t('computer_history_policy_empty_desc')}</span>
                </div>
              </div>
            ) : (
              <>
                {includeEntries.length > 0 && (
                  <>
                    <div className={styles.groupHeader}>{t('computer_history_group_include')}</div>
                    {includeEntries.map(renderRuleRow)}
                  </>
                )}
                {excludeEntries.length > 0 && (
                  <>
                    <div className={styles.groupHeader}>{t('computer_history_group_exclude')}</div>
                    {excludeEntries.map(renderRuleRow)}
                  </>
                )}
              </>
            )}
          </div>
        </section>

        {/* (c) History entries & clear */}
        <section aria-labelledby="computer-history-data-title" className={styles.section}>
          <div className={styles.sectionHeader}>
            <h2 id="computer-history-data-title">{t('computer_history_data_title')}</h2>
          </div>
          <div className={styles.card}>
            <div className={styles.actionRow}>
              <div className={styles.rowCopy}>
                <span className={styles.rowTitle}>{t('computer_history_view_row_title')}</span>
                <span className={styles.rowDesc}>{t('computer_history_view_row_desc')}</span>
              </div>
              <StorageButton disabled={busy} onClick={toggleTimeline}>
                {timelineOpen ? t('computer_history_hide_timeline') : t('computer_history_show_timeline')}
              </StorageButton>
            </div>
            {timelineOpen && (
              <div className={styles.timelinePanel} data-timeline-panel="1">
                {timelineError ? (
                  <div className={styles.timelineEmpty} role="alert">{t('computer_history_timeline_error')}</div>
                ) : timeline === null && timelineLoading ? (
                  <div className={styles.timelineEmpty} role="status">{t('loading')}</div>
                ) : dayGroups.length === 0 ? (
                  <div className={styles.timelineEmpty}>
                    {enabled ? t('computer_history_timeline_empty') : t('computer_history_timeline_empty_off')}
                  </div>
                ) : (
                  <>
                    {dayGroups.map(group => (
                      <div className={styles.dayGroup} key={group.key}>
                        <div className={styles.dayHeader}>{group.label}</div>
                        {group.entries.map((entry, idx) => {
                          const domain = entryDomain(entry)
                          const appInfo = entry.bundleId ? appsByBundleId.get(entry.bundleId.toLowerCase()) : undefined
                          const appLabel = appInfo?.name || entrySource(entry)
                          const isSwitch = entry.kind === 'app'
                          return (
                            <div
                              className={`${styles.timelineRow}${isSwitch ? ' ' + styles.timelineRowApp : ''}`}
                              key={`${entry.at}-${idx}`}
                            >
                              <span className={styles.timelineTime}>{formatEntryTime(entry.at)}</span>
                              <span className={styles.timelineIcon} aria-hidden="true">
                                {appInfo?.iconDataUrl
                                  ? <img src={appInfo.iconDataUrl} width={20} height={20} alt="" />
                                  : <Icon name={domain ? 'settings-nav-engine-web' : 'computer-use-pip'} size={15} />}
                              </span>
                              {isSwitch ? (
                                <span className={styles.timelineTitle}>
                                  {t('computer_history_switched_to').replace('{app}', appLabel)}
                                </span>
                              ) : (
                                <>
                                  <span className={styles.timelineApp}>{appLabel}</span>
                                  <span className={styles.timelineTitle}>{entry.title || ''}</span>
                                  {domain && <span className={styles.domainBadge}>{domain}</span>}
                                </>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    ))}
                    <div className={styles.timelineFooter}>
                      {timelineHasMore ? (
                        <button
                          type="button"
                          className={styles.linkBtn}
                          disabled={timelineLoading || busy}
                          onClick={() => void loadTimeline(true, oldestCursor)}
                        >
                          {t('computer_history_load_more')}
                        </button>
                      ) : (
                        <span>{t('computer_history_all_loaded')}</span>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
            <div className={styles.actionRow}>
              <div className={styles.rowCopy}>
                <span className={styles.rowTitle}>{t('computer_history_clear_row_title')}</span>
                <span className={styles.rowDesc}>{t('computer_history_clear_row_desc')}</span>
              </div>
              <StorageButton
                id="computer-history-clear-open"
                disabled={busy || (status?.entryCount === 0)}
                onClick={() => { setClearChoice('last-hour'); setClearDialogOpen(true) }}
              >
                {t('computer_history_clear_open')}
              </StorageButton>
            </div>
          </div>
        </section>
      </div>

      {/* Add-rule modal */}
      {ruleDialogOpen && (
        <StorageDialog
          wide
          title={t('computer_history_add_rule')}
          description={t('computer_history_policy_desc')}
          returnFocusId="computer-history-add-rule"
          onClose={() => { if (!busy) setRuleDialogOpen(false) }}
          dismissible={!busy}
          footer={
            <>
              <StorageButton disabled={busy} onClick={() => setRuleDialogOpen(false)}>
                {t('cancel')}
              </StorageButton>
              <StorageButton
                busy={busy}
                disabled={busy || (scope === 'app' ? !selectedBundleId : !normalizedUrl)}
                onClick={() => void submitRule()}
              >
                {t('computer_history_add')}
              </StorageButton>
            </>
          }
        >
          <div className={styles.dialogBody}>
            <div className={styles.segmentedGroup}>
              <span className={styles.fieldLabel} id="ch-scope-label">{t('computer_history_scope_label')}</span>
              <div className={styles.segmented} role="radiogroup" aria-labelledby="ch-scope-label">
                <button
                  type="button"
                  role="radio"
                  aria-checked={scope === 'app'}
                  className={styles.segmentBtn}
                  disabled={busy}
                  onClick={() => { setScope('app'); setRuleError('') }}
                >
                  {t('computer_history_scope_app')}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={scope === 'url'}
                  className={styles.segmentBtn}
                  disabled={busy}
                  onClick={() => { setScope('url'); setRuleError('') }}
                >
                  {t('computer_history_scope_url')}
                </button>
              </div>
            </div>

            <div className={styles.segmentedGroup}>
              <span className={styles.fieldLabel} id="ch-observe-label">{t('computer_history_observe_label')}</span>
              <div className={styles.segmented} role="radiogroup" aria-labelledby="ch-observe-label">
                <button
                  type="button"
                  role="radio"
                  aria-checked={observe === 'exclude'}
                  className={styles.segmentBtn}
                  disabled={busy}
                  onClick={() => setObserve('exclude')}
                >
                  {t('computer_history_observe_exclude')}
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={observe === 'include'}
                  className={styles.segmentBtn}
                  disabled={busy}
                  onClick={() => setObserve('include')}
                >
                  {t('computer_history_observe_include')}
                </button>
              </div>
              <p className={styles.segmentHint}>
                {observe === 'exclude' ? t('computer_history_observe_exclude_hint') : t('computer_history_observe_include_hint')}
              </p>
            </div>

            {scope === 'app' ? (
              <>
                <label className={styles.search}>
                  <Icon name="search" size={16} />
                  <input
                    data-storage-autofocus
                    autoFocus
                    autoComplete="off"
                    maxLength={256}
                    type="search"
                    aria-label={t('computer_history_target_app_placeholder')}
                    placeholder={t('computer_history_target_app_placeholder')}
                    value={appQuery}
                    disabled={busy}
                    onChange={event => { setAppQuery(event.target.value); setSelectedBundleId('') }}
                    onKeyDown={event => {
                      if (event.key !== 'Enter' || !firstPickableApp?.bundleId) return
                      event.preventDefault()
                      void submitRule(firstPickableApp.bundleId.toLowerCase())
                    }}
                  />
                </label>
                <div className={styles.appList} role="listbox" aria-label={t('computer_history_scope_app')} aria-busy={installed === null && !catalogError}>
                  {catalogError ? (
                    <div className={styles.pickerMessage} role="alert">{t('computer_use_app_picker_error')}</div>
                  ) : installed === null ? (
                    <div className={styles.pickerMessage} role="status">{t('loading')}</div>
                  ) : !filteredApps.length ? (
                    <div className={styles.pickerMessage}>{t('computer_use_app_no_matches')}</div>
                  ) : (
                    filteredApps.map(app => {
                      const bundleKey = app.bundleId?.toLowerCase() ?? ''
                      const alreadyAdded = !!bundleKey && existingAppTargets.has(bundleKey)
                      const disabled = busy || !bundleKey || alreadyAdded
                      return (
                        <button
                          type="button"
                          role="option"
                          key={app.path}
                          aria-selected={!!bundleKey && selectedBundleId === bundleKey}
                          disabled={disabled}
                          className={styles.appOption}
                          onClick={() => { if (bundleKey) setSelectedBundleId(bundleKey) }}
                        >
                          <span className={styles.ruleIcon} aria-hidden="true">
                            {app.iconDataUrl
                              ? <img src={app.iconDataUrl} width={32} height={32} alt="" />
                              : <Icon name="computer-use-pip" size={22} />}
                          </span>
                          <span className={styles.appText}>
                            <span className={styles.appName}>{app.name}</span>
                            <span className={styles.appSub}>
                              {bundleKey ? app.path : t('computer_history_app_unidentifiable')}
                            </span>
                          </span>
                          {app.running && <span className={styles.pillExclude}>{t('computer_use_app_running')}</span>}
                          {alreadyAdded && <span className={styles.pillExclude}>{t('computer_use_app_already_added')}</span>}
                        </button>
                      )
                    })
                  )}
                </div>
              </>
            ) : (
              <div className={styles.urlField}>
                <label className={styles.fieldLabel} htmlFor="computer-history-url-input">
                  {t('computer_history_target_label')}
                </label>
                <input
                  id="computer-history-url-input"
                  data-storage-autofocus
                  autoFocus
                  autoComplete="off"
                  maxLength={512}
                  className={styles.urlInput}
                  placeholder={t('computer_history_target_url_placeholder')}
                  value={urlDraft}
                  disabled={busy}
                  aria-invalid={urlInvalid || !!ruleError || undefined}
                  onChange={event => {
                    setUrlDraft(event.target.value)
                    setUrlTouched(true)
                    setRuleError('')
                  }}
                  onKeyDown={event => {
                    if (event.key !== 'Enter' || !normalizedUrl) return
                    event.preventDefault()
                    void submitRule(normalizedUrl)
                  }}
                />
                {normalizedUrl && (
                  <p className={styles.urlPreview}>
                    {t('computer_history_url_preview')
                      .replace('{domain}', normalizedUrl)
                      .replace('{example}', subdomainPreviewExample(normalizedUrl))}
                  </p>
                )}
                {(urlInvalid || ruleError) && (
                  <p className={styles.urlError} role="alert">
                    {ruleError || t('computer_history_target_error')}
                  </p>
                )}
              </div>
            )}
          </div>
        </StorageDialog>
      )}

      {/* Clear-entries modal */}
      {clearDialogOpen && (
        <StorageDialog
          title={t('computer_history_clear_title')}
          description={t('computer_history_clear_note')}
          returnFocusId="computer-history-clear-open"
          onClose={() => { if (!busy) setClearDialogOpen(false) }}
          dismissible={!busy}
          footer={
            <>
              <StorageButton disabled={busy} onClick={() => setClearDialogOpen(false)}>
                {t('cancel')}
              </StorageButton>
              <StorageButton danger busy={busy} disabled={busy} onClick={() => void confirmClear()}>
                {t('computer_history_clear_confirm')}
              </StorageButton>
            </>
          }
        >
          <div className={styles.clearChoices} role="radiogroup" aria-label={t('computer_history_clear_title')}>
            {([
              { id: 'last-hour', title: t('computer_history_clear_last_hour'), desc: t('computer_history_clear_last_hour_desc') },
              { id: 'last-day', title: t('computer_history_clear_last_day'), desc: t('computer_history_clear_last_day_desc') },
              { id: 'all', title: t('computer_history_clear_all'), desc: t('computer_history_clear_all_desc') },
            ] as const).map(choice => (
              <button
                type="button"
                role="radio"
                key={choice.id}
                aria-checked={clearChoice === choice.id}
                disabled={busy}
                className={styles.clearOption}
                onClick={() => setClearChoice(choice.id)}
              >
                <span className={styles.radioDot} aria-hidden="true" />
                <span className={styles.rowCopy}>
                  <span className={styles.rowTitle}>{choice.title}</span>
                  <span className={styles.rowDesc}>{choice.desc}</span>
                </span>
              </button>
            ))}
          </div>
        </StorageDialog>
      )}
    </SettingsPage>
  )
}
