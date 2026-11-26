import { useEffect, useState } from 'react'
import { enqueueDefaultGrantChange, type GrantViewData } from './default-grant-state'
import { updateFriendsRuntime } from './runtime-state'
import { useT } from '../../i18n'
import { failureText } from './data'
import { GrantEditor } from './GrantEditor'
import { useSettingsSnapshot } from '../settings/settings-snapshot'
import { ensureSettingsAccountListener } from '../profile/ProfilePage'
import friendsStyles from './friends.module.css'
import settingsStyles from '../settings/settings.module.css'

export function DefaultFriendGrant() {
  const t = useT()
  const [data, setData, beginRead] = useSettingsSnapshot<GrantViewData | null>('account:friends:default-grant', null)
  const [reloadSequence, setReloadSequence] = useState(0)
  const [readError, setReadError] = useState('')
  useEffect(() => {
    ensureSettingsAccountListener()
    let disposed = false
    const publish = beginRead()
    setReadError('')
    void (async () => {
      try {
        const runtime = await window.klaus.friends.runtime()
        if (disposed) return
        const deviceId = runtime.currentDeviceId
        const apps = deviceId !== null ? await window.klaus.friends.apps({ deviceId }) : { available: true, apps: [] }
        const initialGrant = { ...runtime.defaultGrant, deviceId: deviceId ?? runtime.defaultGrant.deviceId }
        if (!disposed) publish(current => current?.pending ? current : {
          draft: initialGrant, confirmedPersisted: initialGrant, deviceId,
          sharedRoot: runtime.friendFilesRoot, targets: runtime.executionTargets, apps,
          ...(current?.saveError ? { error: current.error, saveError: true } : {}),
        })
      } catch (failure) { if (!disposed) setReadError(failureText(failure)) }
    })()
    return () => { disposed = true }
  }, [reloadSequence, beginRead])
  const error = data?.error || readError
  const alert = error && <p className={friendsStyles.formError} role="alert">{error} <button type="button" className="btn-sm" onClick={() => {
    setData(current => current ? { ...current, error: undefined, saveError: false } : current)
    setReadError('')

    setReloadSequence(value => value + 1)
  }}>{t('friends_retry')}</button></p>
  if (!data) return alert || null
  const { draft, deviceId, sharedRoot, targets, apps, pending } = data
  return <div className={settingsStyles['grant-settings']} aria-busy={Boolean(pending)}>
    <div className={settingsStyles['settings-section-heading']}><div className="settings-section-title">{t('friends_default_grant')}</div><p className={settingsStyles['settings-section-hint']}>{t('friends_default_grant_hint')}</p></div>
    <GrantEditor draft={draft} apps={apps} disabled={!deviceId} sharedRoot={sharedRoot} targets={targets} onPickDirectory={async () => {
      try { return (await window.klaus.session.pickWorkdir())?.path ?? null }
      catch (failure) {
        setData(current => current ? { ...current, error: failureText(failure), saveError: false } : current)
        return null
      }
    }} onChange={next => {
      setReadError('')
      enqueueDefaultGrantChange(next, setData, {
        setDefaultGrant: request => window.klaus.friends.setDefaultGrant(request), onRuntime: updateFriendsRuntime,
      })
    }} />
    {alert}
  </div>
}
