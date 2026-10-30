// Device and default authorization settings for friend collaboration.
import { useT } from '../../i18n'
import { SettingsPage } from './kv'
import { ReceiverSettings } from '../friends/ReceiverSettings'
import { DefaultFriendGrant } from '../friends/DefaultFriendGrant'
import styles from './settings.module.css'

export function FriendsSettingsTab() {
  const t = useT()
  return <SettingsPage title={t('friends')} subtitle={t('friends_settings_desc')}>
    <div className={styles['profile-account-card']}><ReceiverSettings /></div>
    <DefaultFriendGrant />
  </SettingsPage>
}
