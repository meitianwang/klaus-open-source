import { useCallback, useEffect, useRef, useState } from 'react'
import type { CollaborationDiscussion, CollaborationIssue, CollaborationIssueInput, CollaborationMember, CollaborationProject } from '../../../../contracts/team-collaboration'
import { Icon } from '../../components/Icon'
import { allPages, boardRequest, errorText } from './board-api'
import { canWriteProject, isAccessDenied, isConflict, issueDeepLink } from './board-model'
import { canManageProject } from './data'
import { useBoardT } from './board-i18n'
import { BoardError, BoardModal, DiscardPrompt, IssueFields, MarkdownBody } from './issue-fields'
import { DiscussionCreate } from './discussion-create'
import { IssueExecutions } from './issue-executions'
import { IssueReactions, IssueActivity } from './issue-reactions'
import { IssueAttachments } from './issue-attachments'
import { IssueDelete } from './issue-delete'
import styles from './board-styles.module.css'

function issueDraft(issue?: CollaborationIssue): CollaborationIssueInput {
  return { title: issue?.title || '', description: issue?.description || '', status: issue?.status || 'backlog', priority: issue?.priority || 'none', assigneeMemberId: issue?.assigneeMemberId || null, cycle: issue?.cycle || null }
}
export function IssueDetail({ issueId, initialIssue, project, members, userId, revision, accessDenied, onClose, onChanged, onDiscussion, onDeleted, previousIssueId, nextIssueId, onNavigate, expanded = false, onToggleExpanded }: {
  issueId: string; initialIssue?: CollaborationIssue; project: CollaborationProject; members: CollaborationMember[]; userId: string | null; revision: number; accessDenied: boolean;
  onClose(): void; onChanged(issue: CollaborationIssue): void; onDiscussion(discussion: CollaborationDiscussion): void; onDeleted(issueId: string): void;
  previousIssueId?: string | null; nextIssueId?: string | null; onNavigate?(issueId: string): void; expanded?: boolean; onToggleExpanded?(): void
}) {
  const t = useBoardT(), [issue, setIssue] = useState(initialIssue), [form, setForm] = useState(() => issueDraft(initialIssue)), [baseline, setBaseline] = useState(() => issueDraft(initialIssue))
  const [loading, setLoading] = useState(!initialIssue), [error, setError] = useState(''), [busy, setBusy] = useState(false), [denied, setDenied] = useState(false), [remoteChanged, setRemoteChanged] = useState(false)
  const [discussions, setDiscussions] = useState<CollaborationDiscussion[]>([]), [createDiscussion, setCreateDiscussion] = useState(false), [archiveConfirm, setArchiveConfirm] = useState(false), [discard, setDiscard] = useState<(() => void) | null>(null)
  const [executionRevision, setExecutionRevision] = useState(0), [copied, setCopied] = useState(false), [deleteOpen, setDeleteOpen] = useState(false), [panelRevision, setPanelRevision] = useState(0)
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline), dirtyRef = useRef(dirty), versionRef = useRef(issue?.version), sequence = useRef(0)
  dirtyRef.current = dirty; versionRef.current = issue?.version
  const projectWritable = !accessDenied && !denied && canWriteProject(project, members, userId), writable = projectWritable && !issue?.archivedAt
  // `administrator()` on the server is owner-or-admin, and deletion is legal on an
  // archived issue; `writable` is false in exactly that state.
  const deletable = !accessDenied && !denied && canManageProject(project)
  const load = useCallback(async () => {
    const id = ++sequence.current
    try {
      const [latest, linked, archived] = await Promise.all([
        boardRequest({ type: 'issues.get', projectId: project.id, issueId }),
        allPages(cursor => boardRequest({ type: 'discussions.list', projectId: project.id, issueId, cursor, limit: 100 })),
        allPages(cursor => boardRequest({ type: 'discussions.list', projectId: project.id, issueId, archived: true, cursor, limit: 100 })),
      ])
      if (id !== sequence.current) return
      if (!dirtyRef.current) { setForm(issueDraft(latest)); setBaseline(issueDraft(latest)); setRemoteChanged(false) }
      else if (versionRef.current !== latest.version) setRemoteChanged(true)
      setIssue(latest); setDiscussions([...linked, ...archived]); setLoading(false); setDenied(false)
    } catch (cause) { if (id === sequence.current) { setLoading(false); setError(errorText(cause, t)); if (isAccessDenied(cause)) setDenied(true) } }
  }, [project.id, issueId])
  useEffect(() => { void load(); return () => { sequence.current++ } }, [load, revision])
  async function save() {
    if (!issue || !writable || busy || !form.title.trim()) return
    setBusy(true); setError('')
    try {
      const updated = await boardRequest({ type: 'issues.update', projectId: project.id, issueId, version: issue.version, patch: { ...form, title: form.title.trim() } })
      dirtyRef.current = false; setIssue(updated); setForm(issueDraft(updated)); setBaseline(issueDraft(updated)); setRemoteChanged(false); onChanged(updated)
    } catch (cause) { setError(errorText(cause, t)); if (isAccessDenied(cause)) setDenied(true); if (isConflict(cause)) setRemoteChanged(true); await load() }
    finally { setBusy(false) }
  }
  async function archive() {
    if (!issue || !projectWritable || busy) return
    setBusy(true); setError('')
    try {
      const updated = await boardRequest({ type: issue.archivedAt ? 'issues.restore' : 'issues.archive', projectId: project.id, issueId, version: issue.version })
      setIssue(updated); setArchiveConfirm(false); onChanged(updated)
    } catch (cause) { setError(errorText(cause, t)); if (isAccessDenied(cause)) setDenied(true); await load() }
    finally { setBusy(false) }
  }
  function navigate(action: () => void) { if (dirty) setDiscard(() => action); else action() }
  async function copyLink() {
    try {
      const clipboard = (window as unknown as { klaus?: { clipboard?: { writeText(text: string): Promise<unknown> } } }).klaus?.clipboard
      const link = issueDeepLink(project.id, issueId)
      if (clipboard) await clipboard.writeText(link); else await navigator.clipboard.writeText(link)
      setCopied(true)
    } catch (cause) { setError(errorText(cause, t)) }
  }
  if (loading) return <div className={styles.empty} role="status">{t('loading')}</div>
  if (!issue || denied || accessDenied) return <section className={styles.detailRoot}><button onClick={onClose}>{t('back')}</button><BoardError message={error || t('accessDenied')} retry={() => void load()} /></section>
  return <section className={styles.detailRoot} aria-label={issue.identifier}>
    <header className={styles.detailHeader}><button onClick={() => navigate(onClose)}><Icon name="back" size={16} />{t('back')}</button><span className={styles.identifier}>{issue.identifier}</span>{issue.archivedAt && <span>{t('readOnly')}</span>}<span className={styles.spacer} /><button disabled={!projectWritable || busy || dirty} onClick={() => issue.archivedAt ? void archive() : setArchiveConfirm(true)}>{issue.archivedAt ? t('restore') : t('archive')}</button><button className={styles.danger} disabled={!deletable || busy || dirty || !issue.archivedAt} onClick={() => setDeleteOpen(true)}>{t('deleteIssue')}</button><button className={styles.primary} disabled={!writable || busy || dirty} onClick={() => setCreateDiscussion(true)}>{t('startDiscussion')}</button></header>
    <nav className={styles.detailNavigation} aria-label={issue.identifier}><button aria-label={t('previousIssue')} disabled={!previousIssueId || !onNavigate || busy} onClick={() => navigate(() => onNavigate?.(previousIssueId!))}><Icon name="back" size={16} />{t('previousIssue')}</button><button aria-label={t('nextIssue')} disabled={!nextIssueId || !onNavigate || busy} onClick={() => navigate(() => onNavigate?.(nextIssueId!))}>{t('nextIssue')}<Icon name="chevron-right" size={16} /></button><span className={styles.spacer} /><button onClick={() => void copyLink()}><Icon name="copy" size={15} />{copied ? t('linkCopied') : t('copyLink')}</button>{onToggleExpanded && <button aria-expanded={expanded} onClick={onToggleExpanded}>{expanded ? t('collapseDetail') : t('expandDetail')}</button>}</nav>
    <BoardError message={error} retry={() => void load()} />
    {remoteChanged && <div className={styles.notice}><p>{t('remoteChanges')}</p><details><summary>{t('preview')}</summary><h3>{issue.title}</h3><MarkdownBody value={issue.description} /></details></div>}
    <div className={styles.detailColumns}><main className={styles.issueMain}>
      <IssueFields value={form} onChange={setForm} members={members} disabled={!writable || busy} />
      <IssueReactions projectId={project.id} issueId={issue.id} disabled={!!issue.archivedAt} revision={revision + panelRevision} onChanged={() => setPanelRevision(value => value + 1)} onDenied={() => setDenied(true)} />
      {dirty && <div className={styles.saveBar}><span>{t('unsaved')}</span><span className={styles.spacer} /><button disabled={busy} onClick={() => { setForm(issueDraft(issue)); setBaseline(issueDraft(issue)); setRemoteChanged(false) }}>{t('discard')}</button><button className={styles.primary} disabled={!writable || busy || !form.title.trim()} onClick={() => void save()}>{busy ? t('saving') : t('save')}</button></div>}
      <IssueExecutions project={project} issue={issue} members={members} userId={userId} disabled={!writable || dirty} revision={revision + executionRevision} onChanged={() => { setExecutionRevision(value => value + 1); void load() }} />
      <IssueAttachments projectId={project.id} issueId={issue.id} writable={writable} revision={revision + panelRevision} onChanged={() => setPanelRevision(value => value + 1)} onDenied={() => setDenied(true)} />
    </main><aside className={styles.issueAside}><h3>{t('linkedDiscussions')}</h3>{!discussions.length && <p className={styles.muted}>{t('noDiscussions')}</p>}{discussions.map(discussion => <button key={discussion.id} className={styles.linkCard} onClick={() => navigate(() => onDiscussion(discussion))}><strong>{discussion.title}</strong>{discussion.archivedAt && <span>{t('archived')}</span>}<time dateTime={discussion.updatedAt}>{new Date(discussion.updatedAt).toLocaleDateString()}</time></button>)}<dl className={styles.metadata}><dt>{t('created')}</dt><dd>{new Date(issue.createdAt).toLocaleString()}</dd><dt>{t('updated')}</dt><dd>{new Date(issue.updatedAt).toLocaleString()}</dd></dl><IssueActivity projectId={project.id} issueId={issue.id} revision={revision + panelRevision} onDenied={() => setDenied(true)} /></aside></div>
    {createDiscussion && <DiscussionCreate issue={issue} members={members} userId={userId} disabled={!writable} onClose={() => setCreateDiscussion(false)} onCreated={discussion => { setCreateDiscussion(false); onDiscussion(discussion) }} />}
    {archiveConfirm && <BoardModal title={t('archive')} busy={busy} onClose={() => setArchiveConfirm(false)}><p className={styles.modalBody}>{t('archiveConfirm')}</p><footer className={styles.modalFooter}><button disabled={busy} onClick={() => setArchiveConfirm(false)}>{t('cancel')}</button><button className={styles.danger} disabled={!projectWritable || busy} onClick={() => void archive()}>{t('archive')}</button></footer></BoardModal>}
    {deleteOpen && <IssueDelete project={project} issue={issue} writable={deletable} onClose={() => setDeleteOpen(false)} onDenied={() => setDenied(true)} onDeleted={() => onDeleted(issue.id)} onChanged={() => { setDeleteOpen(false); void load() }} />}
    {discard && <DiscardPrompt onKeep={() => setDiscard(null)} onDiscard={() => { const action = discard; setDiscard(null); action() }} />}
  </section>
}
