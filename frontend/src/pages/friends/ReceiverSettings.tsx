// Receiving-computer row plus its picker dialog. The row is account-level
// configuration (which of my computers accepts friend tasks), so it lives in
// the Settings profile card; the friends page only consumes the shared
// runtime snapshot. The row reuses the profile card row pattern (copy left,
// value and control right); the picker keeps the device-list dialog.
import { useEffect, useState, useSyncExternalStore } from 'react'
import type { FriendsRuntimeSnapshot } from '../../../../shared/friends'
import { Icon } from '../../components/Icon'
import { useT } from '../../i18n'
import { FriendsDialog } from './FriendsDialog'
import { failureText } from './data'
import { subscribeFriendsRuntime, friendsRuntimeSnapshot } from './runtime-state'
import friendsStyles from './friends.module.css'
import settingsStyles from '../settings/settings.module.css'

interface ReceiverRuntimeApi {
  runtime(): Promise<FriendsRuntimeSnapshot>
  setReceiver(args: { deviceId: string }): Promise<FriendsRuntimeSnapshot>
}

interface ReceiverState {
  runtime: FriendsRuntimeSnapshot | null
  loading: boolean
  busy: string | null
  error: string
}

/** Local store over the friends runtime: reads the shared snapshot first so a
    page that already loaded it renders instantly, then refreshes on mount. */
export function createReceiverController(api: ReceiverRuntimeApi) {
  let state: ReceiverState = { runtime: friendsRuntimeSnapshot(), loading: !friendsRuntimeSnapshot(), busy: null, error: '' }
  let generation = 0, disposed = false
  const subscribers = new Set<() => void>()
  const publish = (next: Partial<ReceiverState>) => {
    if (disposed) return
    state = { ...state, ...next }
    for (const subscriber of subscribers) subscriber()
  }
  const refresh = async () => {
    if (disposed || state.busy) return
    const current = ++generation
    publish({ loading: true })
    try {
      const runtime = await api.runtime()
      if (!disposed && current === generation) publish({ runtime, loading: false, error: runtime.error || '' })
    } catch (failure) {
      if (!disposed && current === generation) publish({ loading: false, error: failureText(failure) })
    }
  }
  const setReceiver = async (deviceId: string): Promise<boolean> => {
    if (disposed || state.busy) return false
    const current = ++generation
    publish({ busy: deviceId, error: '' })
    try {
      const runtime = await api.setReceiver({ deviceId })
      if (disposed || current !== generation) return false
      publish({ runtime, busy: null, error: runtime.error || '' })
      return true
    } catch (failure) {
      if (!disposed && current === generation) publish({ busy: null, error: failureText(failure) })
      return false
    }
  }
  return {
    getSnapshot: () => state,
    subscribe: (subscriber: () => void) => {
      subscribers.add(subscriber)
      const unsubscribeShared = subscribeFriendsRuntime(() => publish({ runtime: friendsRuntimeSnapshot(), loading: false }))
      return () => { subscribers.delete(subscriber); unsubscribeShared() }
    },
    refresh,
    setReceiver,
    dispose: () => { ++generation; disposed = true; subscribers.clear() },
  }
}

export function ReceiverSettings() {
  const t = useT()
  const [controller] = useState(() => createReceiverController(window.klaus.friends))
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
  const [choosing, setChoosing] = useState(false)
  useEffect(() => { void controller.refresh(); return () => controller.dispose() }, [controller])
  const runtime = state.runtime
  const devices = runtime?.receiver?.devices ?? []
  const selected = devices.find(device => device.id === runtime?.receiver?.selectedDeviceId)
  const unavailable = !!state.error || !runtime?.signedIn
  return <>
    <div className={settingsStyles['profile-account-row']}>
      <div className={settingsStyles['profile-account-row-copy']}>
        <div className={settingsStyles['profile-account-row-title']}>{t('friends_receiver')}</div>
        <div className={settingsStyles['profile-account-row-desc']}>{t('friends_receiver_hint')}</div>
        {state.error && <div className={friendsStyles.formError} role="alert">{state.error} <button type="button" className="kls-btn kls-btn-secondary" disabled={!!state.busy} onClick={() => void controller.refresh()}>{t('friends_retry')}</button></div>}
      </div>
      <div className={settingsStyles['profile-account-row-value']}>
        <span className={settingsStyles['profile-receiver-value']}>
          <strong>{selected?.name || t('friends_no_receiver')}</strong>
          {selected && <><span className={`${friendsStyles.dot} ${selected.online ? friendsStyles.online : ''}`} />{t(selected.online ? 'friends_online' : 'friends_offline')}</>}
        </span>
        <button type="button" className="kls-btn kls-btn-secondary" disabled={!!state.busy || unavailable} onClick={() => setChoosing(true)}>{t('friends_change')}</button>
      </div>
    </div>
    {choosing && <FriendsDialog title={t('friends_receiver')} subtitle={t('friends_receiver_hint')} closeDisabled={!!state.busy} onClose={() => setChoosing(false)}><div className={friendsStyles.deviceList}>
      {!devices.length && <p className={friendsStyles.muted}>{t('friends_no_devices')}</p>}
      {devices.map(device => <button key={device.id} className={friendsStyles.deviceOption} disabled={!!state.busy || !device.supportsFriendsMessaging} aria-pressed={device.id === runtime?.receiver?.selectedDeviceId} onClick={() => void controller.setReceiver(device.id).then(ok => { if (ok) setChoosing(false) })}><Icon name="run-mode-local" size={22} /><span><strong>{device.name}</strong><small>{device.platform} · {t(device.online ? 'friends_online' : 'friends_offline')}{device.isCurrent ? ` · ${t('friends_current_computer')}` : ''}{!device.supportsFriendsMessaging ? ` · ${t('friends_device_unsupported')}` : ''}</small></span>{device.id === runtime?.receiver?.selectedDeviceId && <Icon name="check" size={18} />}</button>)}
    </div>{state.error && <p className={friendsStyles.formError} role="alert">{state.error}</p>}</FriendsDialog>}
  </>
}
