// App update settings: two equal cards — the running version with its manual
// update action and automatic-download preference, and the release-notes entry.
// Every phase names itself in both the action and the explanation, and a
// failure keeps its own reason instead of being reported as unsupported.
//
// All update state comes from the one update store that the sidebar card and the
// installation overlay also read, so this page never invents a second update
// path. The developer debug log switch lives in Preferences: it is a diagnostics
// aid, not part of deciding whether to update.
import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { UPDATER_AUTO_DOWNLOAD_KEY, isUpdaterAutoDownloadEnabled } from '../../../../shared/updater-preferences'
import { desktopDistribution, desktopSiteUrl, loadDesktopDistribution, subscribeDesktopDistribution } from '../../app/distribution'
import { PrefToggleRow, SettingsPage, kvGet, kvSet } from './kv'
import { useUpdateSnapshot } from '../../app/update/components'
import { checkForUpdate, clearPostponedUpdate, downloadUpdate, installUpdate } from '../../app/update/store'
import { settingsActionFor, settingsHintFor, type SettingsHint } from '../../app/update/model'
import { logHostDiagnostic } from './settings-error-text'
import styles from './settings.module.css'

const w = () => window as any

const HINT_KEYS: Record<SettingsHint, string> = {
  action: 'update_action_hint',
  checking: 'update_checking_hint',
  available: 'update_available_hint',
  downloading: 'update_downloading_hint',
  ready: 'update_ready_hint',
  installing: 'update_installing_hint_short',
  unsupported: 'updates_unavailable',
  'check-unavailable': 'update_check_unavailable',
  'check-rejected': 'update_check_rejected',
  'download-failed': 'update_download_failed',
  'install-failed': 'update_install_failed',
}

