import { useState } from 'react'
import type { CollaborationIssue, CollaborationIssueInput, CollaborationIssueStatus, CollaborationMember } from '../../../../contracts/team-collaboration'
import { boardRequest, errorText } from './board-api'
import { useBoardT } from './board-i18n'
import { BoardError, BoardModal, DiscardPrompt, IssueFields } from './issue-fields'
import { AttachmentPicker, uploadDraftAttachments, type DraftAttachmentFile } from './issue-attachments'
import { isAccessDenied, isConflict } from './board-model'
import styles from './board-styles.module.css'

/** The server accepts 100 files in a scope; the create draft stays well under it. */
const CREATE_ATTACHMENT_LIMIT = 20

export function IssueCreate({ projectId, members, initialStatus, onCreated, onClose, disabled = false }: {
  projectId: string; members: CollaborationMember[]; initialStatus: CollaborationIssueStatus;
  onCreated(issue: CollaborationIssue): void; onClose(): void; disabled?: boolean
}) {
  const t = useBoardT()
  const [form, setForm] = useState<CollaborationIssueInput>({ title: '', description: '', status: initialStatus, priority: 'none', assigneeMemberId: null, cycle: null })
  const [files, setFiles] = useState<DraftAttachmentFile[]>([])
  const [busy, setBusy] = useState(false), [keep, setKeep] = useState(false), [error, setError] = useState(''), [denied, setDenied] = useState(false), [discard, setDiscard] = useState(false)
  const close = () => { if (form.title || form.description || files.length) setDiscard(true); else onClose() }
  async function submit() {
    if (!form.title.trim() || busy || disabled || denied) return
    setBusy(true); setError('')
    try {
      // Upload first: the ids go into issues.create, which transfers them to the
      // new Issue in its own transaction. A rejected id rolls the whole create
      // back, so a failed attempt leaves nothing under the project root scope.
      const attachmentIds = files.length ? await uploadDraftAttachments(projectId, files) : undefined
      const issue = await boardRequest({ type: 'issues.create', projectId, ...form, title: form.title.trim(), ...(attachmentIds ? { attachmentIds } : {}) })
      onCreated(issue)
      if (keep) { setForm(current => ({ ...current, title: '', description: '' })); setFiles([]) }
      else onClose()
    } catch (cause) {
      setError(isConflict(cause) ? t('conflict') : errorText(cause, t))
      if (isAccessDenied(cause)) setDenied(true)
    }
    finally { setBusy(false) }
  }
  return <>
    <BoardModal title={t('createIssue')} busy={busy} onClose={close}>
      <form onSubmit={event => { event.preventDefault(); void submit() }}>
        <BoardError message={error} />
        <IssueFields value={form} onChange={setForm} members={members} disabled={busy || disabled || denied} />
        <div className={styles.modalBody}><AttachmentPicker files={files} disabled={busy || disabled || denied} max={CREATE_ATTACHMENT_LIMIT} onChange={setFiles} onError={setError} /></div>
        <footer className={styles.modalFooter}><label className={styles.checkbox}><input type="checkbox" checked={keep} onChange={event => setKeep(event.target.checked)} />{t('keepCreating')}</label><span className={styles.spacer} /><button type="button" disabled={busy} onClick={close}>{t('cancel')}</button><button className={styles.primary} disabled={busy || disabled || denied || !form.title.trim()}>{busy ? t('saving') : t('create')}</button></footer>
      </form>
    </BoardModal>
    {discard && <DiscardPrompt onDiscard={onClose} onKeep={() => setDiscard(false)} />}
  </>
}
