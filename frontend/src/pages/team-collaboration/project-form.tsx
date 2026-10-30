import { useId, useRef, useState } from 'react'
import type { CollaborationProject, CollaborationProjectInput } from './data'
import { projectInputError, request, useMutation } from './data'
import { applyProjectDraftPatch, identifierPadding, PROJECT_DESCRIPTION_LIMIT, PROJECT_NAME_LIMIT, suggestProjectIdentifier, type ProjectFormValue } from './project-model'
import { ProjectAgentDraft } from './project-agent-draft'
import { CoverPicker, ErrorNotice, Icon, Modal } from './primitives'
import { useT } from './i18n'
import styles from './team-collaboration.module.css'

export type ProjectFieldsValue = ProjectFormValue
export const emptyProject = (padding: string): ProjectFieldsValue => ({ name: '', identifier: padding, description: '', repositoryUrl: '', coverIcon: 'gyro', coverColor: '#8877d9' })
export function ProjectFields({ value, onChange, disabled = false, onIdentifierEdited }: { value: ProjectFieldsValue; onChange: (value: ProjectFieldsValue) => void; disabled?: boolean; onIdentifierEdited?: () => void }) {
  const t = useT()
  const id = useId()
  const update = (patch: Partial<ProjectFieldsValue>) => onChange({ ...value, ...patch })
  return <fieldset disabled={disabled} className={styles.projectFields}>
    <CoverPicker icon={value.coverIcon} color={value.coverColor} onChange={update} />
    <div className={styles.field}><label htmlFor={`${id}-name`}>{t('tc_name')}</label><div className={styles.nameFields}><input id={`${id}-name`} data-autofocus required autoComplete="off" maxLength={PROJECT_NAME_LIMIT} value={value.name} placeholder={t('tc_name_placeholder')} onChange={event => update({ name: event.target.value })} /><span aria-hidden="true" /><input aria-label={t('tc_identifier')} autoComplete="off" required maxLength={3} pattern="[A-Z]{3}" value={value.identifier} onChange={event => { onIdentifierEdited?.(); update({ identifier: event.target.value.toUpperCase() }) }} /></div></div>
    <label>{t('tc_description')}<textarea maxLength={PROJECT_DESCRIPTION_LIMIT} rows={4} value={value.description} placeholder={t('tc_description_placeholder')} onChange={event => update({ description: event.target.value })} /><span className={styles.characterCount}>{value.description.length}/{PROJECT_DESCRIPTION_LIMIT}</span></label>
    <label className={styles.repositoryField}>{t('tc_repository')}<input value={value.repositoryUrl} maxLength={2048} placeholder="https://github.com/team/project" onChange={event => update({ repositoryUrl: event.target.value })} /><small>{t('tc_repository_hint')}</small></label>
  </fieldset>
}
export function projectInput(value: ProjectFieldsValue): CollaborationProjectInput {
  return { ...value, name: value.name.trim(), description: value.description.trim(), repositoryUrl: value.repositoryUrl || null }
}

export function ProjectCreateModal({ onClose, onCreated }: { onClose: () => void; onCreated: (project: CollaborationProject) => void }) {
  const t = useT()
  const formId = useId()
  const [padding] = useState(identifierPadding)
  const [value, setValue] = useState(() => emptyProject(padding))
  const [agent, setAgent] = useState(false)
  const identifierEdited = useRef(false)
  const mutation = useMutation()
  const updateValue = (next: ProjectFieldsValue) => setValue({ ...next, identifier: identifierEdited.current ? next.identifier : suggestProjectIdentifier(next.name, padding) })
  return <Modal title={t('tc_new')} onClose={onClose} wide={agent} busy={mutation.pending} headerActions={<button type="button" className={styles.agentToggle} aria-expanded={agent} disabled={mutation.pending} onClick={() => setAgent(!agent)}><Icon name="tc-sparkle" size={16} />{t(agent ? 'tc_agent_hide' : 'tc_agent_create')}</button>}>
    <div className={`${styles.createColumns} ${agent ? styles.withAgent : ''}`}>
      <form id={formId} className={styles.createManual} onSubmit={event => {
        event.preventDefault()
        const input = projectInput(value), validation = projectInputError(input)
        if (validation) { mutation.setError(t(validation)); return }
        void mutation.run(() => request({ type: 'projects.create', ...input }), onCreated)
      }}><ProjectFields value={value} onChange={updateValue} onIdentifierEdited={() => { identifierEdited.current = true }} disabled={mutation.pending} /><ErrorNotice error={mutation.error} /></form>
      {agent && <ProjectAgentDraft form={value} onDraftPatch={(patch, snapshot) => setValue(current => {
        const next = applyProjectDraftPatch(current, snapshot, patch)
        return { ...next, identifier: identifierEdited.current ? next.identifier : suggestProjectIdentifier(next.name, padding) }
      })} />}
    </div>
    <footer className={`${styles.modalFooter} ${styles.createFooter}`}><button type="button" disabled={mutation.pending} onClick={onClose}>{t('tc_cancel')}</button><button type="submit" form={formId} className={styles.primaryButton} disabled={mutation.pending || !value.name.trim() || value.description.length > PROJECT_DESCRIPTION_LIMIT}>{mutation.pending ? t('tc_saving') : t('tc_create')}</button></footer>
  </Modal>
}
