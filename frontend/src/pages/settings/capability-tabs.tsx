// 移动端桥 tab + browser 家族共享行组件（capability 行/开关/图标钮）。
import { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../../i18n'
import { rawIconHtml } from '../../components/Icon'
import { SettingsPage } from './kv'
import { useSettingsSnapshot } from './settings-snapshot'
import styles from './settings.module.css'

const w = () => window as any

function Raw({ name }: { name: string }) {
  return <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: rawIconHtml(name) }} />
}

/** 设置页的主开关行（图标砖 + 标题/描述 + 行尾动作）。 */
export function CapabilityRow({ title, desc, iconName, action }: {
  title: string
  desc: string
  iconName: string
  action: React.ReactNode
}) {
  return (
    <div className={styles['browser-capability-row']}>
      <div className={styles['browser-capability-icon']} aria-hidden="true"><Raw name={iconName} /></div>
      <div className={styles['browser-capability-copy']}>
        <div className={styles['pref-row-label']}>{title}</div>
        <div className={styles['pref-row-desc']}>{desc}</div>
      </div>
      <div className={styles['browser-capability-action']}>{action}</div>
    </div>
  )
}

export function CapabilitySwitch({ id, checked, disabled, ariaLabel, onChange }: {
  id: string
  checked: boolean
  disabled?: boolean
  ariaLabel: string
  onChange: (checked: boolean) => void
}) {
  return (
    <label className={styles['pref-switch']}>
      <input
        type="checkbox" id={id} checked={checked} disabled={disabled} aria-label={ariaLabel}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className={styles['pref-switch-track']} />
    </label>
  )
}

// ==================== Mobile Bridge ====================

interface AccountDevice {
  id: string
  name: string
  platform: string
  status: 'online' | 'reconnecting' | 'offline'
  lastSeenAt: number | null
  appVersion: string | null
  isCurrent: boolean
}

