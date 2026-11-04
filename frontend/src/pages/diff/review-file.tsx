import { useEffect, useMemo, useRef, useState } from 'react'
import { FileDiff } from '@pierre/diffs/react'
import type { DiffLineAnnotation, SelectedLineRange } from '@pierre/diffs'
import { Icon } from '../../components/Icon'
import { RawHtml } from '../../components/RawHtml'
import { useT } from '../../i18n'
import { writeClipboardText } from '../../clipboard'
import { fileIconSvg } from '../../chat/file-icon'
import { renderMarkdownHtml } from '../../chat/markdown'
import {
  collapseAll, displayPath, fileKey, hunkErrorMessage, isViewed, loadFileHunks, reviewPreferences,
  runFileAction, state, toggleCollapsed, toggleViewed,
} from './store'
import type { DiffFile } from './store'
import { importHunks, patchForHunks, reviewMetadata } from './review-model'
import { ChangeStats, MenuItem, ReviewMenu } from './review-controls'
import { readCommentDraft, writeCommentDraft, type ReviewComment, type ReviewCommentDraft } from './review-feedback'
import styles from './diff.module.css'
import './review-theme'

export type ReviewAction = 'stage' | 'unstage' | 'revert'
export function absoluteFilePath(file: DiffFile): string {
  return /^(?:\/|[A-Za-z]:[\\/])/.test(file.path) ? file.path : `${file.repositoryRoot ?? state.summary?.root ?? ''}/${file.path}`
}

function MarkdownPreview({ text, sessionId }: { text: string; sessionId: string | null }) {
  const html = useMemo(() => {
    const root = document.createElement('div')
    root.innerHTML = renderMarkdownHtml(text, sessionId ?? undefined)
    root.querySelectorAll('[title],[data-klaus-tip]').forEach(element => { element.removeAttribute('title'); element.removeAttribute('data-klaus-tip') })
    return root.innerHTML
  }, [text, sessionId])
  return <div className={`${styles['review-markdown']} markdown-body`} dangerouslySetInnerHTML={{ __html: html }} />
}

function SnapshotPdf({ dataUrl, path }: { dataUrl: string; path: string }) {
  const url = useMemo(() => {
    if (!dataUrl.startsWith('data:application/pdf;base64,')) return ''
    const bytes = Uint8Array.from(atob(dataUrl.slice(dataUrl.indexOf(',') + 1)), character => character.charCodeAt(0))
    return URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }))
  }, [dataUrl])
  useEffect(() => () => { if (url) URL.revokeObjectURL(url) }, [url])
  return <iframe aria-label={path} src={url} />
}

function CommentEditor({ body, onCancel, onSave, onChange }: { body: string; onCancel: () => void; onSave: (text: string) => void; onChange: (text: string) => void }) {
  const t = useT(), [text, setText] = useState(body)
  return <form className={styles['review-comment-editor']} onSubmit={event => { event.preventDefault(); if (text.trim()) onSave(text.trim()) }}>
    <textarea autoFocus aria-label={t('changes_comment_placeholder')} placeholder={t('changes_comment_placeholder')} value={text}
      onChange={event => { setText(event.target.value); onChange(event.target.value) }} onKeyDown={event => {
        if (event.key === 'Escape') { event.stopPropagation(); onCancel() }
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && text.trim()) { event.preventDefault(); onSave(text.trim()) }
      }} />
    <div><button type="button" onClick={onCancel}>{t('changes_cancel')}</button>
      <button type="submit" disabled={!text.trim()}>{t('changes_save_comment')}</button></div>
  </form>
}

