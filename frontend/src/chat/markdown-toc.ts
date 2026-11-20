import { EditorSelection } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { icon } from '../icons/registry'
import styles from './markdown-toc.module.css'

export interface MarkdownHeadingItem {
  id: string
  text: string
  depth: number
  level: number
  from: number
  textFrom: number
  line: number
}

interface AstNode {
  type: string
  position?: { start: { offset?: number; line?: number }; end: { offset?: number; line?: number } }
  children?: AstNode[]
  value?: string
  depth?: number
  alt?: string | null
}

const AST_OPTIONS = { extensions: [gfm({ singleTilde: false })], mdastExtensions: [gfmFromMarkdown()] }
const NARROW_HOST_WIDTH = 420
const MAX_RAIL_TICKS = 18
const PROGRAMMATIC_LOCK_MS = 360
const FRONTMATTER_BLOCK = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/
const INLINE_MATH_RE = /(?<!\\)\$\$([\s\S]+?)\$\$|(?<![\\$])\$(?![\s$])([^$\n]+?)(?<!\s)\$(?![\d$])/g
const ESCAPED_PUNCT_RE = /\\([!"#$%&'()*+,-./:;<=>?@[\\\]^_`{|}~])/g

const RAIL_TICK_LEVEL_CLASSES = [
  styles.railTickLevel0,
  styles.railTickLevel1,
  styles.railTickLevel2,
  styles.railTickLevel3,
  styles.railTickLevel4,
] as const

const FALLBACK_LABELS: Record<'en' | 'zh', Record<string, string>> = {
  en: {
    markdown_toc_title: 'Contents',
    markdown_toc_nav: 'Table of contents',
    markdown_toc_collapse: 'Collapse table of contents',
    markdown_toc_expand: 'Show table of contents',
  },
  zh: {
    markdown_toc_title: '目录',
    markdown_toc_nav: '文档目录',
    markdown_toc_collapse: '收起目录',
    markdown_toc_expand: '展开目录',
  },
}

function unescapeInlineText(raw: string): string {
  return raw
    .replace(INLINE_MATH_RE, (_match, block: string | undefined, inline: string | undefined) => block ?? inline ?? '')
    .replace(ESCAPED_PUNCT_RE, '$1')
}

function headingNodeText(node: AstNode): string {
  if (node.type === 'text') return unescapeInlineText(node.value ?? '')
  if (node.type === 'inlineCode') return node.value ?? ''
  if (node.type === 'image' || node.type === 'imageReference') return node.alt ?? ''
  if (node.type === 'break') return ' '
  if (node.type === 'html') return ''
  return (node.children ?? []).map(headingNodeText).join('')
}

/** Generate stable GitHub-style anchors supporting Unicode/CJK headings and deduplication. */
export function slugifyMarkdownHeading(text: string, seen?: Map<string, number>): string {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s_-]+/gu, '')
    .trim()
    .replace(/\s+/g, '-')
  const base = normalized || 'section'
  if (!seen) return base
  const count = seen.get(base) ?? 0
  seen.set(base, count + 1)
  return count === 0 ? base : `${base}-${count}`
}

/** Extract heading outline entries from Markdown source, skipping frontmatter and code blocks. */
export function extractMarkdownHeadings(source: string, preParsedTree?: unknown): MarkdownHeadingItem[] {
  if (!source) return []
  const frontmatter = FRONTMATTER_BLOCK.exec(source)
  const frontmatterEnd = frontmatter ? frontmatter[0].length : 0
  const root = (preParsedTree ?? fromMarkdown(source, AST_OPTIONS)) as AstNode
  const rawHeadings: Array<Omit<MarkdownHeadingItem, 'level'>> = []
  const seen = new Map<string, number>()

  const visit = (node: AstNode) => {
    if (node.type === 'code') return
    const offset = node.position?.start.offset ?? 0
    if (node.type === 'heading' && offset >= frontmatterEnd) {
      const text = headingNodeText(node).replace(/\s+/g, ' ').trim()
      if (!text) return
      const depth = Math.min(6, Math.max(1, node.depth ?? 1))
      const endOffset = node.position?.end.offset ?? offset
      const raw = source.slice(offset, endOffset)
      const leading = /^ {0,3}#{1,6}[ \t]+/.exec(raw)
      const textFrom = leading ? offset + leading[0].length : offset
      const line = node.position?.start.line ?? (source.slice(0, offset).split('\n').length)
      rawHeadings.push({
        id: slugifyMarkdownHeading(text, seen),
        text,
        depth,
        from: offset,
        textFrom,
        line,
      })
      return
    }
    for (const child of node.children ?? []) visit(child)
  }

  visit(root)
  if (!rawHeadings.length) return []
  const minDepth = rawHeadings.reduce((min, item) => Math.min(min, item.depth), 6)
  return rawHeadings.map(item => ({
    ...item,
    level: Math.min(4, Math.max(0, item.depth - minDepth)),
  }))
}

