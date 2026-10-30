import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Icon } from '../../components/Icon'
import { RawHtml } from '../../components/RawHtml'
import type { ActivityToolData, ActivityToolState } from './activity-tool-model'
import { editActivityPresentation, type EditActivityFile } from './activity-edit-model'
import styles from './activity-edit.module.css'
import { writeClipboardText } from '../../clipboard'

export interface EditActivityToolProps {
  tool: ActivityToolData
  open: boolean
  onToggle: () => void
  locale: string
  expandedFiles?: Record<string, boolean>
  onToggleFile?: (path: string, open: boolean) => void
}

function text(locale: string, english: string, chinese: string): string { return locale.startsWith('zh') ? chinese : english }
function basename(path: string): string { return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path }

function DiffText({ value, path }: { value: string; path: string }) {
  const highlighted = useMemo(() => {
    const highlighter = typeof window !== 'undefined' ? (window as any).hljs : null
    if (!highlighter) return null
    const extension = path.split('.').at(-1)?.toLowerCase() ?? ''
    const aliases: Record<string, string> = { ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript', py: 'python', rs: 'rust', sh: 'bash', zsh: 'bash', yml: 'yaml', md: 'markdown', h: 'c', hpp: 'cpp', cs: 'csharp', kt: 'kotlin', rb: 'ruby', html: 'xml', vue: 'xml', jsonc: 'json' }
    const language = aliases[extension] ?? extension
    if (!highlighter.getLanguage?.(language)) return null
    try { return highlighter.highlight(value, { language, ignoreIllegals: true }).value as string } catch { return null }
  }, [path, value])
  return highlighted === null ? <>{value || ' '}</> : <RawHtml tag="span" html={highlighted || ' '} />
}

export function editActivityStatus(file: EditActivityFile, state: ActivityToolState, open: boolean, locale: string): string {
  if (state === 'awaiting-approval') return ''
  if (state === 'error') return text(locale, 'Edit failed', '更改失败')
  if (state === 'interrupted') return file.kind === 'add' ? text(locale, 'Stopped creating', '已停止创建') : file.kind === 'delete' ? text(locale, 'Stopped deleting', '已停止删除') : text(locale, 'Stopped editing', '已停止编辑')
  if (state === 'running') return file.kind === 'add' ? text(locale, 'Creating', '正在创建') : file.kind === 'delete' ? text(locale, 'Deleting', '正在删除') : text(locale, 'Editing', '正在编辑')
  if (file.kind === 'add') return open ? text(locale, 'Created file', '文件已创建') : text(locale, 'Created', '已创建')
  if (file.kind === 'delete') return open ? text(locale, 'Deleted file', '文件已删除') : text(locale, 'Deleted', '已删除')
  return open ? text(locale, 'Edited file', '已编辑的文件') : text(locale, 'Edited', '已编辑')
}

function openFile(path: string, cwd: string) {
  const resolved = /^(?:[/\\]|[A-Za-z]:[/\\])/.test(path) || !cwd ? path : `${cwd.replace(/[/\\]$/, '')}/${path}`
  ;(window as any).klausOpenWorkspaceFilePath?.(resolved)
}

function Counts({ file, locale }: { file: EditActivityFile; locale: string }) {
  if (file.added === undefined && file.removed === undefined) return null
  return <span className={styles.counts} aria-label={text(locale, `${file.added ?? 0} lines added, ${file.removed ?? 0} lines removed`, `新增 ${file.added ?? 0} 行，删除 ${file.removed ?? 0} 行`)}>
    {file.added !== undefined ? <span className={styles.addedCount}>+{file.added}</span> : null}
    {file.removed !== undefined ? <span className={styles.removedCount}>−{file.removed}</span> : null}
  </span>
}

function CopyButton({ value, locale, kind = 'diff' }: { value: string; locale: string; kind?: 'diff' | 'result' | 'input' }) {
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState(false)
  const timeout = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timeout.current), [])
  const label = copied ? text(locale, 'Copied', '已复制') : error ? text(locale, 'Copy failed', '复制失败') : kind === 'diff' ? text(locale, 'Copy diff', '复制差异') : kind === 'result' ? text(locale, 'Copy result', '复制结果') : text(locale, 'Copy input', '复制输入')
  const copy = async () => {
    try { await writeClipboardText(value); setCopied(true); setError(false) } catch { setError(true) }
    clearTimeout(timeout.current)
    timeout.current = setTimeout(() => { setCopied(false); setError(false) }, 1500)
  }
  return <><button type="button" className={styles.copy} aria-label={label} onClick={() => void copy()}><Icon name={copied ? 'check' : 'copy'} size={14} /></button><span className={styles.srOnly} role="status">{copied || error ? label : ''}</span></>
}

