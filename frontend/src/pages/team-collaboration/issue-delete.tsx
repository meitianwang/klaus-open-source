import { useState } from 'react'
import type { CollaborationIssue, CollaborationProject } from '../../../../contracts/team-collaboration'
import { boardRequest, errorText } from './board-api'
import { isAccessDenied, isConflict } from './board-model'
import { useBoardT } from './board-i18n'
import { BoardError, BoardModal } from './issue-fields'
import styles from './board-styles.module.css'

/**
 * Permanent Issue deletion.
 *
 * The server requires four things and refuses in a different way for each, so the
 * dialog shows the state it is in rather than letting a doomed request through:
 * the ISSUE must already be archived (archive_before_delete — the project being
 * archived is not part of this check), the caller must be owner or admin
 * (admin_required), the version must match (version_conflict), and the typed text
 * must be the Issue identifier (confirmation_mismatch).
 */
export function IssueDelete({ project, issue, writable, onDeleted, onClose, onDenied, onChanged }: {
  project: CollaborationProject; issue: CollaborationIssue; writable: boolean;
  onDeleted(): void; onClose(): void; onDenied(): void; onChanged(): void
}) {
  const t = useBoardT(), [confirm, setConfirm] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const archived = !!issue.archivedAt
  const ready = writable && archived && confirm === issue.identifier
  async function submit() {
    if (!ready || busy) return
    setBusy(true); setError('')
    try {
      await boardRequest({ type: 'issues.delete', projectId: project.id, issueId: issue.id, version: issue.version, confirmIdentifier: confirm })
      onDeleted()
    } catch (cause) {
      setError(errorText(cause, t))
      if (isAccessDenied(cause)) onDenied()
      if (isConflict(cause)) onChanged()
    }
    finally { setBusy(false) }
  }
  return <BoardModal title={t('deleteIssue')} onClose={onClose} busy={busy}>
    <div className={styles.modalBody}>
      <BoardError message={error} />
      <p>{t('deleteIssueBody')}</p>
      {!archived && <p className={styles.notice}>{t('deleteIssueArchiveFirst')}</p>}
      <ul className={styles.retainedList}><li>{t('deleteIssueRetainsDiscussions')}</li><li>{t('deleteIssueRetainsLinks')}</li><li>{t('deleteIssueRemovesAttachments')}</li></ul>
      <label>{t('deleteIssueConfirm').replace('{identifier}', issue.identifier)}
        <input value={confirm} disabled={busy || !writable || !archived} placeholder={issue.identifier} onChange={event => setConfirm(event.target.value)} />
      </label>
    </div>
    <footer className={styles.modalFooter}><button type="button" disabled={busy} onClick={onClose}>{t('cancel')}</button><button type="button" className={styles.danger} disabled={busy || !ready} onClick={() => void submit()}>{busy ? t('saving') : t('deleteForever')}</button></footer>
  </BoardModal>
}
