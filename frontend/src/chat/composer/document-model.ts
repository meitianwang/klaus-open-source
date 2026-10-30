import { Schema, type Node as DocumentNode, type NodeSpec } from 'prosemirror-model'
import { defaultMarkdownSerializer, MarkdownSerializer, schema as markdownSchema } from 'prosemirror-markdown'
import { escapeTablePipes, tableNodeSpecs, writeMarkdownTable } from './table-document'
import type { InlineTokenSnapshot } from './inline-token'

export interface ComposerDocumentToken {
  value: string
  label: string
  data?: unknown
}

export interface ComposerDocumentSnapshot {
  version: 1
  content: ReturnType<DocumentNode['toJSON']>
}

/** Joining drafts preserves each block and its inline identities. */
export function mergeComposerDocuments(left: { document?: ComposerDocumentSnapshot; text: string; tokens?: InlineTokenSnapshot[] },
  right: { document?: ComposerDocumentSnapshot; text: string; tokens?: InlineTokenSnapshot[] }): ComposerDocumentSnapshot {
  const read = (entry: typeof left) => restoreComposerDocument(entry.document) || composerDocumentFromText(entry.text, entry.tokens)
  const first = read(left), second = read(right)
  const empty = (node: DocumentNode) => node.childCount === 1 && node.firstChild!.type.name === 'paragraph' && node.firstChild!.content.size === 0
  const document = empty(first) ? second : empty(second) ? first
    : composerDocumentSchema.nodes.doc.create(null, first.content.append(second.content))
  return snapshotComposerDocument(document)
}

export const COMPOSER_DOCUMENT_TOKEN_ATTRIBUTE = 'data-klaus-document-token'
export const COMPOSER_DOCUMENT_TOKEN_DATA_LIMIT = 5 * 1024 * 1024
const TOKEN_DATA_DEPTH_LIMIT = 128

/** Bound nested metadata before schema consumers traverse or serialize it recursively. */
export function composerTokenDataWithinDepth(data: unknown): boolean {
  const pending = [{ value: data, depth: 0 }]
  while (pending.length) {
    const { value, depth } = pending.pop()!
    if (!value || typeof value !== 'object') continue
    if (depth >= TOKEN_DATA_DEPTH_LIMIT) return false
    for (const child of Object.values(value)) pending.push({ value: child, depth: depth + 1 })
  }
  return true
}

export function composerClipboardTokenAttributes(raw: string | null): { value: string; label: string; data: unknown } | null {
  if (!raw || raw.length > COMPOSER_DOCUMENT_TOKEN_DATA_LIMIT) return null
  try {
    const token = JSON.parse(raw)
    return typeof token?.value === 'string' && token.value && typeof token?.label === 'string' && composerTokenDataWithinDepth(token.data)
      ? { value: token.value, label: token.label, data: token.data ?? null } : null
  } catch { return null }
}
const tokenSpec: NodeSpec = {
  inline: true, group: 'inline', atom: true, selectable: false, draggable: false,
  attrs: { value: { validate: 'string' }, label: { validate: 'string' }, data: { default: null, validate: value => {
    if (!composerTokenDataWithinDepth(value)) throw new RangeError('Inline metadata nesting exceeds the editable bound')
  } } },
  leafText: node => node.attrs.label,
  toDOM: node => ['span', { [COMPOSER_DOCUMENT_TOKEN_ATTRIBUTE]: JSON.stringify(node.attrs), contenteditable: 'false' }, node.attrs.label],
  parseDOM: [{ tag: `span[${COMPOSER_DOCUMENT_TOKEN_ATTRIBUTE}]`, getAttrs: element => {
    return composerClipboardTokenAttributes(element.getAttribute(COMPOSER_DOCUMENT_TOKEN_ATTRIBUTE)) || false
  } }],
}

/** Inline identities share the same schema and history as formatted text. */
export const composerDocumentSchema = new Schema({
  nodes: markdownSchema.spec.nodes.append(tableNodeSpecs).addBefore('text', 'composer_token', tokenSpec),
  marks: markdownSchema.spec.marks.addToEnd('strike', {
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { style: 'text-decoration=line-through' }],
    toDOM: () => ['s', 0],
  }),
})

export function composerTokenNode(token: ComposerDocumentToken): DocumentNode {
  return composerDocumentSchema.nodes.composer_token.create(token)
}

