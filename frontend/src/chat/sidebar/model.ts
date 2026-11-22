import type { SessionInfo } from '../engine-events'
import { scannableReferenceTokens } from '../../../../shared/composer-reference-scan'

export const SIDEBAR_TITLE_MAX_CHARS = 60
const FRIEND_TOKEN_RE = /@friend-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/giu

export interface SidebarSessionPartitions {
  pinned: SessionInfo[]
  channels: SessionInfo[]
  local: SessionInfo[]
}

export interface EmptySessionLeaveState {
  draftOnly: boolean
  history: readonly unknown[] | null | undefined
  hasContent: boolean
  hasDraft: boolean
  hasPendingFiles: boolean
  /** A turn was admitted for this conversation in this window: never recycle it. */
  hasSubmittedTurn?: boolean
  isChannel: boolean
}

export function isPlaceholderSessionTitle(title: string | null | undefined): boolean {
  const value = String(title || '').trim()
  return !value
    || value === 'New Chat'
    || value === 'New chat'
    || value === 'Chat'
    || value === '新对话'
    || value === '新会话'
}

function collapseReferenceTokens(text: string): string {
  const tokens = scannableReferenceTokens(text).sort((left, right) => left.range.start - right.range.start)
  if (!tokens.length) return text.replace(FRIEND_TOKEN_RE, ' ')
  let out = ''
  let index = 0
  for (const token of tokens) {
    if (token.range.start < index) continue
    out += text.slice(index, token.range.start)
    out += token.name
    index = token.range.end
  }
  out += text.slice(index)
  return out.replace(FRIEND_TOKEN_RE, ' ')
}

function truncateSidebarTitle(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null
  const normalized = collapseReferenceTokens(text).replace(/\s+/gu, ' ').trim()
  if (!normalized || isPlaceholderSessionTitle(normalized)) return null
  const chars = Array.from(normalized)
  return chars.length > SIDEBAR_TITLE_MAX_CHARS
    ? `${chars.slice(0, SIDEBAR_TITLE_MAX_CHARS - 1).join('')}…`
    : normalized
}

export function provisionalSessionTitle(
  text: string | null | undefined,
  attachmentNames?: readonly string[],
): string | null {
  const fromText = truncateSidebarTitle(text)
  if (fromText) return fromText
  if (!attachmentNames?.length) return null
  for (const name of attachmentNames) {
    const fromAttachment = truncateSidebarTitle(name)
    if (fromAttachment) return fromAttachment
  }
  return null
}

export function provisionalTitleForPayload(
  payload: { displayText?: string | null; liveAttachments?: ReadonlyArray<{ name?: string | null }> } | null | undefined,
  fallbackText?: string | null,
): string | null {
  const names = payload?.liveAttachments
    ?.map(item => (typeof item?.name === 'string' ? item.name : ''))
    .filter(Boolean)
  return provisionalSessionTitle(payload?.displayText || fallbackText, names)
}

export function applyProvisionalSessionTitle<T extends Pick<SessionInfo, 'id' | 'title'>>(
  sessions: readonly T[],
  sessionId: string,
  provisionalTitle: string | null | undefined,
): T[] {
  const normalized = truncateSidebarTitle(provisionalTitle)
  if (!sessionId || !normalized) return sessions as T[]
  let changed = false
  const next = sessions.map((session) => {
    if (session.id !== sessionId || !isPlaceholderSessionTitle(session.title)) return session
    if (session.title === normalized) return session
    changed = true
    return { ...session, title: normalized }
  })
  return changed ? next : (sessions as T[])
}

export function shouldDiscardEmptySessionOnLeave(
  session: Pick<SessionInfo, 'title'> | null | undefined,
  state: EmptySessionLeaveState,
): boolean {
  const historyHasRows = Array.isArray(state.history) && state.history.length > 0
  const emptyIsKnown = !historyHasRows
    && (state.draftOnly || (Array.isArray(state.history) && state.history.length === 0))
  return !!session
    && isPlaceholderSessionTitle(session.title)
    && emptyIsKnown
    && !state.hasContent
    && !state.hasDraft
    && !state.hasPendingFiles
    && !state.hasSubmittedTurn
    && !state.isChannel
}

export function isPinnedSession(session: SessionInfo): boolean {
  return Number.isFinite(session.sidebarPinnedAt) && Number(session.sidebarPinnedAt) > 0
}

export function partitionSidebarSessions(
  sessions: SessionInfo[],
  isChannel: (sessionId: string) => boolean,
): SidebarSessionPartitions {
  const pinned = sessions
    .filter(isPinnedSession)
    .sort((left, right) => Number(right.sidebarPinnedAt || 0) - Number(left.sidebarPinnedAt || 0))
  const unpinned = sessions.filter(session => !isPinnedSession(session))
  return {
    pinned,
    channels: unpinned.filter(session => isChannel(session.id)),
    local: unpinned.filter(session => !isChannel(session.id)),
  }
}

/**
 * A conversation-list snapshot can still carry the engine placeholder while the
 * host has already published a seeded or generated title. Keep the visible title
 * until a real title arrives so rows and the titlebar do not blank out between
 * updates.
 */
export function preserveVisibleSessionTitle(
  current: Pick<SessionInfo, 'title'> | undefined,
  incoming: SessionInfo,
): SessionInfo {
  if (!current || isPlaceholderSessionTitle(current.title) || !isPlaceholderSessionTitle(incoming.title)) return incoming
  return { ...incoming, title: current.title }
}

export function mergeSidebarSessionSnapshot(
  current: SessionInfo[],
  incoming: SessionInfo[],
  reorder: boolean = false,
): SessionInfo[] {
  if (current.length === 0 || reorder) return incoming

  const incomingById = new Map(incoming.map(session => [session.id, session]))
  const currentIds = new Set(current.map(session => session.id))
  const added = incoming.filter(session => !currentIds.has(session.id))
  const retained = current.flatMap(session => {
    const fresh = incomingById.get(session.id)
    return fresh ? [{ ...fresh, updatedAt: session.updatedAt }] : []
  })
  return [...added, ...retained]
}

export function automationSourceLabel(
  session: SessionInfo,
  scheduledLabel: string,
): string | null {
  if (session.threadSource !== 'automation') return null
  const taskName = String(session.automation?.taskName || '').trim()
  return taskName ? `${scheduledLabel} · ${taskName}` : scheduledLabel
}

export function sessionTitleForCurrentSession(
  currentSessionId: string | null | undefined,
  session: Pick<SessionInfo, 'id' | 'title' | 'forkedFrom'> | null | undefined,
): string {
  if (!currentSessionId || session?.id !== currentSessionId) return ''
  const title = String(session.title || '').trim()
  if (isPlaceholderSessionTitle(title)) return ''
  return session.forkedFrom ? title.replace(/\s*·\s*Branch$/i, '') : title
}
