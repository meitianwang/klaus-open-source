import { useCallback, useEffect, useRef, useState } from 'react'
import type { CollaborationIssueActivity, CollaborationMember, CollaborationProject } from '../../../../contracts/team-collaboration'
import { boardRequest, errorText } from './board-api'
import { isAccessDenied } from './board-model'
import { useBoardT, type BoardTextKey } from './board-i18n'
import { BoardError } from './issue-fields'
import styles from './board-styles.module.css'

/** The six the discussion composer already offers; an Issue uses the same set. */
export const ISSUE_REACTIONS = ['👍', '❤️', '🎉', '👀', '✅', '🙏'] as const
/** The server pages `issue-activity.list` by offset; 50 is its default limit. */
export const ISSUE_ACTIVITY_PAGE_SIZE = 50

/**
 * Issue reactions are a per-user idempotent switch, not a flip: the server takes
 * `active` and converges to it, so a retry after a dropped reply cannot undo the
 * user's own click. The caller therefore always sends the state it intends.
 */
export function IssueReactions({ projectId, issueId, disabled, revision, onChanged, onDenied }: {
  projectId: string; issueId: string; disabled: boolean; revision: number; onChanged(): void; onDenied(): void
}) {
  const t = useBoardT(), [reactions, setReactions] = useState<Record<string, string[]>>({}), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [userId, setUserId] = useState<string | null>(null), [picker, setPicker] = useState(false)
  const sequence = useRef(0)
  useEffect(() => {
    const auth = (window as unknown as { klaus?: { klausAuth?: { status(): Promise<{ loggedIn?: boolean; user?: { id?: string | number } }> } } }).klaus?.klausAuth
    let alive = true
    void auth?.status().then(result => { if (alive) setUserId(result.loggedIn && result.user?.id != null ? String(result.user.id) : null) }).catch(() => { if (alive) setUserId(null) })
    return () => { alive = false }
  }, [])
  const load = useCallback(async () => {
    const request = ++sequence.current
    try {
      const result = await boardRequest({ type: 'issue-reactions.list', projectId, issueId })
      if (request === sequence.current) { setReactions(result); setError('') }
    } catch (cause) { if (request === sequence.current) { setError(errorText(cause, t)); if (isAccessDenied(cause)) onDenied() } }
  }, [projectId, issueId])
  useEffect(() => { void load(); return () => { sequence.current++ } }, [load, revision])
  async function toggle(reaction: string) {
    if (disabled || busy) return
    const users = reactions[reaction] || []
    const active = !(userId && users.includes(userId))
    setBusy(true); setError('')
    try {
      const result = await boardRequest({ type: 'issue-reactions.toggle', projectId, issueId, reaction, active })
      setReactions(result); setPicker(false); onChanged()
    } catch (cause) { setError(errorText(cause, t)); if (isAccessDenied(cause)) onDenied(); await load() }
    finally { setBusy(false) }
  }
  const chips = Object.entries(reactions).filter(([, users]) => users.length > 0)
  return <section className={styles.reactions} aria-label={t('reactions')}>
    {chips.map(([reaction, users]) => <button key={reaction} type="button" disabled={disabled || busy} aria-pressed={!!userId && users.includes(userId)} aria-label={`${t('reaction')} ${reaction} · ${users.length}`} onClick={() => void toggle(reaction)}>{reaction} {users.length}</button>)}
    <button type="button" disabled={disabled || busy} aria-expanded={picker} aria-label={t('addReaction')} onClick={() => setPicker(!picker)}>＋</button>
    {picker && <div className={styles.reactionPicker} role="group" aria-label={t('reaction')}>{ISSUE_REACTIONS.map(reaction => <button key={reaction} type="button" disabled={disabled || busy} aria-label={`${t('reaction')} ${reaction}`} onClick={() => void toggle(reaction)}>{reaction}</button>)}</div>}
    <BoardError message={error} retry={() => { setError(''); void load() }} />
  </section>
}

/**
 * A static map from the server's event type to a label. Built as a lookup rather
 * than a template key so an event the UI has no wording for still renders: the
 * raw `type` is the fallback, and a missing label never crashes the panel.
 */
