import { useState } from 'react'
import { canManageProject, collaborationBridge, projectInputError, request, useMutation, useResource, type CollaborationProject } from './data'
import { ProjectFields, projectInput, type ProjectFieldsValue } from './project-form'
import { ErrorNotice, Loading, Modal } from './primitives'
import { useT } from './i18n'
import styles from './team-collaboration.module.css'

export type ProjectAction = 'archive' | 'restore' | 'delete'
export function ProjectActionModal({ project, action, onClose, onChanged }: { project: CollaborationProject; action: ProjectAction; onClose: () => void; onChanged: () => void }) {
  const t = useT()
  const [confirmName, setConfirmName] = useState('')
  const mutation = useMutation()
  const title = t(`tc_${action}`)
  return <Modal title={title} onClose={onClose} busy={mutation.pending}>
    <form className={styles.modalBody} onSubmit={event => {
      event.preventDefault()
      void mutation.run(async () => action === 'delete'
        ? request({ type: 'projects.delete', projectId: project.id, version: project.version, confirmName })
        : action === 'archive'
          ? request({ type: 'projects.archive', projectId: project.id, version: project.version })
          : request({ type: 'projects.restore', projectId: project.id, version: project.version }), onChanged)
    }}>
      <p>{t(`tc_${action}_body`)}</p><strong>{project.name}</strong>
      {action === 'delete' && <label className={styles.field}>{t('tc_name')}<input data-autofocus value={confirmName} onChange={event => setConfirmName(event.target.value)} autoComplete="off" /></label>}
      <ErrorNotice error={mutation.error} />
      <footer className={styles.modalFooter}><button type="button" disabled={mutation.pending} onClick={onClose}>{t('tc_cancel')}</button><button className={action === 'delete' ? styles.dangerButton : styles.primaryButton} disabled={mutation.pending || (action === 'delete' && confirmName !== project.name)}>{mutation.pending ? t('tc_saving') : title}</button></footer>
    </form>
  </Modal>
}

export function ProjectSettingsModal({ project, onClose, onChanged }: { project: CollaborationProject; onClose: () => void; onChanged: () => void }) {
  const t = useT()
  const [value, setValue] = useState<ProjectFieldsValue>({ name: project.name, identifier: project.identifier, description: project.description, coverIcon: project.coverIcon, coverColor: project.coverColor, repositoryUrl: project.repositoryUrl || '' })
  const canEdit = canManageProject(project) && !project.archivedAt
  const binding = useResource(() => collaborationBridge().localBinding(project.id), [project.id], project.id)
  const localMutation = useMutation()
  const mutation = useMutation()
  return <Modal title={t('tc_settings')} onClose={onClose} busy={mutation.pending || localMutation.pending}>
    <form className={styles.modalBody} onSubmit={event => {
      event.preventDefault()
      const input = projectInput(value), validation = projectInputError(input)
      if (validation) { mutation.setError(t(validation)); return }
      void mutation.run(() => request({ type: 'projects.update', projectId: project.id, version: project.version, patch: input }), onChanged)
    }}>
      {!canEdit && <p className={styles.hint}>{t(project.archivedAt ? 'tc_project_archived_notice' : 'tc_no_permission')}</p>}
      <ProjectFields value={value} onChange={setValue} disabled={!canEdit || mutation.pending} />
      <section className={styles.localBinding}><h3>{t('tc_local_folder')}</h3><p className={styles.hint}>{t('tc_local_folder_hint')}</p>
        {binding.pending && !binding.data ? <Loading /> : <code className={styles.folderPath}>{binding.data?.localFolder || t('tc_local_folder_none')}</code>}
        <ErrorNotice error={binding.error} onRetry={binding.refresh} /><ErrorNotice error={localMutation.error} />
        <div className={styles.actions}><button type="button" disabled={localMutation.pending} onClick={() => void localMutation.run(() => collaborationBridge().pickLocalFolder(project.id), binding.refresh)}>{t('tc_local_folder_choose')}</button><button type="button" disabled={!binding.data?.localFolder || localMutation.pending} onClick={() => void localMutation.run(() => collaborationBridge().setLocalBinding(project.id, null), binding.refresh)}>{t('tc_local_folder_clear')}</button></div>
      </section>
      <ErrorNotice error={mutation.error} />
      <footer className={styles.modalFooter}><button type="button" disabled={mutation.pending || localMutation.pending} onClick={onClose}>{t('tc_cancel')}</button>{canEdit && <button className={styles.primaryButton} disabled={mutation.pending}>{mutation.pending ? t('tc_saving') : t('tc_save')}</button>}</footer>
    </form>
  </Modal>
}
