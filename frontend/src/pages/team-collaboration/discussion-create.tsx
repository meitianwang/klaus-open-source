import { useState } from 'react'
import type { CollaborationDiscussion, CollaborationIssue, CollaborationMember } from '../../../../contracts/team-collaboration'
import { boardRequest, errorText } from './board-api'
import { memberName, ownMentionableMembers, isAccessDenied } from './board-model'
import { useBoardT } from './board-i18n'
import { BoardError, BoardModal, DiscardPrompt, MarkdownEditor } from './issue-fields'
import styles from './board-styles.module.css'

export function DiscussionCreate({ issue, members, userId, disabled, onCreated, onClose }: {
  issue: CollaborationIssue; members: CollaborationMember[]; userId: string | null; disabled: boolean; onCreated(discussion: CollaborationDiscussion): void; onClose(): void
}) {
  const t = useBoardT(), available = ownMentionableMembers(members, userId)
  const [title, setTitle] = useState(issue.title), [description, setDescription] = useState(issue.description)
  const [memberIds, setMemberIds] = useState<string[]>(members.filter(member => member.kind === 'human' && member.userId === userId).map(member => member.id))
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [denied, setDenied] = useState(false), [discard, setDiscard] = useState(false)
  async function create() {
    if (busy || disabled || denied || !title.trim()) return
    setBusy(true); setError('')
    try {
      const result = await boardRequest({ type: 'discussions.create', projectId: issue.projectId, title: title.trim(), description, memberIds, issueIds: [issue.id] })
      onCreated(result)
    } catch (cause) { setError(errorText(cause, t)); if (isAccessDenied(cause)) setDenied(true) }
    finally { setBusy(false) }
  }
  const close = () => { if (title !== issue.title || description !== issue.description) setDiscard(true); else onClose() }
  return <><BoardModal title={t('startDiscussion')} onClose={close} busy={busy}>
    <form onSubmit={event => { event.preventDefault(); void create() }}>
      <div className={styles.modalBody}><BoardError message={error} /><span className={styles.identifier}>{issue.identifier}</span><input aria-label={t('discussionTitle')} placeholder={t('discussionTitle')} value={title} maxLength={500} disabled={busy || disabled || denied} onChange={event => setTitle(event.target.value)} />
        <MarkdownEditor value={description} disabled={busy || disabled || denied} label={t('discussionDescription')} onChange={setDescription} />
        <fieldset className={styles.memberPicker}><legend>{t('chooseMembers')}</legend>{available.map(member => <label className={styles.checkbox} key={member.id}><input type="checkbox" checked={memberIds.includes(member.id)} disabled={busy || disabled || denied || (member.kind === 'human' && member.userId === userId)} onChange={event => setMemberIds(current => event.target.checked ? [...current, member.id] : current.filter(id => id !== member.id))} />{memberName(member)}{member.kind === 'agent' && <span className={styles.badge}>Agent</span>}</label>)}</fieldset><p className={styles.muted}>{t('ownAgentsOnly')}</p>
      </div><footer className={styles.modalFooter}><button type="button" disabled={busy} onClick={close}>{t('cancel')}</button><button className={styles.primary} disabled={busy || disabled || denied || !title.trim()}>{busy ? t('saving') : t('create')}</button></footer>
    </form>
  </BoardModal>{discard && <DiscardPrompt onDiscard={onClose} onKeep={() => setDiscard(false)} />}</>
}
