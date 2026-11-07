// About settings tab: running version and manual update control (check now /
// restart to install) for users who do not want to wait for the background
// auto-update, plus the developer debug log switch. The full changelog lives
// on the web /updates page; this tab links out instead of compiling release
// notes into the bundle. All update state rides the existing updater:status /
// updater:check / updater:install channels — the same ones the sidebar and
// titlebar pills consume — so this page never invents a second update path.
import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { desktopDistribution, desktopSiteUrl, loadDesktopDistribution, subscribeDesktopDistribution } from '../../app/distribution'
import { PrefToggleRow, SettingsPage, boolChecked, kvGet, kvSet } from './kv'
import { useSettingsSnapshot } from './settings-snapshot'
import { settingsErrorText } from './settings-error-text'
import styles from './settings.module.css'

const w = () => window as any

interface UpdaterStatus {
  supported?: boolean
  state?: 'idle' | 'checking' | 'downloading' | 'downloaded' | 'error'
  currentVersion?: string
  availableVersion?: string | null
  error?: string | null
}

type UpdaterApi = {
  status?: () => Promise<UpdaterStatus>
  check?: () => Promise<UpdaterStatus>
  install?: () => Promise<{ ok?: boolean; error?: string }>
}

function updaterApi(): UpdaterApi | undefined {
  return (w().klaus as { updater?: UpdaterApi } | undefined)?.updater
}