/** Match an internal `#anchor` link against extracted document headings. */
export function resolveMarkdownHeadingAnchor(headings: readonly MarkdownHeadingItem[], href: string): MarkdownHeadingItem | null {
  if (!href.startsWith('#')) return null
  const raw = href.slice(1)
  let decoded = raw
  try { decoded = decodeURIComponent(raw) } catch { decoded = raw }
  const needle = decoded.trim()
  if (!needle) return null
  const lower = needle.toLowerCase()
  const slug = slugifyMarkdownHeading(needle)
  const spaced = needle.replace(/-/g, ' ').trim().toLowerCase()
  return (
    headings.find(item => item.id === lower) ??
    headings.find(item => item.id === slug) ??
    headings.find(item => item.text.toLowerCase() === spaced) ??
    null
  )
}

export interface MarkdownTocOptions {
  host: HTMLElement
  onSelect(item: MarkdownHeadingItem, index: number): void
  translate?(key: string): string
}

export interface MarkdownTocController {
  element: HTMLElement
  updateHeadings(headings: MarkdownHeadingItem[]): void
  setActiveIndex(index: number): void
  setEnabled(enabled: boolean): void
  beginNavigationLock(index: number): void
  clearNavigationLock(): void
  isNavigationLocked(): number
  refreshLabels(): void
  destroy(): void
}

