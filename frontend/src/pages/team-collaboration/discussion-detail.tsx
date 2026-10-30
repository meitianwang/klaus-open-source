import { useCallback, useEffect, useRef, useState } from 'react'
import type { CollaborationDiscussion, CollaborationDiscussionMember, CollaborationIssue, CollaborationMember, CollaborationMessage, CollaborationProject } from '../../../../contracts/team-collaboration'
import { Icon } from '../../components/Icon'
import { allPages, boardRequest, errorText } from './board-api'
import { canWriteProject, isAccessDenied, memberName, ownMentionableMembers } from './board-model'
import { useBoardT } from './board-i18n'
import { BoardError, BoardModal, DiscardPrompt, MarkdownBody, MarkdownEditor } from './issue-fields'
import { DiscussionMessages } from './discussion-messages'
import { DiscussionSources } from './discussion-sources'
import { IssueExecutions } from './issue-executions'
import styles from './board-styles.module.css'

export function DiscussionDetail({ project, members, discussionId, userId, revision, accessDenied, onBack, onIssue, onChanged }: {
  project: CollaborationProject; members: CollaborationMember[]; discussionId: string; userId: string | null; revision: number; accessDenied: boolean;
  onBack(): void; onIssue(issue: CollaborationIssue): void; onChanged(): void
}) {
  const t = useBoardT(), [discussion, setDiscussion] = useState<CollaborationDiscussion | null>(null), [messages, setMessages] = useState<CollaborationMessage[]>([])
  const [discussionMembers, setDiscussionMembers] = useState<CollaborationDiscussionMember[]>([]), [linked, setLinked] = useState<CollaborationIssue[]>([]), [issues, setIssues] = useState<CollaborationIssue[]>([])
  const [error, setError] = useState(''), [denied, setDenied] = useState(false), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true), [messageDirty, setMessageDirty] = useState(false)
  const [archiveConfirm, setArchiveConfirm] = useState(false), [editing, setEditing] = useState(false), [title, setTitle] = useState(''), [description, setDescription] = useState(''), [editBaseVersion, setEditBaseVersion] = useState(0)
  const [memberToAdd, setMemberToAdd] = useState(''), [issueToLink, setIssueToLink] = useState(''), [executionIssueId, setExecutionIssueId] = useState(''), [discard, setDiscard] = useState<(() => void) | null>(null)
  const sequence = useRef(0)
  const writableProject = !accessDenied && !denied && canWriteProject(project, members, userId), writable = writableProject && !discussion?.archivedAt
  const ownMember = members.find(member => member.kind === 'human' && member.userId === userId)
  const participants = members.filter(member => discussionMembers.some(entry => entry.memberId === member.id))
  const joined = !!ownMember && discussionMembers.some(entry => entry.memberId === ownMember.id)
  const manager = discussion?.createdBy === userId || project.role === 'owner' || project.role === 'admin'
  const load = useCallback(async () => {
    const id = ++sequence.current
    try {
      const [latest, memberRows, messageRows, links, activeIssues] = await Promise.all([
        boardRequest({ type: 'discussions.get', projectId: project.id, discussionId }),
        boardRequest({ type: 'discussion-members.list', projectId: project.id, discussionId }),
        allPages(cursor => boardRequest({ type: 'discussion-messages.list', projectId: project.id, discussionId, cursor, limit: 100 })),
        boardRequest({ type: 'discussion-issue-links.list', projectId: project.id, discussionId }),
        allPages(cursor => boardRequest({ type: 'issues.list', projectId: project.id, cursor, limit: 100 })),
      ])
      const linkedIssues = await Promise.all(links.map(link => activeIssues.find(issue => issue.id === link.issueId) || boardRequest({ type: 'issues.get', projectId: project.id, issueId: link.issueId })))
      if (id !== sequence.current) return
      setDiscussion(latest); setDiscussionMembers(memberRows); setMessages(messageRows); setLinked(linkedIssues); setIssues(activeIssues); setLoading(false); setDenied(false)
    } catch (cause) { if (id === sequence.current) { setError(errorText(cause, t)); setLoading(false); if (isAccessDenied(cause)) setDenied(true) } }
  }, [project.id, discussionId])
  useEffect(() => { void load(); return () => { sequence.current++ } }, [load, revision])
  async function mutate(action: () => Promise<unknown>, after?: () => void, restoring = false) {
    if (busy || !(restoring ? writableProject : writable)) return
    setBusy(true); setError('')
    try { await action(); after?.(); await load(); onChanged() }
    catch (cause) { setError(errorText(cause, t)); if (isAccessDenied(cause)) setDenied(true); await load() }
    finally { setBusy(false) }
  }
  function navigate(action: () => void) { if (messageDirty) setDiscard(() => action); else action() }
  const changed = useCallback(() => { void load(); onChanged() }, [load, onChanged])
  if (loading) return <div className={styles.empty} role="status">{t('loading')}</div>
  if (!discussion || denied || accessDenied) return <section className={styles.detailRoot}><button onClick={onBack}>{t('back')}</button><BoardError message={error || t('accessDenied')} retry={() => void load()} /></section>
  const executionIssue = linked.find(issue => issue.id === executionIssueId) || linked.find(issue => !issue.archivedAt)
  return <section className={styles.detailRoot} aria-label={discussion.title}>
    <header className={styles.detailHeader}><button onClick={() => navigate(onBack)}><Icon name="back" size={16} />{t('back')}</button><span>{t('discussions')}</span><span className={styles.spacer} />{discussion.archivedAt && <span>{t('readOnly')}</span>}
      <button disabled={!writable || !manager || busy} onClick={() => { setTitle(discussion.title); setDescription(discussion.description); setEditBaseVersion(discussion.version); setEditing(true) }}>{t('edit')}</button>
      <button disabled={!writableProject || !manager || busy} onClick={() => discussion.archivedAt ? void mutate(() => boardRequest({ type: 'discussions.restore', projectId: project.id, discussionId, version: discussion.version }), undefined, true) : setArchiveConfirm(true)}>{discussion.archivedAt ? t('restore') : t('archive')}</button>
    </header>
    <BoardError message={error} retry={() => void load()} />
    <div className={styles.discussionColumns}><main className={styles.discussionMain}><div className={styles.discussionHeading}><h2>{discussion.title}</h2>{discussion.description && <MarkdownBody value={discussion.description} />}</div>
      {!joined && <div className={styles.notice}>{t('joinRequired')}<button disabled={!writable || busy || !ownMember} onClick={() => void mutate(() => boardRequest({ type: 'discussion-members.add', projectId: project.id, discussionId, memberIds: [ownMember!.id] }))}>{t('join')}</button></div>}
      <DiscussionMessages projectId={project.id} discussionId={discussionId} messages={messages} members={participants} userId={userId} writable={writable && joined && !busy} onChanged={changed} onDraftChanged={setMessageDirty} onDenied={() => setDenied(true)} />
    </main><aside className={styles.discussionAside}>
      <section><h3>{t('members')} <span className={styles.count}>{participants.length}</span></h3><div className={styles.participants}>{participants.map(member => <div key={member.id}><span className={styles.avatar}>{memberName(member).slice(0, 1)}</span><span>{memberName(member)}{member.kind === 'agent' && <small> · Agent</small>}</span><span className={styles.spacer} /><button disabled={!writable || busy || !(manager || member.id === ownMember?.id)} aria-label={`${t('removeMember')} ${memberName(member)}`} onClick={() => void mutate(() => boardRequest({ type: 'discussion-members.remove', projectId: project.id, discussionId, memberId: member.id }))}>×</button></div>)}</div>
        <div className={styles.inlineForm}><select aria-label={t('addMember')} value={memberToAdd} disabled={!writable || busy} onChange={event => setMemberToAdd(event.target.value)}><option value="">{t('addMember')}</option>{ownMentionableMembers(members, userId).filter(member => !participants.some(row => row.id === member.id)).map(member => <option key={member.id} value={member.id}>{memberName(member)}{member.kind === 'agent' ? ' · Agent' : ''}</option>)}</select><button disabled={!writable || busy || !memberToAdd} onClick={() => void mutate(() => boardRequest({ type: 'discussion-members.add', projectId: project.id, discussionId, memberIds: [memberToAdd] }), () => setMemberToAdd(''))}>{t('confirm')}</button></div>
      </section>
      <section><h3>{t('linkedIssues')}</h3>{linked.map(issue => <div className={styles.linkedIssue} key={issue.id}><button onClick={() => navigate(() => onIssue(issue))}><span className={styles.identifier}>{issue.identifier}</span><strong>{issue.title}</strong>{issue.archivedAt && <span>{t('archived')}</span>}</button><button aria-label={`${t('unlink')} ${issue.identifier}`} disabled={!writable || busy} onClick={() => void mutate(() => boardRequest({ type: 'discussion-issue-links.remove', projectId: project.id, discussionId, issueId: issue.id }))}>×</button></div>)}
        <div className={styles.inlineForm}><select aria-label={t('linkIssue')} value={issueToLink} disabled={!writable || busy} onChange={event => setIssueToLink(event.target.value)}><option value="">{t('linkIssue')}</option>{issues.filter(issue => !linked.some(row => row.id === issue.id)).map(issue => <option key={issue.id} value={issue.id}>{issue.identifier} · {issue.title}</option>)}</select><button disabled={!writable || busy || !issueToLink} onClick={() => void mutate(() => boardRequest({ type: 'discussion-issue-links.add', projectId: project.id, discussionId, issueId: issueToLink }), () => setIssueToLink(''))}>{t('confirm')}</button></div>
      </section>
      {linked.length > 1 && <label>{t('execute')}<select value={executionIssue?.id || ''} disabled={!writable} onChange={event => setExecutionIssueId(event.target.value)}>{linked.filter(issue => !issue.archivedAt).map(issue => <option key={issue.id} value={issue.id}>{issue.identifier}</option>)}</select></label>}
      <IssueExecutions project={project} issue={executionIssue} discussionId={discussionId} members={participants} userId={userId} disabled={!writable || !joined} revision={revision} onChanged={changed} />
      <DiscussionSources projectId={project.id} discussionId={discussionId} writable={writable && joined} revision={revision} onDenied={() => setDenied(true)} />
    </aside></div>
    {editing && <BoardModal title={t('edit')} onClose={() => setEditing(false)} busy={busy}><div className={styles.modalBody}>
      {discussion.version !== editBaseVersion && <p className={styles.notice}>{t('conflict')}</p>}<BoardError message={error} />
      <label>{t('title')}<input value={title} disabled={!writable || busy} maxLength={500} onChange={event => setTitle(event.target.value)} /></label><MarkdownEditor value={description} onChange={setDescription} disabled={!writable || busy} />
    </div><footer className={styles.modalFooter}><button disabled={busy} onClick={() => setEditing(false)}>{t('cancel')}</button><button className={styles.primary} disabled={!writable || !manager || busy || !title.trim()} onClick={() => void mutate(() => boardRequest({ type: 'discussions.update', projectId: project.id, discussionId, version: discussion.version, patch: { title: title.trim(), description } }), () => setEditing(false))}>{t('save')}</button></footer></BoardModal>}
    {archiveConfirm && <BoardModal title={t('archive')} busy={busy} onClose={() => setArchiveConfirm(false)}><p className={styles.modalBody}>{t('archiveConfirm')}</p><footer className={styles.modalFooter}><button disabled={busy} onClick={() => setArchiveConfirm(false)}>{t('cancel')}</button><button className={styles.danger} disabled={!writable || !manager || busy} onClick={() => void mutate(() => boardRequest({ type: 'discussions.archive', projectId: project.id, discussionId, version: discussion.version }), () => setArchiveConfirm(false))}>{t('archive')}</button></footer></BoardModal>}
    {discard && <DiscardPrompt onKeep={() => setDiscard(null)} onDiscard={() => { const action = discard; setDiscard(null); action() }} />}
  </section>
}
