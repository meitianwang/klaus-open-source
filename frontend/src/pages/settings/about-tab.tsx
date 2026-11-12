// App update settings: two equal cards — the running version with its manual
// update action, and the release-notes entry. Every phase names itself in both
// the action and the explanation, and a failure keeps its own reason instead of
// being reported as an unsupported installation.
//
// All update state comes from the one update store that the sidebar card and the
// modal surfaces also read, so this page never invents a second update path. The
// developer debug log switch lives in Preferences: it is a diagnostics aid, not
// part of deciding whether to update.
import { useCallback, useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { desktopDistribution, desktopSiteUrl, loadDesktopDistribution, subscribeDesktopDistribution } from '../../app/distribution'
import { SettingsPage } from './kv'
import { useUpdateSnapshot } from '../../app/update/components'
import { checkForUpdate, installUpdate } from '../../app/update/store'
import { settingsActionFor, settingsHintFor, type SettingsHint } from '../../app/update/model'
import { logHostDiagnostic } from './settings-error-text'
import styles from './settings.module.css'

const w = () => window as any

const HINT_KEYS: Record<SettingsHint, string> = {
  action: 'update_action_hint',
  checking: 'update_checking_hint',
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
  const { status, installRequested } = useUpdateSnapshot()
  const [checkFailed, setCheckFailed] = useState(false)
  const [checking, setChecking] = useState(false)

  useEffect(() => {
    let cancelled = false
    const unsubscribe = subscribeDesktopDistribution(() => { if (!cancelled) setDistribution(desktopDistribution()) })
    void loadDesktopDistribution().then(value => { if (!cancelled) setDistribution(value) }).catch(() => {})
    return () => { cancelled = true; unsubscribe() }
  }, [])

  const check = useCallback(async () => {
    if (checking || installRequested) return
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
  }, [checking, installRequested])

  const version = status?.currentVersion || ''
  const supported = status ? status.supported !== false : true
  const action = settingsActionFor(status, checking, installRequested)
  const hint = settingsHintFor(status, checkFailed)
  const busy = action === 'checking' || action === 'downloading' || action === 'installing'

  const openChangelog = useCallback(() => {
    void w().klausOpenExternalUrl?.(desktopSiteUrl('/updates', distribution))
  }, [distribution])

  const actionLabel = action === 'install' ? t('update_restart')
    : action === 'installing' ? t('update_preparing')
      : action === 'downloading' ? t('update_header_downloading')
        : action === 'checking' ? t('update_header_checking')
          : t('about_check_for_updates')

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
              className={action === 'install' ? 'btn-sm btn-primary' : 'btn-sm'}
              id={action === 'install' || action === 'installing' ? 'about-install-update' : 'about-check-update'}
              disabled={busy || !supported}
              aria-busy={busy}
              onClick={() => { if (action === 'install') void installUpdate(); else void check() }}
            >{actionLabel}</button>
          </div>
        </div>
        <div
          className={styles['about-status']} role="status"
          data-state={status?.state ?? 'idle'} data-supported={supported ? '1' : '0'} data-hint={hint}
        >
          {t(HINT_KEYS[hint])}
        </div>
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