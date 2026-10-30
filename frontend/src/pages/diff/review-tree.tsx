import { useMemo, useRef, useState } from 'react'
import { Icon } from '../../components/Icon'
import { RawHtml } from '../../components/RawHtml'
import { fileIconSvg } from '../../chat/file-icon'
import { useT } from '../../i18n'
import { fileKey, files, isViewed, reviewPreferences, selectPath, setReviewPreference, setSearch, state } from './store'
import { fileTree, type FileTreeNode } from './review-model'
import { ChangeStats, FileFilter } from './review-controls'
import type { ReviewComment } from './review-feedback'
import styles from './diff.module.css'

export function ReviewTree({ width, onWidth, comments }: { width: number; onWidth: (value: number) => void; comments: ReviewComment[] }) {
  const t = useT(), root = useRef<HTMLElement>(null)
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const list = files()
  const tree = useMemo(() => fileTree(list, fileKey, state.summary?.repositories), [state.summary, state.search, reviewPreferences.showGenerated])
  const toggle = (key: string, value?: boolean) => setCollapsed(old => {
    const next = new Set(old)
    if (value ?? !next.has(key)) next.add(key)
    else next.delete(key)
    return next
  })
  const row = (node: FileTreeNode, level = 1, parent?: string): React.ReactNode => {
    const directory = Boolean(node.children), expanded = state.search ? true : !collapsed.has(node.key)
    const commentCount = node.file ? comments.filter(comment => comment.fileKey === node.key).length : 0
    return <div key={node.key} role="none">
      <button type="button" role="treeitem" data-tree-key={node.key} data-parent-key={parent} aria-level={level}
        aria-expanded={directory ? expanded : undefined} aria-selected={directory ? undefined : state.selectedPath === node.key}
        aria-label={node.file ? node.file.path : node.label} data-directory={directory}
        className={styles['review-tree-row']} style={{ paddingLeft: 8 + (level - 1) * 12 }}
        onClick={() => directory ? toggle(node.key) : selectPath(node.key)}>
        {directory ? <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={12} />
          : <RawHtml tag="span" className={styles['review-tree-file-icon']} html={fileIconSvg(node.label)} />}
        <span className={styles['review-tree-name']}>{node.label}</span>
        {node.file ? <>
          {node.file.isUntracked ? <span className={styles['diff-file-badge']}>{t('diff_untracked')}</span> : null}
          {node.file.isBinary ? <span className={styles['diff-file-badge']}>{t('diff_binary')}</span> : null}
          {commentCount ? <span className={styles['review-tree-comments']}>{commentCount}</span> : null}
          {isViewed(node.file) ? <Icon name="check" size={12} /> : <ChangeStats added={node.file.additions} removed={node.file.deletions} compact />}
        </> : null}
      </button>
      {directory && expanded ? <div role="group">{node.children!.map(child => row(child, level + 1, node.key))}</div> : null}
    </div>
  }
  return <aside ref={root} className={styles['review-tree']} style={{ width }} aria-label={t('changes_file_tree')}>
    <div role="separator" tabIndex={0} aria-label={t('changes_file_tree')} aria-orientation="vertical" aria-valuenow={width}
      aria-valuemin={200} className={styles['review-tree-resize']}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return
        event.preventDefault(); onWidth(width + (event.key === 'ArrowLeft' ? 16 : -16))
      }}
      onPointerDown={event => {
        if (event.button !== 0) return
        event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId)
        const start = event.clientX, initial = width, handle = event.currentTarget
        const move = (next: PointerEvent) => onWidth(initial + start - next.clientX)
        const done = () => { handle.removeEventListener('pointermove', move); handle.removeEventListener('pointerup', done); handle.removeEventListener('pointercancel', done) }
        handle.addEventListener('pointermove', move); handle.addEventListener('pointerup', done); handle.addEventListener('pointercancel', done)
      }} />
    <FileFilter value={state.search} onChange={setSearch} />
    {state.summary?.files?.some(file => file.isGenerated) ? <label className={styles['review-generated-filter']}>
      <input type="checkbox" checked={reviewPreferences.showGenerated} onChange={event => setReviewPreference('showGenerated', event.target.checked)} />
      {t('changes_generated_files')}
    </label> : null}
    <div id="diff-panel-file-list" role="tree" aria-label={t('diff_files_changed')} className={styles['review-tree-body']}
      onKeyDown={event => {
        const target = (event.target as HTMLElement).closest<HTMLButtonElement>('[role="treeitem"]')
        if (!target) return
        const rows = Array.from(root.current!.querySelectorAll<HTMLButtonElement>('[role="treeitem"]'))
        const index = rows.indexOf(target), key = target.dataset.treeKey!
        let focus: HTMLButtonElement | undefined
        if (event.key === 'ArrowDown') focus = rows[Math.min(rows.length - 1, index + 1)]
        else if (event.key === 'ArrowUp') focus = rows[Math.max(0, index - 1)]
        else if (event.key === 'Home') focus = rows[0]
        else if (event.key === 'End') focus = rows.at(-1)
        else if (event.key === 'ArrowRight' && target.dataset.directory === 'true') {
          if (collapsed.has(key)) toggle(key, false)
          else focus = rows[index + 1]
        } else if (event.key === 'ArrowLeft') {
          if (target.dataset.directory === 'true' && !collapsed.has(key)) toggle(key, true)
          else focus = rows.find(element => element.dataset.treeKey === target.dataset.parentKey)
        } else return
        event.preventDefault(); focus?.focus()
      }}>
      {tree.length ? tree.map(node => row(node)) : <div className={styles['diff-empty']}>{t(state.search ? 'diff_no_search_results' : 'diff_empty')}</div>}
    </div>
  </aside>
}
