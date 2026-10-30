import type { SessionInfo } from '../engine-events'

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
  return !value || value === 'New Chat' || value === 'Chat' || value === '新对话'
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
