import { Annotation, Compartment, EditorSelection, EditorState, StateEffect, StateField, Transaction, type Extension } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, drawSelection, dropCursor, keymap, type DecorationSet } from '@codemirror/view'
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel, closeSearchPanel, searchPanelOpen, findNext, findPrevious } from '@codemirror/search'
import { markdown } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { tags } from '@lezer/highlight'
import { HighlightStyle } from '@codemirror/language'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfm } from 'micromark-extension-gfm'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { diffLines } from 'diff'
import katex from 'katex'
import { renderMarkdownHtml } from './markdown'
import styles from './workspace-markdown-editor.module.css'

export interface MarkdownEditorSnapshot {
  state: EditorState
  scrollTop: number
  scrollLeft: number
}

export interface MarkdownEditorOptions {
  parent: HTMLElement
  content: string
  readOnly?: boolean
  onChange(content: string): void
  onSave?(): void | Promise<void>
  resolveImageUrl?(source: string): string | Promise<string>
  openLink?(href: string): boolean | void
  initialState?: MarkdownEditorSnapshot
  ariaLabel?: string
}

export interface MarkdownEditor {
  getContent(): string
  updateContent(content: string): void
  setReadOnly(value: boolean): void
  snapshot(): MarkdownEditorSnapshot
  goToLine(line: number): void
  focus(): void
  find(direction?: 'next' | 'previous'): void
  destroy(): void
}

interface MarkdownNode {
  type: string
  position?: { start: { offset?: number }; end: { offset?: number } }
  children?: MarkdownNode[]
  value?: string
  depth?: number
  ordered?: boolean
  start?: number | null
  checked?: boolean | null
  url?: string
  title?: string | null
  alt?: string | null
  identifier?: string
  lang?: string | null
}

interface SourceRange { from: number; to: number }
export interface MarkdownPresentation {
  kind: 'hide' | 'mark' | 'line' | 'task' | 'image' | 'table' | 'math' | 'diagram' | 'rule'
  from: number
  to: number
  className?: string
  value?: string
  href?: string
  alt?: string
  title?: string
  checked?: boolean
  block?: boolean
  headingLevel?: number
}

const externalContent = Annotation.define<boolean>()
const focusEffect = StateEffect.define<boolean>()
const presentationRefresh = StateEffect.define<null>()
const AST_OPTIONS = { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }

/** Map external edits narrowly so unaffected selections and undo entries survive. */
export function markdownExternalChanges(state: EditorState, content: string) {
  const next = state.toText(content)
  const previous = state.doc.toString()
  const text = next.toString()
  const chunks = previous.length <= 1_000_000 && text.length <= 1_000_000
    ? diffLines(previous, text, { newlineIsToken: true, timeout: 50 }) : undefined
  if (!chunks) {
    let start = 0, beforeEnd = previous.length, afterEnd = text.length
    while (start < beforeEnd && start < afterEnd && previous[start] === text[start]) start++
    while (beforeEnd > start && afterEnd > start && previous[beforeEnd - 1] === text[afterEnd - 1]) { beforeEnd--; afterEnd-- }
    return state.changes({ from: start, to: beforeEnd, insert: text.slice(start, afterEnd) })
  }
  const changes: Array<{ from: number; to: number; insert: string }> = []
  let position = 0
  for (const chunk of chunks) {
    if (chunk.added) {
      const previous = changes.at(-1)
      if (previous?.to === position) previous.insert += chunk.value
      else changes.push({ from: position, to: position, insert: chunk.value })
    } else {
      if (chunk.removed) changes.push({ from: position, to: position + chunk.value.length, insert: '' })
      position += chunk.value.length
    }
  }
  return state.changes(changes)
}

/** A fixed separator preserves existing CRLF files through ordinary edits. */
export function markdownLineSeparator(content: string): string {
  if (content.includes('\r\n') && !/(?<!\r)\n/.test(content)) return '\r\n'
  if (content.includes('\r') && !content.includes('\n')) return '\r'
  // In a mixed file, CR remains part of the preceding line's text so that
  // untouched separators keep their original bytes rather than being unified.
  return '\n'
}

function rangeOf(node: MarkdownNode): SourceRange {
  return { from: node.position?.start.offset ?? 0, to: node.position?.end.offset ?? 0 }
}

