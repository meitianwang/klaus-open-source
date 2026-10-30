import { useCallback, useEffect, useRef, useState } from 'react'
import type { CollaborationFile, CollaborationFileScope } from '../../../../contracts/team-collaboration'
import { boardBridge, boardRequest, errorText } from './board-api'
import { isAccessDenied } from './board-model'
import { useBoardT } from './board-i18n'
import { BoardError } from './issue-fields'
import { ATTACHMENT_INPUT_ACCEPT, ATTACHMENT_SCOPE_LIMIT, attachmentError, attachmentMediaType, attachmentSize, encodeAttachment } from './attachment-contract'
import type { FilePreview } from '../../../../main/services/team-collaboration/files'
import styles from './board-styles.module.css'

/**
 * The picked-but-not-yet-uploaded file an Issue is created with.
 *
 * An Issue's attachments are transferred inside `issues.create`: the file is
 * uploaded first under the project root scope, and its id goes into
 * `attachmentIds`. `issues.update.patch` deliberately does not accept that field,
 * so this draft list exists only on the create path.
 */
export interface DraftAttachmentFile { id: string; file: File }

export function AttachmentPicker({ files, disabled, max, onChange, onError }: {
  files: DraftAttachmentFile[]; disabled: boolean; max: number; onChange(next: DraftAttachmentFile[]): void; onError(message: string): void
}) {
  const t = useBoardT(), input = useRef<HTMLInputElement>(null)
  function add(picked: FileList | null) {
    if (!picked?.length) return
    const next = files.slice()
    for (const file of Array.from(picked)) {
      const problem = attachmentError(file.name, file.size)
      if (problem) { onError(problem === 'size' ? t('attachmentSize') : t('attachmentType')); continue }
      if (next.length >= max) { onError(t('attachmentCount').replace('{n}', String(max))); break }
      next.push({ id: crypto.randomUUID(), file })
    }
    onChange(next)
  }
  return <div className={styles.attachmentPicker}>
    <button type="button" disabled={disabled} aria-label={t('addAttachment')} onClick={() => input.current?.click()}>{t('addAttachment')}</button>
    <input ref={input} type="file" multiple hidden accept={ATTACHMENT_INPUT_ACCEPT} onChange={event => { add(event.target.files); event.target.value = '' }} />
    {files.length > 0 && <ul className={styles.attachmentDrafts}>{files.map(item => <li key={item.id}>
      <span className={styles.attachmentName}>{item.file.name}</span>
      <span className={styles.attachmentMeta}>{attachmentSize(item.file.size)}</span>
      <button type="button" disabled={disabled} aria-label={`${t('removeAttachment')} ${item.file.name}`} onClick={() => onChange(files.filter(row => row.id !== item.id))}>×</button>
    </li>)}</ul>}
  </div>
}

/**
 * Uploads each draft under the project root scope and returns the ids in order,
 * so `issues.create` can transfer them in its own transaction. A failure here
 * leaves no Issue behind, which is why the create path uploads before it posts.
 */
export async function uploadDraftAttachments(projectId: string, files: DraftAttachmentFile[]): Promise<string[]> {
  const ids: string[] = []
  for (const item of files) {
    const mediaType = attachmentMediaType(item.file.name)
    if (!mediaType) throw new Error(item.file.name)
    const file = await boardRequest({ type: 'files.upload', scope: { projectId }, name: item.file.name, mediaType, dataBase64: await encodeAttachment(item.file) })
    ids.push(file.id)
  }
  return ids
}

/**
 * The Issue's own attachment list. After creation the scope is
 * `{projectId, issueId}`: `files.list` is the only way to enumerate what the
 * Issue carries, and `files.remove` is the only way to take one away.
 */