function Body({ open, id, children }: { open: boolean; id: string; children: ReactNode }) {
  const [mounted, setMounted] = useState(open)
  const [visible, setVisible] = useState(open)
  useLayoutEffect(() => {
    if (open) {
      setMounted(true)
      const frame = requestAnimationFrame(() => setVisible(true))
      return () => cancelAnimationFrame(frame)
    }
    setVisible(false)
    const timer = setTimeout(() => setMounted(false), 300)
    return () => clearTimeout(timer)
  }, [open])
  return <div className={styles.body} id={id} data-open={visible || undefined} aria-hidden={!open} inert={!open}><div className={styles.bodyInner}>{mounted ? children : null}</div></div>
}

function DiffCard({ file, state, cwd, locale }: { file: EditActivityFile; state: ActivityToolState; cwd: string; locale: string }) {
  const path = file.movePath ?? file.path
  const deleted = file.kind === 'delete'
  const fallback = deleted && state === 'done' ? text(locale, 'Contents deleted', '内容已删除') : text(locale, 'Diff content unavailable', '差异内容不可用')
  return <div className={styles.diffCard}>
    <div className={styles.diffHeader}>
      <button type="button" className={styles.fileLink} onClick={event => { event.stopPropagation(); openFile(path, cwd) }}>{path}</button>
      <Counts file={file} locale={locale} />
      {file.diff ? <CopyButton value={file.diff} locale={locale} /> : null}
    </div>
    {file.requested ? <div className={styles.previewLabel}>{file.exact === false ? text(locale, 'Requested changes; the applied result was adjusted', '请求的更改；实际应用内容经过调整') : text(locale, 'Requested changes', '请求的更改')}</div> : null}
    {file.lines.length ? <div className={styles.diffScroll} data-pending={state === 'awaiting-approval' || undefined} tabIndex={0} role="region" aria-label={text(locale, `Diff for ${path}`, `${path} 的差异`)}>
      <div className={styles.diffLines}>
        {file.lines.map((line, index) => line.kind === 'hunk' || line.kind === 'notice'
          ? <div key={index} className={line.kind === 'hunk' ? styles.hunk : styles.notice}>{line.text}</div>
          : <div key={index} className={styles.diffLine} data-kind={line.kind}>
            <span className={styles.lineNumber} aria-hidden="true">{line.oldLine ?? ''}</span>
            <span className={styles.lineNumber} aria-hidden="true">{line.newLine ?? ''}</span>
            <span className={styles.marker} aria-hidden="true">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</span>
            <span className={styles.srOnly}>{line.kind === 'added' ? text(locale, 'Added: ', '新增：') : line.kind === 'removed' ? text(locale, 'Removed: ', '删除：') : ''}</span>
            <span className={styles.code}><DiffText value={line.text} path={path} /></span>
          </div>)}
      </div>
    </div> : <div className={styles.empty}>{fallback}</div>}
  </div>
}

function FileEntry({ file, state, cwd, locale, open, onToggle, emphasis = true }: { file: EditActivityFile; state: ActivityToolState; cwd: string; locale: string; open: boolean; onToggle: () => void; emphasis?: boolean }) {
  const bodyId = useId()
  const completedExpanded = state === 'done' && open
  const status = editActivityStatus(file, state, open, locale)
  const path = file.movePath ?? file.path
  return <div className={styles.fileEntry} data-file-path={file.path} data-edit-state={state}>
    <div className={styles.header}>
      <button className={styles.toggle} type="button" aria-label={text(locale, `Toggle diff for ${basename(path)}`, `切换 ${basename(path)} 的差异视图`)} aria-expanded={open} aria-controls={bodyId}
        onClick={event => { event.stopPropagation(); onToggle() }} />
      <span className={styles.icon} aria-hidden="true"><Icon name="tool-edit" size={16} /></span>
      <span className={styles.summary}>
        {status ? <span data-running={emphasis && state === 'running' || undefined}>{status}</span> : null}
        {!completedExpanded ? <>
          {status ? ' ' : null}<button className={styles.fileLink} type="button" data-agent-activity-file-link onClick={event => { event.stopPropagation(); openFile(path, cwd) }}>{basename(file.path)}</button>
          {file.movePath ? <span className={styles.rename}> → <button className={styles.fileLink} type="button" data-agent-activity-file-link onClick={event => { event.stopPropagation(); openFile(path, cwd) }}>{basename(file.movePath)}</button></span> : null}
        </> : null}
      </span>
      {!completedExpanded ? <Counts file={file} locale={locale} /> : null}
      {!completedExpanded && file.kind !== 'update' ? <span className={styles.kindDot} data-kind={file.kind} aria-label={file.kind === 'add' ? text(locale, 'New file', '新文件') : text(locale, 'Deleted file', '删除的文件')} /> : null}
      {state === 'awaiting-approval' ? <span className={styles.srOnly}>{text(locale, 'Awaiting approval', '等待批准')}</span> : null}
      <span className={styles.chevron} data-open={open || undefined} aria-hidden="true"><Icon name="chevron-right" size={14} /></span>
    </div>
    <Body open={open} id={bodyId}><DiffCard file={file} state={state} cwd={cwd} locale={locale} /></Body>
  </div>
}

