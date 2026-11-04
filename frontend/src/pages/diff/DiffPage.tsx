import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from '../../components/Icon'
import { useT } from '../../i18n'
import { writeClipboardText } from '../../clipboard'
import {
  allFiles, canCommit, changeTotals, collapseAll, comparisonMessage, fileKey, files, fmt, getVersion,
  loadFileHunks, reload, requestOptions, reviewPreferences, selectPath, setBaseBranch, setCommit,
  setRepository, setReviewPreference, setSource, startCommitFlow, state, subscribe,
} from './store'
import type { DiffFile, DiffSource } from './store'
import { ChangeStats, FileFilter, MenuItem, ReviewIcon, ReviewMenu } from './review-controls'
import { ReviewFile, type ReviewAction } from './review-file'
import { ReviewTree } from './review-tree'
import { commentFeedback, readComments, writeComments, type ReviewComment } from './review-feedback'
import styles from './diff.module.css'

const w = () => window as any
const sources: DiffSource[] = ['last-turn', 'branch', 'uncommitted', 'unstaged', 'staged']

function RevertConfirmation({ onCancel, onConfirm }: { onCancel: () => void; onConfirm: (remember: boolean) => void }) {
  const t = useT(), [remember, setRemember] = useState(false), dialog = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const focused = document.activeElement as HTMLElement | null
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus()
    return () => focused?.focus({ preventScroll: true })
  }, [])
  return createPortal(<div className={styles['review-confirm-overlay']} onPointerDown={event => { if (event.target === event.currentTarget) onCancel() }}>
    <div role="dialog" aria-modal="true" aria-labelledby="changes-revert-title" ref={dialog} className={styles['review-confirm']}
      onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); onCancel() }
        if (event.key !== 'Tab') return
        const controls = Array.from(dialog.current!.querySelectorAll<HTMLElement>('button,input'))
        const next = (controls.indexOf(document.activeElement as HTMLElement) + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
        event.preventDefault(); controls[next].focus()
      }}>
      <h2 id="changes-revert-title">{t('changes_revert_title')}</h2><p>{t('changes_revert_message')}</p>
      <label><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} />{t('changes_dont_ask')}</label>
      <div><button type="button" onClick={onCancel}>{t('changes_cancel')}</button>
        <button type="button" className={styles['review-confirm-destructive']} onClick={() => onConfirm(remember)}>{t('changes_confirm')}</button></div>
    </div>
  </div>, document.body)
}

