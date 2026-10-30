import { FRIEND_ID_PATTERN, friendMentionValue } from '../../../../shared/friends'
import type { BrowserTabMention } from '../../../../shared/browser-tab-mention'
import { scannableReferenceTokens } from '../../../../shared/composer-reference-scan'
import { browserTabReference, normalizeBrowserTabMention } from './browser-tab-reference'

export type ComposerReferenceKind = 'skill' | 'mcp' | 'agent' | 'plugin' | 'device' | 'conversation' | 'browser-tab' | 'friend' | 'file' | 'folder'

export interface ComposerReferenceToken {
  kind: ComposerReferenceKind
  name: string
  value: string
  range: { start: number; end: number }
  source?: 'configured' | 'live' | 'plugin'
  id?: string
  skillPath?: string
  skillPreview?: boolean
  path?: string
  rel?: string
  avatarId?: number
  agentStatus?: string
  browserTab?: BrowserTabMention
}

// Keep this grammar in step with the engine's bare agent-mention contract.
// Namespaced/plugin agents may contain `:`, `@`, `_`, `.`, and `-`.
const CONFIGURED_AGENT_RE = /(^|\s)(@agent-([A-Za-z0-9_:.@-]+))(?=\s|$)/g

function validReference(text: string, value: unknown): ComposerReferenceToken | null {
  if (!value || typeof value !== 'object') return null
  const candidate = value as Partial<ComposerReferenceToken>
  const kind = candidate.kind === 'skill' || candidate.kind === 'mcp' || candidate.kind === 'agent' || candidate.kind === 'plugin' || candidate.kind === 'device' || candidate.kind === 'conversation' || candidate.kind === 'browser-tab' || candidate.kind === 'friend' || candidate.kind === 'file' || candidate.kind === 'folder' ? candidate.kind : null
  const name = typeof candidate.name === 'string' ? candidate.name.trim() : ''
  const tokenValue = typeof candidate.value === 'string' ? candidate.value : ''
  const range = candidate.range
  if (!kind || !name || !tokenValue || !range) return null
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end)) return null
  if (range.start < 0 || range.end <= range.start || range.end > text.length) return null
  if (text.slice(range.start, range.end) !== tokenValue) return null
  if (kind === 'friend' && (typeof candidate.id !== 'string' || !FRIEND_ID_PATTERN.test(candidate.id) || tokenValue !== friendMentionValue(candidate.id))) return null
  const browserTab = kind === 'browser-tab' ? normalizeBrowserTabMention(candidate.browserTab) : null
  if (kind === 'browser-tab' && (!browserTab || browserTabReference(browserTab).value !== tokenValue)) return null
  return {
    kind,
    name: browserTab ? browserTabReference(browserTab).name : name,
    value: tokenValue,
    range: { start: range.start, end: range.end },
    ...(candidate.source ? { source: candidate.source } : {}),
    ...(candidate.id ? { id: candidate.id } : {}),
    ...(kind === 'skill' && typeof candidate.skillPath === 'string' && candidate.skillPath && !/[\u0000-\u001f\u007f]/.test(candidate.skillPath) ? { skillPath: candidate.skillPath } : {}),
    ...(kind === 'skill' && candidate.skillPreview === true ? { skillPreview: true } : {}),
    ...(typeof candidate.path === 'string' && candidate.path && !/[\u0000-\u001f\u007f]/.test(candidate.path) ? { path: candidate.path } : {}),
    ...(typeof candidate.rel === 'string' && candidate.rel && !/[\u0000-\u001f\u007f]/.test(candidate.rel) ? { rel: candidate.rel } : {}),
    ...(Number.isInteger(candidate.avatarId) ? { avatarId: Number(candidate.avatarId) } : {}),
    ...(candidate.agentStatus ? { agentStatus: candidate.agentStatus } : {}),
    ...(browserTab ? { browserTab, id: browserTab.mention } : {}),
  }
}

export function configuredAgentReferences(text: string): ComposerReferenceToken[] {
  const value = String(text || '')
  const references: ComposerReferenceToken[] = []
  CONFIGURED_AGENT_RE.lastIndex = 0
  for (let match = CONFIGURED_AGENT_RE.exec(value); match; match = CONFIGURED_AGENT_RE.exec(value)) {
    const prefixLength = match[1].length
    const start = match.index + prefixLength
    const tokenValue = match[2]
    references.push({
      kind: 'agent',
      name: match[3],
      value: tokenValue,
      range: { start, end: start + tokenValue.length },
      source: 'configured',
    })
  }
  return references
}

