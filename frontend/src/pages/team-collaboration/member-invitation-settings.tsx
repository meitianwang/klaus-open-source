import { useId } from 'react'
import { request, updateProjectInvitationAccess, useMutation, useResource, type CollaborationInvitationSettings } from './data'
import { ErrorNotice } from './primitives'
import { useT } from './i18n'
import styles from './team-collaboration.module.css'

export type InvitationAccessState = CollaborationInvitationSettings
export function useInvitationSettings(projectId: string) {
  const result = useResource(() => request({ type: 'project-invitation-settings.get', projectId }), [projectId], projectId)
  const mutation = useMutation()
  const refresh = () => { mutation.setError(''); result.refresh() }
  const setEnabled = async (enabled: boolean) => {
    const current = result.data
    if (!current || !current.canManage || result.pending || mutation.pending || current.enabled === enabled) return
    await mutation.run(() => updateProjectInvitationAccess(projectId, current, enabled))
    result.refresh()
  }
  return { settings: result.data, pending: result.pending, changing: mutation.pending, error: mutation.error || result.error, setEnabled, refresh }
}
export function InvitationSettingsSection({ settings, pending, changing, disabled = false, error, onChange, onRetry }: { settings: InvitationAccessState | null; pending: boolean; changing: boolean; disabled?: boolean; error: string; onChange: (enabled: boolean) => void; onRetry: () => void }) {
  const t = useT()
  const hintId = useId()
  return <section className={styles.invitationSettings} aria-busy={pending || changing}>
    <label><span>{t('tc_invitation_enabled')}</span>{settings ? <input type="checkbox" role="switch" aria-describedby={hintId} checked={settings.enabled} disabled={disabled || pending || changing || !settings.canManage} onChange={event => onChange(event.target.checked)} /> : <span role="status">{pending ? t('tc_loading') : '—'}</span>}</label>
    {settings && <p id={hintId}>{t(settings.enabled ? 'tc_invitation_enabled_hint' : 'tc_invitation_disabled_hint')}</p>}
    {settings && !settings.canManage && <p>{t('tc_invitation_readonly')}</p>}
    <ErrorNotice error={error} onRetry={onRetry} />
  </section>
}
