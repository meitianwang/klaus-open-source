import { useEffect, useRef, useState } from 'react'
import type { FriendAppsSnapshot, FriendExecutionTargets, FriendTaskGrant } from '../../../../shared/friends'
import { useT } from '../../i18n'
import { failureText } from './data'
import { GrantEditor } from './GrantEditor'
import { useSettingsSnapshot } from '../settings/settings-snapshot'
import { ensureSettingsAccountListener } from '../profile/ProfilePage'
import friendsStyles from './friends.module.css'
import settingsStyles from '../settings/settings.module.css'

interface GrantViewData {
  draft: FriendTaskGrant
  deviceId: string | null
  sharedRoot: string | null
  targets: FriendExecutionTargets
  apps: FriendAppsSnapshot | null
}

export function DefaultFriendGrant() {
  const t = useT()
  const [data, setData, beginRead] = useSettingsSnapshot<GrantViewData | null>('account:friends:default-grant', null)
  const [reloadSequence, setReloadSequence] = useState(0)
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [saved, setSaved] = useState(false)
  const generation = useRef(0)
  useEffect(() => {
    ensureSettingsAccountListener()
    generation.current++
    let disposed = false
    const publish = beginRead()
    setError(''); setSaved(false); setPending(false)
    void (async () => {
      try {
        const runtime = await window.klaus.friends.runtime()
        if (disposed) return
        const apps = runtime.currentDeviceId ? await window.klaus.friends.apps({ deviceId: runtime.currentDeviceId }) : null
        if (!disposed) publish({
          draft: { ...runtime.defaultGrant, deviceId: runtime.currentDeviceId ?? runtime.defaultGrant.deviceId },
          deviceId: runtime.currentDeviceId,
          sharedRoot: runtime.friendFilesRoot,
          targets: runtime.executionTargets,
          apps,
        })
      } catch (failure) { if (!disposed) setError(failureText(failure)) }
    })()
    return () => { disposed = true; generation.current++ }
  }, [reloadSequence, beginRead])
  if (!data) return error ? <p className={friendsStyles.formError} role="alert">{error} <button type="button" className="btn-sm" onClick={() => setReloadSequence(value => value + 1)}>{t('friends_retry')}</button></p> : null
  const { draft, deviceId, sharedRoot, targets, apps } = data
  const save = async () => {
    const current = generation.current
    setPending(true); setError(''); setSaved(false)
    try { await window.klaus.friends.setDefaultGrant({ grant: draft }); if (current === generation.current) setSaved(true) }
    catch (failure) { if (current === generation.current) setError(failureText(failure)) }
    finally { if (current === generation.current) setPending(false) }
  }
  return <div className={settingsStyles['grant-settings']}>
    <div className={settingsStyles['settings-section-heading']}><div className="settings-section-title">{t('friends_default_grant')}</div><p className={settingsStyles['settings-section-hint']}>{t('friends_default_grant_hint')}</p></div>
    <GrantEditor draft={draft} apps={apps} disabled={pending} sharedRoot={sharedRoot} targets={targets} onPickDirectory={async () => {
      try { return (await window.klaus.session.pickWorkdir())?.path ?? null }
      catch (failure) { setError(failureText(failure)); return null }
    }} onChange={next => { setSaved(false); setData(value => value ? { ...value, draft: next(value.draft) } : value) }} />
    {error && <p className={friendsStyles.formError} role="alert">{error} <button type="button" className="btn-sm" onClick={() => setReloadSequence(value => value + 1)}>{t('friends_retry')}</button></p>}
    <div className={settingsStyles['grant-settings-actions']}><button type="button" className="kls-btn kls-btn-primary" disabled={pending || !deviceId || draft.policy !== 'reject' && (!apps || draft.computerUse && (!apps.available || !draft.apps.length))} onClick={() => void save()}>{t('friends_default_grant_save')}</button>{saved && <span className={friendsStyles.muted}>{t('friends_saved')}</span>}</div>
  </div>
}