export function createMarkdownToc(options: MarkdownTocOptions): MarkdownTocController {
  const owner = options.host.ownerDocument || document
  const viewWin = owner.defaultView
  let enabled = true
  let headings: MarkdownHeadingItem[] = []
  let activeIndex = -1
  let userCollapsed = false
  let drawerOpen = false
  let isNarrow = false
  let structureSignature = ''
  let lockedIndex = -1
  let lockedUntil = 0
  let lastObservedWidth = -1
  let layoutRaf: number | ReturnType<typeof setTimeout> = 0
  let destroyed = false
  const itemButtons: HTMLButtonElement[] = []
  const railTickEls: HTMLElement[] = []

  const tr = (key: string): string => {
    const custom = options.translate?.(key)
    if (custom && custom !== key) return custom
    const globalTt = (viewWin as unknown as { tt?: (k: string) => string } | null)?.tt?.(key)
    if (globalTt && globalTt !== key) return globalTt
    const lang = (viewWin as unknown as { currentLang?: string } | null)?.currentLang === 'zh' ? 'zh' : 'en'
    return FALLBACK_LABELS[lang][key] ?? key
  }

  const aside = owner.createElement('aside')
  aside.className = styles.toc
  aside.dataset.markdownToc = '1'
  aside.hidden = true

  const railBtn = owner.createElement('button')
  railBtn.type = 'button'
  railBtn.className = styles.railBtn
  railBtn.dataset.tocAction = 'expand'
  const railIcon = owner.createElement('span')
  railIcon.className = styles.railIcon
  railIcon.setAttribute('aria-hidden', 'true')
  railIcon.innerHTML = icon('markdown-toc-expand')
  const railTicks = owner.createElement('span')
  railTicks.className = styles.railTicks
  railTicks.setAttribute('aria-hidden', 'true')
  railBtn.append(railIcon, railTicks)

  const panel = owner.createElement('div')
  panel.className = styles.tocPanel

  const header = owner.createElement('div')
  header.className = styles.header
  const headingLabel = owner.createElement('span')
  headingLabel.className = styles.headingLabel
  headingLabel.dataset.tocLabel = '1'
  const collapseBtn = owner.createElement('button')
  collapseBtn.type = 'button'
  collapseBtn.className = styles.toggleBtn
  collapseBtn.dataset.tocAction = 'collapse'
  collapseBtn.innerHTML = icon('markdown-toc-collapse')
  header.append(headingLabel, collapseBtn)

  const nav = owner.createElement('nav')
  nav.className = styles.nav
  const list = owner.createElement('ul')
  list.className = styles.list
  nav.append(list)

  panel.append(header, nav)
  aside.append(railBtn, panel)
  options.host.append(aside)

  const refreshLabels = () => {
    if (destroyed) return
    const navLabel = tr('markdown_toc_nav')
    const expandLabel = tr('markdown_toc_expand')
    const collapseLabel = tr('markdown_toc_collapse')
    aside.setAttribute('aria-label', navLabel)
    nav.setAttribute('aria-label', navLabel)
    headingLabel.textContent = tr('markdown_toc_title')
    railBtn.setAttribute('aria-label', expandLabel)
    collapseBtn.setAttribute('aria-label', collapseLabel)
  }

  const syncLayout = () => {
    if (destroyed) return
    const width = options.host.clientWidth
    const nextNarrow = width > 0 && width < NARROW_HOST_WIDTH
    if (nextNarrow !== isNarrow) {
      isNarrow = nextNarrow
      if (isNarrow) drawerOpen = false
    }
    const visible = enabled && headings.length > 0
    aside.hidden = !visible
    if (!visible) return
    const expanded = isNarrow ? drawerOpen : !userCollapsed
    aside.classList.toggle(styles.tocDocked, !isNarrow && expanded)
    aside.classList.toggle(styles.tocCompact, !expanded)
    aside.classList.toggle(styles.tocDrawer, isNarrow && expanded)
    aside.dataset.tocMode = isNarrow ? (expanded ? 'drawer' : 'compact') : (expanded ? 'docked' : 'compact')
    railBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false')
    collapseBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false')
  }

  const ensureActiveVisibleInNav = (button: HTMLButtonElement) => {
    const navHeight = nav.clientHeight
    if (navHeight <= 0) return
    const top = button.offsetTop
    const bottom = top + button.offsetHeight
    if (top < nav.scrollTop) nav.scrollTop = top
    else if (bottom > nav.scrollTop + navHeight) nav.scrollTop = bottom - navHeight
  }

  const setActiveIndex = (nextIndex: number) => {
    if (destroyed) return
    const clamped = nextIndex >= 0 && nextIndex < itemButtons.length ? nextIndex : -1
    activeIndex = clamped
    itemButtons.forEach((button, index) => {
      const active = index === clamped
      button.classList.toggle(styles.itemBtnActive, active)
      if (active) button.setAttribute('aria-current', 'location')
      else button.removeAttribute('aria-current')
    })
    railTickEls.forEach((tick, index) => {
      tick.classList.toggle(styles.railTickActive, index === clamped)
    })
    if (clamped >= 0) ensureActiveVisibleInNav(itemButtons[clamped])
  }

  const beginNavigationLock = (index: number) => {
    lockedIndex = index
    lockedUntil = Date.now() + PROGRAMMATIC_LOCK_MS
    setActiveIndex(index)
  }

  const clearNavigationLock = () => {
    lockedIndex = -1
    lockedUntil = 0
  }

  const isNavigationLocked = () => (Date.now() < lockedUntil ? lockedIndex : -1)

  const rebuildList = () => {
    itemButtons.length = 0
    railTickEls.length = 0
    const listFragment = owner.createDocumentFragment()
    const tickFragment = owner.createDocumentFragment()

    headings.forEach((item, index) => {
      const li = owner.createElement('li')
      li.className = styles.item
      const button = owner.createElement('button')
      button.type = 'button'
      button.className = styles.itemBtn
      button.dataset.tocId = item.id
      button.dataset.tocLevel = String(item.level)
      button.style.setProperty('--toc-indent', `${item.level * 12}px`)
      const labelSpan = owner.createElement('span')
      labelSpan.className = styles.itemText
      labelSpan.textContent = item.text
      button.append(labelSpan)
      button.addEventListener('click', () => {
        const target = headings[index]
        if (!target) return
        beginNavigationLock(index)
        options.onSelect(target, index)
        if (isNarrow && drawerOpen) {
          drawerOpen = false
          syncLayout()
        }
      })
      li.append(button)
      listFragment.append(li)
      itemButtons.push(button)

      if (index < MAX_RAIL_TICKS) {
        const tick = owner.createElement('span')
        tick.className = `${styles.railTick} ${RAIL_TICK_LEVEL_CLASSES[item.level] ?? styles.railTickLevel4}`
        tickFragment.append(tick)
        railTickEls.push(tick)
      }
    })

    list.replaceChildren(listFragment)
    railTicks.replaceChildren(tickFragment)
  }

  const updateHeadings = (next: MarkdownHeadingItem[]) => {
    if (destroyed) return
    headings = next
    const signature = JSON.stringify(next.map(item => [item.id, item.text, item.level]))
    if (signature !== structureSignature) {
      structureSignature = signature
      rebuildList()
      if (activeIndex >= headings.length) activeIndex = headings.length - 1
      setActiveIndex(activeIndex)
    }
    syncLayout()
  }

  const onToggleExpand = () => {
    if (isNarrow) drawerOpen = true
    else userCollapsed = false
    syncLayout()
  }

  const onToggleCollapse = () => {
    if (isNarrow) drawerOpen = false
    else userCollapsed = true
    syncLayout()
  }

  const onPointerDownOutside = (event: Event) => {
    if (!isNarrow || !drawerOpen) return
    const target = event.target as Node | null
    if (target && !aside.contains(target)) {
      drawerOpen = false
      syncLayout()
    }
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape' && isNarrow && drawerOpen) {
      drawerOpen = false
      syncLayout()
    }
  }

  railBtn.addEventListener('click', onToggleExpand)
  collapseBtn.addEventListener('click', onToggleCollapse)
  owner.addEventListener('pointerdown', onPointerDownOutside, true)
  owner.addEventListener('keydown', onKeyDown)
  viewWin?.addEventListener('klaus:lang-change', refreshLabels)
  viewWin?.addEventListener('resize', syncLayout)

  const scheduleLayout = () => {
    if (destroyed || layoutRaf) return
    const run = () => {
      layoutRaf = 0
      const width = Math.round(options.host.clientWidth)
      if (width === lastObservedWidth) return
      lastObservedWidth = width
      syncLayout()
    }
    layoutRaf = viewWin?.requestAnimationFrame ? viewWin.requestAnimationFrame(run) : setTimeout(run, 0)
  }

  const ResizeObserverCtor = viewWin?.ResizeObserver ?? (typeof ResizeObserver !== 'undefined' ? ResizeObserver : undefined)
  const resizeObserver = ResizeObserverCtor ? new ResizeObserverCtor(entries => {
    const measured = entries[0]?.contentRect?.width
    const width = Math.round(measured ?? options.host.clientWidth)
    if (width === lastObservedWidth) return
    scheduleLayout()
  }) : null
  resizeObserver?.observe(options.host)

  lastObservedWidth = Math.round(options.host.clientWidth)
  refreshLabels()
  syncLayout()

  return {
    element: aside,
    updateHeadings,
    setActiveIndex,
    setEnabled(nextEnabled: boolean) {
      enabled = nextEnabled
      if (!enabled) drawerOpen = false
      syncLayout()
    },
    beginNavigationLock,
    clearNavigationLock,
    isNavigationLocked,
    refreshLabels,
    destroy() {
      if (destroyed) return
      destroyed = true
      if (layoutRaf) {
        if (viewWin?.cancelAnimationFrame && typeof layoutRaf === 'number') viewWin.cancelAnimationFrame(layoutRaf)
        else clearTimeout(layoutRaf as ReturnType<typeof setTimeout>)
        layoutRaf = 0
      }
      resizeObserver?.disconnect()
      railBtn.removeEventListener('click', onToggleExpand)
      collapseBtn.removeEventListener('click', onToggleCollapse)
      owner.removeEventListener('pointerdown', onPointerDownOutside, true)
      owner.removeEventListener('keydown', onKeyDown)
      viewWin?.removeEventListener('klaus:lang-change', refreshLabels)
      viewWin?.removeEventListener('resize', syncLayout)
      aside.remove()
    },
  }
}