/** Keep navigation local or within the URL schemes the host knows how to open. */
export function safeMarkdownHref(value: string, image = false): string {
  const href = value.trim()
  if (!href || /[\u0000-\u001f\u007f]/.test(href)) return ''
  const compact = href.replace(/\s/g, '')
  if (/^(?:javascript|vbscript|data):/i.test(compact)) return ''
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^(?:https?|mailto|file|klaus-media|blob):/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) return ''
  if (image && /^mailto:/i.test(href)) return ''
  return href
}

/** Toggle exactly the task marker; stale widget events cannot edit nearby text. */
export function markdownTaskChange(source: string, from: number, checked: boolean): { from: number; to: number; insert: string } | null {
  if (!Number.isInteger(from) || from < 0 || !/^\[[ xX]\]$/.test(source.slice(from, from + 3))) return null
  return { from: from + 1, to: from + 2, insert: checked ? 'x' : ' ' }
}

function intersects(range: SourceRange, selections: readonly SourceRange[]): boolean {
  return selections.some(selection => selection.from === selection.to
    ? selection.from >= range.from && selection.from <= range.to
    : selection.from < range.to && selection.to > range.from)
}

function lineRange(source: string, range: SourceRange): SourceRange {
  const from = source.lastIndexOf('\n', Math.max(0, range.from - 1)) + 1
  const end = source.indexOf('\n', range.to)
  return { from, to: end < 0 ? source.length : end }
}

function normalizeIdentifier(identifier: string): string { return identifier.trim().replace(/\s+/g, ' ').toLowerCase() }

