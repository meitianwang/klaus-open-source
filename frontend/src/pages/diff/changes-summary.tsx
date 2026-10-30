import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { RawHtml } from '../../components/RawHtml'
import fileDiffSvg from 'lucide-static/icons/file-diff.svg?raw'
import { useT } from '../../i18n'
import { fileIconSvg } from '../../chat/file-icon'
import type { ArtifactTurn } from '../../chat/overview/artifacts'
import { ChangeStats } from './review-controls'
import { openTurnChanges, show } from './store'
import styles from './diff.module.css'

export function visibleTurnChanges(turn: ArtifactTurn | null): ArtifactTurn | null {
  if (!turn) return null
  const files = turn.files.filter(file => file.turnDiff !== '')
  if (!files.length) return null
  const sum = (key: 'added' | 'removed'): number | null => files.some(file => file[key] === null)
    ? null : files.reduce((total, file) => total + file[key]!, 0)
  return { ...turn, files, added: sum('added'), removed: sum('removed') }
}

/** A live turn keeps its own counts and opens that exact recorded turn. */
export function ChangesCapsule({ sessionId, turn, embedded = false }: { sessionId: string; turn: ArtifactTurn; embedded?: boolean }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [record, setRecord] = useState<{ owner: ArtifactTurn; value: ArtifactTurn | null; error?: string } | null>(null)
  useEffect(() => { setOpen(false) }, [sessionId, turn.turnId])
  useEffect(() => {
    let current = true
    void (window as any).klaus.diff.summary(sessionId, { source: 'last-turn', turnId: turn.turnId }).then((reply: any) => {
      if (!current) return
      if (reply?.ok === false || reply?.turnId !== turn.turnId) throw new Error(reply?.error || t('diff_turn_patch_unavailable'))
      const files = (Array.isArray(reply.files) ? reply.files : []).map((file: any) => {
        const path = /^(?:\/|[A-Za-z]:[\\/])/.test(file.path) ? file.path : `${file.repositoryRoot ?? reply.root}/${file.path}`
        return { path, relativePath: file.path, name: file.path.split(/[/\\]/).at(-1) ?? file.path, kind: file.kind ?? 'modify',
          added: file.additions ?? null, removed: file.deletions ?? null, turnDiff: null }
      })
      setRecord({ owner: turn, value: files.length ? { turnId: turn.turnId, files,
        added: reply.stats?.linesAdded ?? null, removed: reply.stats?.linesRemoved ?? null } : null })
    }).catch((error: any) => {
      if (current) setRecord({ owner: turn, value: { ...turn, added: null, removed: null }, error: error?.message || t('error') })
    })
    return () => { current = false }
  }, [sessionId, turn])
  const shown = record?.owner === turn ? record.value : visibleTurnChanges(turn)
  if (!shown) return null
  return <span className={styles['changes-capsule-slot']} onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}
    onFocus={() => setOpen(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false) }}
    onKeyDown={event => { if (event.key === 'Escape') { setOpen(false); event.stopPropagation() } }}>
    <button type="button" className={styles['changes-capsule']} data-embedded={embedded || undefined} aria-label={t('action_dots_review_title')}
      onClick={() => openTurnChanges(turn.turnId, null, sessionId)}>
      <span>{t(shown.files.length === 1 ? 'changes_review_file' : 'changes_review_files').replace('{n}', shown.files.length.toLocaleString())}</span>
      <ChangeStats added={shown.added} removed={shown.removed} />
    </button>
    {open ? <div className={styles['changes-capsule-files']} role="region" aria-label={t('diff_files_changed')}>
      {record?.owner === turn && record.error ? <div role="status" className={styles['review-context-notice']}>{record.error}</div> : null}
      {shown.files.map((file, index) => <button type="button" key={`${file.path}:${index}`}
        onClick={() => { setOpen(false); openTurnChanges(turn.turnId, file.path, sessionId) }}>
        <RawHtml tag="span" html={fileIconSvg(file.name || file.path)} />
        <span>{file.relativePath || file.path}</span><ChangeStats added={file.added} removed={file.removed} />
      </button>)}
    </div> : null}
  </span>
}

/** A checkout entry is independent of the conversation's currently selected turn. */
export function ChangesEntry({ sessionId }: { sessionId: string }) {
  const t = useT()
  const [summary, setSummary] = useState<any>(null)
  useEffect(() => {
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    let sequence = 0
    const load = async () => {
      const request = ++sequence
      try {
        const result = await (window as any).klaus.diff.summary(sessionId, { source: 'branch' })
        if (active && request === sequence) setSummary(result)
      } catch (error: any) { if (active && request === sequence) setSummary({ error: error?.message || t('error') }) }
    }
    void load()
    const dispose = (window as any).klaus.on?.chatEvent?.((event: any) => {
      if (event.sessionId !== sessionId && event.sessionId !== (window as any).getCurrentSessionId?.()) return
      if (!['diff_update', 'tool_end', 'done', 'workspace:changed', 'workspace:invalidated'].includes(event.type)) return
      clearTimeout(timer); timer = setTimeout(() => void load(), 250)
    })
    return () => { active = false; clearTimeout(timer); if (typeof dispose === 'function') dispose() }
  }, [sessionId])
  if (!summary?.stats?.filesCount && !summary?.error) return null
  return <button type="button" className={styles['changes-entry']}
    onClick={() => show({ source: 'branch', sessionId, repositoryRoot: summary.repositoryRoot, openPanel: true })}>
    <RawHtml tag="span" className={styles['changes-entry-icon']} html={fileDiffSvg} /><span>{t('diff_view_title')}</span>
    <ChangeStats added={summary.stats?.linesAdded ?? null} removed={summary.stats?.linesRemoved ?? null} />
    {summary.error ? <span role="status" className={styles['changes-entry-error']}>{summary.error}</span> : null}
  </button>
}

export function mountChangesEntry(host: HTMLElement, sessionId: string): () => void {
  const root = createRoot(host)
  root.render(<ChangesEntry sessionId={sessionId} />)
  return () => root.unmount()
}