/** Literal text keeps every line break; Markdown-looking text remains editable prose. */
export function composerDocumentFromText(value: string, tokens: readonly InlineTokenSnapshot[] = []): DocumentNode {
  const children: DocumentNode[] = []
  const appendText = (text: string) => {
    for (const [index, line] of text.split('\n').entries()) {
      if (index) children.push(composerDocumentSchema.nodes.hard_break.create())
      if (line) children.push(composerDocumentSchema.text(line))
    }
  }
  let cursor = 0
  for (const token of tokens.slice().sort((left, right) => left.start - right.start)) {
    if (token.start < cursor || token.end <= token.start || token.end > value.length
      || value.slice(token.start, token.end) !== token.value) continue
    appendText(value.slice(cursor, token.start))
    const data = token.data && typeof token.data === 'object' ? token.data as Record<string, unknown> : null
    const label = typeof data?.name === 'string' ? data.name
      : typeof data?.previewText === 'string' ? data.previewText : typeof data?.text === 'string' ? data.text : token.value
    children.push(composerTokenNode({ value: token.value, label, data: token.data }))
    cursor = token.end
  }
  appendText(value.slice(cursor))
  return composerDocumentSchema.nodes.doc.create(null, composerDocumentSchema.nodes.paragraph.create(null, children))
}

/** Plain projection is for native offsets; clipboard projection uses readable labels. */
export function composerDocumentText(document: DocumentNode, clipboard: boolean | ((token: ComposerDocumentToken) => string) = false): string {
  const render = (node: DocumentNode): string => {
    if (node.isText) return node.text || ''
    if (node.type.name === 'hard_break') return '\n'
    if (node.type.name === 'composer_token') return typeof clipboard === 'function'
      ? clipboard({ value: node.attrs.value, label: node.attrs.label, data: node.attrs.data })
      : clipboard ? node.attrs.label : node.attrs.value
    const parts: string[] = []
    node.forEach(child => parts.push(render(child)))
    return parts.join(node.isTextblock ? '' : '\n')
  }
  return render(document)
}

export function snapshotComposerDocument(document: DocumentNode): ComposerDocumentSnapshot {
  document.check()
  return { version: 1, content: document.toJSON() }
}

/** An incompatible document falls back to the separately persisted prompt. */
export function restoreComposerDocument(value: unknown): DocumentNode | null {
  if (!value || typeof value !== 'object') return null
  const snapshot = value as Partial<ComposerDocumentSnapshot>
  if (snapshot.version !== 1 || !snapshot.content) return null
  try {
    const document = composerDocumentSchema.nodeFromJSON(snapshot.content)
    if (document.type !== composerDocumentSchema.nodes.doc) return null
    document.check()
    return document
  } catch { return null }
}

/** Submission serializes formatting while collecting each inline target's authored offset. */
export function serializeComposerDocument(document: DocumentNode): { text: string; tokens: InlineTokenSnapshot[] } {
  const tokens: InlineTokenSnapshot[] = []
  const occurrences: Array<{ marker: string; token: ComposerDocumentToken }> = []
  let prefix = 'KLSDOCTOKEN'
  const source = JSON.stringify(document.toJSON())
  while (source.includes(prefix)) prefix += 'X'
  const tokenWriter = (cell: boolean) => (state: Parameters<typeof defaultMarkdownSerializer.nodes.text>[0], node: DocumentNode) => {
    const marker = `${prefix}${occurrences.length}END`
    const value = cell ? escapeTablePipes(node.attrs.value) : node.attrs.value
    const data = cell && node.attrs.data && typeof node.attrs.data === 'object' && typeof node.attrs.data.value === 'string'
      ? { ...node.attrs.data, value } : node.attrs.data
    occurrences.push({ marker, token: { value, label: node.attrs.label, data } })
    state.write(marker)
  }
  const marks = { ...defaultMarkdownSerializer.marks, strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true } }
  const cellSerializer = new MarkdownSerializer({ ...defaultMarkdownSerializer.nodes,
    hard_break: state => { state.write('<br>') }, composer_token: tokenWriter(true),
  }, marks)
  const serializer = new MarkdownSerializer({
    ...defaultMarkdownSerializer.nodes,
    hard_break: state => { state.write('\n') },
    text: (state, node) => { state.text(node.text || '', false) },
    composer_token: tokenWriter(false),
    table: (state, table) => writeMarkdownTable(state, table,
      cell => cellSerializer.serialize(composerDocumentSchema.nodes.doc.create(null,
        composerDocumentSchema.nodes.paragraph.create(null, cell.content))),
      text => {
        for (const { marker, token } of occurrences) text = text.replace(marker, () => (token.data as { kind?: string } | null)?.kind === 'selected-text' ? '' : token.value)
        return text.length
      }),
  }, marks)
  const marked = serializer.serialize(document)
  let text = '', cursor = 0
  for (const { marker, token } of occurrences) {
    const index = marked.indexOf(marker, cursor)
    if (index < 0) throw new Error('An inline document target could not be serialized')
    text += marked.slice(cursor, index)
    const start = text.length
    const data = token.data as { kind?: string } | null
    if (data?.kind !== 'selected-text') text += token.value
    tokens.push({ start, end: text.length, value: token.value, ...(data == null ? {} : { data }) })
    cursor = index + marker.length
  }
  return { text: text + marked.slice(cursor), tokens }
}
