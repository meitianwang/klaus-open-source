import { useState } from 'react'
import { writeClipboardText } from '../../clipboard'
import { canChangeMember, canCreateProjectInvitation, projectMemberRemovalAction, request, useAccountId, useMutation, useResource, type CollaborationMember, type CollaborationProject, type CollaborationRole } from './data'
import { CoverIcon, ErrorNotice, Loading, MemberAvatar, Modal } from './primitives'
import { intlLocale, useT } from './i18n'
import { InvitationSettingsSection, useInvitationSettings } from './member-invitation-settings'
import styles from './team-collaboration.module.css'

export function MembersModal({ project, onClose, onChanged, onLeft, onInvite }: { project: CollaborationProject; onClose: () => void; onChanged: () => void; onLeft?: () => void; onInvite?: () => void }) {
  const t = useT()
  const accountId = useAccountId()
  const [search, setSearch] = useState('')
  const result = useResource(() => request({ type: 'project-members.list', projectId: project.id }), [project.id], project.id)
  const mutation = useMutation()
  const [remove, setRemove] = useState<CollaborationMember | null>(null)
  const invitation = useInvitationSettings(project.id)
  const busy = mutation.pending || invitation.changing
  const members = result.data || []
  const query = search.trim().toLocaleLowerCase()
  const filtered = members.filter(member => !query || `${member.agent?.name || member.user.displayName} ${member.user.displayName} ${member.role} ${t(`tc_${member.role}`)}`.toLocaleLowerCase().includes(query))
  const leaving = !!remove && projectMemberRemovalAction(project, remove, accountId) === 'leave'
  const changed = () => { result.refresh(); invitation.refresh(); onChanged() }
  return <Modal width={640} title={`${t('tc_members')} · ${result.data ? members.length : project.memberCount}`} onClose={onClose} busy={busy}>
    <div className={styles.modalBody}>
      <InvitationSettingsSection settings={invitation.settings} pending={invitation.pending} changing={busy} disabled={!!project.archivedAt} error={invitation.error} onChange={enabled => void invitation.setEnabled(enabled)} onRetry={invitation.refresh} />
      <ErrorNotice error={result.error} onRetry={result.refresh} />
      <input className={styles.memberSearch} data-autofocus type="search" aria-label={t('tc_member_search')} placeholder={t('tc_member_search')} value={search} onChange={event => setSearch(event.target.value)} />
      {result.pending && !result.data && <Loading />}
      {!result.pending && filtered.length === 0 && <p className={styles.hint}>{t('tc_member_no_matches')}</p>}
      <ul className={styles.memberList}>{filtered.map(member => {
        const editable = !project.archivedAt && canChangeMember(project, member, members)
        const removalAction = projectMemberRemovalAction(project, member, accountId)
        return <li className={styles.memberRow} key={member.id}><MemberAvatar member={member} /><div className={styles.memberIdentity}><strong>{member.agent?.name || member.user.displayName}</strong>{member.kind === 'agent' && <small>Agent · {member.user.displayName}</small>}</div>
          <select aria-label={`${member.agent?.name || member.user.displayName} ${t('tc_role')}`} value={member.role} disabled={!editable || busy || member.kind === 'agent'} onChange={event => void mutation.run(() => request({ type: 'project-members.set-role', projectId: project.id, memberId: member.id, role: event.target.value as CollaborationRole }), changed)}>
            {(['owner', 'admin', 'member'] as const).map(role => <option key={role} value={role} disabled={project.role !== 'owner' && role !== 'member'}>{t(`tc_${role}`)}</option>)}
          </select>
          {removalAction && <button type="button" className={styles.textDanger} disabled={busy} onClick={() => setRemove(member)}>{t(removalAction === 'leave' ? 'tc_member_leave' : 'tc_member_remove')}</button>}
        </li>
      })}</ul>
      <p className={styles.hint}>{t('tc_owner_last')}</p>
      {remove && <div className={styles.confirmInline} role="alert"><p>{t(leaving ? 'tc_member_leave_confirm' : 'tc_member_remove_confirm')} <strong>{leaving ? project.name : remove.agent?.name || remove.user.displayName}</strong></p><div className={styles.actions}><button type="button" disabled={busy} onClick={() => setRemove(null)}>{t('tc_cancel')}</button><button type="button" className={styles.dangerButton} disabled={busy} onClick={() => void mutation.run(() => request({ type: 'project-members.remove', projectId: project.id, memberId: remove.id }), () => { setRemove(null); if (leaving) (onLeft || onClose)(); else changed() })}>{t('tc_confirm')}</button></div></div>}
      <ErrorNotice error={mutation.error} />
      {onInvite && <footer className={styles.modalFooter}><button type="button" className={styles.primaryButton} disabled={busy || invitation.pending || !canCreateProjectInvitation(project, invitation.settings)} onClick={onInvite}>{t('tc_invite')}</button></footer>}
    </div>
  </Modal>
}