export interface CodeMirrorTocBinding {
  view: EditorView
  toc: MarkdownTocController
  updateFromDoc(source: string, tree?: unknown): void
  scrollToAnchor(href: string): boolean
  syncScroll(): void
  destroy(): void
}

/** Wrap a CodeMirror Markdown editor view inside a flex shell with a live right-side TOC. */
export function attachCodeMirrorToc(options: {
  parent: HTMLElement
  mountEditor(mainEl: HTMLElement): EditorView
  translate?(key: string): string
}): CodeMirrorTocBinding {
  const owner = options.parent.ownerDocument || document
  const win = owner.defaultView
  const shell = owner.createElement('div')
  shell.className = styles.shell
  const main = owner.createElement('div')
  main.className = styles.main
  shell.append(main)
  options.parent.append(shell)

  let view!: EditorView
  let headings: MarkdownHeadingItem[] = []
  let rafId: number | ReturnType<typeof setTimeout> = 0
  const scheduleFrame = (cb: () => void) => (win?.requestAnimationFrame ? win.requestAnimationFrame(cb) : setTimeout(cb, 0))
  const cancelFrame = (id: number | ReturnType<typeof setTimeout>) => {
    if (win?.cancelAnimationFrame && typeof id === 'number') win.cancelAnimationFrame(id)
    else clearTimeout(id as ReturnType<typeof setTimeout>)
  }

  const scrollToHeading = (item: MarkdownHeadingItem) => {
    const docLength = view.state.doc.length
    const lineStart = Math.max(0, Math.min(item.from, docLength))
    const caretPos = Math.max(0, Math.min(item.textFrom, docLength))
    view.dispatch({
      ...(view.hasFocus ? { selection: EditorSelection.cursor(caretPos) } : {}),
      effects: EditorView.scrollIntoView(lineStart, { y: 'start', yMargin: 16 }),
    })
  }

  const toc = createMarkdownToc({
    host: shell,
    translate: options.translate,
    onSelect: item => scrollToHeading(item),
  })

  view = options.mountEditor(main)

  const computeActiveIndex = (): number => {
    if (!headings.length) return -1
    const scroller = view.scrollDOM
    if (scroller.scrollTop <= 2) return 0
    const threshold = scroller.scrollTop + Math.min(72, Math.max(24, scroller.clientHeight * 0.18))
    const docLength = view.state.doc.length
    let active = 0
    for (let i = 0; i < headings.length; i++) {
      const pos = Math.max(0, Math.min(headings[i].from, docLength))
      const top = view.lineBlockAt(pos).top
      if (top <= threshold) active = i
      else break
    }
    return active
  }

  const syncScroll = () => {
    const locked = toc.isNavigationLocked()
    if (locked >= 0 && locked < headings.length) {
      toc.setActiveIndex(locked)
      return
    }
    toc.setActiveIndex(computeActiveIndex())
  }

  const scheduleSyncScroll = () => {
    if (rafId) return
    rafId = scheduleFrame(() => {
      rafId = 0
      syncScroll()
    })
  }

  const onUserScrollGesture = () => {
    toc.clearNavigationLock()
    scheduleSyncScroll()
  }

  view.scrollDOM.addEventListener('scroll', scheduleSyncScroll, { passive: true })
  view.scrollDOM.addEventListener('wheel', onUserScrollGesture, { passive: true })
  view.scrollDOM.addEventListener('touchstart', onUserScrollGesture, { passive: true })

  return {
    view,
    toc,
    updateFromDoc(source: string, tree?: unknown) {
      headings = extractMarkdownHeadings(source, tree)
      toc.updateHeadings(headings)
      syncScroll()
    },
    scrollToAnchor(href: string) {
      const match = resolveMarkdownHeadingAnchor(headings, href)
      if (!match) return false
      const index = headings.indexOf(match)
      if (index >= 0) toc.beginNavigationLock(index)
      scrollToHeading(match)
      return true
    },
    syncScroll,
    destroy() {
      if (rafId) {
        cancelFrame(rafId)
        rafId = 0
      }
      view.scrollDOM.removeEventListener('scroll', scheduleSyncScroll)
      view.scrollDOM.removeEventListener('wheel', onUserScrollGesture)
      view.scrollDOM.removeEventListener('touchstart', onUserScrollGesture)
      toc.destroy()
      shell.remove()
    },
  }
}

