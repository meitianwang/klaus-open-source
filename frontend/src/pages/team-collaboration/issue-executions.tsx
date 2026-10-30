import { useCallback, useEffect, useRef, useState } from 'react'
import type { CollaborationExecution, CollaborationIssue, CollaborationMember, CollaborationProject } from '../../../../contracts/team-collaboration'
import { allPages, boardBridge, boardRequest, errorText, openExecutionChat } from './board-api'
import { memberName } from './board-model'
import { useBoardT } from './board-i18n'
import { BoardError, BoardModal, MarkdownBody } from './issue-fields'
import styles from './board-styles.module.css'

export function IssueExecutions({ project, issue, discussionId, members, userId, disabled, revision, onChanged }: {
  project: CollaborationProject; issue?: CollaborationIssue; discussionId?: string; members: CollaborationMember[]; userId: string | null; disabled: boolean; revision: number; onChanged(): void
}) {
  const t = useBoardT(), [rows, setRows] = useState<CollaborationExecution[]>([]), [error, setError] = useState(''), [confirm, setConfirm] = useState(false), [stopping, setStopping] = useState<string | null>(null)
  const sequence = useRef(0)
  const load = useCallback(async () => {
    const request = ++sequence.current
    try {
      const result = await allPages(cursor => boardRequest({ type: 'executions.list', projectId: project.id, ...(discussionId ? { discussionId } : { issueId: issue?.id }), cursor, limit: 100 }))
      if (request === sequence.current) setRows(result)
    } catch (cause) { if (request === sequence.current) setError(errorText(cause, t)) }
  }, [project.id, issue?.id, discussionId])
  useEffect(() => { void load(); return () => { sequence.current++ } }, [load, revision])
  async function stop(row: CollaborationExecution) {
    setStopping(row.id); setError('')
    try { await boardRequest({ type: 'executions.cancel', projectId: project.id, executionId: row.id, version: row.version }); await load(); onChanged() }
    catch (cause) { setError(errorText(cause, t)); await load() }
    finally { setStopping(null) }
  }
  return <section className={styles.executions}><header className={styles.sectionHeader}><h3>{t('executions')}</h3><span className={styles.spacer} /><button disabled={disabled || !issue || !!issue.archivedAt} onClick={() => setConfirm(true)}>{t('execute')}</button></header>
    <BoardError message={error} retry={() => { setError(''); void load() }} />
    {!rows.length && <p className={styles.muted}>{t('noExecutions')}</p>}
    {rows.map(row => <article key={row.id} className={styles.executionRow}>
      <header><strong>{memberName(members.find(member => member.agentId === row.agentId)) || t('agent')}</strong><span data-state={row.status}>{t(row.status)}</span><time dateTime={row.createdAt}>{new Date(row.createdAt).toLocaleString()}</time></header>
      {row.error && <p className={styles.error}>{row.error}</p>}{row.result && <MarkdownBody value={row.result} />}
      <footer>{row.sessionId && row.ownerId === userId && <button onClick={() => void openExecutionChat(row.sessionId!).catch(cause => setError(errorText(cause, t)))}>{t('openChat')}</button>}{(row.status === 'pending' || row.status === 'running') && <button disabled={disabled || row.ownerId !== userId || !!stopping} onClick={() => void stop(row)}>{t('stop')}</button>}</footer>
    </article>)}
    {confirm && issue && <ExecutionConfirm project={project} issue={issue} discussionId={discussionId} members={members} userId={userId} disabled={disabled} onClose={() => setConfirm(false)} onStarted={() => { setConfirm(false); void load(); onChanged() }} />}
  </section>
}
function ExecutionConfirm({ project, issue, discussionId, members, userId, disabled, onClose, onStarted }: {
  project: CollaborationProject; issue: CollaborationIssue; discussionId?: string; members: CollaborationMember[]; userId: string | null; disabled: boolean; onClose(): void; onStarted(): void
}) {
  const t = useBoardT(), agents = members.filter(member => member.kind === 'agent' && member.agent?.ownerId === userId)
  const [agentId, setAgentId] = useState(''), [folder, setFolder] = useState<string | null>(null), [loading, setLoading] = useState(true)
  const [prompt, setPrompt] = useState(`${issue.identifier}: ${issue.title}\n\n${issue.description}`), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const idempotency = useRef(crypto.randomUUID())
  useEffect(() => {
    let alive = true
    void boardBridge().localBinding(project.id).then(binding => { if (alive) setFolder(binding.localFolder) }).catch(cause => { if (alive) setError(errorText(cause, t)) }).finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [project.id])
  const changed = () => { idempotency.current = crypto.randomUUID() }
  async function pick() {
    setError(''); setLoading(true)
    try { const binding = await boardBridge().pickLocalFolder(project.id); setFolder(binding.localFolder); changed() }
    catch (cause) { setError(errorText(cause, t)) }
    finally { setLoading(false) }
  }
  async function execute() {
    if (!folder || !agentId || !prompt.trim() || disabled || busy || !agents.some(member => member.agentId === agentId)) return
    setBusy(true); setError('')
    try {
      const binding = await boardBridge().localBinding(project.id)
      if (binding.localFolder !== folder) { setFolder(binding.localFolder); throw new Error(t('conflict')) }
      await boardBridge().execute({ projectId: project.id, issueId: issue.id, issueVersion: issue.version, ...(discussionId ? { discussionId } : {}), agentId, idempotencyKey: idempotency.current, localFolderConfirmed: true, prompt: prompt.trim() })
      onStarted()
    } catch (cause) { setError(errorText(cause, t)) }
    finally { setBusy(false) }
  }
  return <BoardModal title={t('confirmExecution')} onClose={onClose} busy={busy}>
    <div className={styles.modalBody}><BoardError message={error} /><p>{t('executionNotice')}</p>
      <label>{t('localFolder')}<div className={styles.folderRow}><code>{loading ? t('loading') : folder || t('noFolder')}</code><button disabled={busy || loading || disabled} onClick={() => void pick()}>{t('selectFolder')}</button></div></label>
      <label>{t('agent')}<select value={agentId} disabled={busy || disabled} onChange={event => { setAgentId(event.target.value); changed() }}><option value="">{t('chooseAgent')}</option>{agents.map(member => <option key={member.id} value={member.agentId!}>{memberName(member)}</option>)}</select></label>
      {!agents.length && <p>{t('noAgents')}</p>}<label>{t('prompt')}<textarea value={prompt} rows={6} disabled={busy || disabled} onChange={event => { setPrompt(event.target.value); changed() }} /></label>
    </div><footer className={styles.modalFooter}><button disabled={busy} onClick={onClose}>{t('cancel')}</button><button className={styles.primary} disabled={busy || loading || disabled || !folder || !agentId || !prompt.trim()} onClick={() => void execute()}>{busy ? t('saving') : t('approveExecution')}</button></footer>
  </BoardModal>
}