const ACTIVITY_LABELS: Partial<Record<string, BoardTextKey>> = {
  'issues.create': 'activity_issues_create',
  'issues.update': 'activity_issues_update',
  'issues.archive': 'activity_issues_archive',
  'issues.restore': 'activity_issues_restore',
  'issues.reorder': 'activity_issues_reorder',
  'issue-reactions.toggle': 'activity_issue_reactions_toggle',
  'projects.archive': 'activity_projects_archive',
  'projects.restore': 'activity_projects_restore',
  'files.upload': 'activity_files_upload',
  'files.remove': 'activity_files_remove',
}
const FIELD_LABELS: Partial<Record<string, BoardTextKey>> = {
  title: 'title', description: 'description', status: 'status', priority: 'priority',
  assigneeMemberId: 'assignee', sortOrder: 'sort', cycle: 'cycle', archivedAt: 'archived', attachment: 'attachments',
}

function ActivityLine({ row, members }: { row: CollaborationIssueActivity; members: CollaborationMember[] }) {
  const t = useBoardT()
  const field = (key: string) => { const label = FIELD_LABELS[key]; return label ? t(label) : key }
  const member = (raw: unknown) => {
    const found = members.find(item => item.id === String(raw))
    return found ? found.agent?.name || found.user.displayName : t('unknownMember')
  }
  const value = (key: string, raw: unknown): string => {
    if (raw === null || raw === undefined || raw === '') return t('emptyValue')
    if (key === 'archivedAt') return t('archived')
    if (key === 'assigneeMemberId') return member(raw)
    return String(raw)
  }
  const entries = Object.entries(row.changes || {})
  const label = ACTIVITY_LABELS[row.type]
  return <li className={styles.activityRow}>
    <span className={styles.avatar}>{(row.actor.displayName || '?').slice(0, 1).toUpperCase()}</span>
    <div>
      <p><strong>{row.actor.displayName}</strong> <span className={styles.source}>{label ? t(label) : row.type}</span></p>
      {entries.length > 0 && <ul className={styles.activityChanges}>{entries.map(([key, change]) => <li key={key}>{field(key)}<span className={styles.spacer} /><span className={styles.before}>{value(key, change?.before)}</span><span aria-hidden="true">→</span><span className={styles.after}>{value(key, change?.after)}</span></li>)}</ul>}
      <time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString()}</time>
    </div>
  </li>
}

export function IssueActivity({ projectId, issueId, revision, onDenied }: {
  projectId: string; issueId: string; revision: number; onDenied(): void
}) {
  const t = useBoardT(), [rows, setRows] = useState<CollaborationIssueActivity[]>([]), [members, setMembers] = useState<CollaborationMember[]>([])
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [cursor, setCursor] = useState<string | null>(null)
  const sequence = useRef(0)
  const load = useCallback(async () => {
    const request = ++sequence.current
    try {
      const [first, list] = await Promise.all([
        boardRequest({ type: 'issue-activity.list', projectId, issueId, limit: ISSUE_ACTIVITY_PAGE_SIZE }),
        boardRequest({ type: 'project-members.list', projectId }),
      ])
      if (request !== sequence.current) return
      setRows(first.items); setCursor(first.nextCursor); setMembers(list); setError('')
    } catch (cause) { if (request === sequence.current) { setError(errorText(cause, t)); if (isAccessDenied(cause)) onDenied() } }
    finally { if (request === sequence.current) setLoading(false) }
  }, [projectId, issueId])
  useEffect(() => { void load(); return () => { sequence.current++ } }, [load, revision])
  async function loadMore() {
    if (!cursor || busy) return
    setBusy(true); setError('')
    try {
      const page = await boardRequest({ type: 'issue-activity.list', projectId, issueId, cursor, limit: ISSUE_ACTIVITY_PAGE_SIZE })
      setRows(current => [...current, ...page.items]); setCursor(page.nextCursor)
    } catch (cause) { setError(errorText(cause, t)); if (isAccessDenied(cause)) onDenied() }
    finally { setBusy(false) }
  }
  return <section className={styles.activity} aria-label={t('activity')}>
    <h3>{t('activity')}</h3>
    <BoardError message={error} retry={() => { setError(''); void load() }} />
    {loading && <p className={styles.muted}>{t('loading')}</p>}
    {!loading && !rows.length && <p className={styles.muted}>{t('noActivity')}</p>}
    {rows.length > 0 && <ol className={styles.activityList}>{rows.map(row => <ActivityLine key={row.id} row={row} members={members} />)}</ol>}
    {cursor && <button type="button" disabled={busy} onClick={() => void loadMore()}>{busy ? t('loading') : t('loadMore')}</button>}
  </section>
}
