import { t } from '../../i18n'
import { bootstrapProfile } from '../settings/profile-tab'
import { serializeIdentityWrite } from './identity-store'

export interface ProfileIdentity { displayName: string; handle: string; avatar: string; isGuest: boolean; ownerId: string }
const api = () => window.klaus
const ownerOf = (status: any): string => {
  if (status?.loggedIn === false) return 'guest'
  if (status?.loggedIn === true && typeof status.user?.id === 'string' && status.user.id) return status.user.id
  throw new Error(t('profile_load_failed'))
}
const handleKey = (ownerId: string) => 'profile_handle:' + ownerId

export async function loadIdentity(): Promise<ProfileIdentity> {
  const status = await api().klausAuth.status(), ownerId = ownerOf(status)
  return serializeIdentityWrite(async () => {
    const [displayName, handle, avatar] = await Promise.all([
      api().settings.kv.get('display_name'), api().settings.kv.get(handleKey(ownerId)), api().settings.kv.get('avatar_data_url'),
    ])
    return { displayName: displayName || t('user_default_name'), handle: handle || '', avatar: avatar || '', isGuest: !status.loggedIn, ownerId }
  })
}

export async function saveIdentity(identity: ProfileIdentity): Promise<{ localOnly: boolean }> {
  const name = identity.displayName.trim()
  if (!name) throw new Error(t('profile_display_name_required'))
  const handle = identity.handle.replace(/^@/, '').trim()
  if (handle && !/^[\p{L}\p{N}_.]{3,32}$/u.test(handle)) throw new Error(t('profile_handle_invalid'))
  if (ownerOf(await api().klausAuth.status()) !== identity.ownerId) throw new Error(t('profile_load_failed'))
  let localOnly = false
  if (!identity.isGuest) {
    try {
      const result = await api().klausAuth.updateProfile(name)
      if (!result?.ok) localOnly = true
      if (identity.avatar.startsWith('data:image/png;base64,')) {
        const bytes = Uint8Array.from(atob(identity.avatar.split(',')[1]), char => char.charCodeAt(0))
        const uploaded = await api().klausAuth.uploadAvatar('image/png', bytes.buffer)
        if (!uploaded?.ok) localOnly = true
      }
    } catch { localOnly = true }
  }
  await serializeIdentityWrite(async () => {
    if (ownerOf(await api().klausAuth.status()) !== identity.ownerId) throw new Error(t('profile_load_failed'))
    for (const [key, value] of [['display_name', name], [handleKey(identity.ownerId), handle], ['avatar_data_url', identity.avatar]]) {
      const result = await api().settings.kv.set(key, value)
      if (result?.ok === false || result?.error) throw new Error(result?.error || t('profile_save_failed'))
    }
    await bootstrapProfile()
  })
  return { localOnly }
}
