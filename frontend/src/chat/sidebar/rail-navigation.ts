// Pure navigation state helpers for the two-level left sidebar:
// level 1 (#primary-rail) selects the active module or toggles the level-2
// contextual pane (#sidebar-secondary) when clicking the already-active module.

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
  kind: 'toggle-collapse' | 'activate-section'
  nextCollapsed: boolean
  targetSection: PrimaryRailSection
}

export function decidePrimaryRailClick(input: {
  clicked: PrimaryRailSection
  currentSection: PrimaryRailSection
  sidebarCollapsed: boolean
}): PrimaryRailClickDecision {
  if (input.clicked === input.currentSection) {
    return {
      kind: 'toggle-collapse',
      nextCollapsed: !input.sidebarCollapsed,
      targetSection: input.currentSection,
    }
  }
  return {
    kind: 'activate-section',
    nextCollapsed: false,
    targetSection: input.clicked,
  }
}