export function MobileBridgeSettingsTab() {
  const t = useT()
  const [state, setState, beginStateRead] = useSettingsSnapshot<{ kind: 'loading' } | { kind: 'unavailable' } | { kind: 'ready'; cfg: any }>('account:mobile-bridge:state', { kind: 'loading' })
  const [loadError, setLoadError] = useState('')
  const [busy, setBusy] = useState(false)
  const [deviceSnapshot, setDeviceSnapshot, beginDevicesRead] = useSettingsSnapshot<AccountDevice[] | null>('account:mobile-bridge:devices', null)
  const [devicesError, setDevicesError] = useState<string | null>(null)
  const [deviceBusy, setDeviceBusy] = useState<string | null>(null)
  const [editingDevice, setEditingDevice] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [power, setPower, beginPowerRead] = useSettingsSnapshot<{ keepAwake: boolean; revision: number } | null>('mobile-bridge:power', null)
  const [powerBusy, setPowerBusy] = useState(false)
  const [powerError, setPowerError] = useState('')
  const powerRevision = useRef(power?.revision ?? -1)
  const keepAwake = power?.keepAwake ?? false
  const devices = deviceSnapshot ?? []
  const devicesLoading = deviceSnapshot === null && !devicesError

  const reload = useCallback(async () => {
    const publish = beginStateRead()
    setLoadError('')
    const api = w().settingsApi.mobileBridge
    if (!api?.get) { publish({ kind: 'unavailable' }); return }
    const result = await api.get().catch((err: any) => ({ ok: false, error: err?.message || String(err) }))
    if (!result?.ok) { if (publish(current => current)) setLoadError(result?.error || t('settings_failed')); return }
    publish({ kind: 'ready', cfg: result.settings || {} })
  }, [t, beginStateRead])

  const reloadDevices = useCallback(async () => {
    const publish = beginDevicesRead()
    setDevicesError(null)
    const api = w().settingsApi.mobileBridge
    if (!api?.devices) { if (publish(current => current)) setDevicesError(t('mobile_bridge_unavailable')); return }
    const result = await api.devices().catch((err: any) => ({ ok: false, error: err?.message || String(err) }))
    if (!result?.ok) { if (publish(current => current)) setDevicesError(t('mobile_bridge_devices_load_failed')); return }
    if (!publish(Array.isArray(result.devices) ? result.devices : [])) return
    setDevicesError(null)
  }, [t, beginDevicesRead])

  useEffect(() => { void Promise.all([reload(), reloadDevices()]) }, [reload, reloadDevices])
  useEffect(() => {
    let cancelled = false
    const publish = beginPowerRead()
    const apply = (snapshot: any) => {
      if (cancelled || snapshot.revision < powerRevision.current) return
      powerRevision.current = snapshot.revision
      setPower({ keepAwake: snapshot.preferences.keepRemoteControlAwakeWhilePluggedIn, revision: snapshot.revision }); setPowerError('')
    }
    const off = w().klaus.powerSave.subscribe(apply)
    void w().klaus.powerSave.snapshot().then((snapshot: any) => {
      if (!cancelled && snapshot.revision >= powerRevision.current && publish({ keepAwake: snapshot.preferences.keepRemoteControlAwakeWhilePluggedIn, revision: snapshot.revision })) {
        powerRevision.current = snapshot.revision
        setPowerError('')
      }
    }).catch((error: any) => { if (!cancelled && publish(current => current)) setPowerError(error?.message || t('settings_failed')) })
    return () => { cancelled = true; off() }
  }, [t, beginPowerRead, setPower])
  const shouldPoll = state.kind === 'ready' && state.cfg?.accountLinked === true
  useEffect(() => {
    if (!shouldPoll || busy || deviceBusy) return
    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'hidden') void Promise.all([reload(), reloadDevices()])
    }, 5000)
    return () => window.clearInterval(timer)
  }, [busy, deviceBusy, reload, reloadDevices, shouldPoll])

  if (state.kind === 'loading' && !loadError) {
    return (
      <SettingsPage title={t('mobile_bridge_settings')} subtitle={t('mobile_bridge_desc')}>
        <div dangerouslySetInnerHTML={{ __html: w().klsLoading.render() }} />
      </SettingsPage>
    )
  }
  if (state.kind === 'unavailable' || state.kind === 'loading') {
    return (
      <SettingsPage title={t('mobile_bridge_settings')} subtitle={t('mobile_bridge_desc')}>
        <div className="empty-text sk-empty" role={loadError ? 'alert' : undefined}>
          <p>{state.kind === 'unavailable' ? t('mobile_bridge_unavailable') : loadError}</p>
          {loadError ? (
            <button type="button" className="btn-sm" onClick={() => { void reload() }}>{t('auth_status_retry')}</button>
          ) : null}
        </div>
      </SettingsPage>
    )
  }
  const api = w().settingsApi.mobileBridge
  const cfg = state.cfg
  const enabled = cfg.enabled === true
  const accountLinked = cfg.accountLinked === true
  // Feature flags beyond the legacy option type are carried in the same payload.
  const saveBridgeSettings = api.set as (update: Record<string, unknown>) => Promise<any>
  const lockedComputerUse = cfg.allowLockedComputerUse === true

  const saveAndReload = async (operation: () => Promise<any>) => {
    if (busy) return
    setState(current => current)
    setDeviceSnapshot(current => current)
    setBusy(true)
    try {
      const res = await operation().catch((err: any) => ({ ok: false, error: err?.message || String(err) }))
      if (res?.cancelled) return
      if (!res?.ok) {
        w().showToast(res?.error || t('settings_failed'))
        return
      }
      await Promise.all([reload(), reloadDevices()])
    } finally {
      setBusy(false)
    }
  }

  const removeDevice = async (device: AccountDevice) => {
    if (deviceBusy || device.isCurrent) return
    const confirmed = await w().klausDialog.confirm({
      title: t('mobile_bridge_remove_device'),
      message: t('mobile_bridge_remove_device_confirm'),
      confirmText: t('mobile_bridge_remove_device'),
      danger: true,
    })
    if (!confirmed) return
    setDeviceBusy(device.id)
    setDeviceSnapshot(current => current)
    try {
      const result = await api.removeDevice(device.id).catch((err: any) => ({ ok: false, error: err?.message || String(err) }))
      if (!result?.ok) { w().showToast(t('mobile_bridge_remove_failed')); return }
      w().showToast(t('mobile_bridge_remove_done'))
      await reloadDevices()
      // The @-menu caches devices separately; drop it so a removed device does
      // not linger in the picker until its staleTime lapses.
      w().invalidateDeviceMentionCache?.()
    } finally {
      setDeviceBusy(null)
    }
  }

  const renameDevice = async (device: AccountDevice, name: string) => {
    if (deviceBusy) return
    const trimmed = name.trim()
    if (!trimmed) return
    setDeviceBusy(device.id)
    setDeviceSnapshot(current => current)
    try {
      const result = await api.renameDevice(device.id, trimmed).catch((err: any) => ({ ok: false, error: err?.message || String(err) }))
      if (!result?.ok) {
        w().showToast(result?.error === 'invalid_name' ? t('mobile_bridge_rename_invalid') : t('mobile_bridge_rename_failed'))
        return
      }
      w().showToast(t('mobile_bridge_rename_done'))
      setEditingDevice(null)
      await reloadDevices()
      // Drop the @-menu's device cache so a rename shows immediately there too.
      w().invalidateDeviceMentionCache?.()
    } finally {
      setDeviceBusy(null)
    }
  }

  const platformLabel = (platform: string) => {
    if (platform === 'darwin') return 'macOS'
    if (platform === 'win32') return 'Windows'
    if (platform === 'linux') return 'Linux'
    return t('mobile_bridge_desktop_device')
  }

  const statusLabel = (status: AccountDevice['status']) => {
    if (status === 'online') return t('mobile_bridge_device_online')
    if (status === 'reconnecting') return t('mobile_bridge_device_reconnecting')
    return t('mobile_bridge_device_offline')
  }

  return (
    <SettingsPage title={t('mobile_bridge_settings')} subtitle={t('mobile_bridge_desc')}>
      {loadError && <div className="empty-text" role="alert">{loadError}{' '}
        <button type="button" className="btn-sm" onClick={() => { void reload() }}>{t('auth_status_retry')}</button></div>}
      <div className={styles['pref-card']} aria-busy={busy}>
        <CapabilityRow
          title={t('mobile_bridge_title')} desc={t('mobile_bridge_toggle_desc')}
          iconName="browser-use-logo-6"
          action={
            <CapabilitySwitch
              id="mobile-bridge-enabled" checked={enabled} disabled={busy} ariaLabel={t('mobile_bridge_title')}
              onChange={(checked) => { void saveAndReload(() => api.set({ enabled: checked })) }}
            />
          }
        />
        {!accountLinked || !enabled ? (
          <div className={styles['mobile-bridge-summary']}>
            {!accountLinked ? t('mobile_bridge_account_required') : t('mobile_bridge_disabled_hint')}
          </div>
        ) : null}
      </div>

      <div className={styles['pref-card']} aria-busy={powerBusy}>
        <CapabilityRow title={t('power_remote_keep_awake')} desc={t('power_remote_keep_awake_desc')} iconName="browser-use-logo-6" action={
          <CapabilitySwitch id="remote-keep-awake" checked={keepAwake} disabled={!power || powerBusy || !!powerError}
            ariaLabel={t('power_remote_keep_awake')} onChange={(checked) => {
              setPowerBusy(true)
              setPower(current => current)
              void w().klaus.powerSave.setPreference('keepRemoteControlAwakeWhilePluggedIn', checked)
                .then((result: any) => {
                  if (!result?.ok) throw new Error(result?.error || t('settings_failed'))
                  if (result.revision >= powerRevision.current) { powerRevision.current = result.revision; setPower({ keepAwake: result.keepRemoteControlAwakeWhilePluggedIn, revision: result.revision }) }
                })
                .catch((error: any) => w().showToast(error?.message || t('settings_failed')))
                .finally(() => setPowerBusy(false))
            }} />
        } />
        {powerError ? <p className="empty-text" role="alert">{powerError}</p> : null}
      </div>

      <div className={styles['pref-card']} aria-busy={busy}>
        <CapabilityRow
          title={t('mobile_bridge_locked_use_title')} desc={t('mobile_bridge_locked_use_desc')}
          iconName="browser-use-logo-6"
          action={
            <CapabilitySwitch
              id="mobile-bridge-locked-use" checked={lockedComputerUse} disabled={busy}
              ariaLabel={t('mobile_bridge_locked_use_title')}
              onChange={(checked) => { void saveAndReload(() => saveBridgeSettings({ allowLockedComputerUse: checked })) }}
            />
          }
        />
      </div>

      <div className="settings-section">
        <div className="settings-section-title">{t('mobile_bridge_devices_title')}</div>
        <div className={styles['settings-section-hint']}>{t('mobile_bridge_devices_desc')}</div>
        <div className={`${styles['pref-card']} ${styles['mobile-device-list']}`} aria-live="polite">
          {devicesLoading ? <div className={styles['mobile-device-empty']} dangerouslySetInnerHTML={{ __html: w().klsLoading.render() }} /> : null}
          {!devicesLoading && devicesError ? (
            <div className={styles['mobile-device-empty']} role="alert">
              <span>{devicesError}</span>
              <button type="button" className={styles['browser-action-btn']} onClick={() => { void reloadDevices() }}>{t('auth_status_retry')}</button>
            </div>
          ) : null}
          {!devicesLoading && !devicesError && !accountLinked ? (
            <div className={styles['mobile-device-empty']}>{t('mobile_bridge_account_required')}</div>
          ) : null}
          {!devicesLoading && !devicesError && accountLinked && devices.length === 0 ? (
            <div className={styles['mobile-device-empty']}>{t('mobile_bridge_devices_empty')}</div>
          ) : null}
          {!devicesLoading && accountLinked ? devices.map(device => (
            <div className={styles['mobile-device-row']} key={device.id}>
              <div className={styles['mobile-device-icon']} aria-hidden="true"><Raw name="run-mode-local" /></div>
              <div className={styles['mobile-device-copy']}>
                {editingDevice === device.id ? (
                  <form
                    className={styles['mobile-device-rename']}
                    onSubmit={(event) => { event.preventDefault(); void renameDevice(device, editName) }}
                  >
                    <input
                      className={styles['settings-field-input']} type="text" value={editName} maxLength={120}
                      aria-label={t('mobile_bridge_rename_label')} autoFocus
                      onChange={(event) => setEditName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Escape') { event.preventDefault(); setEditingDevice(null) }
                      }}
                    />
                    <button type="submit" className="btn-sm btn-primary" disabled={deviceBusy === device.id || !editName.trim()}>{t('save')}</button>
                    <button type="button" className="btn-sm" disabled={deviceBusy === device.id} onClick={() => setEditingDevice(null)}>{t('cancel')}</button>
                  </form>
                ) : (
                  <div className={styles['mobile-device-name']}>
                    <button
                      type="button" className={styles['mobile-device-name-btn']}
                      aria-label={`${t('mobile_bridge_rename_device')} ${device.name}`}
                      onClick={() => { setEditingDevice(device.id); setEditName(device.name) }}
                    >{device.name}</button>
                    {device.isCurrent ? <span className={styles['mobile-device-current']}>{t('mobile_bridge_current_device')}</span> : null}
                  </div>
                )}
                <div className={styles['mobile-device-meta']}>{platformLabel(device.platform)} · {statusLabel(device.status)}</div>
              </div>
              {!device.isCurrent ? (
                <button
                  type="button" className={styles['mobile-device-remove']} disabled={deviceBusy === device.id}
                  aria-label={`${t('mobile_bridge_remove_device')} ${device.name}`}
                  onClick={() => { void removeDevice(device) }}
                >{t('mobile_bridge_remove_device')}</button>
              ) : null}
            </div>
          )) : null}
        </div>
      </div>
    </SettingsPage>
  )
}