/**
 * Typed reference links carry their full identity in the text, so
 * a surface that only has the text — a paste, a restored draft, a sent bubble
 * without display metadata — still restores the chip. Explicit metadata wins
 * where ranges overlap; the sort below keeps the earliest complete token.
 */
function scannableReferences(text: string): ComposerReferenceToken[] {
  return scannableReferenceTokens(text).map(token => ({
    kind: token.kind,
    name: token.name,
    value: token.value,
    range: token.range,
    id: token.id,
    ...(token.skillPath ? { skillPath: token.skillPath } : {}),
    ...(token.browserTab ? { browserTab: token.browserTab } : {}),
    ...(token.kind === 'file' || token.kind === 'folder' ? { rel: token.id, path: token.id } : {}),
  }))
}

export function normalizeComposerReferences(text: string, value: unknown): ComposerReferenceToken[] {
  const source = String(text || '')
  const explicit = Array.isArray(value)
    ? value.map(entry => validReference(source, entry)).filter((entry): entry is ComposerReferenceToken => !!entry)
    : []
  const combined = [...explicit, ...configuredAgentReferences(source), ...scannableReferences(source)]
    .sort((left, right) => left.range.start - right.range.start || right.range.end - left.range.end)
  const normalized: ComposerReferenceToken[] = []
  for (const reference of combined) {
    const previous = normalized[normalized.length - 1]
    if (previous && reference.range.start < previous.range.end) continue
    if (previous && reference.range.start === previous.range.start && reference.range.end === previous.range.end) continue
    normalized.push(reference)
  }
  return normalized
}

function changedRange(previous: string, next: string) {
  if (previous === next) return null
  let prefix = 0
  const shortest = Math.min(previous.length, next.length)
  while (prefix < shortest && previous[prefix] === next[prefix]) prefix++

  let previousSuffix = previous.length - 1
  let nextSuffix = next.length - 1
  while (
    previousSuffix >= prefix &&
    nextSuffix >= prefix &&
    previous[previousSuffix] === next[nextSuffix]
  ) {
    previousSuffix--
    nextSuffix--
  }
  return {
    previousStart: prefix,
    previousEnd: previousSuffix + 1,
    nextEnd: nextSuffix + 1,
  }
}

export function syncComposerReferences(
  previous: string,
  next: string,
  references: ComposerReferenceToken[],
): ComposerReferenceToken[] {
  const change = changedRange(previous, next)
  if (!change) return normalizeComposerReferences(next, references)
  const delta = change.nextEnd - change.previousEnd
  const kept: ComposerReferenceToken[] = []
  for (const reference of references) {
    const valid = validReference(previous, reference)
    if (!valid) continue
    if (change.previousEnd <= valid.range.start) {
      kept.push({
        ...valid,
        range: { start: valid.range.start + delta, end: valid.range.end + delta },
      })
    } else if (change.previousStart >= valid.range.end) {
      kept.push(valid)
    }
  }
  return normalizeComposerReferences(next, kept)
}

export function replaceComposerReferenceRange(
  text: string,
  start: number,
  end: number,
  replacement: string,
  reference: Omit<ComposerReferenceToken, 'value' | 'range'> & { value?: string },
): { text: string; reference: ComposerReferenceToken; caret: number } {
  const safeStart = Math.max(0, Math.min(text.length, start))
  const safeEnd = Math.max(safeStart, Math.min(text.length, end))
  const tokenValue = reference.value || `@${reference.name}`
  const prefix = text.slice(0, safeStart)
  const suffix = text.slice(safeEnd)
  const leading = prefix && !/\s$/.test(prefix) ? ' ' : ''
  const trailing = suffix && !/^\s/.test(suffix) ? ' ' : (suffix ? '' : ' ')
  const inserted = `${leading}${tokenValue}${replacement}${trailing}`
  const rangeStart = safeStart + leading.length
  const rangeEnd = rangeStart + tokenValue.length
  return {
    text: prefix + inserted + suffix,
    reference: {
      ...reference,
      value: tokenValue,
      range: { start: rangeStart, end: rangeEnd },
    },
    caret: rangeEnd + replacement.length + trailing.length + (!trailing && reference.kind === 'plugin' && /^\s/.test(suffix) ? 1 : 0),
  }
}