function ReviewBody({ scope }: { scope: string }) {
  const t = useT(), scroll = useRef<HTMLDivElement>(null), shell = useRef<HTMLDivElement>(null)
  const sections = useRef(new Map<string, HTMLElement>())
  const [comments, setComments] = useState<ReviewComment[]>(() => readComments(state.sessionId ?? ''))
  const [paneWidth, setPaneWidth] = useState(0), [treeWidth, setTreeWidth] = useState(() => {
    try { return Number(localStorage.getItem('klaus.diff.treeWidth')) || 232 } catch { return 232 }
  })
  const [theme, setTheme] = useState<'light' | 'dark'>(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light')
  const [mutating, setMutating] = useState(false), busy = useRef(false)
  const [mutationError, setMutationError] = useState<string | null>(null)
  const [pendingRevert, setPendingRevert] = useState<{ file?: DiffFile; hunkIndex?: number; snapshotId?: string } | null>(null)
  const updateComments = (next: ReviewComment[]) => { setComments(next); writeComments(state.sessionId ?? '', next) }
  useEffect(() => {
    const observer = new ResizeObserver(entries => setPaneWidth(entries[0]?.contentRect.width ?? 0))
    if (shell.current) observer.observe(shell.current)
    const themes = new MutationObserver(() => setTheme(document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'))
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    return () => { observer.disconnect(); themes.disconnect() }
  }, [])
  useEffect(() => {
    const container = scroll.current
    const section = state.selectedPath ? sections.current.get(state.selectedPath) : null
    // File navigation must not scroll the panel header or the application viewport.
    if (container && section) container.scrollTo({
      top: container.scrollTop + section.getBoundingClientRect().top - container.getBoundingClientRect().top,
      behavior: 'instant',
    })
  }, [state.selectedPath, state.navigationVersion])
  const resizeTree = (value: number) => {
    const maximum = Math.max(160, paneWidth * 0.6), minimum = Math.min(200, maximum)
    const width = Math.round(Math.max(minimum, Math.min(value, maximum)))
    setTreeWidth(width)
    try { localStorage.setItem('klaus.diff.treeWidth', String(width)) } catch {}
  }
  const applyAction = async (action: ReviewAction, file?: DiffFile, hunkIndex?: number) => {
    if (busy.current || !state.sessionId) return
    busy.current = true; setMutating(true); setMutationError(null)
    const sessionId = state.sessionId, sequence = state.seq
    try {
      const result = await w().klaus.diff.applyReviewAction(sessionId, action, {
        ...requestOptions(file), expectedSnapshotId: file?.snapshotId ?? state.summary?.snapshotId,
        ...(file ? { filePath: file.path } : {}), ...(hunkIndex !== undefined ? { hunkIndex } : {}),
      })
      if (!result?.ok) throw new Error(result?.error || t('error'))
    } catch (error: any) { if (state.sessionId === sessionId) setMutationError(error?.message || t('error')) }
    finally {
      busy.current = false; setMutating(false)
      if (state.sessionId === sessionId && state.seq === sequence) await reload(true)
    }
  }
  const onAction = (action: ReviewAction, file?: DiffFile, hunkIndex?: number) => {
    if (busy.current) return
    if (action === 'revert') {
      let skip = false
      try { skip = localStorage.getItem('klaus.diff.skipRevertConfirm') === 'true' } catch {}
      if (!skip) { setPendingRevert({ file, hunkIndex, snapshotId: file?.snapshotId ?? state.summary?.snapshotId }); return }
    }
    void applyAction(action, file, hunkIndex)
  }
  const copyPatch = async () => {
    const sequence = state.seq
    try {
      const list = allFiles(), repositories = new Map<string, { working: string[]; index: string[] }>(), paths = new Set<string>()
      for (let offset = 0; offset < list.length; offset += 4) {
        const results = await Promise.all(list.slice(offset, offset + 4).map(file => loadFileHunks(file)))
        for (const [index, detail] of results.entries()) {
          if (!detail?.patch) throw new Error(t(detail?.patchCopyUnavailable ? 'changes_patch_copy_unavailable' : 'changes_context_unavailable'))
          const file = list[offset + index], root = file.repositoryRoot ?? state.summary?.root
          if (!root || root.startsWith('ssh://')) throw new Error(t('changes_context_unavailable'))
          const key = JSON.stringify([root, file.path])
          if (paths.has(key)) throw new Error(t('changes_context_unavailable'))
          paths.add(key)
          const patches = repositories.get(root) ?? { working: [], index: [] }
          const pointer = /^(?:index [^\n]+ 160000|(?:new file|deleted file|old|new) mode 160000)$/m.test(detail.patch)
          patches[pointer ? 'index' : 'working'].push(detail.patch.endsWith('\n') ? detail.patch : detail.patch + '\n')
          repositories.set(root, patches)
        }
      }
      if (sequence !== state.seq) throw new Error(t('diff_snapshot_changed'))
      const quote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`
      const commands = [...repositories].flatMap(([root, groups]) => (['working', 'index'] as const).flatMap(target => {
        if (!groups[target].length) return []
        const patch = groups[target].join('')
        let delimiter = 'KLAUS_REVIEW_PATCH'
        while (patch.split('\n').includes(delimiter)) delimiter += '_END'
        return [(target === 'index' ? '# Record repository pointers in the index; nested working files are unchanged.\n' : '')
          + `git -C ${quote(root)} apply -p1${target === 'index' ? ' --cached' : ''} <<'${delimiter}'\n${patch}${delimiter}`]
      }))
      await writeClipboardText(commands.join('\n\n'))
      w().showToast?.(t('changes_copied'))
    } catch (error: any) { w().showToast?.(error?.message || t('error')) }
  }
  const totals = changeTotals(), list = files(), all = allFiles()
  const comparisonError = comparisonMessage()
  const emptyReason = state.loading && !state.summary ? t('diff_loading') : state.error
    ?? (state.summary?.root?.startsWith('ssh://') ? t('diff_remote')
      : !state.summary?.isGit ? t('diff_not_git') : state.summary.transient ? t('diff_transient') : comparisonError)
  const branchLabel = (ref: string) => ref.startsWith('refs/remotes/') ? ref.slice(13)
    : state.summary?.baseBranches?.includes(ref) ? `${ref.replace(/^refs\/heads\//, '')} (${t('diff_local_branch')})` : ref
  const setBase = (value: string, close: () => void) => { close(); setBaseBranch(value) }
  const mutable = ['branch', 'uncommitted', 'unstaged', 'staged'].includes(state.source) && Boolean(state.summary?.snapshotId) && all.length > 0
  const allCollapsed = all.length > 0 && all.every(file => state.collapsedPaths.has(fileKey(file)))
  const submitFeedback = () => {
    const owner = state.ownerSessionId ?? w().getCurrentSessionId?.()
    const text = commentFeedback(comments, t('changes_feedback_heading'))
    if (!w().klausComposer?.appendReviewFeedback?.(text, owner)) { w().showToast?.(t('changes_feedback_stale')); return }
    updateComments([])
  }
  return <div ref={shell} className={styles['review-shell']} aria-label={t('diff_view_title')} aria-busy={state.loading || mutating}>
    <div className={styles['review-toolbar']}>
      <div className={styles['review-comparison-controls']}>
        <ReviewMenu label={t('diff_scope')} className={styles['review-source-pill']}
          text={<><span>{t(`diff_scope_${state.source}`)}</span><Icon name="chevron-down" size={12} /><ChangeStats added={totals.added} removed={totals.removed} /></>}>
          {close => <>
            {sources.map((source, index) => <div key={source}>
              {index === 1 ? <div role="separator" className={styles['review-menu-separator']} /> : null}
              <MenuItem checked={state.source === source} onClick={() => { close(); setSource(source) }}>{t(`diff_scope_${source}`)}</MenuItem>
            </div>)}
            <div role="separator" className={styles['review-menu-separator']} />
            <details className={styles['review-commit-submenu']}><summary role="menuitem" tabIndex={0}>{t('diff_commit_selection')}</summary>
              {(state.summary?.commits ?? []).map(commit => <MenuItem key={commit.sha} checked={state.source === 'commit' && state.commitSha === commit.sha}
                onClick={() => { close(); setSource('commit'); setCommit(commit.sha) }}>{commit.sha.slice(0, 7)} {commit.subject}</MenuItem>)}
              {!state.summary?.commits?.length ? <MenuItem checked={state.source === 'commit'} onClick={() => { close(); setSource('commit') }}>{t('diff_scope_commit')}</MenuItem> : null}
            </details>
          </>}
        </ReviewMenu>
        {state.source === 'branch' ? <ReviewMenu label={t('diff_base_branch')} className={styles['review-base-pill']}
          text={<><span>{state.summary?.currentBranch ?? 'HEAD'}</span><span className={styles['review-compare-arrow']}>→</span>
            <span>{state.baseBranch ? branchLabel(state.baseBranch) : state.summary?.defaultBaseBranch ?? t('diff_automatic')}</span><Icon name="chevron-down" size={12} /></>}>
          {close => <>
            <MenuItem checked={!state.baseBranch} onClick={() => setBase('', close)}>{state.summary?.defaultBaseBranch ? `${state.summary.defaultBaseBranch} (${t('diff_automatic')})` : t('diff_automatic_base')}</MenuItem>
            {[...new Set([state.baseBranch, ...(state.summary?.baseBranches ?? [])])].filter((ref): ref is string => Boolean(ref)).map(ref =>
              <MenuItem key={ref} checked={state.baseBranch === ref} onClick={() => setBase(ref, close)}>{branchLabel(ref)}</MenuItem>)}
            <div role="separator" className={styles['review-menu-separator']} />
            <form className={styles['review-custom-base']} onSubmit={event => {
              event.preventDefault(); const input = event.currentTarget.querySelector<HTMLInputElement>('input')!; if (input.value.trim()) setBase(input.value.trim(), close)
            }}><label>{t('diff_custom_base')}<input aria-label={t('diff_custom_base')} placeholder={t('diff_custom_base_placeholder')} /></label>
              <button type="submit">{t('diff_apply_base')}</button></form>
          </>}
        </ReviewMenu> : null}
        {(state.summary?.repositories?.length ?? 0) > 1 ? <ReviewMenu label={t('diff_repository')} className={styles['review-repository-pill']}
          text={<><Icon name="folder" size={15} /><span>{state.source === 'last-turn' ? t('diff_all_repositories') : state.summary?.repositories?.find(repo => repo.root === state.repositoryRoot)?.name ?? t('diff_repository')}</span><Icon name="chevron-down" size={12} /></>}>
          {close => <>
            {state.source === 'last-turn' ? <MenuItem checked onClick={() => close()}>{t('diff_all_repositories')}</MenuItem> : null}
            {state.summary?.repositories?.map(repo => <MenuItem key={repo.root} checked={state.repositoryRoot === repo.root}
              onClick={() => { close(); setRepository(repo.root) }}>{repo.name}</MenuItem>)}
          </>}
        </ReviewMenu> : null}
        {state.source === 'commit' ? <ReviewMenu label={t('diff_commit_selection')} className={styles['review-base-pill']}
          text={<><span>{state.commitSha?.slice(0, 7) ?? t('diff_commit_selection')}</span><Icon name="chevron-down" size={12} /></>}>
          {close => <>{state.summary?.commits?.map(commit => <MenuItem key={commit.sha} checked={state.commitSha === commit.sha}
            onClick={() => { close(); setCommit(commit.sha) }}>{commit.sha.slice(0, 7)} {commit.subject}</MenuItem>)}</>}
        </ReviewMenu> : null}
      </div>
      <div className={styles['review-toolbar-actions']}>
        <button type="button" className={`${styles['review-button']} ${styles['review-wide-control']}`} aria-label={t('diff_refresh')}
          onClick={() => void reload(true)}><Icon name="refresh" size={16} /></button>
        <button type="button" className={`${styles['review-button']} ${styles['review-wide-control']}`} aria-label={t('changes_word_wrap')}
          aria-pressed={reviewPreferences.wordWrap} onClick={() => setReviewPreference('wordWrap', !reviewPreferences.wordWrap)}><ReviewIcon name="wrap" /></button>
        <button type="button" className={`${styles['review-button']} ${styles['review-wide-control']}`} aria-label={t(allCollapsed ? 'changes_expand_all' : 'changes_collapse_all')}
          onClick={() => collapseAll(!allCollapsed)}><ReviewIcon name={allCollapsed ? 'expand' : 'collapse'} /></button>
        <button type="button" className={`${styles['review-button']} ${styles['review-wide-control']}`} aria-label={`${t('changes_layout')} · ${t(`changes_layout_${reviewPreferences.layout}`)}`}
          onClick={() => setReviewPreference('layout', ({ auto: 'unified', unified: 'split', split: 'auto' } as const)[reviewPreferences.layout])}><ReviewIcon name={reviewPreferences.layout === 'split' ? 'split' : 'unified'} /></button>
        <ReviewMenu label={t('changes_options')} icon="panel-tab-more">{close => <>
          <MenuItem icon="refresh" onClick={() => { close(); void reload(true) }}>{t('diff_refresh')}</MenuItem>
          <MenuItem checked={reviewPreferences.wordWrap} onClick={() => { close(); setReviewPreference('wordWrap', !reviewPreferences.wordWrap) }}>{t('changes_word_wrap')}</MenuItem>
          <MenuItem onClick={() => { close(); setReviewPreference('layout', ({ auto: 'unified', unified: 'split', split: 'auto' } as const)[reviewPreferences.layout]) }}>
            {t('changes_layout')} · {t(`changes_layout_${reviewPreferences.layout}`)}</MenuItem>
          <MenuItem onClick={() => { close(); collapseAll(!allCollapsed) }}>{t(allCollapsed ? 'changes_expand_all' : 'changes_collapse_all')}</MenuItem>
          <div role="separator" className={styles['review-menu-separator']} />
          {(['fullFiles', 'richPreview', 'wordDiffs', 'hideWhitespace', 'hideImports'] as const).map((key, index) => <MenuItem key={key}
            checked={reviewPreferences[key]} onClick={() => { close(); setReviewPreference(key, !reviewPreferences[key]) }}>
            {t(['changes_full_files', 'changes_rich_preview', 'changes_word_diffs', 'changes_hide_whitespace', 'changes_hide_imports'][index])}</MenuItem>)}
          <div role="separator" className={styles['review-menu-separator']} />
          <MenuItem disabled={!all.length || state.loading} onClick={() => { close(); void copyPatch() }} icon="copy">{t('changes_copy_patch')}</MenuItem>
          {canCommit() ? <MenuItem disabled={state.committing || mutating} onClick={() => { close(); void startCommitFlow() }}>{t(state.committing ? 'diff_commit_working' : 'diff_commit')}</MenuItem> : null}
        </>}</ReviewMenu>
        <ReviewMenu label={t('changes_jump')} icon="tc-search">{close => <JumpMenu close={close} />}</ReviewMenu>
        <button type="button" className={styles['review-button']} aria-label={t('changes_file_tree')} aria-pressed={reviewPreferences.fileTree}
          onClick={() => setReviewPreference('fileTree', !reviewPreferences.fileTree)}><Icon name="folder-open" size={17} /></button>
      </div>
    </div>
    {state.summary?.detailsTruncated ? <div className={styles['review-notice']}>{t('diff_details_truncated')}</div> : null}
    {state.summary?.untrackedFilesOmitted ? <div className={styles['review-notice']}>{fmt('diff_untracked_omitted', state.summary.untrackedFilesOmitted)}</div> : null}
    {state.summary?.generatedAttributesUnavailable ? <div className={styles['review-notice']}>{fmt('changes_attributes_unavailable', { error: state.summary.generatedAttributesUnavailable })}</div> : null}
    {mutationError ? <div className={styles['review-notice']} role="alert">{mutationError}</div> : null}
    <div className={styles['review-layout']}>
      <main ref={scroll} className={styles['review-scroll']} data-review-scroll tabIndex={0} aria-label={t('diff_view_title')}>
        {emptyReason ? <div className={`${styles['diff-detail-empty']}${state.error ? ` ${styles['diff-detail-error']}` : ''}`} role={state.error ? 'alert' : undefined}>
          <span>{emptyReason}</span>{state.error ? <button type="button" className="btn-sm" onClick={() => void reload(true)}>{t('diff_retry')}</button> : null}</div>
          : list.length ? list.map(file => <ReviewFile key={fileKey(file)} file={file} paneWidth={Math.max(0, paneWidth - (reviewPreferences.fileTree ? treeWidth : 0))}
            theme={theme} comments={comments} onComments={updateComments} onAction={onAction} mutating={mutating}
            sectionRef={node => { if (node) sections.current.set(fileKey(file), node); else sections.current.delete(fileKey(file)) }} />)
            : <div className={styles['diff-detail-empty']}>{t(state.search ? 'diff_no_search_results' : 'diff_empty')}</div>}
      </main>
      {reviewPreferences.fileTree && !emptyReason ? <ReviewTree width={Math.min(treeWidth, Math.max(160, paneWidth * 0.6))} onWidth={resizeTree} comments={comments} /> : null}
    </div>
    {mutable || comments.length ? <footer className={styles['review-footer']}>
      <span>{comments.length ? fmt('changes_feedback_count', { count: comments.length }) : ''}</span>
      {comments.length ? <button type="button" onClick={submitFeedback}>{t('changes_feedback')}</button> : null}
      {mutable && state.source !== 'staged' ? <button type="button" disabled={mutating || state.loading} onClick={() => onAction('revert')}>{t('changes_revert_all')}</button> : null}
      {mutable ? <button type="button" className={styles['review-primary']} disabled={mutating || state.loading}
        onClick={() => onAction(state.source === 'staged' ? 'unstage' : 'stage')}>{t(mutating ? 'changes_working' : state.source === 'staged' ? 'changes_unstage_all' : 'changes_stage_all')}</button> : null}
    </footer> : null}
    {pendingRevert ? <RevertConfirmation onCancel={() => setPendingRevert(null)} onConfirm={remember => {
      const pending = pendingRevert; setPendingRevert(null)
      const currentSnapshot = pending.file ? allFiles().find(file => fileKey(file) === fileKey(pending.file!))?.snapshotId : state.summary?.snapshotId
      if (!pending.snapshotId || pending.snapshotId !== currentSnapshot) { setMutationError(t('diff_snapshot_changed')); return }
      if (remember) { try { localStorage.setItem('klaus.diff.skipRevertConfirm', 'true') } catch {} }
      void applyAction('revert', pending.file, pending.hunkIndex)
    }} /> : null}
  </div>
}

function JumpMenu({ close }: { close: () => void }) {
  const t = useT(), [query, setQuery] = useState('')
  const list = allFiles().filter(file => file.path.toLowerCase().includes(query.toLowerCase()))
  return <><FileFilter id="diff-jump-search" value={query} onChange={setQuery} />
    {list.map(file => <MenuItem key={fileKey(file)} checked={state.selectedPath === fileKey(file)} onClick={() => { close(); selectPath(fileKey(file)) }}>{file.path}</MenuItem>)}
    {!list.length ? <div className={styles['diff-empty']}>{t('diff_no_search_results')}</div> : null}</>
}

export function DiffPage() {
  useSyncExternalStore(subscribe, getVersion)
  const scope = JSON.stringify([state.sessionId, state.source, state.repositoryRoot, state.baseBranch, state.commitSha, state.requestedTurnId])
  return <ReviewBody key={scope} scope={scope} />
}
