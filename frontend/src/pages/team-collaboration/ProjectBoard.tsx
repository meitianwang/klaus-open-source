import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CollaborationDiscussion, CollaborationIssue, CollaborationIssueInput, CollaborationIssueStatus, CollaborationMember, CollaborationProject } from '../../../../contracts/team-collaboration'
import { Icon } from '../../components/Icon'
import { allPages, boardBridge, boardRequest, errorText, useBoardIdentity } from './board-api'
import { DEFAULT_BOARD_PREFERENCES, ISSUE_PRIORITIES, ISSUE_STATUSES, canWriteProject, groupIssues, isAccessDenied, keyboardIssueTarget, memberName, mergeIssues, parseBoardPreferences, reorderIssue, selectIssues, type KeyboardIssueTarget, type BoardGroup, type BoardPreferences, type BoardSort, type BoardTab } from './board-model'
import { useBoardT, type BoardTextKey } from './board-i18n'
import { BoardError } from './issue-fields'
import { IssueCreate } from './issue-create'
import { IssueFilters } from './issue-filters'
import { IssueDetail } from './issue-detail'
import { DiscussionDetail } from './discussion-detail'
import styles from './board-styles.module.css'

export interface ProjectBoardProps {
  project: CollaborationProject
  members: CollaborationMember[]
  onProjectChanged(): void | Promise<void>
  searchTarget?: HTMLElement | null
  headerActionsTarget?: HTMLElement | null
  initialIssueId?: string | null
}
export function ProjectBoard(props: ProjectBoardProps) {
  const t = useBoardT(), { userId, ready } = useBoardIdentity()
  if (!ready) return <div role="status" className={styles.empty}>{t('loading')}</div>
  if (!userId) return <BoardError message={t('accessDenied')} />
  return <AccountProjectBoard key={`${userId}:${props.project.id}`} {...props} userId={userId} />
}
function AccountProjectBoard({ project, members, onProjectChanged, searchTarget, headerActionsTarget, initialIssueId, userId }: ProjectBoardProps & { userId: string }) {
  const t = useBoardT()
  const [prefs, setPrefs] = useState<BoardPreferences>(() => {
    try { return parseBoardPreferences(localStorage.getItem(`klaus:collaboration:board:${userId}:${project.id}`)) } catch { return { ...DEFAULT_BOARD_PREFERENCES } }
  })
  const [issues, setIssues] = useState<CollaborationIssue[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [denied, setDenied] = useState(false), [busy, setBusy] = useState(false), [filterOpen, setFilterOpen] = useState(false), [displayOpen, setDisplayOpen] = useState(false)
  const [creating, setCreating] = useState<CollaborationIssueStatus | null>(null), [selectedIssue, setSelectedIssue] = useState<string | null>(initialIssueId || null)
  const [discussion, setDiscussion] = useState<CollaborationDiscussion | null>(null), [connection, setConnection] = useState<'connected' | 'reconnecting' | 'forbidden'>('reconnecting')
  const [revision, setRevision] = useState(0)
  const [selectedIds, setSelectedIds] = useState<string[]>([]), [detailIds, setDetailIds] = useState<string[]>([]), [expandedDetail, setExpandedDetail] = useState(false)
  const [keyboardTarget, setKeyboardTarget] = useState<KeyboardIssueTarget | null>(null), [keyboardNotice, setKeyboardNotice] = useState('')
  const keyboardOrigin = useRef<KeyboardIssueTarget | null>(null)
  const keyboardFocus = useRef<string | null>(null)
  const boardRoot = useRef<HTMLElement | null>(null)
  const generation = useRef(0), dragging = useRef<string | null>(null), projectChanged = useRef(onProjectChanged)
  projectChanged.current = onProjectChanged
  const writable = !denied && canWriteProject(project, members, userId)
  const reload = useCallback(async () => {
    const requestId = ++generation.current
    try {
      const result = await allPages(cursor => boardRequest({ type: 'issues.list', projectId: project.id, archived: prefs.archived, cursor, limit: 100 }))
      if (generation.current === requestId) { setIssues(result); setDenied(false); setLoading(false) }
    } catch (cause) {
      if (generation.current === requestId) { setError(errorText(cause, t)); setLoading(false); if (isAccessDenied(cause)) { setDenied(true); setIssues([]) } }
    }
  }, [project.id, prefs.archived])
  useEffect(() => {
    if (keyboardFocus.current) {
      const target = [...(boardRoot.current?.querySelectorAll<HTMLElement>('[data-issue-id]') || [])].find(element => element.dataset.issueId === keyboardFocus.current)
      target?.focus(); keyboardFocus.current = null
    }
  }, [issues])
  useEffect(() => { if (initialIssueId) setSelectedIssue(initialIssueId) }, [initialIssueId])
  useEffect(() => { setLoading(true); void reload(); return () => { generation.current++ } }, [reload])
  useEffect(() => { try { localStorage.setItem(`klaus:collaboration:board:${userId}:${project.id}`, JSON.stringify(prefs)) } catch { /* Preferences are optional; cloud entities remain authoritative. */ } }, [project.id, prefs])
  useEffect(() => {
    let unsubscribe: (() => void) | undefined, updateTimer: ReturnType<typeof setTimeout> | undefined
    try {
      unsubscribe = boardBridge().onUpdated(event => {
        if (event.kind === 'account') { generation.current++; setIssues([]); setSelectedIssue(null); setDiscussion(null); setDenied(true); setError(t('accessDenied')); void projectChanged.current(); return }
        if (event.projectId !== project.id) return
        if (event.kind === 'connection') {
          setConnection(event.state || 'reconnecting')
          if (event.state === 'forbidden') { generation.current++; setDenied(true); setIssues([]); setSelectedIssue(null); setDiscussion(null); setError(event.error || t('accessDenied')); void projectChanged.current() }
          return
        }
        clearTimeout(updateTimer)
        updateTimer = setTimeout(() => { void reload(); setRevision(current => current + 1) }, 50)
      })
      void boardBridge().watch(project.id).catch(cause => setError(errorText(cause, t)))
    } catch (cause) { setError(errorText(cause, t)) }
    return () => { clearTimeout(updateTimer); unsubscribe?.() }
  }, [project.id, reload])
  const changePrefs = (patch: Partial<BoardPreferences>) => { setPrefs(previous => ({ ...previous, ...patch })); setSelectedIds([]); setKeyboardTarget(null) }
  const changedIssue = (issue: CollaborationIssue) => { setIssues(current => mergeIssues(current, [issue])); setRevision(current => current + 1); void projectChanged.current() }
  const visible = selectIssues(issues, prefs, members, userId), groups = groupIssues(visible, prefs.group, members)
  const currentIssue = issues.find(issue => issue.id === selectedIssue)
  const selectedRows = visible.filter(issue => selectedIds.includes(issue.id))
  const detailIndex = detailIds.indexOf(selectedIssue || '')
  function setIssueRoute(issueId: string | null) {
    const params = new URLSearchParams(window.location.hash.slice(1))
    params.set('tcProject', project.id)
    if (issueId) params.set('tcIssue', issueId); else params.delete('tcIssue')
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${window.location.search}#${params}`)
    setSelectedIssue(issueId)
  }
  function openIssue(issueId: string) { setDetailIds(visible.map(issue => issue.id)); setIssueRoute(issueId) }
  useEffect(() => {
    const route = () => {
      const params = new URLSearchParams(window.location.hash.slice(1))
      if (params.get('tcProject') === project.id) setSelectedIssue(params.get('tcIssue'))
    }
    route(); window.addEventListener('hashchange', route); window.addEventListener('popstate', route)
    return () => { window.removeEventListener('hashchange', route); window.removeEventListener('popstate', route) }
  }, [project.id])
  async function bulkUpdate(patch: Partial<CollaborationIssueInput>) {
    if (!writable || busy || prefs.archived || !selectedRows.length) return
    setBusy(true); setError('')
    const result = await Promise.allSettled(selectedRows.map(issue => boardRequest({ type: 'issues.update', projectId: project.id, issueId: issue.id, version: issue.version, patch })))
    const updated = result.flatMap(row => row.status === 'fulfilled' ? [row.value] : [])
    const failed = result.flatMap((row, index) => row.status === 'rejected' ? [{ issue: selectedRows[index], error: row.reason }] : [])
    setIssues(rows => mergeIssues(rows, updated))
    if (failed.length) {
      setError(`${t('batchPartial')} ${failed.map(row => `${row.issue.identifier}: ${errorText(row.error, t)}`).join(' · ')}`)
      setSelectedIds(failed.map(row => row.issue.id))
      if (failed.some(row => isAccessDenied(row.error))) setDenied(true)
    }
    await reload(); void projectChanged.current(); setBusy(false)
  }
  async function move(issueId: string, status: CollaborationIssueStatus, beforeId: string | null) {
    if (!writable || busy || prefs.archived) return
    const changes = reorderIssue(issues, issueId, status, beforeId)
    if (!changes.length) return
    const snapshot = issues
    setBusy(true); setError('')
    setIssues(rows => rows.map(row => { const change = changes.find(item => item.issueId === row.id); return change ? { ...row, status: change.status, sortOrder: change.sortOrder } : row }))
    try {
      const updated = await boardRequest({ type: 'issues.reorder', projectId: project.id, items: changes })
      setIssues(rows => mergeIssues(rows, updated)); void projectChanged.current()
    } catch (cause) {
      setIssues(snapshot); setError(errorText(cause, t)); if (isAccessDenied(cause)) setDenied(true)
      await reload()
    } finally { setBusy(false) }
  }
  function handleCardKey(event: React.KeyboardEvent<HTMLElement>, issue: CollaborationIssue) {
    if (event.target !== event.currentTarget || !canDrag) return
    if (event.key === 'Escape' && keyboardTarget) { event.preventDefault(); setKeyboardTarget(null); keyboardOrigin.current = null; setKeyboardNotice(t('keyboardCancelled')); return }
    if (event.key === ' ') {
      event.preventDefault()
      if (keyboardTarget?.issueId === issue.id) {
        if (JSON.stringify(keyboardTarget) !== JSON.stringify(keyboardOrigin.current)) { keyboardFocus.current = issue.id; void move(issue.id, keyboardTarget.status, keyboardTarget.beforeId) }
        setKeyboardTarget(null); keyboardOrigin.current = null; setKeyboardNotice(t('keyboardDropped'))
      } else {
        const siblings = issues.filter(row => row.status === issue.status && !row.archivedAt).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
        const target = { issueId: issue.id, status: issue.status, beforeId: siblings[siblings.findIndex(row => row.id === issue.id) + 1]?.id || null }
        keyboardOrigin.current = target; setKeyboardTarget(target); setKeyboardNotice('')
      }
    } else if (keyboardTarget?.issueId === issue.id && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault(); setKeyboardTarget(keyboardIssueTarget(issues, keyboardTarget, event.key as 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight'))
    }
  }
  function drop(event: React.DragEvent, status: CollaborationIssueStatus, beforeId: string | null) {
    event.preventDefault(); event.stopPropagation()
    const id = dragging.current || event.dataTransfer.getData('application/x-klaus-issue')
    dragging.current = null
    if (id) void move(id, status, beforeId)
  }
  function groupLabel(key: string) {
    if (prefs.group === 'assignee') return key === 'unassigned' ? t('unassigned') : memberName(members.find(member => member.id === key)) || t('unknownMember')
    return t(key as BoardTextKey)
  }
  function issueControls(issue: CollaborationIssue) {
    const siblings = issues.filter(row => row.status === issue.status && !row.archivedAt).sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id))
    const index = siblings.findIndex(row => row.id === issue.id)
    return <details className={styles.cardMenu} onClick={event => event.stopPropagation()}><summary aria-label={`${issue.identifier} · ${t('changeStatus')}`}><Icon name="chat-project-more" size={16} /></summary>
      <div className={styles.cardMenuContent}><label>{t('status')}<select aria-label={`${issue.identifier} · ${t('status')}`} value={issue.status} disabled={!writable || busy || !!issue.archivedAt} onChange={event => void move(issue.id, event.target.value as CollaborationIssueStatus, null)}>{ISSUE_STATUSES.map(status => <option key={status} value={status}>{t(status)}</option>)}</select></label>
        <button disabled={!writable || busy || index <= 0 || !!issue.archivedAt} onClick={() => void move(issue.id, issue.status, siblings[index - 1]?.id || null)}>{t('moveUp')}</button>
        <button disabled={!writable || busy || index === siblings.length - 1 || !!issue.archivedAt} onClick={() => void move(issue.id, issue.status, siblings[index + 2]?.id || null)}>{t('moveDown')}</button></div>
    </details>
  }
  const canDrag = writable && !busy && !prefs.archived && prefs.sort === 'manual' && !prefs.descending && (prefs.group === 'status' || prefs.group === 'none')
  const card = (issue: CollaborationIssue) => <article key={issue.id} className={`${styles.issueCard} ${selectedIds.includes(issue.id) ? styles.selectedCard : ''}`} data-issue-id={issue.id} data-keyboard-picked={keyboardTarget?.issueId === issue.id || undefined} draggable={canDrag && !keyboardTarget}
    tabIndex={canDrag ? 0 : undefined} aria-label={`${issue.identifier}: ${issue.title}`} aria-describedby={canDrag ? 'collaboration-keyboard-help' : undefined} onKeyDown={event => handleCardKey(event, issue)}
    onDragStart={event => { dragging.current = issue.id; event.dataTransfer.setData('application/x-klaus-issue', issue.id); event.dataTransfer.effectAllowed = 'move' }}
    onDragEnd={() => { dragging.current = null }} onDragOver={event => { if (canDrag) event.preventDefault() }} onDrop={event => { if (canDrag) drop(event, issue.status, issue.id) }}>
    <div className={styles.cardTop}><input className={styles.cardCheckbox} type="checkbox" aria-label={`${t('selectIssue')} ${issue.identifier}`} checked={selectedIds.includes(issue.id)} disabled={busy || !writable || prefs.archived} onChange={event => setSelectedIds(ids => event.target.checked ? [...ids, issue.id] : ids.filter(id => id !== issue.id))} />{prefs.cardNumber && <span className={styles.identifier}>{issue.identifier}</span>}<span className={styles.spacer} />{issueControls(issue)}</div>
    <button className={styles.cardTitle} onClick={() => openIssue(issue.id)}>{issue.title}</button>
    {prefs.description && issue.description && <p className={styles.descriptionSummary}>{issue.description}</p>}
    <div className={styles.cardMeta}>{prefs.cardPriority && <span className={styles.priority} data-priority={issue.priority}>{t(issue.priority)}</span>}<span>{memberName(members.find(member => member.id === issue.assigneeMemberId)) || t('unassigned')}</span></div>
    {prefs.cardCreatedAt && <time className={styles.cardCreated} dateTime={issue.createdAt}>{t('created')} · {new Date(issue.createdAt).toLocaleDateString()}</time>}
  </article>
  if (discussion) return <DiscussionDetail key={discussion.id} project={project} members={members} discussionId={discussion.id} userId={userId} revision={revision} accessDenied={denied} onBack={() => setDiscussion(null)} onIssue={issue => { setSelectedIssue(issue.id); changedIssue(issue); setDiscussion(null) }} onChanged={() => { setRevision(current => current + 1); void projectChanged.current() }} />
  const detail = selectedIssue && <aside className={styles.detailDrawer} data-expanded={expandedDetail} aria-label={t('issues')}><IssueDetail key={selectedIssue} issueId={selectedIssue} initialIssue={currentIssue} project={project} members={members} userId={userId} revision={revision} accessDenied={denied} onClose={() => setIssueRoute(null)} onChanged={changedIssue} onDiscussion={setDiscussion} onDeleted={() => { setIssueRoute(null); setRevision(current => current + 1); void reload(); void projectChanged.current() }}
    previousIssueId={detailIndex > 0 ? detailIds[detailIndex - 1] : null} nextIssueId={detailIndex >= 0 ? detailIds[detailIndex + 1] || null : null} onNavigate={setIssueRoute} expanded={expandedDetail} onToggleExpanded={() => setExpandedDetail(value => !value)} /></aside>
  const search = <div className={styles.search}><Icon name="search" size={16} /><input aria-label={t('search')} placeholder={t('search')} value={prefs.search} onKeyDown={event => { if (event.key === 'Escape') changePrefs({ search: '' }) }} onChange={event => changePrefs({ search: event.target.value })} /></div>
  const create = <div className={styles.headerActions}><button disabled={!writable} className={styles.primary} onClick={() => setCreating('backlog')}><Icon name="plus" size={16} />{t('createIssue')}</button></div>
  return <section ref={boardRoot} className={styles.boardRoot} aria-label={t('issues')}>
    {headerActionsTarget ? createPortal(create, headerActionsTarget) : <header className={styles.boardHeader}><div className={styles.boardHeading}><h2>{t('issues')}</h2><span className={styles.count}>{visible.length}</span></div><span className={styles.spacer} />{create}</header>}
    {searchTarget && createPortal(search, searchTarget)}
    <nav className={styles.statusTabs} aria-label={t('status')}>{(['all', 'mine', ...ISSUE_STATUSES] as BoardTab[]).map(tab => <button key={tab} aria-pressed={prefs.tab === tab} onClick={() => changePrefs({ tab })}>{t(tab)}</button>)}</nav>
    <div className={styles.toolbar}>
      {!searchTarget && search}
      <button aria-expanded={filterOpen} onClick={() => { setFilterOpen(!filterOpen); setDisplayOpen(false) }}>{t('filters')}{prefs.statuses.length + prefs.priorities.length + prefs.assignees.length > 0 && <span className={styles.count}>{prefs.statuses.length + prefs.priorities.length + prefs.assignees.length}</span>}</button>
      <span className={styles.count}>{visible.length}</span>
      <span className={styles.spacer} />
      <span className={styles.connection} data-state={connection}>{connection === 'forbidden' ? t('accessDenied') : t(connection)}</span>
      <button aria-expanded={displayOpen} onClick={() => { setDisplayOpen(!displayOpen); setFilterOpen(false) }}>{t('display')}</button><button aria-label={t('refresh')} onClick={() => { setError(''); void reload() }}><Icon name="refresh" size={16} /></button>
    </div>
    {filterOpen && <IssueFilters key={`${project.id}:${userId}`} projectId={project.id} userId={userId} prefs={prefs} members={members} onChange={changePrefs} />}
    {displayOpen && <div className={styles.displayPanel}><label>{t('sort')}<select value={prefs.sort} onChange={event => changePrefs({ sort: event.target.value as BoardSort })}>{(['manual', 'priority', 'created', 'updated', 'title'] as const).map(sort => <option key={sort} value={sort}>{t(sort)}</option>)}</select></label><label className={styles.checkbox}><input type="checkbox" checked={prefs.descending} onChange={event => changePrefs({ descending: event.target.checked })} />{t('descending')}</label><label>{t('group')}<select value={prefs.group} onChange={event => changePrefs({ group: event.target.value as BoardGroup })}>{(['status', 'priority', 'assignee', 'none'] as const).map(group => <option key={group} value={group}>{t(group === 'none' ? 'noGroup' : group)}</option>)}</select></label>{(['cardNumber', 'cardPriority', 'description', 'cardCreatedAt'] as const).map(field => <label key={field} className={styles.checkbox}><input type="checkbox" checked={prefs[field]} onChange={event => changePrefs({ [field]: event.target.checked })} />{t(field === 'description' ? 'cardDescription' : field)}</label>)}<label className={styles.checkbox}><input type="checkbox" checked={prefs.archived} onChange={event => changePrefs({ archived: event.target.checked })} />{t('archived')}</label></div>}
    <div className={styles.selectionToolbar}><button disabled={!writable || busy || prefs.archived || !visible.length} aria-pressed={!!visible.length && selectedRows.length === visible.length} onClick={() => setSelectedIds(selectedRows.length === visible.length ? [] : visible.map(issue => issue.id))}>{t('selectAll')}</button>{selectedRows.length > 0 && <><strong>{t('selected')} {selectedRows.length}</strong><button disabled={busy} onClick={() => setSelectedIds([])}>{t('clearSelection')}</button><select aria-label={t('batchStatus')} value="" disabled={!writable || busy || prefs.archived} onChange={event => void bulkUpdate({ status: event.target.value as CollaborationIssueStatus })}><option value="" disabled>{t('batchStatus')}</option>{ISSUE_STATUSES.map(status => <option key={status} value={status}>{t(status)}</option>)}</select><select aria-label={t('batchPriority')} value="" disabled={!writable || busy || prefs.archived} onChange={event => void bulkUpdate({ priority: event.target.value as CollaborationIssueInput['priority'] })}><option value="" disabled>{t('batchPriority')}</option>{ISSUE_PRIORITIES.map(priority => <option key={priority} value={priority}>{t(priority)}</option>)}</select><select aria-label={t('batchAssignee')} value="" disabled={!writable || busy || prefs.archived} onChange={event => void bulkUpdate({ assigneeMemberId: event.target.value === 'unassigned' ? null : event.target.value })}><option value="" disabled>{t('batchAssignee')}</option><option value="unassigned">{t('unassigned')}</option>{members.map(member => <option key={member.id} value={member.id}>{memberName(member)}</option>)}</select></>}</div>
    <p id="collaboration-keyboard-help" className={styles.keyboardHelp}>{t('keyboardHelp')}</p>
    <div role="status" aria-live="polite" className={keyboardTarget || keyboardNotice ? styles.keyboardNotice : styles.srOnly}>{keyboardTarget ? `${t('keyboardMoving')} ${issues.find(issue => issue.id === keyboardTarget.issueId)?.identifier}: ${t(keyboardTarget.status)}. ${t('keyboardHelp')}` : keyboardNotice}</div>
    <BoardError message={error} retry={() => { setError(''); void reload() }} />
    {loading ? <div role="status" className={styles.empty}>{t('loading')}</div> : <>
      {!visible.length && <div className={styles.empty}><h3>{t('empty')}</h3><p>{t('emptyHint')}</p></div>}
      <div className={styles.columns}>{groups.map(group => <section key={group.key} className={styles.column} data-status-column={prefs.group === 'status' ? group.key : undefined} onDragOver={event => { if (canDrag && prefs.group === 'status') event.preventDefault() }} onDrop={event => { if (canDrag && prefs.group === 'status') drop(event, group.key as CollaborationIssueStatus, null) }}><header><span className={styles.statusDot} data-status={prefs.group === 'status' ? group.key : undefined} /><h3>{groupLabel(group.key)}</h3><span className={styles.count}>{group.issues.length}</span><span className={styles.spacer} /><button disabled={!writable || prefs.archived} aria-label={`${t('createIssue')} · ${groupLabel(group.key)}`} onClick={() => setCreating(prefs.group === 'status' ? group.key as CollaborationIssueStatus : 'backlog')}><Icon name="plus" size={15} /></button></header><div className={styles.columnCards}>{group.issues.map(issue => <div key={issue.id}>{keyboardTarget?.status === group.key && keyboardTarget.beforeId === issue.id && <div className={styles.dropPreview}>{issues.find(row => row.id === keyboardTarget.issueId)?.identifier}</div>}{card(issue)}</div>)}{keyboardTarget?.status === group.key && !keyboardTarget.beforeId && <div className={styles.dropPreview}>{issues.find(row => row.id === keyboardTarget.issueId)?.identifier}</div>}</div></section>)}</div>
    </>}
    {detail}
    {creating && <IssueCreate projectId={project.id} members={members} initialStatus={creating} disabled={!writable} onClose={() => setCreating(null)} onCreated={changedIssue} />}
  </section>
}
