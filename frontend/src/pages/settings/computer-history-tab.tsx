import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { useT } from '../../i18n'
import { showToast } from '../../app/ui-shared'
import { SettingsPage } from './kv'
import { StorageButton, StorageDialog } from './storage-dialog'
import { entryDomain, entrySource, formatEntryTime, parseEntriesPayload, parseHistorySnapshot,
  type HistoryEntry, type HistorySnapshot } from './computer-history-model'
import styles from './computer-use.module.css'

const api = () => (window as any).settingsApi.computerHistory

export function ComputerHistorySettingsTab() {
  const t = useT()
  const [snapshot, setSnapshot] = useState<HistorySnapshot | null>(null)
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [scope, setScope] = useState<'app' | 'url'>('app')
  const [observe, setObserve] = useState<'include' | 'exclude'>('exclude')
  const [target, setTarget] = useState('')
  const [targetError, setTargetError] = useState(false)
  const [clearInterval, setClearInterval] = useState<'all' | 'last-day' | 'last-hour' | null>(null)
  const [timeline, setTimeline] = useState<HistoryEntry[] | null>(null)
  const [timelineError, setTimelineError] = useState(false)
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])

  const load = useCallback(async () => {
    setError(false)
    try {
      const next = parseHistorySnapshot(await api().get())
      if (alive.current) setSnapshot(next)
      return next
    } catch { if (alive.current) setError(true); return null }
  }, [])
  useEffect(() => { void load() }, [load])

  const guarded = async (run: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true)
    try { await run() } finally { if (alive.current) setBusy(false) }
  }
  const report = (result: any, fallback: string) => {
    if (result?.ok === false) { showToast(result.error || fallback); return false }
    return true
  }

  const toggle = async (enabled: boolean) => guarded(async () => {
    const result = await api().setEnabled(enabled).catch((err: any) => ({ ok: false, error: err?.message || String(err) }))
    if (!report(result, t('settings_failed'))) return
    showToast(enabled ? t('computer_history_started_toast') : t('computer_history_stopped_toast'), { tone: 'success' })
    await load()
  })
  const pauseResume = async (pause: boolean) => guarded(async () => {
    const result = await (pause ? api().pause() : api().resume()).catch((err: any) => ({ ok: false, error: err?.message || String(err) }))
    if (!report(result, t('settings_failed'))) return
    await load()
  })
  const addEntry = async () => {
    const value = target.trim()
    if (!value || busy) return
    setTargetError(false)
    await guarded(async () => {
      try {
        const result = await api().updateObservation({ observe, scope, target: value })
        if (!alive.current) return
        const next = snapshot ? { ...snapshot, settings: { ...snapshot.settings, policy: result?.policy ?? snapshot.settings.policy } } : null
        if (next) setSnapshot(next)
        setTarget('')
        showToast(t('computer_history_policy_added'), { tone: 'success' })
      } catch { if (alive.current) setTargetError(true) }
    })
  }
  const removeEntry = async (entryScope: 'app' | 'url', entryTarget: string) => guarded(async () => {
    try {
      const result = await api().removeObservationEntry(entryScope, entryTarget)
      if (!alive.current) return
      if (snapshot) setSnapshot({ ...snapshot, settings: { ...snapshot.settings, policy: result?.policy ?? snapshot.settings.policy } })
    } catch { showToast(t('settings_failed')) }
  })
  const clearHistory = async () => {
    const interval = clearInterval
    if (!interval) return
    setClearInterval(null)
    await guarded(async () => {
      try {
        const result = await api().clearHistory(interval)
        if (!alive.current) return
        if (result && typeof result.removed === 'number') showToast(t('computer_history_cleared').replace('{count}', String(result.removed)), { tone: 'success' })
        setTimeline(null)
        await load()
      } catch { showToast(t('settings_failed')) }
    })
  }
  const loadTimeline = async (more: boolean) => {
    setTimelineError(false)
    try {
      const before = more && timeline?.length ? timeline[0]!.at : undefined
      const result = parseEntriesPayload(await api().entries(200, before))
      if (!alive.current) return
      setTimeline(previous => more && previous ? [...result, ...previous] : result)
    } catch { if (alive.current) setTimelineError(true) }
  }

  if (error) {
    return <SettingsPage title={t('computer_history_title')} subtitle={t('computer_history_settings_desc')}>
      <div className={styles.message} role="alert">{t('computer_history_load_error')} <StorageButton onClick={() => void load()}>{t('computer_use_retry')}</StorageButton></div>
    </SettingsPage>
  }
  const status = snapshot?.status, settings = snapshot?.settings
  const managedBlocked = status?.managedDisabled === true || settings?.managedDisabled === true
  const running = status?.state === 'running'
  const policy = settings?.policy ?? []
  return <SettingsPage title={t('computer_history_title')} subtitle={t('computer_history_settings_desc')}>
    <section aria-labelledby="computer-history-switch-title" className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 id="computer-history-switch-title" tabIndex={-1}>{t('computer_history_capture_title')}</h2>
      </div>
      <div className={styles.card} aria-busy={snapshot === null}>
        {snapshot === null ? <div className={styles.message} role="status">{t('loading')}</div>
          : <>
            <div className={styles.row}>
              <span className={styles.name}>{settings?.enabled
                ? running ? t('computer_history_state_running') : status?.state === 'paused' ? t('computer_history_state_paused') : t('computer_history_state_stopped')
                : t('computer_history_state_stopped')}</span>
              {status?.entryCount !== undefined && <span className={styles.badge}>{t('computer_history_entry_count').replace('{count}', String(status.entryCount))}</span>}
            </div>
            {managedBlocked && <div className={styles.message} role="status">{t('computer_history_managed_blocked')}</div>}
            {status?.unavailableReason && <div className={styles.message} role="alert">{t('computer_history_unavailable').replace('{reason}', status.unavailableReason)}</div>}
            <p className={styles.appPath}>{t('computer_history_retention_note')}</p>
            <div className={styles.row}>
              <StorageButton disabled={busy || managedBlocked || settings?.enabled === true}
                onClick={() => void toggle(true)}>{t('computer_history_enable')}</StorageButton>
              <StorageButton disabled={busy || settings?.enabled !== true}
                onClick={() => void toggle(false)}>{t('computer_history_disable')}</StorageButton>
              {settings?.enabled === true && (running
                ? <StorageButton disabled={busy} onClick={() => void pauseResume(true)}>{t('computer_history_pause')}</StorageButton>
                : status?.state === 'paused'
                  ? <StorageButton disabled={busy || managedBlocked} onClick={() => void pauseResume(false)}>{t('computer_history_resume')}</StorageButton>
                  : null)}
            </div>
          </>}
      </div>
    </section>

    <section aria-labelledby="computer-history-policy-title" className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 id="computer-history-policy-title" tabIndex={-1}>{t('computer_history_policy_title')}</h2>
      </div>
      <div className={styles.card}>
        <p className={styles.appPath}>{t('computer_history_policy_desc')}</p>
        {!policy.length && <div className={styles.message}>{t('computer_history_policy_empty')}</div>}
        {policy.map(entry => <div className={styles.row} key={`${entry.scope}:${entry.target}`}>
          <span className={styles.icon} aria-hidden="true"><Icon name={entry.scope === 'app' ? 'computer-use-pip' : 'browser'} size={20} /></span>
          <span className={styles.name}>{entry.target}</span>
          <span className={styles.badge}>{entry.observe === 'include' ? t('computer_history_observe_include') : t('computer_history_observe_exclude')}</span>
          <button type="button" className={styles.remove} disabled={busy}
            aria-label={t('computer_history_remove').replace('{target}', entry.target)}
            onClick={() => void removeEntry(entry.scope, entry.target)}><Icon name="trash" size={18} /></button>
        </div>)}
        <form className={styles.addForm} onSubmit={event => { event.preventDefault(); void addEntry() }}>
          <label htmlFor="computer-history-observe">{t('computer_history_observe_label')}</label>
          <select id="computer-history-observe" value={observe} disabled={busy}
            onChange={event => setObserve(event.target.value as 'include' | 'exclude')}>
            <option value="exclude">{t('computer_history_observe_exclude')}</option>
            <option value="include">{t('computer_history_observe_include')}</option>
          </select>
          <label htmlFor="computer-history-scope">{t('computer_history_scope_label')}</label>
          <select id="computer-history-scope" value={scope} disabled={busy}
            onChange={event => { setScope(event.target.value as 'app' | 'url'); setTargetError(false) }}>
            <option value="app">{t('computer_history_scope_app')}</option>
            <option value="url">{t('computer_history_scope_url')}</option>
          </select>
          <label htmlFor="computer-history-target">{t('computer_history_target_label')}</label>
          <input id="computer-history-target" autoComplete="off" maxLength={256} value={target} disabled={busy}
            placeholder={scope === 'app' ? t('computer_history_target_app_placeholder') : t('computer_history_target_url_placeholder')}
            aria-invalid={targetError || undefined}
            onChange={event => { setTarget(event.target.value); setTargetError(false) }} />
          {targetError && <p role="alert">{t('computer_history_target_error')}</p>}
          <StorageButton disabled={busy || !target.trim()} onClick={() => void addEntry()}>{t('computer_history_add')}</StorageButton>
        </form>
      </div>
    </section>

    <section aria-labelledby="computer-history-data-title" className={styles.section}>
      <div className={styles.sectionHeader}>
        <h2 id="computer-history-data-title" tabIndex={-1}>{t('computer_history_data_title')}</h2>
      </div>
      <div className={styles.card}>
        <div className={styles.row}>
          <StorageButton disabled={busy} onClick={() => setTimeline(timeline === null ? [] : null)}>
            {timeline === null ? t('computer_history_show_timeline') : t('computer_history_hide_timeline')}</StorageButton>
          <StorageButton disabled={busy} onClick={() => setClearInterval('last-hour')}>{t('computer_history_clear_last_hour')}</StorageButton>
          <StorageButton disabled={busy} onClick={() => setClearInterval('last-day')}>{t('computer_history_clear_last_day')}</StorageButton>
          <StorageButton danger disabled={busy} onClick={() => setClearInterval('all')}>{t('computer_history_clear_all')}</StorageButton>
        </div>
        {timeline !== null && <>
          {timelineError && <div className={styles.message} role="alert">{t('computer_history_timeline_error')}</div>}
          {timeline.length === 0 && !timelineError && <div className={styles.message}>{t('computer_history_timeline_empty')}</div>}
          {timeline.map((entry, index) => {
            const domain = entryDomain(entry)
            return <div className={styles.row} key={`${entry.at}-${index}`}>
              <span className={styles.badge}>{formatEntryTime(entry.at)}</span>
              <span className={styles.name}>{entrySource(entry)}{entry.kind === 'app' ? ` ${t('computer_history_activated_suffix')}` : entry.title ? ` — ${entry.title}` : ''}{domain ? ` (${domain})` : ''}</span>
            </div>
          })}
          {timeline.length > 0 && <StorageButton disabled={busy} onClick={() => void loadTimeline(true)}>{t('computer_history_load_more')}</StorageButton>}
        </>}
      </div>
    </section>

    {clearInterval && <StorageDialog title={t('computer_history_clear_title')}
      description={clearInterval === 'all' ? t('computer_history_clear_all_desc')
        : clearInterval === 'last-day' ? t('computer_history_clear_last_day_desc') : t('computer_history_clear_last_hour_desc')}
      onClose={() => { if (!busy) setClearInterval(null) }} dismissible={!busy}
      footer={<><StorageButton autoFocus disabled={busy} onClick={() => setClearInterval(null)}>{t('cancel')}</StorageButton>
        <StorageButton danger busy={busy} disabled={busy} onClick={() => void clearHistory()}>{t('computer_history_clear_confirm')}</StorageButton></>}>
      <p>{t('computer_history_clear_note')}</p>
    </StorageDialog>}
    <TimelineLoader open={timeline !== null && timeline.length === 0 && !timelineError} onLoad={() => void loadTimeline(false)} />
  </SettingsPage>
}

/** First timeline open loads the newest page once. */
function TimelineLoader({ open, onLoad }: { open: boolean; onLoad: () => void }) {
  const fired = useRef(false)
  useEffect(() => {
    if (open && !fired.current) { fired.current = true; onLoad() }
    if (!open) fired.current = false
  }, [open, onLoad])
  return null
}
