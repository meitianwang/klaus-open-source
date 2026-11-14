// Device and default authorization settings for friend collaboration.
import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { FRIENDS_ENABLED_KEY, isFriendsFeatureEnabled } from '../../../../shared/friends'
import { SettingsPage, PrefToggleRow, kvGet, kvSet } from './kv'
import { setFriendsFeatureEnabled } from '../friends/feature-enabled'
import { ReceiverSettings } from '../friends/ReceiverSettings'
import { DefaultFriendGrant } from '../friends/DefaultFriendGrant'
import styles from './settings.module.css'

/** The master switch for the whole friends feature; absent means off, matching the host reader. */
function FriendsFeatureToggle() {
  const t = useT()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    void kvGet(FRIENDS_ENABLED_KEY).then(raw => {
      if (!live) return
      const resolved = isFriendsFeatureEnabled(raw)
      setEnabled(resolved)
      setFriendsFeatureEnabled(resolved)
    })
    return () => { live = false }
  }, [])
  return <PrefToggleRow
    id="friends-enabled"
    label={t('friends_enabled')}
    desc={t('friends_enabled_desc')}
    checked={enabled === true}
    disabled={enabled === null}
    onChange={async checked => {
      setEnabled(checked)
      setFriendsFeatureEnabled(checked)
      if (!await kvSet(FRIENDS_ENABLED_KEY, checked ? 'on' : 'off')) {
        setEnabled(!checked)
        setFriendsFeatureEnabled(!checked)
      }
    }}
  />
}

export function FriendsSettingsTab() {
  const t = useT()
  return <SettingsPage title={t('friends')} subtitle={t('friends_settings_desc')}>
    <div className={styles['pref-card']}><FriendsFeatureToggle /></div>
    <div className={styles['profile-account-card']}><ReceiverSettings /></div>
    <DefaultFriendGrant />
  </SettingsPage>
}