export interface HtmlDocumentTocBinding {
  toc: MarkdownTocController
  refresh(): void
  syncScroll(): void
  setEnabled(enabled: boolean): void
  scrollToAnchor(href: string): boolean
  destroy(): void
}

/** Attach a right-side TOC + heading anchor navigation to a rendered HTML Markdown surface. */
export function attachHtmlDocumentToc(options: {
  host: HTMLElement
  scrollContainer: HTMLElement
  contentContainer: HTMLElement
  onNavigate?(): void
  translate?(key: string): string
}): HtmlDocumentTocBinding {
  const owner = options.host.ownerDocument || document
  const win = owner.defaultView
  let headings: MarkdownHeadingItem[] = []
  let headingElements: HTMLElement[] = []
  let rafId: number | ReturnType<typeof setTimeout> = 0
  const scheduleFrame = (cb: () => void) => (win?.requestAnimationFrame ? win.requestAnimationFrame(cb) : setTimeout(cb, 0))
  const cancelFrame = (id: number | ReturnType<typeof setTimeout>) => {
    if (win?.cancelAnimationFrame && typeof id === 'number') win.cancelAnimationFrame(id)
    else clearTimeout(id as ReturnType<typeof setTimeout>)
  }

  const scrollToHeadingIndex = (index: number) => {
    const el = headingElements[index]
    if (!el) return
    options.onNavigate?.()
    const containerRect = options.scrollContainer.getBoundingClientRect()
    const targetRect = el.getBoundingClientRect()
    const nextTop = Math.max(0, options.scrollContainer.scrollTop + (targetRect.top - containerRect.top) - 16)
    options.scrollContainer.scrollTop = nextTop
  }

  const toc = createMarkdownToc({
    host: options.host,
    translate: options.translate,
    onSelect: (_item, index) => scrollToHeadingIndex(index),
  })

  const computeActiveIndex = (): number => {
    if (!headingElements.length) return -1
    if (options.scrollContainer.scrollTop <= 2) return 0
    const containerRect = options.scrollContainer.getBoundingClientRect()
    const offsetThreshold = Math.min(72, Math.max(24, options.scrollContainer.clientHeight * 0.18))
    let active = 0
    for (let i = 0; i < headingElements.length; i++) {
      const delta = headingElements[i].getBoundingClientRect().top - containerRect.top
      if (delta <= offsetThreshold) active = i
      else break
    }
    return active
  }

  const syncScroll = () => {
    const locked = toc.isNavigationLocked()
    if (locked >= 0 && locked < headingElements.length) {
      toc.setActiveIndex(locked)
      return
    }
    toc.setActiveIndex(computeActiveIndex())
  }

  const scheduleSyncScroll = () => {
    if (rafId) return
    rafId = scheduleFrame(() => {
      rafId = 0
      syncScroll()
    })
  }

  const onUserScrollGesture = () => {
    toc.clearNavigationLock()
    scheduleSyncScroll()
  }

  const refresh = () => {
    const seen = new Map<string, number>()
    const nextHeadings: MarkdownHeadingItem[] = []
    const nextElements: HTMLElement[] = []
    const rawElements = Array.from(options.contentContainer.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6'))
    for (const el of rawElements) {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (!text) continue
      const depth = Number(el.tagName.slice(1)) || 1
      const id = slugifyMarkdownHeading(text, seen)
      el.id = id
      nextElements.push(el)
      nextHeadings.push({
        id,
        text,
        depth,
        level: 0,
        from: nextHeadings.length,
        textFrom: nextHeadings.length,
        line: nextHeadings.length + 1,
      })
    }
    const minDepth = nextHeadings.reduce((min, item) => Math.min(min, item.depth), 6)
    headings = nextHeadings.map(item => ({
      ...item,
      level: Math.min(4, Math.max(0, item.depth - minDepth)),
    }))
    headingElements = nextElements
    toc.updateHeadings(headings)
    syncScroll()
  }

  const scrollToAnchor = (href: string): boolean => {
    const match = resolveMarkdownHeadingAnchor(headings, href)
    if (!match) return false
    const index = headings.indexOf(match)
    if (index < 0) return false
    toc.beginNavigationLock(index)
    scrollToHeadingIndex(index)
    return true
  }

  const onContentClick = (event: MouseEvent) => {
    const anchor = (event.target as Element | null)?.closest<HTMLAnchorElement>('a[href]')
    if (!anchor) return
    const href = anchor.getAttribute('href') || ''
    if (!href.startsWith('#')) return
    event.preventDefault()
    event.stopPropagation()
    scrollToAnchor(href)
  }

  options.scrollContainer.addEventListener('scroll', scheduleSyncScroll, { passive: true })
  options.scrollContainer.addEventListener('wheel', onUserScrollGesture, { passive: true })
  options.scrollContainer.addEventListener('touchstart', onUserScrollGesture, { passive: true })
  options.contentContainer.addEventListener('click', onContentClick)

  return {
    toc,
    refresh,
    syncScroll,
    setEnabled(enabled: boolean) {
      toc.setEnabled(enabled)
      if (!enabled) {
        headings = []
        headingElements = []
      }
    },
    scrollToAnchor,
    destroy() {
      if (rafId) {
        cancelFrame(rafId)
        rafId = 0
      }
      options.scrollContainer.removeEventListener('scroll', scheduleSyncScroll)
      options.scrollContainer.removeEventListener('wheel', onUserScrollGesture)
      options.scrollContainer.removeEventListener('touchstart', onUserScrollGesture)
      options.contentContainer.removeEventListener('click', onContentClick)
      toc.destroy()
    },
  }
}
