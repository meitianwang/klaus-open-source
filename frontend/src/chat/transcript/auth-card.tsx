// The auth-required card keeps every subscription source actionable after a
// credential failure. Sources with device flows open their model settings;
// Claude keeps its direct login action. The card stays in the transcript column.
// Which copy and which action each source gets lives in auth-card-copy.ts, so the
// mapping is testable without a DOM.
import { useRef, useState } from 'react'
import { useT } from '../../i18n'
import { rawIconHtml } from '../../components/Icon'
import { RawHtml } from '../../components/RawHtml'
import { activateModelSource } from '../../pages/settings/model-shared'
import { authCardCopy } from './auth-card-copy'
import styles from '../chat.module.css'

const w = () => window as any

export function AuthRequiredCard({ reason, mode }: { reason?: string; mode?: string }) {
  const t = useT()
  const copy = authCardCopy(mode, reason)
  const [primaryLabel, setPrimaryLabel] = useState<string | null>(null)
  const [primaryDisabled, setPrimaryDisabled] = useState(false)
  const [status, setStatus] = useState('')
  const busyRef = useRef(false)

  const icon = copy.action === 'login' || copy.action === 'device-flow'
    ? rawIconHtml('chat-append-auth-required')
    : rawIconHtml('chat-append-auth-required-2')
  const title = t(copy.titleKey)
  const hint = t(copy.hintKey)
  const defaultPrimary = t(copy.primaryKey)
  const secondaryLabel = t(copy.secondaryKey)

  const openProviderSettings = () => {
    if (typeof w().openModelSettings === 'function') {
      w().openModelSettings(mode)
      return
    }
    if (mode && typeof w().setModelSettingsCategory === 'function') w().setModelSettingsCategory(mode)
    const settingsActive = document.getElementById('settings-view')?.classList.contains('active')
    if (!settingsActive) {
      if (typeof w().openSettings === 'function') w().openSettings('models')
      else if (typeof w().toggleSettings === 'function') w().toggleSettings('models')
    } else if (typeof w().loadSettingsTab === 'function') {
      w().loadSettingsTab('models')
    }
  }

  const onPrimary = async () => {
    if (busyRef.current) return
    if (copy.action === 'login') {
      busyRef.current = true
      setPrimaryDisabled(true)
      setPrimaryLabel(t('auth_opening_browser'))
      setStatus(t('auth_wait_browser'))
      try {
        const res = await w().klaus.auth.login()
        if (res?.ok) {
          setPrimaryLabel(t('auth_success'))
          setStatus(t('auth_please_resend'))
        } else {
          setPrimaryDisabled(false)
          setPrimaryLabel(t('auth_retry_login'))
          setStatus(t('auth_login_failed_prefix') + (res?.error || t('auth_unknown_error')))
        }
      } catch (err: any) {
        setPrimaryDisabled(false)
        setPrimaryLabel(t('auth_retry_login'))
        setStatus(t('auth_login_failed_prefix') + (err?.message || String(err)))
      } finally {
        busyRef.current = false
      }
    } else if (copy.action === 'device-flow') {
      busyRef.current = true
      setPrimaryDisabled(true)
      setPrimaryLabel(t('auth_opening_browser'))
      setStatus(t('codex_auth_opening'))
      try {
        const flow = await w().klaus.codexAuth.start()
        if (!flow?.ok) {
          setPrimaryDisabled(false)
          setPrimaryLabel(t('auth_retry_login'))
          setStatus(t('auth_login_failed_prefix') + (flow?.error || t('auth_unknown_error')))
          return
        }
        setStatus(`${t('codex_auth_code')} ${flow.userCode}`)
        const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
        while (Date.now() < flow.expiresAt) {
          await wait(Math.max(2, flow.interval || 5) * 1000)
          const res = await w().klaus.codexAuth.poll(flow.deviceCode)
          if (res?.ok) {
            setPrimaryLabel(t('auth_success'))
            setStatus(t('auth_please_resend'))
            window.dispatchEvent(new Event('klaus:auth-mode-changed'))
            return
          }
          if (res?.pending) continue
          setPrimaryDisabled(false)
          setPrimaryLabel(t('auth_retry_login'))
          setStatus(t('auth_login_failed_prefix') + (res?.error || t('auth_unknown_error')))
          return
        }
        setPrimaryDisabled(false)
        setPrimaryLabel(t('auth_retry_login'))
        setStatus(t('codex_auth_expired'))
      } catch (err: any) {
        setPrimaryDisabled(false)
        setPrimaryLabel(t('auth_retry_login'))
        setStatus(t('auth_login_failed_prefix') + (err?.message || String(err)))
      } finally {
        busyRef.current = false
      }
    } else {
      openProviderSettings()
    }
  }

  const onSwitch = async () => {
    // One-click switch to the other source kind. Which one is pre-existing behavior:
    // subscription sources step back to a custom provider, everything else steps to
    // the Claude subscription.
    const newMode = copy.switchTo
    try {
      await activateModelSource(newMode)
      setStatus(newMode === 'subscription' ? t('auth_mode_switched_sub') : t('auth_mode_switched_custom'))
      setPrimaryDisabled(true)
    } catch (err: any) {
      setStatus(t('auth_switch_failed_prefix') + (err?.message || String(err)))
    }
  }

  return (
    <div className="msg-group assistant">
      <div className="msg assistant auth-card" style={{ background: 'var(--bg-surface)', border: '1px solid var(--border)', borderRadius: 12, padding: 16, width: '100%', boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', gap: 12, alignItems: 'flex-start', marginBottom: 12 }}>
          <RawHtml style={{ color: 'var(--accent)', marginTop: 2 }} html={icon} />
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>{title}</div>
            <div style={{ fontSize: 12, color: 'var(--fg-tertiary)', lineHeight: 1.5 }}>{hint}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {copy.action === 'open-settings' ? (
            <button
              type="button"
              id="auth-primary-btn"
              className={styles['auth-settings-link']}
              data-auth-settings-link
              onClick={openProviderSettings}
            >
              {primaryLabel ?? defaultPrimary}
            </button>
          ) : (
            <button className="btn-sm btn-primary" id="auth-primary-btn" style={{ padding: '7px 14px', fontSize: 13, fontWeight: 500 }} disabled={primaryDisabled} onClick={onPrimary}>
              {primaryLabel ?? defaultPrimary}
            </button>
          )}
          <button className="btn-sm" id="auth-switch-btn" style={{ padding: '7px 14px', fontSize: 13, background: 'transparent', color: 'var(--fg-tertiary)', border: '1px solid var(--border)' }} onClick={onSwitch}>
            {secondaryLabel}
          </button>
        </div>
        {copy.action !== 'open-settings' ? (
          <div style={{ marginTop: 10 }}>
            <button
              type="button"
              className={styles['auth-settings-link']}
              data-auth-settings-link
              onClick={openProviderSettings}
            >
              {t('auth_open_provider_settings')}
            </button>
          </div>
        ) : null}
        <div id="auth-action-status" style={{ marginTop: 10, fontSize: 12, color: 'var(--fg-tertiary)' }}>{status}</div>
      </div>
    </div>
  )
}
