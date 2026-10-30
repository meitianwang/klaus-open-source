import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { CollaborationIssueInput, CollaborationMember } from '../../../../contracts/team-collaboration'
import { ModalPortal } from '../../components/ModalPortal'
import { Icon } from '../../components/Icon'
import { renderMarkdownHtml } from '../../chat/markdown'
import { ISSUE_PRIORITIES, ISSUE_STATUSES, memberName } from './board-model'
import { useBoardT } from './board-i18n'
import styles from './board-styles.module.css'

export function BoardModal({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose(): void; busy?: boolean }) {
  const t = useBoardT(), root = useRef<HTMLDivElement>(null), close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const el = root.current
    el?.querySelector<HTMLElement>('input, textarea, button')?.focus()
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); if (!busy) close.current() }
      if (event.key !== 'Tab' || !el) return
      const nodes = [...el.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]')].filter(node => node.getClientRects().length)
      const first = nodes[0], last = nodes[nodes.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
    document.addEventListener('keydown', keyboard, true)
    return () => { document.removeEventListener('keydown', keyboard, true); previous?.focus() }
  }, [busy])
  return <ModalPortal><div className={styles.overlay} onMouseDown={event => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div ref={root} className={styles.modal} role="dialog" aria-modal="true" aria-label={title}>
      <header className={styles.modalHeader}><h2>{title}</h2><button type="button" aria-label={t('close')} disabled={busy} onClick={onClose}><Icon name="close" size={18} /></button></header>
      {children}
    </div>
  </div></ModalPortal>
}
export function BoardError({ message, retry }: { message: string; retry?: () => void }) {
  const t = useBoardT()
  return message ? <div role="alert" className={styles.error}>{message}{retry && <button type="button" onClick={retry}>{t('retry')}</button>}</div> : null
}
export function MarkdownBody({ value }: { value: string }) {
  return <div className={styles.markdown} dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(value) }} />
}
export function MarkdownEditor({ value, onChange, disabled, label }: { value: string; onChange(value: string): void; disabled?: boolean; label?: string }) {
  const t = useBoardT(), [preview, setPreview] = useState(false)
  return <div className={styles.markdownEditor}>
    <div className={styles.editorTabs}><button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>{t('edit')}</button><button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>{t('preview')}</button><span>Markdown</span></div>
    {preview ? <MarkdownBody value={value} /> : <textarea aria-label={label || t('description')} disabled={disabled} value={value} placeholder={t('issueDescription')} onChange={event => onChange(event.target.value)} rows={7} />}
  </div>
}
export function IssueFields({ value, onChange, members, disabled, includeTitle = true }: { value: CollaborationIssueInput; onChange(value: CollaborationIssueInput): void; members: CollaborationMember[]; disabled?: boolean; includeTitle?: boolean }) {
  const t = useBoardT()
  return <div className={styles.issueFields}>
    {includeTitle && <><input className={styles.titleInput} aria-label={t('title')} autoFocus maxLength={500} placeholder={t('issueTitle')} value={value.title} disabled={disabled} onChange={event => onChange({ ...value, title: event.target.value })} />
      <MarkdownEditor value={value.description || ''} disabled={disabled} onChange={description => onChange({ ...value, description })} /></>}
    <div className={styles.fieldRow}>
      <label>{t('status')}<select value={value.status || 'backlog'} disabled={disabled} onChange={event => onChange({ ...value, status: event.target.value as CollaborationIssueInput['status'] })}>{ISSUE_STATUSES.map(status => <option key={status} value={status}>{t(status)}</option>)}</select></label>
      <label>{t('priority')}<select value={value.priority || 'none'} disabled={disabled} onChange={event => onChange({ ...value, priority: event.target.value as CollaborationIssueInput['priority'] })}>{ISSUE_PRIORITIES.map(priority => <option key={priority} value={priority}>{t(priority)}</option>)}</select></label>
      <label>{t('assignee')}<select value={value.assigneeMemberId || ''} disabled={disabled} onChange={event => onChange({ ...value, assigneeMemberId: event.target.value || null })}><option value="">{t('unassigned')}</option>{members.map(member => <option key={member.id} value={member.id}>{memberName(member)}{member.kind === 'agent' ? ' · Agent' : ''}</option>)}</select></label>
      <label>{t('cycle')}<input value={value.cycle || ''} disabled={disabled} maxLength={120} placeholder={t('uncycled')} onChange={event => onChange({ ...value, cycle: event.target.value || null })} /></label>
    </div>
  </div>
}
export function DiscardPrompt({ onDiscard, onKeep }: { onDiscard(): void; onKeep(): void }) {
  const t = useBoardT()
  return <BoardModal title={t('unsaved')} onClose={onKeep}><div className={styles.modalFooter}><button onClick={onKeep}>{t('keepEditing')}</button><button className={styles.danger} onClick={onDiscard}>{t('discard')}</button></div></BoardModal>
}