interface InvitationsModalProps { project: CollaborationProject; onClose: () => void; onManageSettings?: () => void }
export function InvitationsModal(props: InvitationsModalProps) {
  const t = useT()
  if (props.project.role !== 'owner') return <Modal title={t('tc_invite_links')} onClose={props.onClose}><div className={styles.modalBody}><ErrorNotice error={t('tc_invitation_owner_only')} /></div></Modal>
  return <OwnerInvitationsModal {...props} />
}
function OwnerInvitationsModal({ project, onClose, onManageSettings }: InvitationsModalProps) {
  const t = useT()
  const result = useResource(() => request({ type: 'project-invitations.list', projectId: project.id }), [project.id], project.id)
  const mutation = useMutation()
  const [link, setLink] = useState<{ id: string; url: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [revoking, setRevoking] = useState<string | null>(null)
  const invitation = useInvitationSettings(project.id)
  const canManageLinks = !!invitation.settings?.canManage && !project.archivedAt
  const canInvite = canCreateProjectInvitation(project, invitation.settings) && !invitation.pending
  const linkUnavailable = !!link && !!result.data?.some(entry => entry.id === link.id && (entry.revokedAt || new Date(entry.expiresAt).getTime() <= Date.now()))
  return <Modal title={t(project.archivedAt ? 'tc_invite_links' : 'tc_invite')} onClose={onClose} busy={mutation.pending}>
    <div className={styles.modalBody}>
      <p>{t(project.archivedAt ? 'tc_project_archived_notice' : 'tc_invite_body')}</p>
      {invitation.pending && !invitation.settings && <Loading />}
      <ErrorNotice error={invitation.error} onRetry={invitation.refresh} />
      {invitation.settings && !invitation.settings.enabled && <p className={styles.hint} role="status">{t('tc_invitation_disabled_hint')}{onManageSettings && invitation.settings.canManage && <button type="button" disabled={mutation.pending} onClick={onManageSettings}>{t('tc_invitation_manage')}</button>}</p>}
      {invitation.settings && !invitation.settings.canManage && <p className={styles.hint}>{t('tc_invitation_readonly')}</p>}
      <button type="button" className={styles.primaryButton} disabled={mutation.pending || !canInvite} onClick={() => void mutation.run(() => request({ type: 'project-invitations.create', projectId: project.id }), invitation => {
        result.refresh(); setCopied(false)
        if (!/^https?:\/\//i.test(invitation.joinPath)) { mutation.setError(t('tc_invite_url_unavailable')); return }
        setLink({ id: invitation.id, url: invitation.joinPath })
      })}>{t('tc_invite_create')}</button>
      {link && canManageLinks && !linkUnavailable && <div className={styles.inviteCopy}><input aria-label={t('tc_invite_copy')} readOnly value={link.url} onFocus={event => event.target.select()} /><button type="button" disabled={mutation.pending || !canInvite} onClick={() => void mutation.run(() => writeClipboardText(link.url), () => setCopied(true))}>{copied ? t('tc_copied') : t('tc_invite_copy')}</button><small>{t('tc_invite_link_once')}</small></div>}
      <ErrorNotice error={mutation.error} /><ErrorNotice error={result.error} onRetry={result.refresh} />
      <h3>{t('tc_invite_links')}</h3>{result.pending && !result.data && <Loading />}
      {result.data?.length === 0 && <p className={styles.hint}>{t('tc_invite_no_links')}</p>}
      {result.data?.map(entry => {
        const expired = new Date(entry.expiresAt).getTime() <= Date.now()
        return <div key={entry.id} className={styles.invitationRow}><div><code>{entry.id.slice(0, 8)}</code><small>{t('tc_invite_expires')} · {new Date(entry.expiresAt).toLocaleString(intlLocale())}</small></div>{entry.revokedAt ? <span>{t('tc_invite_revoked')}</span> : expired ? <span>{t('tc_invite_expired')}</span> : canManageLinks && <button type="button" disabled={mutation.pending || invitation.pending} onClick={() => setRevoking(entry.id)}>{t('tc_invite_revoke')}</button>}</div>
      })}
      {revoking && <div className={styles.confirmInline}><p>{t('tc_invite_revoke_confirm')}</p><div className={styles.actions}><button type="button" disabled={mutation.pending} onClick={() => setRevoking(null)}>{t('tc_cancel')}</button><button type="button" disabled={mutation.pending || !canManageLinks || invitation.pending} className={styles.dangerButton} onClick={() => void mutation.run(() => request({ type: 'project-invitations.revoke', projectId: project.id, invitationId: revoking }), () => { if (link?.id === revoking) setLink(null); setRevoking(null); result.refresh() })}>{t('tc_invite_revoke')}</button></div></div>}
    </div>
  </Modal>
}

export function InvitationPreview({ token, onJoined, onClose }: { token: string; onJoined: (project: CollaborationProject) => void; onClose: () => void }) {
  const t = useT()
  const preview = useResource(() => request({ type: 'project-invitations.preview', token }), [token])
  const mutation = useMutation()
  return <Modal title={t('tc_join')} onClose={onClose} busy={mutation.pending}><div className={styles.modalBody}>
    {preview.pending && !preview.data && <Loading />}<ErrorNotice error={preview.error} onRetry={preview.refresh} />
    {preview.data && <><CoverIcon icon={preview.data.project.coverIcon} color={preview.data.project.coverColor} /><h3>{preview.data.project.name}</h3><p>{preview.data.alreadyMember ? t('tc_join_already') : t('tc_invite_body')}</p><p>{t('tc_invite_expires')} · {new Date(preview.data.expiresAt).toLocaleString(intlLocale())}</p><button type="button" className={styles.primaryButton} disabled={mutation.pending} onClick={() => void mutation.run(() => request({ type: 'project-invitations.accept', token }), value => onJoined(value.project))}>{t('tc_join')}</button></>}
    <ErrorNotice error={mutation.error} />
  </div></Modal>
}
