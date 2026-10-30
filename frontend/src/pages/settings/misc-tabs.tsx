// 系统授权 tab（迁自 js/settings.js 的 loadSystemAuthTab + showRestartPrompt）。
// 类名与旧版逐一对应。Workspace 排除规则已并入偏好设置（prefs-tabs.tsx）。
import { useCallback, useEffect, useState } from 'react'
import { useSettingsSnapshot } from './settings-snapshot'
import { useT } from '../../i18n'
import { rawIconHtml } from '../../components/Icon'
import { SettingsPage } from './kv'
import styles from './settings.module.css'

const w = () => window as any

function Raw({ name }: { name: string }) {
  return <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: rawIconHtml(name) }} />
}

// ---- 系统授权（macOS TCC 面板） ----

const SYSTEM_AUTH_ITEMS = [
  { key: 'fullDiskAccess', i18nTitle: 'sys_auth_full_disk', i18nDesc: 'sys_auth_full_disk_desc' },
  { key: 'photosLibrary', i18nTitle: 'sys_auth_photos', i18nDesc: 'sys_auth_photos_desc' },
  { key: 'screenRecording', i18nTitle: 'sys_auth_screen', i18nDesc: 'sys_auth_screen_desc' },
  { key: 'accessibility', i18nTitle: 'sys_auth_accessibility', i18nDesc: 'sys_auth_accessibility_desc' },
  { key: 'automation', i18nTitle: 'sys_auth_automation', i18nDesc: 'sys_auth_automation_desc' },
  { key: 'notification', i18nTitle: 'sys_auth_notification', i18nDesc: 'sys_auth_notification_desc' },
  { key: 'location', i18nTitle: 'sys_auth_location', i18nDesc: 'sys_auth_location_desc' },
]

/** Domains whose consent Klaus can request in-app through the host; the rest only open a settings pane. */
export const REQUESTABLE_SYSTEM_PERMISSIONS = ['notification', 'photosLibrary', 'automation']

type SysAuthState =
  | { kind: 'loading' }
  | { kind: 'unsupported' }
  | { kind: 'ready'; perms: Record<string, string> }

export function SystemAuthTab() {
  const t = useT()
  const [state, , beginStateRead] = useSettingsSnapshot<SysAuthState>('system-auth:state', { kind: 'loading' })
  const [loadError, setLoadError] = useState('')
  const [busyKey, setBusyKey] = useState('')

  const refresh = useCallback(async () => {
    const publish = beginStateRead()
    setLoadError('')
    let result
    try {
      result = await w().klaus.systemPermissions.check()
    } catch (err: any) {
      if (publish(current => current)) setLoadError(String(err?.message || err))
      return
    }
    if (!result?.supported) {
      publish({ kind: 'unsupported' })
      return
    }
    const perms = { ...(result.permissions || {}) }
    publish({ kind: 'ready', perms })
  }, [beginStateRead])

  useEffect(() => { void refresh() }, [refresh])

  const manualRefresh = async () => {
    if (busyKey) return
    setBusyKey('refresh')
    try { await refresh() } finally { setBusyKey('') }
  }

  const grant = async (type: string) => {
    if (busyKey) return
    setBusyKey(type)
    try {
      if (REQUESTABLE_SYSTEM_PERMISSIONS.includes(type)) {
        // Ask the system for consent in-app; the host presents the dialog and answers
        // with the recorded status, so the refreshed row reflects it without a relaunch.
        const res = await w().klaus.systemPermissions.request(type)
        if (!res?.ok) throw new Error(res?.error || t('settings_failed'))
        await refresh()
        if (res.status === 'granted') return
        if (res.status !== 'denied') throw new Error(t('sys_auth_request_unavailable'))
      }
      const res = await w().klaus.systemPermissions.openSettings(type)
      if (!res?.ok) throw new Error(res?.error || t('settings_failed'))
      // macOS caches TCC decisions for a running process. A relaunch is needed
      // before a newly granted permission can be observed by Klaus.
      w().showRestartPrompt()
    } catch (error: any) {
      w().showToast(error?.message || t('settings_failed'))
    } finally {
      setBusyKey('')
    }
  }

  return (
    <SettingsPage title={t('sys_auth_title')} subtitle={t('sys_auth_subtitle')}>
      <div className={styles['sys-auth-card']} id="sys-auth-list" aria-busy={Boolean(busyKey)}>
        {state.kind === 'loading' && !loadError && <div className={styles['sys-auth-loading']}>{t('loading')}</div>}
        {loadError && (
          <div className={styles['sys-auth-empty']} role="alert">
            <span>{loadError}</span>
            <button type="button" className="btn-sm" disabled={Boolean(busyKey)} onClick={() => { void manualRefresh() }}>{t('auth_status_retry')}</button>
          </div>
        )}
        {state.kind === 'unsupported' && <div className={styles['sys-auth-empty']}>{t('sys_auth_macos_only')}</div>}
        {state.kind === 'ready' && SYSTEM_AUTH_ITEMS.map((item, idx) => {
          const status = state.perms[item.key] || 'unknown'
          const granted = status === 'granted'
          const badgeCls = granted ? `${styles['sys-auth-badge']} granted` : (status === 'denied' ? `${styles['sys-auth-badge']} denied` : `${styles['sys-auth-badge']} unknown`)
          const badgeText = granted ? t('sys_auth_granted') : (status === 'denied' ? t('sys_auth_denied') : t('sys_auth_unknown'))
          return (
            <div className={`${styles['sys-auth-row']} ${granted ? styles['is-granted'] : ''}`} {...(idx === 0 ? {} : { 'data-sep': '1' })} key={item.key}>
              <div className={styles['sys-auth-row-icon']}><Raw name={granted ? 'sys-auth-shield-ok' : 'sys-auth-shield-warn'} /></div>
              <div className={styles['sys-auth-row-main']}>
                <div className={styles['sys-auth-row-head']}>
                  <span className={styles['sys-auth-row-title']}>{t(item.i18nTitle)}</span>
                  <span className={badgeCls}>{badgeText}</span>
                </div>
                <div className={styles['sys-auth-row-desc']}>{t(item.i18nDesc)}</div>
              </div>
              <div className={styles['sys-auth-row-action']}>
                {!granted && (
                  <button
                    type="button" className="btn-sm" data-sys-grant={item.key} disabled={Boolean(busyKey)}
                    aria-label={`${t('sys_auth_grant_btn')}: ${t(item.i18nTitle)}`}
                    onClick={() => { void grant(item.key) }}
                  >{t(busyKey === item.key ? 'sys_auth_requesting' : 'sys_auth_grant_btn')}</button>
                )}
              </div>
            </div>
          )
        })}
      </div>
      <div className={styles['sys-auth-footer']}>
        <span className={styles['sys-auth-hint']}>{t('sys_auth_restart_hint')}</span>
        <button type="button" className="btn-sm" id="sys-auth-refresh" disabled={Boolean(busyKey)} onClick={() => { void manualRefresh() }}>{t('sys_auth_refresh')}</button>
      </div>
    </SettingsPage>
  )
}