export function IssueAttachments({ projectId, issueId, writable, revision, onChanged, onDenied }: {
  projectId: string; issueId: string; writable: boolean; revision: number; onChanged(): void; onDenied(): void
}) {
  const t = useBoardT(), scope: CollaborationFileScope = { projectId, issueId }
  const [files, setFiles] = useState<CollaborationFile[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null), [preview, setPreview] = useState<{ file: CollaborationFile; value: FilePreview } | null>(null)
  const input = useRef<HTMLInputElement>(null), sequence = useRef(0)
  const load = useCallback(async () => {
    const request = ++sequence.current
    try {
      const rows = await boardRequest({ type: 'files.list', scope })
      if (request === sequence.current) { setFiles(rows); setError('') }
    } catch (cause) { if (request === sequence.current) { setError(errorText(cause, t)); if (isAccessDenied(cause)) onDenied() } }
  }, [projectId, issueId])
  useEffect(() => { void load(); return () => { sequence.current++ } }, [load, revision])
  async function upload(picked: FileList | null) {
    if (!picked?.length || busy) return
    setBusy(true); setError('')
    try {
      for (const file of Array.from(picked)) {
        const problem = attachmentError(file.name, file.size)
        if (problem) throw new Error(problem === 'size' ? t('attachmentSize') : t('attachmentType'))
        if (files.length >= ATTACHMENT_SCOPE_LIMIT) throw new Error(t('attachmentLimit'))
        const mediaType = attachmentMediaType(file.name)!
        await boardRequest({ type: 'files.upload', scope, name: file.name, mediaType, dataBase64: await encodeAttachment(file) })
      }
      await load(); onChanged()
    } catch (cause) { setError(errorText(cause, t)); if (isAccessDenied(cause)) onDenied(); await load() }
    finally { setBusy(false) }
  }
  async function remove(file: CollaborationFile) {
    setBusy(true); setError('')
    try { await boardRequest({ type: 'files.remove', scope, fileId: file.id }); setRemoving(null); await load(); onChanged() }
    catch (cause) { setError(errorText(cause, t)); if (isAccessDenied(cause)) onDenied(); await load() }
    finally { setBusy(false) }
  }
  async function open(file: CollaborationFile) {
    setError('')
    try {
      const value = await boardBridge().previewFile(scope, file.id)
      if (value.kind === 'download') { await boardBridge().downloadFile(scope, file.id); return }
      setPreview({ file, value })
    } catch (cause) { setError(errorText(cause, t)) }
  }
  async function download(file: CollaborationFile) {
    try { await boardBridge().downloadFile(scope, file.id) } catch (cause) { setError(errorText(cause, t)) }
  }
  return <section className={styles.attachments} aria-label={t('attachments')}>
    <header className={styles.sectionHeader}><h3>{t('attachments')}</h3>{files.length > 0 && <span className={styles.count}>{files.length}</span>}<span className={styles.spacer} /><button type="button" disabled={!writable || busy} onClick={() => input.current?.click()}>{t('addAttachment')}</button>
      <input ref={input} type="file" multiple hidden accept={ATTACHMENT_INPUT_ACCEPT} onChange={event => { void upload(event.target.files); event.target.value = '' }} /></header>
    <BoardError message={error} retry={() => { setError(''); void load() }} />
    {!files.length && <p className={styles.muted}>{t('noAttachments')}</p>}
    {files.map(file => <article key={file.id} className={styles.attachmentRow}>
      <button type="button" className={styles.attachmentOpen} onClick={() => void open(file)} aria-label={`${t('preview')} ${file.name}`}>
        <span className={styles.attachmentName}>{file.name}</span><span className={styles.attachmentMeta}>{attachmentSize(file.size)} · {new Date(file.createdAt).toLocaleDateString()}</span>
      </button>
      <button type="button" aria-label={`${t('downloadAttachment')} ${file.name}`} onClick={() => void download(file)}>{t('downloadAttachment')}</button>
      <button type="button" className={styles.danger} aria-label={`${t('removeAttachment')} ${file.name}`} disabled={!writable || busy} onClick={() => setRemoving(file.id)}>{t('remove')}</button>
      {removing === file.id && <div className={styles.confirmInline} role="alert"><p>{t('removeAttachmentConfirm')} <strong>{file.name}</strong></p><div className={styles.actions}><button type="button" disabled={busy} onClick={() => setRemoving(null)}>{t('cancel')}</button><button type="button" className={styles.danger} disabled={busy} onClick={() => void remove(file)}>{t('confirm')}</button></div></div>}
    </article>)}
    {preview && <div className={styles.previewPanel} role="dialog" aria-label={preview.file.name}><header><h3>{preview.file.name}</h3><button type="button" aria-label={t('close')} onClick={() => setPreview(null)}>×</button></header>
      {preview.value.kind === 'image' && preview.value.dataUrl ? <img src={preview.value.dataUrl} alt={preview.file.name} /> : <pre>{preview.value.text}</pre>}
    </div>}
  </section>
}
