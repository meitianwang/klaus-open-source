// Device and default authorization settings for friend collaboration.
import { useEffect, useState } from 'react'
import { useT } from '../../i18n'
import { FRIENDS_ENABLED_KEY } from '../../../../shared/friends'
import { SettingsPage, PrefToggleRow, kvGet, kvSet, boolChecked } from './kv'
import { ReceiverSettings } from '../friends/ReceiverSettings'
import { DefaultFriendGrant } from '../friends/DefaultFriendGrant'
import styles from './settings.module.css'

/** The master switch for the whole friends feature; absent means on, matching the host reader. */
function FriendsFeatureToggle() {
  const t = useT()
  const [enabled, setEnabled] = useState<boolean | null>(null)
  useEffect(() => {
    let live = true
    void kvGet(FRIENDS_ENABLED_KEY).then(raw => { if (live) setEnabled(boolChecked(raw, true)) })
    return () => { live = false }
  }, [])
  return <PrefToggleRow
    id="friends-enabled"
    label={t('friends_enabled')}
    desc={t('friends_enabled_desc')}
    checked={enabled !== false}
    disabled={enabled === null}
    onChange={async checked => {
      setEnabled(checked)
      if (!await kvSet(FRIENDS_ENABLED_KEY, checked ? 'on' : 'off')) setEnabled(!checked)
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