function RawDetail({ value, kind, locale }: { value: string; kind: 'input' | 'result'; locale: string }) {
  return <div className={styles.result}>
    <div className={styles.resultHeader}>{kind === 'input' ? text(locale, 'Input', '输入') : text(locale, 'Tool result', '工具结果')}<CopyButton value={value} kind={kind} locale={locale} /></div>
    <pre tabIndex={0}>{value}</pre>
  </div>
}

export function EditActivityTool({ tool, open, onToggle, locale, expandedFiles: savedFiles, onToggleFile }: EditActivityToolProps) {
  const model = useMemo(() => editActivityPresentation(tool), [tool.toolName, tool.args, tool.output])
  const [localFiles, setExpandedFiles] = useState<Record<string, boolean>>({})
  const expandedFiles = savedFiles || localFiles
  const fallbackId = useId()
  const anyOpen = model.files.some(file => expandedFiles[file.key] ?? open)
  const single = model.files.length === 1
  const fallbackLabel = tool.state === 'error' ? text(locale, 'Edit failed', '更改失败') : tool.state === 'interrupted' ? text(locale, 'Stopped editing', '已停止编辑') : tool.state === 'awaiting-approval' ? text(locale, 'Awaiting approval', '等待批准') : tool.state === 'running' ? text(locale, 'Editing files', '正在编辑文件') : text(locale, 'Edited files', '已编辑文件')
  return <div className={styles.editActivity} data-edit-tool-id={tool.toolCallId}>
    {model.files.length ? model.files.map((file, index) => <FileEntry key={file.key} file={file} state={tool.state} cwd={model.cwd} locale={locale}
      // One sweep per turn: every file row shares this tool's
      // state, so an N-file edit used to light N gradient sweeps at once — and
      // each one re-rasterizes its text-clipped gradient every frame. Only the
      // first row carries the sweep; the others keep the same "正在编辑" wording,
      // so no state information is lost, just the duplicated animation.
      emphasis={index === 0}
      open={single ? open : expandedFiles[file.key] ?? open}
      onToggle={single ? onToggle : () => onToggleFile ? onToggleFile(file.key, expandedFiles[file.key] ?? open) : setExpandedFiles(previous => ({ ...previous, [file.key]: !(previous[file.key] ?? open) }))} />)
      : <><button type="button" className={styles.fallbackToggle} aria-expanded={open} aria-controls={fallbackId} onClick={onToggle}><Icon name="tool-edit" size={16} />{fallbackLabel}<span className={styles.chevron} data-open={open || undefined}><Icon name="chevron-right" size={14} /></span></button><Body open={open} id={fallbackId}><RawDetail value={model.input} kind="input" locale={locale} /></Body></>}
    {/* Failures used to render their result unconditionally, ahead of any
        disclosure: a rejected write has no diff, and the reasoning was that
        hiding the one useful line behind a click made the failure look like a
        quiet success. In practice the open box reads as noise next to every
        other collapsed row, and the row already says 更改失败 — so failures
        now fold exactly like successes: the result sits behind the same
        two-step disclosure, one click away. */}
    {model.result ? <Body open={model.files.length ? anyOpen : open} id={`${fallbackId}-result`}><details className={styles.resultDisclosure}><summary>{text(locale, 'Tool result', '工具结果')}</summary><RawDetail value={model.result} kind="result" locale={locale} /></details></Body> : null}
  </div>
}