/** Source offsets are used for every edit; rendering never serializes the document. */
export function planMarkdownPresentation(source: string, selections: readonly SourceRange[] = [], tree?: MarkdownNode): MarkdownPresentation[] {
  const root = tree ?? fromMarkdown(source, AST_OPTIONS) as MarkdownNode
  const specs: MarkdownPresentation[] = []
  const definitions = new Map<string, MarkdownNode>()
  const collectDefinitions = (node: MarkdownNode) => {
    if (node.type === 'definition' && node.identifier) definitions.set(normalizeIdentifier(node.identifier), node)
    node.children?.forEach(collectDefinitions)
  }
  collectDefinitions(root)
  const add = (spec: MarkdownPresentation) => { if (spec.to >= spec.from) specs.push(spec) }
  const hide = (from: number, to: number) => { if (to > from) add({ kind: 'hide', from, to }) }
  const mark = (range: SourceRange, className: string, href?: string) => { if (range.to > range.from) add({ kind: 'mark', ...range, className, href }) }
  const decorateLines = (range: SourceRange, className: string, headingLevel?: number) => {
    let from = source.lastIndexOf('\n', Math.max(0, range.from - 1)) + 1
    while (from < range.to || (from === range.to && range.from === range.to)) {
      add({ kind: 'line', from, to: from, className, ...(headingLevel ? { headingLevel } : {}) })
      const next = source.indexOf('\n', from)
      if (next < 0 || next + 1 >= range.to) break
      from = next + 1
    }
  }

  const visit = (node: MarkdownNode, parent?: MarkdownNode) => {
    const range = rangeOf(node)
    const raw = source.slice(range.from, range.to)
    const active = intersects(range, selections)
    const children = node.children ?? []
    if (node.type === 'code') {
      const fenced = /^([ \t]*)(`{3,}|~{3,})([^\n]*)\n/.exec(raw)
      if (node.lang?.toLowerCase() === 'mermaid' && !active) {
        add({ kind: 'diagram', ...range, value: node.value ?? '', block: true })
        return
      }
      decorateLines(range, styles.codeLine)
      if (fenced) {
        const openingEnd = range.from + fenced[0].length - 1
        const lastStart = source.lastIndexOf('\n', range.to - 1) + 1
        if (!intersects({ from: range.from, to: openingEnd }, selections)) hide(range.from, openingEnd)
        if (lastStart > openingEnd && /^\s*(?:`{3,}|~{3,})\s*$/.test(source.slice(lastStart, range.to)) && !intersects({ from: lastStart, to: range.to }, selections)) hide(lastStart, range.to)
      }
      return
    }
    if (node.type === 'table') {
      // Container markers belong to the quote/list, rather than to its table.
      // Removing them here affects the widget's HTML only, never the document.
      const tableSource = raw.split('\n').map(line => line.replace(/^(?:[ \t]*>[ \t]?)+/, '').trimStart()).join('\n')
      if (!active) add({ kind: 'table', ...range, value: tableSource, block: true })
      else decorateLines(range, styles.tableSourceLine)
      return
    }
    if (node.type === 'image' || node.type === 'imageReference') {
      const definition = node.type === 'imageReference' ? definitions.get(normalizeIdentifier(node.identifier ?? '')) : node
      const href = safeMarkdownHref(definition?.url ?? '', true)
      if (!active && href) {
        const block = parent?.type === 'paragraph' && parent.children?.length === 1
        add({ kind: 'image', ...range, href, alt: node.alt ?? '', title: definition?.title ?? '', block })
        return
      }
    }
    if (node.type === 'heading') {
      decorateLines(range, `${styles.headingLine} ${styles['heading' + node.depth] ?? ''}`, node.depth)
      // Concealment is gated on the mark tokens themselves: a caret editing the
      // heading text keeps the rendered line clean, while a caret inside the
      // marks exposes exactly the span being edited.
      const leading = /^#{1,6}\s+/.exec(raw)
      if (leading) {
        if (!intersects({ from: range.from, to: range.from + leading[0].length }, selections)) hide(range.from, range.from + leading[0].length)
        const trailing = /\s+#+\s*$/.exec(raw)
        if (trailing && trailing.index >= leading[0].length && !intersects({ from: range.from + trailing.index, to: range.to }, selections)) hide(range.from + trailing.index, range.to)
      } else {
        const underline = /\n[ \t]*(?:=+|-+)[ \t]*$/.exec(raw)
        if (underline && !intersects({ from: range.from + underline.index, to: range.to }, selections)) hide(range.from + underline.index, range.to)
      }
    } else if (node.type === 'strong' || node.type === 'emphasis' || node.type === 'delete' || node.type === 'inlineCode') {
      const className = node.type === 'strong' ? styles.strong : node.type === 'emphasis' ? styles.emphasis : node.type === 'delete' ? styles.strike : styles.inlineCode
      mark(range, className)
      if (!active) {
        if (node.type === 'inlineCode') {
          const delimiter = /^`+/.exec(raw)?.[0].length ?? 1
          hide(range.from, range.from + delimiter)
          hide(range.to - delimiter, range.to)
        } else if (children.length) {
          hide(range.from, rangeOf(children[0]).from)
          hide(rangeOf(children[children.length - 1]).to, range.to)
        }
      }
    } else if (node.type === 'link' || node.type === 'linkReference') {
      const definition = node.type === 'linkReference' ? definitions.get(normalizeIdentifier(node.identifier ?? '')) : node
      const href = safeMarkdownHref(definition?.url ?? '')
      if (href) {
        if (!active && children.length) {
          const content = { from: rangeOf(children[0]).from, to: rangeOf(children[children.length - 1]).to }
          hide(range.from, content.from)
          hide(content.to, range.to)
          mark(content, styles.link, href)
        } else mark(range, styles.link, href)
      }
    } else if (node.type === 'blockquote') {
      decorateLines(range, styles.quoteLine)
      const lines = raw.split('\n')
      let from = range.from
      for (const line of lines) {
        const prefix = /^(?:[ \t]*>[ \t]?)+/.exec(line)
        if (prefix && !intersects({ from, to: from + prefix[0].length }, selections)) hide(from, from + prefix[0].length)
        from += line.length + 1
      }
    } else if (node.type === 'listItem') {
      decorateLines(range, styles.listLine)
      const marker = /^(?:[-+*]|\d+[.)])\s+/.exec(raw)
      if (marker && !parent?.ordered && !intersects({ from: range.from, to: range.from + marker[0].length }, selections)) {
        add({ kind: 'mark', from: range.from, to: range.from + marker[0].length, className: styles.bulletMarker })
      }
      if (node.checked !== null && node.checked !== undefined && marker) {
        const taskFrom = range.from + marker[0].length
        const task = /^\[([ xX])\]/.exec(source.slice(taskFrom))
        if (task && !intersects({ from: taskFrom, to: taskFrom + 3 }, selections)) {
          add({ kind: 'task', from: taskFrom, to: taskFrom + 3, checked: node.checked })
        }
      }
    } else if (node.type === 'thematicBreak' && !active) {
      add({ kind: 'rule', ...range })
      return
    } else if (node.type === 'html') {
      mark(range, styles.literalHtml)
      return
    } else if (node.type === 'text') {
      if (!active) {
        const punctuation = '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'
        for (let index = 0; index + 1 < raw.length; index++) {
          if (raw[index] === '\\' && punctuation.includes(raw[index + 1])) { hide(range.from + index, range.from + index + 1); index++ }
        }
      }
      // Math is deliberately restricted to text nodes, excluding code, links,
      // HTML and escaped dollars; ordinary currency stays ordinary text.
      if (parent?.type !== 'link' && parent?.type !== 'linkReference') {
        const math = /(?<!\\)\$\$([\s\S]+?)\$\$|(?<![\\$])\$(?![\s$])([^$\n]+?)(?<!\s)\$(?![\d$])/g
        for (const match of raw.matchAll(math)) {
          const mathRange = { from: range.from + match.index!, to: range.from + match.index! + match[0].length }
          if (!intersects(mathRange, selections)) add({ kind: 'math', ...mathRange, value: match[1] ?? match[2], block: match[1] !== undefined && /^\s*\$\$[\s\S]*\$\$\s*$/.test(source.slice(lineRange(source, mathRange).from, lineRange(source, mathRange).to)) })
        }
      }
    }
    children.forEach(child => visit(child, node))
  }
  visit(root)
  // A block replacement must not overlap a nested inline decoration.
  const replacements = specs.filter(spec => ['image', 'table', 'diagram', 'math'].includes(spec.kind) && spec.block)
  const visible = specs.filter(spec => !replacements.some(block => block !== spec && spec.from >= block.from && spec.to <= block.to))
  const concealed = visible.filter(spec => spec.kind === 'hide').sort((a, b) => a.from - b.from || b.to - a.to)
  const merged: MarkdownPresentation[] = []
  for (const spec of concealed) {
    const previous = merged[merged.length - 1]
    if (previous && spec.from <= previous.to) previous.to = Math.max(previous.to, spec.to)
    else merged.push({ ...spec })
  }
  return [...visible.filter(spec => spec.kind !== 'hide'), ...merged]
}

export interface MarkdownPresentationContext {
  options: Pick<MarkdownEditorOptions, 'resolveImageUrl' | 'openLink'>
  isReadOnly(): boolean
  renderedOnly?: boolean
  tableWidget?(spec: MarkdownPresentation): WidgetType
}

function selectWidgetSource(view: EditorView, range: SourceRange, atEnd = false) {
  view.dispatch({ selection: EditorSelection.cursor(atEnd ? range.to : range.from), scrollIntoView: true })
  view.focus()
}

class TaskWidget extends WidgetType {
  readonly disabled: boolean
  constructor(readonly spec: MarkdownPresentation, readonly context: MarkdownPresentationContext) { super(); this.disabled = context.isReadOnly() }
  eq(other: TaskWidget) { return other.spec.checked === this.spec.checked && other.spec.from === this.spec.from && other.disabled === this.disabled && other.context === this.context }
  toDOM(view: EditorView) {
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.className = styles.task
    input.checked = !!this.spec.checked
    input.disabled = this.disabled
    input.setAttribute('aria-label', view.state.doc.lineAt(this.spec.from).text.replace(/^\s*(?:[-+*]|\d+[.)])\s+\[[ xX]\]\s*/, ''))
    input.addEventListener('mousedown', event => event.preventDefault())
    input.addEventListener('change', () => {
      if (this.context.isReadOnly()) { input.checked = !!this.spec.checked; return }
      const changes = markdownTaskChange(view.state.doc.toString(), this.spec.from, input.checked)
      if (changes) view.dispatch({ changes, annotations: Transaction.userEvent.of('input.task') })
    })
    return input
  }
  ignoreEvent() { return true }
}

class RichWidget extends WidgetType {
  constructor(readonly spec: MarkdownPresentation, readonly context: MarkdownPresentationContext) { super() }
  eq(other: RichWidget) { return JSON.stringify(other.spec) === JSON.stringify(this.spec) && other.context === this.context }
  get estimatedHeight() { return this.spec.kind === 'image' || this.spec.kind === 'diagram' ? 240 : this.spec.block ? 100 : -1 }
  toDOM(view: EditorView) {
    const root = document.createElement(this.spec.block ? 'div' : 'span')
    root.className = styles.widget + ' ' + (styles[this.spec.kind] ?? '')
    root.dataset.markdownWidget = this.spec.kind
    root.setAttribute('contenteditable', 'false')
    const reveal = (event: Event) => {
      if ((event.target as HTMLElement).closest('a,input,button')) return
      event.preventDefault()
      selectWidgetSource(view, this.spec, this.context.renderedOnly)
    }
    root.addEventListener('mousedown', reveal)
    root.addEventListener('keydown', (event: Event) => {
      const key = (event as KeyboardEvent).key
      if (key === 'Enter' || key === 'F2') reveal(event)
    })
    root.tabIndex = 0
    root.addEventListener('focus', () => {
      // Mouse activation selects the raw span. Keyboard users can choose the
      // same action with Enter without losing their place in the tab order.
      root.classList.add(styles.widgetFocused)
    })
    root.addEventListener('blur', () => root.classList.remove(styles.widgetFocused))
    if (this.spec.kind === 'image') this.renderImage(root)
    if (this.spec.kind === 'table') {
      root.innerHTML = renderMarkdownHtml(this.spec.value ?? '')
      root.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(anchor => {
        const href = safeMarkdownHref(anchor.getAttribute('href') ?? '')
        anchor.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); if (href) this.context.options.openLink?.(href) })
      })
      root.querySelectorAll<HTMLElement>('[data-file-path]').forEach(link => link.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation()
        const href = safeMarkdownHref(link.dataset.filePath ?? '')
        if (href) this.context.options.openLink?.(href)
      }))
      root.querySelectorAll<HTMLImageElement>('img[src]').forEach(image => this.resolveImage(image, image.getAttribute('src') ?? ''))
    }
    if (this.spec.kind === 'math') root.innerHTML = katex.renderToString(this.spec.value ?? '', { displayMode: !!this.spec.block, throwOnError: false, trust: false, strict: 'ignore' })
    if (this.spec.kind === 'diagram') this.renderDiagram(root, view)
    if (this.spec.kind === 'rule') root.appendChild(document.createElement('hr'))
    return root
  }
  private resolveImage(image: HTMLImageElement, raw: string) {
    const href = safeMarkdownHref(raw, true)
    if (!href) { image.removeAttribute('src'); return }
    const resolved = this.context.options.resolveImageUrl?.(href) ?? (/^(?:https?:|blob:|klaus-media:)/i.test(href) ? href : '')
    Promise.resolve(resolved).then(url => { if (url && image.isConnected && safeMarkdownHref(url, true)) image.src = url }).catch(() => { image.classList.add(styles.imageError) })
  }
  private renderImage(root: HTMLElement) {
    const image = document.createElement('img')
    image.alt = this.spec.alt ?? ''
    image.loading = 'lazy'
    image.addEventListener('error', () => image.classList.add(styles.imageError))
    root.appendChild(image)
    this.resolveImage(image, this.spec.href ?? '')
  }
  private renderDiagram(root: HTMLElement, view: EditorView) {
    const loading = document.createElement('pre')
    loading.textContent = this.spec.value ?? ''
    root.appendChild(loading)
    const id = 'markdown-diagram-' + crypto.randomUUID().replace(/-/g, '')
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', suppressErrorRendering: true })
      const result = await mermaid.render(id, this.spec.value ?? '')
      if (!root.isConnected) return
      root.innerHTML = result.svg
      // The strict renderer generates the SVG; links still go through the
      // workspace's navigation callback rather than navigating this renderer.
      root.querySelectorAll('a').forEach(anchor => anchor.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation()
        const href = safeMarkdownHref(anchor.getAttribute('href') ?? anchor.getAttribute('xlink:href') ?? '')
        if (href) this.context.options.openLink?.(href)
      }))
      view.requestMeasure()
    }).catch(() => { root.classList.add(styles.diagramError) })
  }
  ignoreEvent(event: Event) { return event.type !== 'keydown' }
}

function decorationsFor(specs: readonly MarkdownPresentation[], context: MarkdownPresentationContext): DecorationSet {
  const ranges = specs.map(spec => {
    if (spec.kind === 'hide') return Decoration.replace({}).range(spec.from, spec.to)
    if (spec.kind === 'line') return Decoration.line({ attributes: { class: spec.className ?? '', ...(spec.headingLevel ? { role: 'heading', 'aria-level': String(spec.headingLevel) } : {}) } }).range(spec.from)
    if (spec.kind === 'mark') return Decoration.mark({ class: spec.className, attributes: spec.href ? { 'data-markdown-href': spec.href, role: 'link', tabindex: '0' } : undefined }).range(spec.from, spec.to)
    if (spec.kind === 'task') return Decoration.replace({ widget: new TaskWidget(spec, context) }).range(spec.from, spec.to)
    if (spec.kind === 'table' && context.tableWidget) return Decoration.replace({ widget: context.tableWidget(spec), block: true }).range(spec.from, spec.to)
    return Decoration.replace({ widget: new RichWidget(spec, context), block: !!spec.block }).range(spec.from, spec.to)
  })
  return Decoration.set(ranges, true)
}

export const markdownEditorClassName = styles.editor

export function markdownPresentationExtension(context: MarkdownPresentationContext): Extension {
  interface PresentationState { tree: MarkdownNode; focused: boolean; decorations: DecorationSet; concealed: DecorationSet }
  const present = (source: string, selections: readonly SourceRange[], tree: MarkdownNode) => {
    const specs = planMarkdownPresentation(source, selections, tree)
    return { decorations: decorationsFor(specs, context), concealed: Decoration.set(context.renderedOnly ? specs.filter(spec => spec.kind === 'hide').map(spec => Decoration.replace({}).range(spec.from, spec.to)) : [], true) }
  }
  const field = StateField.define<PresentationState>({
    create(state) {
      const source = state.doc.toString()
      const tree = fromMarkdown(source, AST_OPTIONS) as MarkdownNode
      return { tree, focused: false, ...present(source, [], tree) }
    },
    update(value, transaction) {
      const focused = transaction.effects.find(effect => effect.is(focusEffect))?.value ?? value.focused
      if (!transaction.docChanged && !transaction.selection && !transaction.reconfigured && focused === value.focused && !transaction.effects.some(effect => effect.is(presentationRefresh))) return value
      const source = transaction.state.doc.toString()
      const tree = transaction.docChanged ? fromMarkdown(source, AST_OPTIONS) as MarkdownNode : value.tree
      const selections = focused && !context.renderedOnly ? transaction.state.selection.ranges : []
      return { tree, focused, ...present(source, selections, tree) }
    },
    provide: field => [EditorView.decorations.from(field, value => value.decorations), EditorView.atomicRanges.of(view => view.state.field(field).concealed)],
  })
  // Styled text stays navigable one character at a time. The editor's normal
  // position mapping takes care of replacement widgets without turning the
  // contents of links, headings or emphasis into indivisible cursor stops.
  return field
}

const markdownHighlight = HighlightStyle.define([
  ...defaultHighlightStyle.specs,
  { tag: tags.heading, fontWeight: '600', textDecoration: 'none' },
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: tags.link, color: 'var(--theme-accent)' },
  { tag: tags.url, color: 'var(--fg-secondary)' },
  { tag: tags.meta, color: 'var(--fg-secondary)' },
])

export function createMarkdownEditor(options: MarkdownEditorOptions): MarkdownEditor {
  let readOnly = !!options.readOnly
  let destroyed = false
  const readOnlyCompartment = new Compartment()
  const lineSeparatorCompartment = new Compartment()
  const searchPhrases = new Compartment()
  const phrases = (): Record<string, string> => (window as unknown as { currentLang?: string }).currentLang === 'zh'
    ? { Find: '查找', Replace: '替换', next: '下一个', previous: '上一个', all: '全部', 'match case': '区分大小写', regexp: '正则表达式', 'by word': '全字匹配', replace: '替换', 'replace all': '全部替换', close: '关闭', 'Go to line': '跳转到行', go: '跳转', 'current match': '当前匹配', 'on line': '所在行' }
    : {}
  const context: MarkdownPresentationContext = { options, isReadOnly: () => readOnly }
  const extensions: Extension[] = [
    markdown({ codeLanguages: languages }),
    history(), drawSelection(), dropCursor(), EditorView.lineWrapping, search({ top: true }), highlightSelectionMatches(),
    searchPhrases.of(EditorState.phrases.of(phrases())),
    syntaxHighlighting(markdownHighlight),
    markdownPresentationExtension(context),
    lineSeparatorCompartment.of(EditorState.lineSeparator.of(markdownLineSeparator(options.content))),
    EditorView.contentAttributes.of({ 'aria-label': options.ariaLabel ?? '', spellcheck: 'true' }),
    readOnlyCompartment.of([EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]),
    keymap.of([{ key: 'Mod-s', run: () => { void options.onSave?.(); return true } }, ...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
    EditorView.updateListener.of(update => {
      if (update.docChanged && !update.transactions.every(transaction => transaction.annotation(externalContent))) options.onChange(update.state.sliceDoc())
    }),
    EditorView.domEventHandlers({
      focus: (_event, view) => { view.dispatch({ effects: focusEffect.of(true) }) },
      blur: (_event, view) => {
        // The next frame lets pointer selection in a protected widget complete
        // before its surrounding syntax is concealed again.
        requestAnimationFrame(() => { if (!destroyed && !view.hasFocus) view.dispatch({ effects: focusEffect.of(false) }) })
      },
      click: (event, view) => {
        const anchor = (event.target as HTMLElement).closest<HTMLElement>('[data-markdown-href]')
        if (!anchor || (!readOnly && !(event.metaKey || event.ctrlKey))) return false
        const href = safeMarkdownHref(anchor.dataset.markdownHref ?? '')
        if (href) { event.preventDefault(); options.openLink?.(href) }
        return true
      },
      keydown: event => {
        const anchor = (event.target as HTMLElement).closest<HTMLElement>('[data-markdown-href]')
        if (!anchor || event.key !== 'Enter') return false
        const href = safeMarkdownHref(anchor.dataset.markdownHref ?? '')
        if (href) { event.preventDefault(); options.openLink?.(href) }
        return true
      },
    }),
    EditorView.theme({ '&': { height: '100%' }, '&.cm-focused': { outline: 'none' }, '.cm-scroller': { overflow: 'auto', fontFamily: 'inherit' } }),
  ]
  let state = options.initialState?.state
  state = state ? state.update({ effects: StateEffect.reconfigure.of(extensions) }).state : EditorState.create({ doc: options.content, extensions })
  if (state.sliceDoc() !== options.content) state = state.update({ changes: markdownExternalChanges(state, options.content), annotations: [externalContent.of(true), Transaction.addToHistory.of(false)] }).state
  const view = new EditorView({ state, parent: options.parent })
  const refreshSearchLanguage = () => {
    if (destroyed) return
    const open = searchPanelOpen(view.state)
    if (open) closeSearchPanel(view)
    view.dispatch({ effects: searchPhrases.reconfigure(EditorState.phrases.of(phrases())) })
    if (open) openSearchPanel(view)
  }
  window.addEventListener('klaus:lang-change', refreshSearchLanguage)
  view.dom.classList.add(styles.editor)
  if (options.initialState) {
    const { scrollTop, scrollLeft } = options.initialState
    view.requestMeasure({ read: () => null, write: () => { view.scrollDOM.scrollTop = scrollTop; view.scrollDOM.scrollLeft = scrollLeft } })
  }
  return {
    getContent: () => view.state.sliceDoc(),
    updateContent(content) {
      if (destroyed || content === view.state.sliceDoc()) return
      const separator = markdownLineSeparator(content)
      if (view.state.facet(EditorState.lineSeparator) !== separator) view.dispatch({ effects: lineSeparatorCompartment.reconfigure(EditorState.lineSeparator.of(separator)) })
      view.dispatch({ changes: markdownExternalChanges(view.state, content), annotations: [externalContent.of(true), Transaction.addToHistory.of(false)] })
    },
    setReadOnly(value) {
      if (destroyed || value === readOnly) return
      readOnly = value
      view.dispatch({ effects: [readOnlyCompartment.reconfigure([EditorState.readOnly.of(value), EditorView.editable.of(!value)]), presentationRefresh.of(null)] })
    },
    snapshot: () => ({ state: view.state, scrollTop: view.scrollDOM.scrollTop, scrollLeft: view.scrollDOM.scrollLeft }),
    goToLine(line) {
      if (destroyed) return
      const target = view.state.doc.line(Math.max(1, Math.min(view.state.doc.lines, Math.floor(line))))
      view.dispatch({ selection: EditorSelection.cursor(target.from), effects: [focusEffect.of(true), EditorView.scrollIntoView(target.from, { y: 'center' })] })
      view.focus()
    },
    focus: () => { if (!destroyed) view.focus() },
    find: direction => { if (!destroyed) { if (direction === 'next') findNext(view); else if (direction === 'previous') findPrevious(view); else openSearchPanel(view) } },
    destroy() { if (!destroyed) { destroyed = true; window.removeEventListener('klaus:lang-change', refreshSearchLanguage); view.destroy() } },
  }
}
