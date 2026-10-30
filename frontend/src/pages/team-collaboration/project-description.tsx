import { useState } from 'react'
import { canManageProject, request, useMutation, type CollaborationProject } from './data'
import { ErrorNotice, Icon, Modal } from './primitives'
import { PROJECT_DESCRIPTION_LIMIT } from './project-model'
import { useT } from './i18n'
import styles from './team-collaboration.module.css'

export function ProjectDescription({ project, onChanged }: { project: CollaborationProject; onChanged: () => void }) {
  const t = useT()
  const [editing, setEditing] = useState<CollaborationProject | null>(null)
  const [description, setDescription] = useState('')
  const mutation = useMutation()
  return <><div className={styles.projectDescription}><span>{project.description || t('tc_no_description')}</span>{canManageProject(project) && !project.archivedAt && <button type="button" className={styles.descriptionEdit} aria-label={t('tc_edit_description')} onClick={() => { mutation.setError(''); setDescription(project.description); setEditing(project) }}><Icon name="tc-edit" size={14} /></button>}</div>
    {editing && <Modal width={520} title={t('tc_edit_description')} onClose={() => setEditing(null)} busy={mutation.pending}><form className={styles.modalBody} onSubmit={event => {
      event.preventDefault()
      if (description.trim() === editing.description) { setEditing(null); return }
      void mutation.run(() => request({ type: 'projects.update', projectId: project.id, version: editing.version, patch: { description: description.trim() } }), () => { setEditing(null); onChanged() })
    }}><textarea className={styles.descriptionTextarea} data-autofocus aria-label={t('tc_description')} value={description} maxLength={PROJECT_DESCRIPTION_LIMIT} rows={5} onChange={event => setDescription(event.target.value)} /><div className={styles.characterCount}>{description.length}/{PROJECT_DESCRIPTION_LIMIT}</div><ErrorNotice error={mutation.error} /><footer className={styles.modalFooter}><button type="button" disabled={mutation.pending} onClick={() => setEditing(null)}>{t('tc_cancel')}</button><button className={styles.primaryButton} disabled={mutation.pending || !canManageProject(project) || !!project.archivedAt}>{mutation.pending ? t('tc_saving') : t('tc_save')}</button></footer></form></Modal>}
  </>
}