export function ReviewFile({ file, paneWidth, theme, comments, onComments, onAction, mutating, sectionRef }: {
  file: DiffFile; paneWidth: number; theme: 'light' | 'dark'; comments: ReviewComment[]
  onComments: (comments: ReviewComment[]) => void
  onAction: (action: ReviewAction, file?: DiffFile, hunkIndex?: number) => void
  mutating: boolean; sectionRef: (node: HTMLElement | null) => void
}) {
  const t = useT(), key = fileKey(file), container = useRef<HTMLElement>(null)
  const [visible, setVisible] = useState(key === state.selectedPath)
  const [selection, setSelection] = useState<SelectedLineRange | null>(null)
  const owner = state.sessionId ?? ''
  const [editor, setEditorState] = useState<ReviewCommentDraft | null>(() => readCommentDraft(owner, absoluteFilePath(file)))
  const setEditor = (draft: ReviewCommentDraft | null) => { setEditorState(draft); writeCommentDraft(owner, absoluteFilePath(file), draft) }
  const [hoveredHunk, setHoveredHunk] = useState<number | null>(null)
  const [contextError, setContextError] = useState<string | null>(null)
  const [hiddenImports, setHiddenImports] = useState<Set<number>>(new Set())
  const hunks = state.hunkMap.get(key)
  const detail = state.detailMap.get(key)
  const collapsed = state.collapsedPaths.has(key)
  const richContent = /\.(?:md|markdown|mdown|mdx|mkd|svg|png|jpe?g|gif|webp|bmp|ico|avif|pdf)$/i.test(file.path)
  const fullContent = state.source !== 'last-turn' || reviewPreferences.fullFiles || reviewPreferences.hideWhitespace || reviewPreferences.hideImports || richContent
  const mutable = ['branch', 'uncommitted', 'unstaged', 'staged'].includes(state.source) && Boolean(file.snapshotId)
  const stageAction: ReviewAction = state.source === 'staged' ? 'unstage' : 'stage'
  const fileComments = comments.filter(comment => comment.path === absoluteFilePath(file) && (comment.snapshotId === file.snapshotId || (hunks ?? []).some(hunk => comment.localDiffHunk.includes(patchForHunks([hunk]).split('\n').slice(2).join('\n')))))
  useEffect(() => {
    if (key === state.selectedPath) setVisible(true)
    const node = container.current
    if (!node || typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect() } },
      { root: node.closest('[data-review-scroll]'), rootMargin: '300px' })
    observer.observe(node); return () => observer.disconnect()
  }, [key, state.selectedPath])
  useEffect(() => {
    if (!visible || collapsed || state.loading || state.loadingPaths.has(key) || state.hunkMap.has(key) && (!fullContent || detail?.oldContent !== undefined && detail?.newContent !== undefined || detail?.contentsUnavailable) || state.hunkErrors.has(key)) return
    if (!file.patchUnavailable && (!file.isBinary || richContent)) void loadFileHunks(file, fullContent)
  }, [visible, collapsed, key, state.seq, state.loading, file.snapshotId, fullContent, hunks, detail?.contentsUnavailable, detail?.oldContent !== undefined])
  useEffect(() => {
    let active = true
    setHiddenImports(old => old.size ? new Set() : old)
    if (!reviewPreferences.hideImports || !hunks || detail?.oldContent === undefined || detail.newContent === undefined) return
    if (hunks.some(hunk => (hunk.oldStart ?? 0) === 0 || (hunk.newStart ?? 0) === 0)) return
    void importHunks(file.path, hunks, detail.oldContent, detail.newContent).then(indices => { if (active) setHiddenImports(indices) }).catch(() => {})
    return () => { active = false }
  }, [reviewPreferences.hideImports, hunks, detail?.oldContent, detail?.newContent, file.path])
  const filteredHunks = useMemo(() => (hunks ?? []).filter((hunk, index) => !hiddenImports.has(index)
    || fileComments.some(comment => {
      const old = comment.range.side === 'deletions'
      const start = old ? hunk.oldStart ?? 0 : hunk.newStart ?? 0
      const count = old ? hunk.oldLines ?? 0 : hunk.newLines ?? 0
      const a = Math.min(comment.range.start, comment.range.end), b = Math.max(comment.range.start, comment.range.end)
      return a < start + count && b >= start
    })), [hunks, hiddenImports, comments])
  const model = useMemo(() => {
    try { return reviewMetadata(file, filteredHunks, fullContent ? detail : { patch: detail?.patch }, { hideWhitespace: reviewPreferences.hideWhitespace, hideImports: reviewPreferences.hideImports },
      `${state.sessionId}:${state.seq}:${key}:${reviewPreferences.hideWhitespace}:${reviewPreferences.hideImports}:${fullContent && detail?.oldContent !== undefined && detail?.newContent !== undefined ? 'complete' : 'partial'}`) }
    catch { return null }
  }, [filteredHunks, fullContent, fullContent ? detail : detail?.patch, reviewPreferences.hideWhitespace, reviewPreferences.hideImports, key])
  type Annotation = ReviewComment | 'editor' | { kind: 'hunk-actions'; index: number }
  const annotations: DiffLineAnnotation<Annotation>[] = fileComments.filter(comment => comment.id !== editor?.id)
    .map(comment => ({ side: comment.range.endSide ?? comment.range.side ?? 'additions', lineNumber: comment.range.end, metadata: comment }))
  if (editor && editor.snapshotId === file.snapshotId) annotations.push({ side: editor.range.endSide ?? editor.range.side ?? 'additions', lineNumber: editor.range.end, metadata: 'editor' })
  if (mutable) for (const [index, hunk] of (hunks ?? []).entries()) {
    if (hiddenImports.has(index)) continue
    const leading = (hunk.lines ?? []).findIndex(line => line.startsWith('+') || line.startsWith('-'))
    const old = (hunk.lines ?? [])[Math.max(0, leading)]?.startsWith('-')
    annotations.push({ side: old ? 'deletions' : 'additions', lineNumber: Math.max(1, (old ? hunk.oldStart ?? 0 : hunk.newStart ?? 0) + Math.max(0, leading)), metadata: { kind: 'hunk-actions', index } })
  }
  const capturedHunk = (range: SelectedLineRange) => patchForHunks((hunks ?? []).filter(hunk => {
    const old = range.side === 'deletions', start = old ? hunk.oldStart ?? 0 : hunk.newStart ?? 0
    const length = old ? hunk.oldLines ?? 0 : hunk.newLines ?? 0
    return Math.min(range.start, range.end) < start + length && Math.max(range.start, range.end) >= start
  }))
  const openComment = (range: SelectedLineRange) => {
    const existing = fileComments.find(comment => comment.range.end === range.end && (comment.range.endSide ?? comment.range.side) === (range.endSide ?? range.side))
    setEditor(existing ? { id: existing.id, range: existing.range, body: existing.body, localDiffHunk: existing.localDiffHunk, snapshotId: file.snapshotId } : { range, body: '', localDiffHunk: capturedHunk(range), snapshotId: file.snapshotId })
  }
  const saveComment = (body: string) => {
    if (!editor) return
    const comment = { id: editor.id ?? crypto.randomUUID(), fileKey: key, path: absoluteFilePath(file), range: editor.range, body, localDiffHunk: editor.localDiffHunk, snapshotId: editor.snapshotId }
    onComments([...comments.filter(row => row.id !== comment.id), comment]); setEditor(null); setSelection(null)
  }
  const copyPath = async () => {
    try { await writeClipboardText(absoluteFilePath(file)); (window as any).showToast?.(t('changes_copied')) }
    catch (error: any) { (window as any).showToast?.(error.message) }
  }
  const openInternal = () => (window as any).klausOpenWorkspaceFilePath?.(absoluteFilePath(file))
  const isMarkdown = /\.(?:md|markdown|mdown|mdx|mkd)$/i.test(file.path)
  const isSvg = /\.svg$/i.test(file.path)
  const isPdf = /\.pdf$/i.test(file.path)
  const isImage = /\.(?:png|jpe?g|gif|webp|bmp|ico|avif)$/i.test(file.path)
  const mediaPreview = (isImage || isPdf || isSvg && reviewPreferences.richPreview) && Boolean(detail?.oldDataUrl || detail?.newDataUrl)
  const markdownPreview = isMarkdown && reviewPreferences.richPreview && detail?.newContent !== undefined && detail.newContent !== ''
  let body
  if (!visible) body = <div className={styles['review-file-placeholder']} />
  else if (file.patchUnavailable || detail?.patchUnavailable) body = <div className={styles['diff-detail-empty']}>{t('diff_turn_patch_unavailable')}</div>
  else if (state.hunkErrors.has(key)) body = <div className={`${styles['diff-detail-empty']} ${styles['diff-detail-error']}`} role="alert">
    <span>{hunkErrorMessage(state.hunkErrors.get(key))}</span><button type="button" className="btn-sm" onClick={() => void loadFileHunks(file, true)}>{t('diff_retry')}</button></div>
  else if (file.isBinary && !richContent) body = <div className={styles['diff-detail-empty']}>{t('diff_binary_detail')}</div>
  else if (!hunks) body = <div className={styles['diff-detail-empty']}>{t('diff_loading_hunks')}</div>
  else if (mediaPreview) body = <div className={styles['review-media']}>
    {(['oldDataUrl', 'newDataUrl'] as const).map(side => detail?.[side] ? <div key={side} className={styles[side === 'oldDataUrl' ? 'review-media-before' : 'review-media-after']}>
      {isPdf ? <SnapshotPdf dataUrl={detail[side]} path={file.path} />
        : <img src={detail[side]} alt={file.path} />}
    </div> : null)}
  </div>
  else if (markdownPreview) body = <div className={styles['review-markdown-pair']}>
    {detail!.oldContent ? <div className={styles['review-media-before']}><MarkdownPreview text={detail!.oldContent} sessionId={state.sessionId} /></div> : null}
    <div className={styles['review-media-after']}><MarkdownPreview text={detail!.newContent!} sessionId={state.sessionId} /></div>
  </div>
  else if (file.isBinary || detail?.isBinary) body = <div className={styles['diff-detail-empty']}>{t('diff_binary_detail')}</div>
  else if (state.hunkTruncated.has(key)) body = <div className={styles['diff-detail-empty']}>{t('diff_patch_truncated')}</div>
  else if (!model) body = <div className={styles['diff-detail-empty']}>{t(hunks.length ? 'changes_unchanged' : 'diff_no_hunks')}</div>
  else body = <>
    {contextError ? <div className={styles['review-context-notice']} role="status">{contextError}</div> : null}
    {editor && editor.snapshotId !== file.snapshotId ? <><div className={styles['review-context-notice']}>{t('diff_snapshot_changed')}</div><CommentEditor body={editor.body} onChange={body => setEditor({ ...editor, body })} onCancel={() => setEditor(null)} onSave={saveComment} /></> : null}
    {detail?.contentsUnavailable ? <div className={styles['review-context-notice']}>{t(detail.contentsUnavailable === 'too-large' ? 'changes_contents_large' : 'changes_context_unavailable')}</div> : null}
    <FileDiff<Annotation> fileDiff={model} selectedLines={selection} lineAnnotations={annotations}
      options={{ theme: { light: 'klaus-review-light', dark: 'github-dark' }, themeType: theme, preferredHighlighter: 'shiki-js',
        diffStyle: reviewPreferences.layout === 'auto' ? paneWidth >= 800 && (file.additions ?? 0) > 0 && (file.deletions ?? 0) > 0 ? 'split' : 'unified' : reviewPreferences.layout,
        overflow: reviewPreferences.wordWrap ? 'wrap' : 'scroll', disableFileHeader: true, diffIndicators: 'bars', hunkSeparators: 'line-info',
        lineDiffType: reviewPreferences.wordDiffs ? 'word-alt' : 'none', expandUnchanged: false,
        loadDiffFiles: model.isPartial && !detail?.contentsUnavailable ? async () => {
          const loaded = await loadFileHunks(file, true)
          if (loaded?.oldContent === undefined || loaded.newContent === undefined) {
            const error = t(loaded?.contentsUnavailable === 'too-large' ? 'changes_contents_large' : 'changes_context_unavailable')
            setContextError(error); throw new Error(error)
          }
          return { oldFile: { name: file.previousPath ?? file.path, contents: loaded.oldContent }, newFile: { name: file.path, contents: loaded.newContent } }
        } : undefined,
        onLineEnter: ({ lineNumber, annotationSide }) => setHoveredHunk((hunks ?? []).findIndex(hunk => {
          const old = annotationSide === 'deletions', start = old ? hunk.oldStart ?? 0 : hunk.newStart ?? 0
          const length = old ? hunk.oldLines ?? 0 : hunk.newLines ?? 0
          return lineNumber >= start && lineNumber < start + length
        })),
        onLineLeave: () => setHoveredHunk(null),
        expansionLineCount: 20, enableLineSelection: true, enableGutterUtility: true, controlledSelection: true,
        onLineSelected: setSelection, onLineSelectionChange: setSelection,
        unsafeCSS: ':host{--diffs-font-family:var(--font-mono,ui-monospace,monospace);--diffs-font-size:12px;--diffs-line-height:20px;--diffs-bg:var(--bg);--diffs-bg-addition-override:var(--theme-diff-added);--diffs-bg-deletion-override:var(--theme-diff-removed);--diffs-bg-addition-number-override:var(--theme-diff-added);--diffs-bg-deletion-number-override:var(--theme-diff-removed)}',
      }}
      renderGutterUtility={getHovered => <button type="button" className={styles['review-add-comment']} aria-label={t('changes_add_comment')}
        onClick={() => {
          const hovered = getHovered()
          if (selection) openComment(selection)
          else if (hovered) openComment({ start: hovered.lineNumber, end: hovered.lineNumber, side: hovered.side })
        }}><Icon name="plus" size={14} /></button>}
      renderAnnotation={({ metadata }) => metadata === 'editor'
        ? <CommentEditor body={editor?.body ?? ''} onChange={body => { if (editor) setEditor({ ...editor, body }) }} onCancel={() => setEditor(null)} onSave={saveComment} />
        : metadata && 'kind' in metadata ? <div className={styles['review-hunk-slot']}><div className={styles['review-hunk-actions']} data-active={hoveredHunk === metadata.index}>
          <button type="button" disabled={mutating} aria-label={`${t(`changes_${stageAction}`)} · ${metadata.index + 1}`} onClick={() => onAction(stageAction, file, metadata.index)}>{t(`changes_${stageAction}`)}</button>
          <button type="button" disabled={mutating} aria-label={`${t('changes_revert')} · ${metadata.index + 1}`} onClick={() => onAction('revert', file, metadata.index)}>{t('changes_revert')}</button>
        </div></div>
        : metadata ? <div className={styles['review-comment']}><p>{metadata.body}</p><div>
          <button type="button" aria-label={t('changes_edit_comment')} onClick={() => setEditor({ id: metadata.id, range: metadata.range, body: metadata.body, localDiffHunk: metadata.localDiffHunk, snapshotId: file.snapshotId })}>{t('edit')}</button>
          <button type="button" aria-label={t('changes_remove_comment')} onClick={() => onComments(comments.filter(row => row.id !== metadata.id))}>{t('delete')}</button>
        </div></div> : null} />
    {selection && !editor ? <button type="button" className={styles['review-selection-comment']} onClick={() => openComment(selection)}><Icon name="plus" size={14} />{t('changes_add_comment')}</button> : null}
  </>
  return <section ref={node => { container.current = node; sectionRef(node) }} className={styles['review-file']}
    data-file-key={key} data-collapsed={collapsed} data-viewed={isViewed(file)}>
    <header className={styles['review-file-header']}>
      <button type="button" className={styles['review-file-heading']} aria-expanded={!collapsed}
        aria-label={displayPath(file)} onClick={event => event.altKey ? collapseAll(!collapsed) : toggleCollapsed(key)}>
        <span className={styles['review-file-icon']}><RawHtml tag="span" html={fileIconSvg(file.path)} /></span>
        <span className={styles['review-file-path']}>{file.previousPath ? `${file.previousPath} → ${file.path}` : file.path}</span>
      </button>
      <ChangeStats added={file.additions} removed={file.deletions} compact />
      <div className={styles['review-file-actions']}>
        {state.source === 'branch' && file.snapshotId ? <button type="button" className={styles['review-button']} aria-pressed={isViewed(file)}
          aria-label={t(isViewed(file) ? 'changes_unviewed' : 'changes_viewed')} onClick={() => toggleViewed(file)}><Icon name={isViewed(file) ? 'check' : 'ws-file-preview'} size={16} /></button> : null}
        <button type="button" className={styles['review-button']} aria-label={t('diff_open')} disabled={model?.type === 'deleted'} onClick={openInternal}><Icon name="arrow-up-right" size={16} /></button>
        <ReviewMenu label={t('changes_file_options')} icon="panel-tab-more">{close => <>
          <MenuItem onClick={() => { close(); void copyPath() }} icon="copy">{t('diff_copy_path')}</MenuItem>
          <MenuItem disabled={model?.type === 'deleted'} onClick={() => { close(); void runFileAction('open', file) }} icon="arrow-up-right">{t('changes_open_editor')}</MenuItem>
          <MenuItem onClick={() => { close(); void runFileAction('reveal', file) }} icon="folder-open">{t('diff_reveal')}</MenuItem>
          <MenuItem onClick={() => { close(); toggleCollapsed(key) }}>{t(collapsed ? 'changes_expand_file' : 'changes_collapse_file')}</MenuItem>
          {mutable ? <>
            <div role="separator" className={styles['review-menu-separator']} />
            <MenuItem disabled={mutating} onClick={() => { close(); onAction(stageAction, file) }}>{t(`changes_${stageAction}`)}</MenuItem>
            <MenuItem disabled={mutating} onClick={() => { close(); onAction('revert', file) }}>{t('changes_revert')}</MenuItem>
            {(hunks ?? []).map((hunk, index) => <div key={index}>
              <div className={styles['review-menu-caption']}>{`@@ -${hunk.oldStart} +${hunk.newStart} @@`}</div>
              <MenuItem disabled={mutating || file.isBinary} onClick={() => { close(); onAction(stageAction, file, index) }}>{t(`changes_${stageAction}`)}</MenuItem>
              <MenuItem disabled={mutating || file.isBinary} onClick={() => { close(); onAction('revert', file, index) }}>{t('changes_revert')}</MenuItem>
            </div>)}
          </> : null}
        </>}</ReviewMenu>
      </div>
    </header>
    {!collapsed ? <div className={styles['review-file-body']}>{body}</div> : null}
  </section>
}