export function AboutTab() {
  const t = useT()
  const [distribution, setDistribution] = useState(desktopDistribution)
  const [status, setStatus, beginStatusRead] = useSettingsSnapshot<UpdaterStatus | null>('about:updater', null)
  const [checkError, setCheckError] = useState('')
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  // Developer debug log lives here, not on a runtime page: it is a diagnostics
  // aid for problem reports, not a knob users decide on day to day.
  const [traceOn, setTraceOn, beginTraceRead] = useSettingsSnapshot<boolean | null>('about:provider-trace', null)
  const [traceError, setTraceError] = useState('')
  const [traceSaving, setTraceSaving] = useState(false)

  useEffect(() => {
    let cancelled = false
    const unsubscribe = subscribeDesktopDistribution(() => { if (!cancelled) setDistribution(desktopDistribution()) })
    void loadDesktopDistribution().then(value => { if (!cancelled) setDistribution(value) }).catch(() => {})
    return () => { cancelled = true; unsubscribe() }
  }, [])

  const loadTrace = useCallback(() => {
    const publish = beginTraceRead()
    setTraceError('')
    void kvGet('klaus.providerTrace')
      .then(raw => { publish(boolChecked(raw, false)) })
      .catch((error: unknown) => { if (publish(current => current)) setTraceError(settingsErrorText('about-trace', error, 'about_trace_load_failed')) })
  }, [beginTraceRead])
  useEffect(() => { loadTrace() }, [loadTrace])

  const toggleTrace = useCallback(async (checked: boolean) => {
    if (traceSaving) return
    const previous = traceOn
    setTraceSaving(true)
    setTraceOn(checked)
    try {
      const saved = await kvSet('klaus.providerTrace', checked ? 'on' : 'off')
      if (!saved) setTraceOn(previous)
    } finally {
      setTraceSaving(false)
    }
  }, [traceOn, traceSaving, setTraceOn])

  useEffect(() => {
    let cancelled = false
    const publish = beginStatusRead()
    updaterApi()?.status?.()
      .then(next => { if (!cancelled) publish(next ?? null) })
      .catch(() => {})
    const unsubscribe = w().klaus?.on?.updaterStatus?.((next: UpdaterStatus | null) => {
      setChecking(false)
      setCheckError('')
      setStatus(next ?? null)
    })
    return () => { cancelled = true; unsubscribe?.() }
  }, [beginStatusRead, setStatus])

  const checkForUpdates = useCallback(async () => {
    const api = updaterApi()
    if (!api?.check || checking || installing) return
    setStatus(current => current)
    setCheckError('')
    setChecking(true)
    try {
      const next = await api.check()
      setStatus(next ?? null)
    } catch (error: any) {
      setCheckError(settingsErrorText('about-update-check', error, 'update_check_failed'))
    } finally {
      setChecking(false)
    }
  }, [checking, installing, setStatus])

  const installUpdate = useCallback(async () => {
    const api = updaterApi()
    if (!api?.install || installing || checking) return
    setInstalling(true)
    try {
      const result = await api.install()
      if (result && result.ok === false) {
        w().showToast(result.error === 'update_install_modified_app' ? t('update_install_modified_app') : t('update_install_failed'))
        setInstalling(false)
      }
      // A successful install relaunches the app; nothing to reset.
    } catch (error: any) {
      w().showToast(settingsErrorText('about-update-install', error, 'update_install_failed'))
      setInstalling(false)
    }
  }, [checking, installing, t])

  const version = status?.currentVersion || ''
  const state = status?.state ?? 'idle'
  const supported = status ? status.supported !== false : true
  const availableVersion = status?.availableVersion || ''
  const downloaded = state === 'downloaded' && Boolean(availableVersion)
  const busy = checking || state === 'checking' || state === 'downloading'

  const openChangelog = useCallback(() => {
    void w().klausOpenExternalUrl?.(desktopSiteUrl('/updates', distribution))
  }, [distribution])

  const statusLine = (() => {
    if (checkError) return t('update_unavailable_notice').replace('{reason}', checkError)
    if (!supported) {
      return t('update_unavailable_notice').replace('{reason}', t('updates_unavailable'))
    }
    if (state === 'checking') return t('update_header_checking')
    if (state === 'downloading') return t('update_header_downloading')
    if (downloaded) return t('update_ready').replace('{v}', availableVersion)
    if (state === 'error' && status?.error) return t('update_unavailable_notice').replace('{reason}', t('updates_unavailable'))
    return t('about_up_to_date')
  })()

  return (
    <SettingsPage title={t('about_title')} subtitle={t('about_subtitle')}>
      <div className={`settings-card ${styles['about-card']}`}>
        <div className={styles['about-version-row']}>
          <div className={styles['about-version-main']}>
            <span className={styles['about-version-name']}>{distribution.productName}</span>
            {version && <span className={styles['about-version-number']}>{version}</span>}
          </div>
          <div className={styles['about-version-actions']}>
            {downloaded ? (
              <button
                type="button" className="btn-sm btn-primary" id="about-install-update"
                disabled={installing} aria-busy={installing}
                onClick={() => { void installUpdate() }}
              >{installing ? t('update_preparing') : t('update_restart')}</button>
            ) : (
              <button
                type="button" className="btn-sm" id="about-check-update"
                disabled={busy || !supported} aria-busy={busy}
                onClick={() => { void checkForUpdates() }}
              >{busy ? t('update_header_checking') : t('about_check_for_updates')}</button>
            )}
          </div>
        </div>
        <div className={styles['about-status']} role="status" data-state={state} data-supported={supported ? '1' : '0'}>
          {statusLine}
        </div>
      </div>

      {traceError && <div className="empty-text" role="alert">{traceError}{' '}
        <button type="button" className="btn-sm" onClick={loadTrace}>{t('auth_status_retry')}</button></div>}
      {traceOn !== null && (
        <div className={styles['pref-card']}>
          <PrefToggleRow
            id="klaus-provider-trace" label={t('klaus_provider_trace')} desc={t('klaus_provider_trace_desc')}
            checked={traceOn} disabled={traceSaving}
            onChange={(checked) => { void toggleTrace(checked) }}
          />
        </div>
      )}

      <button
        type="button" className={styles['about-changelog-link']} id="about-open-changelog"
        onClick={openChangelog}
      >
        <span>{t('about_changelog_link')}</span>
        <svg className={styles['about-changelog-link-icon']} viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false">
          <path d="M216,104a8,8,0,0,1-16,0V107.31L125.66,181.66a8,8,0,0,1-11.32-11.32L188.69,96H152a8,8,0,0,1,0-16h56a8,8,0,0,1,8,8ZM192,152a8,8,0,0,0-8,8v40a8,8,0,0,1-8,8H56a8,8,0,0,1-8-8V80a8,8,0,0,1,8-8h40a8,8,0,0,1,0,16H64V192H176V160A8,8,0,0,0,192,152Z" />
        </svg>
      </button>
    </SettingsPage>
  )
}
