import { useEffect, useRef, useState } from 'react'
import { classifyLink, render } from '../../app/artifact-markdown'
import { attachHtmlDocumentToc } from '../../chat/markdown-toc'
import { writeClipboardText } from '../../clipboard'
import { rawIconHtml } from '../../components/Icon'
import { useT } from '../../i18n'
import { consumePendingMemoryAnchor, MEMORY_DREAM_EVENT, normalizeMemorySelectionKey, resolveRelativeMemoryPath, selectMemoryFile } from './data'
import styles from './memory.module.css'

interface MemoryDocument {
  content: string
  filePath?: string
  truncated?: boolean
}

const documents = new Map<string, MemoryDocument>()
const w = () => window as any
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const glyph = (name: string) => <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: rawIconHtml(name) }} />
let cacheGeneration = 0
if (typeof window !== 'undefined') window.addEventListener(MEMORY_DREAM_EVENT, event => {
  const dream = (event as CustomEvent).detail
  if (dream && dream.status !== 'running') {
    cacheGeneration++
    documents.clear()
  }
})

export function MemoryDocumentView({ filePath }: { filePath: string }) {
  const cacheKey = normalizeMemorySelectionKey(filePath)
  const t = useT()
  const [mode, setMode] = useState<'preview' | 'source'>('preview')
  const [result, setResult] = useState<{ path: string; doc?: MemoryDocument; error?: string }>()
  const [loadingPath, setLoadingPath] = useState('')
  const generation = useRef(0)
  const host = useRef<HTMLDivElement>(null)
  const scroll = useRef<HTMLDivElement>(null)
  const article = useRef<HTMLElement>(null)
  const doc = result?.path === filePath ? result.doc : undefined
  const error = result?.path === filePath ? result.error : undefined
  const resolvedPath = doc?.filePath

  useEffect(() => {
    const request = ++generation.current
    const epoch = cacheGeneration
    const cached = documents.get(cacheKey)
    setLoadingPath('')
    if (cached) {
      setResult({ path: filePath, doc: cached })
      return
    }
    const timer = setTimeout(() => setLoadingPath(filePath), 80)
    void (async () => {
      try {
        const response = await w().klaus.memory.readFile(filePath, { includePath: true })
        if (generation.current !== request) return
        if (response?.ok && typeof response.content === 'string') {
          if (epoch === cacheGeneration) documents.set(cacheKey, response)
          setResult({ path: filePath, doc: response })
        } else {
          setResult({ path: filePath, error: /ENOENT|missing|not found/i.test(response?.error ?? '') ? 'artifacts_file_missing' : 'artifacts_load_failed' })
        }
      } catch {
        if (generation.current === request) setResult({ path: filePath, error: 'artifacts_load_failed' })
      } finally {
        clearTimeout(timer)
      }
    })()
    return () => { generation.current++; clearTimeout(timer) }
  }, [cacheKey, filePath])

  const source = doc?.content ?? ''
  const stripped = source.replace(/^\uFEFF?---[^\S\r\n]*\r?\n[\s\S]*?^---[^\S\r\n]*(?:\r?\n|$)/m, (match, offset) => offset === 0 ? '' : match)
  let html = ''
  if (doc) {
    const text = mode === 'preview' ? stripped : source
    html = `<pre><code>${escape(text)}</code></pre>`
    try {
      if (mode === 'preview' && w().marked) html = render(w().marked, text)
      if (mode === 'source' && w().hljs) html = `<pre><code class="hljs">${w().hljs.highlight(text, { language: 'markdown' }).value}</code></pre>`
    } catch {}
  }

  useEffect(() => {
    if (!doc || !host.current || !scroll.current || !article.current || mode !== 'preview') return
    const content = article.current
    const toc = attachHtmlDocumentToc({ host: host.current, scrollContainer: scroll.current, contentContainer: content, translate: t })
    toc.refresh()
    const anchor = consumePendingMemoryAnchor()
    if (anchor) toc.scrollToAnchor(`#${encodeURIComponent(anchor)}`)
    const onLink = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.('a')
      if (!link) return
      event.preventDefault()
      const href = link.getAttribute('href')?.trim() ?? ''
      switch (classifyLink(href)) {
        case 'anchor': toc.scrollToAnchor(href); break
        case 'external': void w().klaus.app.openExternal(href); break
        case 'relative': {
          const target = resolveRelativeMemoryPath(filePath, href)
          if (!target) break
          if (target.path === cacheKey && target.anchor) toc.scrollToAnchor(`#${encodeURIComponent(target.anchor)}`)
          else selectMemoryFile(target.path, target.anchor)
          break
        }
      }
    }
    content.addEventListener('click', onLink)
    return () => { content.removeEventListener('click', onLink); toc.destroy() }
  }, [cacheKey, doc, filePath, html, mode, t])

  const copy = async () => {
    try { await writeClipboardText(resolvedPath || filePath); w().showToast?.(t('copied')) }
    catch { w().showToast?.(t('settings_failed')) }
  }
  const reveal = async () => {
    try {
      if (resolvedPath) {
        try {
          const result = await w().klaus.artifacts.reveal(resolvedPath)
          if (result?.ok !== false) return
        } catch {}
      }
      await w().klaus.memory.reveal()
    } catch { w().showToast?.(t('settings_failed')) }
  }
  return <>
    <div className={styles['memory-doc-toolbar']}>
      <div className={styles['memory-doc-viewtoggle']} role="group">
        <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>{glyph('aw-view-preview')}{t('artifacts_view_preview')}</button>
        <button type="button" aria-pressed={mode === 'source'} onClick={() => setMode('source')}>{glyph('aw-view-source')}{t('artifacts_view_source')}</button>
      </div>
      <div className={styles['memory-doc-fileinfo']}>{glyph('aw-fileicon')}<span className={styles['memory-doc-filename']}>{filePath.split(/[\\/]/).at(-1)}</span><span className={styles['memory-doc-filetype']}>Markdown</span></div>
      <div className={styles['memory-doc-actions']}>
        <button type="button" title={t('artifacts_copy_path')} aria-label={t('artifacts_copy_path')} onClick={() => void copy()}>{glyph('aw-copy')}</button>
        <button type="button" title={t('project_menu_reveal')} aria-label={t('project_menu_reveal')} onClick={() => void reveal()}>{glyph('aw-reveal')}</button>
      </div>
    </div>
    <div ref={host} className={styles['memory-doc-main']}>
      <div ref={scroll} className={styles['memory-doc-scroll']}>
        {error && <p role="alert">{t(error)}</p>}
        {!doc && !error && loadingPath === filePath && <p role="status">{t('artifacts_loading')}</p>}
        {doc?.truncated && <p className={styles['memory-doc-truncated']}>{t('artifacts_truncated')}</p>}
        <article ref={article} className={`${styles['memory-doc-article']} md`} dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </div>
  </>
}
