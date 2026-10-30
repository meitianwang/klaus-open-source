import { useCallback, useEffect, useRef, useState } from 'react'
import type { CollaborationDiscussionSource } from '../../../../contracts/team-collaboration'
import { boardRequest, errorText } from './board-api'
import { isAccessDenied } from './board-model'
import { useBoardT } from './board-i18n'
import { BoardError, MarkdownBody } from './issue-fields'
import styles from './board-styles.module.css'

/**
 * A discussion's reference list.
 *
 * A source is stored, never fetched: the server refuses credentials in a URL and
 * does not resolve the target, so an entry is a citation the members share rather
 * than a live embed. `kind` picks how it reads — a URL is shown as its link, a
 * markdown entry is rendered like the rest of the discussion text.
 */
export function DiscussionSources({ projectId, discussionId, writable, revision, onDenied }: {
  projectId: string; discussionId: string; writable: boolean; revision: number; onDenied(): void
}) {
  const t = useBoardT(), [rows, setRows] = useState<CollaborationDiscussionSource[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false), [kind, setKind] = useState<'url' | 'markdown'>('url'), [title, setTitle] = useState(''), [content, setContent] = useState('')
  const [removing, setRemoving] = useState<string | null>(null), [open, setOpen] = useState<string | null>(null)
  const sequence = useRef(0)
  const load = useCallback(async () => {
    const request = ++sequence.current
    try {
      const result = await boardRequest({ type: 'discussion-sources.list', discussionId })
      if (request === sequence.current) { setRows(result); setError('') }
    } catch (cause) { if (request === sequence.current) { setError(errorText(cause, t)); if (isAccessDenied(cause)) onDenied() } }
  }, [discussionId])
  useEffect(() => { void load(); return () => { sequence.current++ } }, [load, revision])
  async function add() {
    if (!writable || busy || !title.trim() || !content.trim()) return
    setBusy(true); setError('')
    try {
      await boardRequest({ type: 'discussion-sources.add', projectId, discussionId, kind, title: title.trim(), content: content.trim() })
      setTitle(''); setContent(''); setKind('url'); setAdding(false); await load()
    } catch (cause) { setError(errorText(cause, t)); if (isAccessDenied(cause)) onDenied() }
    finally { setBusy(false) }
  }
  async function remove(source: CollaborationDiscussionSource) {
    setBusy(true); setError('')
    try { await boardRequest({ type: 'discussion-sources.remove', projectId, discussionId, sourceId: source.id }); setRemoving(null); await load() }
    catch (cause) { setError(errorText(cause, t)); if (isAccessDenied(cause)) onDenied() }
    finally { setBusy(false) }
  }
  return <section className={styles.sources} aria-label={t('sources')}>
    <header className={styles.sectionHeader}><h3>{t('sources')}</h3>{rows.length > 0 && <span className={styles.count}>{rows.length}</span>}<span className={styles.spacer} />{writable && <button type="button" disabled={busy} aria-expanded={adding} onClick={() => setAdding(!adding)}>{t('addSource')}</button>}</header>
    <BoardError message={error} retry={() => { setError(''); void load() }} />
    {adding && <div className={styles.sourceForm}>
      <label>{t('sourceKind')}<select value={kind} disabled={busy} onChange={event => setKind(event.target.value as 'url' | 'markdown')}><option value="url">{t('sourceKindUrl')}</option><option value="markdown">{t('sourceKindMarkdown')}</option></select></label>
      <label>{t('sourceTitle')}<input value={title} maxLength={200} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
      {kind === 'url'
        ? <label>{t('sourceUrl')}<input value={content} maxLength={32000} placeholder="https://" disabled={busy} onChange={event => setContent(event.target.value)} /><span className={styles.muted}>{t('sourceUrlHint')}</span></label>
        : <label>{t('sourceContent')}<textarea value={content} rows={4} maxLength={32000} disabled={busy} onChange={event => setContent(event.target.value)} /></label>}
      <div className={styles.actions}><button type="button" disabled={busy} onClick={() => { setAdding(false); setTitle(''); setContent('') }}>{t('cancel')}</button><button type="button" className={styles.primary} disabled={busy || !title.trim() || !content.trim()} onClick={() => void add()}>{busy ? t('saving') : t('confirm')}</button></div>
    </div>}
    {!rows.length && !adding && <p className={styles.muted}>{t('noSources')}</p>}
    {rows.map(source => <article key={source.id} className={styles.sourceRow}>
      <button type="button" className={styles.sourceHead} aria-expanded={open === source.id} onClick={() => setOpen(open === source.id ? null : source.id)}>
        <span className={styles.source}>{t(source.kind === 'url' ? 'sourceKindUrl' : 'sourceKindMarkdown')}</span><strong>{source.title}</strong>
      </button>
      {open === source.id && (source.kind === 'url'
        ? <a href={source.content} target="_blank" rel="noreferrer noopener">{source.content}</a>
        : <MarkdownBody value={source.content} />)}
      {writable && (removing === source.id
        ? <div className={styles.confirmInline} role="alert"><p>{t('removeSourceConfirm')} <strong>{source.title}</strong></p><div className={styles.actions}><button type="button" disabled={busy} onClick={() => setRemoving(null)}>{t('cancel')}</button><button type="button" className={styles.danger} disabled={busy} onClick={() => void remove(source)}>{t('confirm')}</button></div></div>
        : <button type="button" className={styles.danger} disabled={busy} aria-label={`${t('removeSource')} ${source.title}`} onClick={() => setRemoving(source.id)}>{t('remove')}</button>)}
    </article>)}
  </section>
}
