// Primary rail navigation activates modules without collapsing the secondary sidebar.

export type PrimaryRailSection =
  | 'chats'
  | 'teamCollaboration'
  | 'extensions'
  | 'channels'
  | 'cron'
  | 'memory'
  | 'friends'
  | 'settings'

export type ExtensionSubView = 'mcp' | 'skills' | 'plugins' | 'slashCommands' | 'agents'

export type SessionModuleOwner = 'chats' | 'channels' | 'friends' | 'cron'

export interface SessionOwnerProbe {
  id?: string | null
  threadSource?: string | null
  friendGroupId?: string | null
  automation?: { taskId?: string | null } | null
  hostMetadata?: Record<string, unknown> | null
  host_metadata?: Record<string, unknown> | null
}

export function classifySessionModuleOwner(session: SessionOwnerProbe | null | undefined, isChannel = false): SessionModuleOwner {
  if (isChannel) return 'channels'
  if (!session) return 'chats'
  const meta = session.hostMetadata ?? session.host_metadata
  if (session.friendGroupId || session.threadSource === 'friend' || meta?.threadSource === 'friend'
    || meta?.friendTask || meta?.friend || meta?.friendPeerName) return 'friends'
  if (session.threadSource === 'automation' || session.automation?.taskId
    || meta?.threadSource === 'automation' || meta?.automation) return 'cron'
  return 'chats'
}

export function pickLatestUnreadModuleSession<T extends { id: string; updatedAt?: number }>(
  candidates: readonly T[], openChatSessionId?: string | null,
): T | null {
  const ordered = [...candidates].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0))
  return (openChatSessionId ? ordered.find(item => item.id !== openChatSessionId) : undefined) ?? ordered[0] ?? null
}

const EXTENSION_VIEWS = new Set<string>(['mcp', 'skills', 'plugins', 'slashCommands', 'agents'])

export function isExtensionSubView(view: string | null | undefined): view is ExtensionSubView {
  return typeof view === 'string' && EXTENSION_VIEWS.has(view)
}

export function extensionButtonIdForView(view: ExtensionSubView): string {
  if (view === 'slashCommands') return 'btn-slash-commands'
  return `btn-${view}`
}

export function resolvePrimaryRailSection(
  nonChatView: string | null | undefined,
  settingsOpen: boolean,
  sessionOwner: boolean | SessionModuleOwner = 'chats',
): PrimaryRailSection {
  if (settingsOpen) return 'settings'
  if (isExtensionSubView(nonChatView)) return 'extensions'
  if (
    nonChatView === 'teamCollaboration'
    || nonChatView === 'channels'
    || nonChatView === 'cron'
    || nonChatView === 'memory'
    || nonChatView === 'friends'
  ) {
    return nonChatView
  }
  if (sessionOwner === true || sessionOwner === 'channels') return 'channels'
  if (sessionOwner === 'friends') return 'friends'
  if (sessionOwner === 'cron') return 'cron'
  return 'chats'
}

const RAIL_SECTION_TITLE_KEYS: Record<PrimaryRailSection, string> = {
  chats: 'sidebar_section_chats',
  teamCollaboration: 'tc_nav',
  extensions: 'extensions',
  channels: 'channels',
  cron: 'cron',
  memory: 'memory',
  friends: 'friends',
  settings: 'settings',
}

export function railSectionTitleKey(section: PrimaryRailSection): string {
  return RAIL_SECTION_TITLE_KEYS[section] || 'sidebar_section_chats'
}

export interface PrimaryRailClickDecision {
  kind: 'jump-unread' | 'activate-section' | 'noop'
  nextCollapsed: false
  targetSection: PrimaryRailSection
  unreadSessionId: string | null
}

export function decidePrimaryRailClick<T extends { id: string; updatedAt?: number }>(input: {
  clicked: PrimaryRailSection
  currentSection: PrimaryRailSection
  sidebarCollapsed: boolean
  unreadCandidates?: readonly T[]
  openChatSessionId?: string | null
}): PrimaryRailClickDecision {
  if (input.clicked !== input.currentSection) {
    return {
      kind: 'activate-section',
      nextCollapsed: false,
      targetSection: input.clicked,
      unreadSessionId: null,
    }
  }
  const target = pickLatestUnreadModuleSession(input.unreadCandidates ?? [], input.openChatSessionId)
  return {
    kind: target ? 'jump-unread' : 'noop',
    nextCollapsed: false,
    targetSection: input.clicked,
    unreadSessionId: target?.id ?? null,
  }
}
