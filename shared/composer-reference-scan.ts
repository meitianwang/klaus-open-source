/**
 * Text grammar for references that can be restored from plain text alone.
 *
 * References serialize into message text as Markdown links. Conversations,
 * skills, plugins and MCP sources use typed `klaus:` targets; browser tabs use a
 * `plugin://browser@klaus-bundled?...` URI. The link text
 * carries the full identity, so any surface that only receives the text — a
 * paste into the composer, a restored draft, a sent bubble without display
 * metadata — can promote the link back into a chip. This module owns that
 * grammar so the composer and the host parse exactly the same syntax.
 */
import { parseBrowserTabMention, type BrowserTabMention } from './browser-tab-mention'

const CONVERSATION_LINK_RE = /\[([^\]\n]{1,200})\]\(klaus:conversation\/([A-Za-z0-9_-]{1,128})\)/g
const BROWSER_TAB_LINK_RE = /\[([^\]\n]*)\]\((plugin:\/\/browser@klaus-bundled\?[^\s<>)]*)\)/g
const RESOURCE_LINK_RE = /\[((?:\\.|[^\]\\\n]){1,400})\]\(klaus:(skill|plugin|mcp|file|folder)\/([^\s<>?)]{1,4096})(?:\?path=([^\s<>)]{1,16384}))?\)/g

export type ResourceReferenceKind = 'skill' | 'plugin' | 'mcp' | 'file' | 'folder'

function referenceComponent(value: string): string {
  return encodeURIComponent(value).replaceAll('(', '%28').replaceAll(')', '%29')
}

/** A readable reference whose stable target survives copy, paste and restoration. */
export function resourceReferenceValue(kind: ResourceReferenceKind, name: string, id: string, skillPath?: string): string {
  const label = name.replace(/[\r\n]+/g, ' ').replace(/([\\\[\]])/g, '\\$1')
  const query = kind === 'skill' && skillPath ? `?path=${referenceComponent(skillPath)}` : ''
  return `[${label}](klaus:${kind}/${referenceComponent(id)}${query})`
}

export interface ConversationReference {
  title: string
  id: string
}

export interface ScannedReferenceToken {
  kind: 'conversation' | 'browser-tab' | ResourceReferenceKind
  name: string
  value: string
  range: { start: number; end: number }
  id: string
  skillPath?: string
  browserTab?: BrowserTabMention
}

/** The distinct conversations a request text links, in first-seen order. */
export function conversationReferencesIn(text: string): ConversationReference[] {
  const seen: ConversationReference[] = []
  CONVERSATION_LINK_RE.lastIndex = 0
  for (const match of String(text || '').matchAll(CONVERSATION_LINK_RE)) {
    const id = match[2]!
    if (seen.some(row => row.id === id)) continue
    seen.push({ title: match[1]!, id })
  }
  return seen
}

/** Undo the Markdown escaping a browser tab link title carries. */
export function plainBrowserTabLinkTitle(title: string): string {
  return title.replace(/\\([\\\[\]])/g, '$1').replace(/[\r\n]+/g, ' ').trim()
}

/**
 * Every restorable reference link in a text, positioned, in reading order.
 * Invalid tab URIs and links of any other scheme stay ordinary prose.
 */
export function scannableReferenceTokens(text: string): ScannedReferenceToken[] {
  const source = String(text || '')
  const tokens: ScannedReferenceToken[] = []
  RESOURCE_LINK_RE.lastIndex = 0
  for (const match of source.matchAll(RESOURCE_LINK_RE)) {
    let id: string, skillPath: string | undefined
    try {
      id = decodeURIComponent(match[3]!)
      if (match[4]) skillPath = decodeURIComponent(match[4])
    } catch { continue }
    if (!id.trim() || /[\u0000-\u001f\u007f]/.test(id)) continue
    if (skillPath && (match[2] !== 'skill' || /[\u0000-\u001f\u007f]/.test(skillPath))) continue
    const value = match[0]!
    tokens.push({ kind: match[2] as ResourceReferenceKind, name: match[1]!.replace(/\\([\\\[\]])/g, '$1'), id, value,
      ...(skillPath ? { skillPath } : {}),
      range: { start: match.index, end: match.index + value.length } })
  }
  CONVERSATION_LINK_RE.lastIndex = 0
  for (const match of source.matchAll(CONVERSATION_LINK_RE)) {
    const value = match[0]!
    tokens.push({
      kind: 'conversation',
      name: match[1]!,
      value,
      range: { start: match.index, end: match.index + value.length },
      id: match[2]!,
    })
  }
  BROWSER_TAB_LINK_RE.lastIndex = 0
  for (const match of source.matchAll(BROWSER_TAB_LINK_RE)) {
    const row = parseBrowserTabMention(match[2]!)
    if (!row) continue
    const value = match[0]!
    tokens.push({
      kind: 'browser-tab',
      name: plainBrowserTabLinkTitle(match[1]!) || row.url,
      value,
      range: { start: match.index, end: match.index + value.length },
      id: row.mention,
      browserTab: row,
    })
  }
  return tokens.sort((left, right) => left.range.start - right.range.start)
}
