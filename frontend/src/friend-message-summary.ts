// Deterministic summary of a long incoming friend message. A friend task's
// prose can run to thousands of characters; rendering it verbatim in a task
// row or a chat bubble pushes every control off screen. The summary is a
// projection only — the full text always stays reachable (inline expand and
// the reader overlay), and approval surfaces keep showing everything.
//
// Pure logic: no DOM, no i18n. Presentation composes these fields with
// localized labels.

import { renderMarkdownHtml } from './chat/markdown'
const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

export const FRIEND_MESSAGE_COLLAPSE_MIN_LINES = 12
export const FRIEND_MESSAGE_COLLAPSE_MIN_CHARS = 800

const LEAD_MAX_CHARS = 160
const ASK_MAX_ITEMS = 4
const ASK_MAX_CHARS = 120
const FILE_MAX_ITEMS = 3

export interface FriendMessageSummary {
  /** True when the message is long enough to deserve a collapsed surface. */
  collapsed: boolean
  /** First meaningful line, trimmed to a readable length. */
  lead: string
  /** Non-empty line count, for the size meta line. */
  lines: number
  /** Character count, for the size meta line. */
  chars: number
  /** Lines that read as requests: bullets, numbered items, questions. */
  asks: string[]
  /** Path-like tokens mentioned in the text, de-duplicated. */
  files: string[]
  /** Fenced code block count. */
  codeBlocks: number
  /** True when the text carries a unified diff (diff --git / @@ hunks). */
  hasDiff: boolean
}

function countLines(value: string): number {
  return value.split(/\r\n|\r|\n/).filter(line => line.trim()).length
}

function trimLead(line: string): string {
  const clean = line.trim()
  if (clean.length <= LEAD_MAX_CHARS) return clean
  const cut = clean.slice(0, LEAD_MAX_CHARS)
  const boundary = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('　'))
  return (boundary > LEAD_MAX_CHARS / 2 ? cut.slice(0, boundary) : cut).trimEnd() + '…'
}

const ASK_LINE_RE = /^\s*(?:[-*•▪]\s+|\d+[.)、]\s*|\d+\s+(?=\S))/
const PATH_TOKEN_RE = /(?:^|[\s(`"'])((?:~|\/|\.{1,2}\/)[^\s`)"'|;,]+(?:\/[^\s`)"'|;,]+)+)/g
// Unified-diff headers name the touched files with an a/ b/ prefix; those are
// the chips a code-review message most needs, so they are read from the
// headers directly instead of through the generic path scan.
const DIFF_PATH_RE = /^(?:diff --git a\/\S+ b\/|\+\+\+ b\/|--- a\/)(\S+)/

export function summarizeFriendMessage(text: unknown): FriendMessageSummary {
  const value = String(text || '')
  const lines = countLines(value)
  const chars = value.trim().length
  const collapsed = lines > FRIEND_MESSAGE_COLLAPSE_MIN_LINES || chars > FRIEND_MESSAGE_COLLAPSE_MIN_CHARS
  const allLines = value.split(/\r\n|\r|\n/)
  const nonEmpty = allLines.map(line => line.trim()).filter(Boolean)
  const lead = nonEmpty.length ? trimLead(nonEmpty[0]) : ''
  const asks: string[] = []
  for (const line of nonEmpty) {
    if (asks.length >= ASK_MAX_ITEMS) break
    const bulleted = ASK_LINE_RE.test(line)
    const question = /[?？]\s*$/.test(line)
    if (!bulleted && !question) continue
    const body = line.replace(ASK_LINE_RE, '').trim()
    if (!body) continue
    asks.push(body.length > ASK_MAX_CHARS ? body.slice(0, ASK_MAX_CHARS).trimEnd() + '…' : body)
  }
  const files: string[] = []
  const addFile = (token: string) => {
    if (!files.includes(token)) files.push(token)
  }
  for (const line of allLines) {
    const diffPath = DIFF_PATH_RE.exec(line.trim())
    if (diffPath) addFile(diffPath[1])
    if (files.length >= FILE_MAX_ITEMS) break
  }
  if (files.length < FILE_MAX_ITEMS) {
    for (const match of value.matchAll(PATH_TOKEN_RE)) {
      addFile(match[1])
      if (files.length >= FILE_MAX_ITEMS) break
    }
  }
  const fenceLines = allLines.filter(line => line.trim().startsWith('```')).length
  const codeBlocks = Math.floor(fenceLines / 2)
  const hasDiff = /(^|\n)(diff --git |@@ -\d+)/.test(value)
  return { collapsed, lead, lines, chars, asks, files, codeBlocks, hasDiff }
}

/** Shared by transcript cards and task pages; the original text remains available to the reader. */
export function renderFriendMessageHtml(text: string, t: (key: string) => string, sessionId = '', options: { copy?: boolean } = {}): string {
  const summary = summarizeFriendMessage(text)
  const markdown = `<div class="md friend-msg-full"${summary.collapsed ? ' hidden' : ''}>${renderMarkdownHtml(text, sessionId)}</div>`
  if (!summary.collapsed) return markdown
  const meta = t('friend_message_meta').replace('{chars}', String(summary.chars)).replace('{lines}', String(summary.lines))
  const buttonClass = options.copy ? 'friend-msg-btn kls-btn kls-btn-secondary' : 'friend-msg-btn'
  return `<div class="friend-msg-collapsed" data-friend-message="collapsed" data-friend-message-text="${escapeHtml(text)}"><div class="friend-msg-preview md">${renderMarkdownHtml(summary.lead, sessionId)}</div><div class="friend-msg-foot"><span class="friend-msg-meta">${escapeHtml(meta)}</span><button type="button" class="${buttonClass}" data-friend-msg-action="expand" aria-expanded="false">${escapeHtml(t('friend_message_expand'))}</button><button type="button" class="${buttonClass}" data-friend-msg-action="reader">${escapeHtml(t('friend_message_open_reader'))}</button>${options.copy ? `<button type="button" class="${buttonClass}" data-friend-msg-action="copy">${escapeHtml(t('friend_message_copy'))}</button>` : ''}</div>${markdown}</div>`
}