export function AboutTab() {
  const t = useT()
  const [distribution, setDistribution] = useState(desktopDistribution)
  const { status, downloadRequested, installRequested } = useUpdateSnapshot()
  const [checkFailed, setCheckFailed] = useState(false)
  const [checking, setChecking] = useState(false)
  const [autoDownload, setAutoDownload] = useState(true)
  const [autoDownloadLoaded, setAutoDownloadLoaded] = useState(() => !w().settingsApi?.kv?.get)
  const [savingAutoDownload, setSavingAutoDownload] = useState(false)

  useEffect(() => {
    let cancelled = false
    const unsubscribe = subscribeDesktopDistribution(() => { if (!cancelled) setDistribution(desktopDistribution()) })
    void loadDesktopDistribution().then(value => { if (!cancelled) setDistribution(value) }).catch(() => {})
    return () => { cancelled = true; unsubscribe() }
  }, [])

  useEffect(() => {
    let live = true
    const readPref = () => {
      if (!w().settingsApi?.kv?.get) { setAutoDownloadLoaded(true); return }
      void kvGet(UPDATER_AUTO_DOWNLOAD_KEY)
        .then(raw => {
          if (!live) return
          setAutoDownload(isUpdaterAutoDownloadEnabled(raw))
          setAutoDownloadLoaded(true)
        })
        .catch(() => { if (live) setAutoDownloadLoaded(true) })
    }
    readPref()
    const unsubscribe = w().klaus?.on?.appPreferencesChanged?.((payload: { key?: string }) => {
      if (payload?.key === UPDATER_AUTO_DOWNLOAD_KEY) readPref()
    })
    return () => {
      live = false
      if (typeof unsubscribe === 'function') unsubscribe()
    }
  }, [])

  const check = useCallback(async () => {
    if (checking || downloadRequested || installRequested) return
    setCheckFailed(false)
    setChecking(true)
    try {
      await checkForUpdate()
    } catch (error) {
      logHostDiagnostic('about-update-check', error)
      setCheckFailed(true)
    } finally {
      setChecking(false)
    }
  }, [checking, downloadRequested, installRequested])

  const startDownload = useCallback(async () => {
    if (checking || downloadRequested || installRequested) return
    setCheckFailed(false)
    try {
      await downloadUpdate()
    } catch (error) {
      logHostDiagnostic('about-update-download', error)
      setCheckFailed(true)
    }
  }, [checking, downloadRequested, installRequested])

  const onToggleAutoDownload = useCallback(async (checked: boolean) => {
    if (savingAutoDownload) return
    const previous = autoDownload
    setAutoDownload(checked)
    if (checked) clearPostponedUpdate()
    if (!w().settingsApi?.kv?.set) return
    setSavingAutoDownload(true)
    try {
      const saved = await kvSet(UPDATER_AUTO_DOWNLOAD_KEY, checked ? 'on' : 'off')
      if (!saved) setAutoDownload(previous)
    } finally {
      setSavingAutoDownload(false)
    }
  }, [autoDownload, savingAutoDownload])

  const version = status?.currentVersion || ''
  const availableVersion = status?.availableVersion || ''
  const supported = status ? status.supported !== false : true
  const action = settingsActionFor(status, checking, installRequested, downloadRequested)
  const hint = settingsHintFor(status, checkFailed)
  const busy = action === 'checking' || action === 'downloading' || action === 'installing'

  const openChangelog = useCallback(() => {
    void w().klausOpenExternalUrl?.(desktopSiteUrl('/updates', distribution))
  }, [distribution])

  const actionLabel = action === 'install' ? t('update_restart')
    : action === 'installing' ? t('update_preparing')
      : action === 'available' ? t('update_download_action')
        : action === 'downloading' ? t('update_header_downloading')
          : action === 'checking' ? t('update_header_checking')
            : t('about_check_for_updates')

  const buttonId = action === 'install' || action === 'installing'
    ? 'about-install-update'
    : action === 'available'
      ? 'about-download-update'
      : 'about-check-update'

  const hintText = hint === 'available' && availableVersion
    ? t('update_available_hint_version').split('{version}').join(availableVersion)
    : hint === 'action' && !autoDownload
      ? t('update_action_manual_hint')
      : t(HINT_KEYS[hint])

  return (
    <SettingsPage title={t('update_page_title')} subtitle={t('update_page_subtitle')}>
      <div className={`settings-card ${styles['about-card']}`}>
        <div className={styles['about-version-row']}>
          <div className={styles['about-version-main']}>
            <span className={styles['about-version-name']}>{t('update_current_version')}</span>
            <span className={styles['about-version-number']}>{version || distribution.productName}</span>
          </div>
          <div className={styles['about-version-actions']}>
            <button
              type="button"
              className={action === 'install' || action === 'available' ? 'btn-sm btn-primary' : 'btn-sm'}
              id={buttonId}
              disabled={busy || !supported}
              aria-busy={busy}
              onClick={() => {
                if (action === 'install') void installUpdate()
                else if (action === 'available') void startDownload()
                else void check()
              }}
            >{actionLabel}</button>
          </div>
        </div>
        <div
          className={styles['about-status']} role="status"
          data-state={status?.state ?? 'idle'} data-supported={supported ? '1' : '0'} data-hint={hint}
        >
          {hintText}
        </div>
        <PrefToggleRow
          id="about-auto-download"
          label={t('update_auto_download')}
          desc={t('update_auto_download_desc')}
          checked={autoDownload}
          disabled={!supported || !autoDownloadLoaded || savingAutoDownload}
          onChange={checked => { void onToggleAutoDownload(checked) }}
        />
      </div>

      <div className={`settings-card ${styles['about-card']}`}>
        <div className={styles['about-version-row']}>
          <div className={styles['about-version-main']}>
            <span className={styles['about-version-name']}>{t('about_changelog_link')}</span>
          </div>
          <div className={styles['about-version-actions']}>
            <button type="button" className="btn-sm" id="about-open-changelog" onClick={openChangelog}>
              {t('about_changelog_link')}
            </button>
          </div>
        </div>
        <div className={styles['about-status']}>{t('update_changelog_hint')}</div>
      </div>
    </SettingsPage>
  )
}
