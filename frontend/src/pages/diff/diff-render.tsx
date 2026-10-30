// Shared diff line/hunk rendering: the Changes surface and the per-turn change
// card's hover preview draw the same rows, so the highlighter and the row
// markup live here once instead of drifting in two copies.
import type { ReactNode } from 'react'
import { escHtml } from '../../components/mcpDetailShell'
import styles from './diff.module.css'

const w = () => window as any

const DIFF_LANGUAGE_BY_EXT: Record<string, string> = {
  bash: 'bash', c: 'c', cc: 'cpp', cpp: 'cpp', cjs: 'javascript',
  conf: 'ini', cs: 'csharp', css: 'css', diff: 'diff', dockerfile: 'dockerfile',
  go: 'go', graphql: 'graphql', h: 'c', hpp: 'cpp', html: 'xml', ino: 'arduino',
  java: 'java', js: 'javascript', json: 'json', jsonc: 'json', jsx: 'javascript',
  kt: 'kotlin', kts: 'kotlin', latex: 'latex', less: 'less', lua: 'lua',
  m: 'objectivec', makefile: 'makefile', markdown: 'markdown', md: 'markdown',
  mjs: 'javascript', mm: 'objectivec', nb: 'mathematica', nginx: 'nginx',
  perl: 'perl', pgsql: 'pgsql', php: 'php', pl: 'perl', psql: 'pgsql',
  py: 'python', r: 'r', rb: 'ruby', rs: 'rust', scss: 'scss', sh: 'bash',
  sql: 'sql', swift: 'swift', tex: 'latex', ts: 'typescript', tsx: 'typescript',
  vue: 'xml', wl: 'mathematica', wls: 'mathematica', xml: 'xml', yaml: 'yaml',
  yml: 'yaml', zsh: 'bash',
}

function fileExt(path: string): string {
  const m = /\.([A-Za-z0-9]+)$/.exec(path || '')
  return m ? m[1].toLowerCase() : ''
}

function fileBaseName(path: string): string {
  const text = String(path || '')
  const idx = Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\'))
  return (idx >= 0 ? text.slice(idx + 1) : text).toLowerCase()
}

function diffLanguageForPath(path: string): string {
  const base = fileBaseName(path)
  const ext = fileExt(path)
  const candidates: string[] = []
  if (base === 'dockerfile' || base.endsWith('.dockerfile')) candidates.push('dockerfile')
  if (base === 'makefile' || base.endsWith('.mk')) candidates.push('makefile')
  if (base === 'package-lock.json' || base === 'package.json' || base.endsWith('.json')) candidates.push('json')
  if (ext && DIFF_LANGUAGE_BY_EXT[ext]) candidates.push(DIFF_LANGUAGE_BY_EXT[ext])
  if (ext) candidates.push(ext)
  const hljs = w().hljs
  if (!hljs) return ''
  return candidates.find(lang => lang !== 'plaintext' && hljs.getLanguage?.(lang)) || ''
}

export function highlightDiffText(text: string, path: string | null): string {
  const value = String(text ?? '')
  const hljs = w().hljs
  const language = path ? diffLanguageForPath(path) : ''
  if (!language || !hljs) return escHtml(value)
  try { return hljs.highlight(value, { language, ignoreIllegals: true }).value } catch {}
  return escHtml(value)
}

function lineClass(line: string): 'add' | 'del' | 'ctx' {
  if (line.startsWith('+')) return 'add'
  if (line.startsWith('-')) return 'del'
  return 'ctx'
}

export function DiffLine({ line, oldLine, newLine, path }: {
  line: string
  oldLine: number | ''
  newLine: number | ''
  path: string | null
}) {
  const kind = lineClass(line)
  const marker = kind === 'add' ? '+' : kind === 'del' ? '-' : ' '
  const text = line.startsWith('+') || line.startsWith('-') || line.startsWith(' ')
    ? line.slice(1)
    : line
  return (
    <div className={`${styles['diff-line']} ${styles[`diff-line-${kind}`] || ''}`.trim()}>
      <span className={styles['diff-ln']}>{oldLine || ''}</span>
      <span className={styles['diff-ln']}>{newLine || ''}</span>
      <span className={styles['diff-marker']}>{marker}</span>
      {/* hljs 输出（或 escHtml 兜底）——同旧版信任边界 */}
      <span className={styles['diff-text']} dangerouslySetInnerHTML={{ __html: highlightDiffText(text, path) }} />
    </div>
  )
}

export interface RenderHunk {
  oldStart?: number
  oldLines?: number
  newStart?: number
  newLines?: number
  lines?: string[]
}

export function Hunk({ hunk, path }: { hunk: RenderHunk; path: string | null }) {
  let oldLine = Number(hunk.oldStart) || 0
  let newLine = Number(hunk.newStart) || 0
  const rows: ReactNode[] = []
  let i = 0
  for (const rawLine of Array.isArray(hunk.lines) ? hunk.lines : []) {
    const line = String(rawLine ?? '')
    if (line.startsWith('\\')) {
      rows.push(<div className={styles['diff-line-note']} key={i++}>{line}</div>)
    } else if (line.startsWith('+')) {
      rows.push(<DiffLine line={line} oldLine="" newLine={newLine++} path={path} key={i++} />)
    } else if (line.startsWith('-')) {
      rows.push(<DiffLine line={line} oldLine={oldLine++} newLine="" path={path} key={i++} />)
    } else {
      rows.push(<DiffLine line={line} oldLine={oldLine++} newLine={newLine++} path={path} key={i++} />)
    }
  }
  const header = `@@ -${hunk.oldStart || 0},${hunk.oldLines || 0} +${hunk.newStart || 0},${hunk.newLines || 0} @@`
  return (
    <section className={styles['diff-hunk']}>
      <div className={styles['diff-hunk-head']}>{header}</div>
      <div className={styles['diff-code']}>{rows}</div>
    </section>
  )
}
