import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'
import { I18N } from '../../i18n/messages'
import { PRIMARY_RAIL_WIDTH, computeWorkspaceWidth } from '../panel-layout'
import {
  classifySessionModuleOwner,
  pickLatestUnreadModuleSession,
  decidePrimaryRailClick,
  extensionButtonIdForView,
  isExtensionSubView,
  railSectionTitleKey,
  resolvePrimaryRailSection,
  type PrimaryRailSection,
} from './rail-navigation'
import {
  CHANNEL_ROWS,
  formatCronSessionTitle,
  isModuleGroupOpen,
  reconcileModuleExpansionOnSessions,
  toggleModuleGroupExpansion,
  parseMemoryIndexMarkdown,
  stripChannelTitlePrefix,
} from './secondary-module-panes'

describe('two-level primary rail navigation', () => {
  test('resolves the active rail section from settings, non-chat views, and channel/friend/cron sessions', () => {
    expect(resolvePrimaryRailSection(null, false)).toBe('chats')
    expect(resolvePrimaryRailSection(null, false, true)).toBe('channels')
    expect(resolvePrimaryRailSection(null, false, 'channels')).toBe('channels')
    expect(resolvePrimaryRailSection(null, false, 'friends')).toBe('friends')
    expect(resolvePrimaryRailSection(null, false, 'cron')).toBe('cron')
    expect(resolvePrimaryRailSection('profile', false)).toBe('chats')
    expect(resolvePrimaryRailSection(null, true, true)).toBe('settings')
    expect(resolvePrimaryRailSection(null, true, 'friends')).toBe('settings')
    expect(resolvePrimaryRailSection(null, true, 'cron')).toBe('settings')
    expect(resolvePrimaryRailSection('cron', true)).toBe('settings')
    expect(resolvePrimaryRailSection('mcp', false)).toBe('extensions')
    expect(resolvePrimaryRailSection('skills', false)).toBe('extensions')
    expect(resolvePrimaryRailSection('plugins', false)).toBe('extensions')
    expect(resolvePrimaryRailSection('slashCommands', false)).toBe('extensions')
    expect(resolvePrimaryRailSection('agents', false)).toBe('extensions')
    expect(resolvePrimaryRailSection('cron', false)).toBe('cron')
    expect(resolvePrimaryRailSection('channels', false)).toBe('channels')
    expect(resolvePrimaryRailSection('memory', false)).toBe('memory')
    expect(resolvePrimaryRailSection('teamCollaboration', false)).toBe('teamCollaboration')
    expect(resolvePrimaryRailSection('friends', false)).toBe('friends')
  })

  test('classifies native and metadata-backed module sessions', () => {
    expect(classifySessionModuleOwner(null)).toBe('chats')
    expect(classifySessionModuleOwner({ friendGroupId: 'f' }, true)).toBe('channels')
    expect(classifySessionModuleOwner({ friendGroupId: 'f', automation: { taskId: 'a' } })).toBe('friends')
    expect(classifySessionModuleOwner({ host_metadata: { friendTask: {} } })).toBe('friends')
    expect(classifySessionModuleOwner({ hostMetadata: { automation: {} } })).toBe('cron')
    expect(classifySessionModuleOwner({ threadSource: 'automation' })).toBe('cron')
  })

  test('picks the latest unread candidate without mutating the input', () => {
    const old = { id: 'old', updatedAt: 1 }
    const latest = { id: 'new', updatedAt: 2 }
    const candidates = [old, latest]
    expect(pickLatestUnreadModuleSession(candidates)).toBe(latest)
    expect(pickLatestUnreadModuleSession(candidates, latest.id)).toBe(old)
    expect(pickLatestUnreadModuleSession([])).toBeNull()
    expect(candidates).toEqual([old, latest])
  })

  test('rail clicks activate inactive sections and only jump to unread in the active section', () => {
    const unreadCandidates = [{ id: 'old', updatedAt: 1 }, { id: 'new', updatedAt: 2 }]
    for (const clicked of ['chats', 'channels', 'cron', 'friends', 'settings', 'memory', 'extensions', 'teamCollaboration'] as const) {
      for (const sidebarCollapsed of [true, false]) {
        const base = { clicked, sidebarCollapsed }
        const result = { nextCollapsed: false, targetSection: clicked }
        const currentSection = clicked === 'settings' ? 'chats' : 'settings'
        expect(decidePrimaryRailClick({ ...base, currentSection, unreadCandidates }))
          .toEqual({ ...result, kind: 'activate-section', unreadSessionId: null })
        expect(decidePrimaryRailClick({ ...base, currentSection: clicked, unreadCandidates }))
          .toEqual({ ...result, kind: 'jump-unread', unreadSessionId: 'new' })
        expect(decidePrimaryRailClick({ ...base, currentSection: clicked, unreadCandidates, openChatSessionId: 'new' }))
          .toEqual({ ...result, kind: 'jump-unread', unreadSessionId: 'old' })
        expect(decidePrimaryRailClick({ ...base, currentSection: clicked, unreadCandidates: [] }))
          .toEqual({ ...result, kind: 'noop', unreadSessionId: null })
      }
    }
  })

  test('maps extension subviews to their sub-navigation button ids', () => {
    expect(isExtensionSubView('slashCommands')).toBe(true)
    expect(isExtensionSubView('cron')).toBe(false)
    expect(extensionButtonIdForView('slashCommands')).toBe('btn-slash-commands')
    expect(extensionButtonIdForView('mcp')).toBe('btn-mcp')
  })

  test('workspace width accounts for the 48px primary rail when the secondary pane is collapsed', () => {
    expect(PRIMARY_RAIL_WIDTH).toBe(48)
    expect(computeWorkspaceWidth(1280, true, 300, PRIMARY_RAIL_WIDTH)).toBe(980)
    expect(computeWorkspaceWidth(1280, false, 300, PRIMARY_RAIL_WIDTH)).toBe(1232)
  })

  test('maps every rail section to a translated topbar title key in both locales', () => {
    const sections: PrimaryRailSection[] = [
      'chats',
      'extensions',
      'cron',
      'channels',
      'memory',
      'teamCollaboration',
      'friends',
      'settings',
    ]
    for (const section of sections) {
      const key = railSectionTitleKey(section)
      expect(I18N.en[key]).toBeTruthy()
      expect(I18N.zh[key]).toBeTruthy()
    }
    expect(I18N.zh[railSectionTitleKey('chats')]).toBe('会话')
  })

  test('every channel row icon in the secondary pane resolves to an existing asset in frontend/public', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const publicDir = resolve(here, '../../../public')
    expect(CHANNEL_ROWS.length).toBe(8)
    for (const row of CHANNEL_ROWS) {
      expect(existsSync(resolve(publicDir, row.icon))).toBe(true)
    }
  })

  test('every literal translation key used in secondary-module-panes exists in both locales', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(here, './secondary-module-panes.tsx'), 'utf8')
    const literalKeys = Array.from(src.matchAll(/\bt\(\s*'([a-z0-9_]+)'\s*\)/g), match => match[1])
    expect(literalKeys.length).toBeGreaterThan(10)
    for (const key of literalKeys) {
      expect(I18N.en[key]).toBeTruthy()
      expect(I18N.zh[key]).toBeTruthy()
    }
  })

  test('every Icon name used in secondary-module-panes is registered in icons/library.ts', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(here, './secondary-module-panes.tsx'), 'utf8')
    const libSrc = readFileSync(resolve(here, '../../icons/library.ts'), 'utf8')
    const iconNames = Array.from(src.matchAll(/<Icon\s+name="([^"]+)"/g), match => match[1])
    expect(iconNames.length).toBeGreaterThan(5)
    for (const iconName of iconNames) {
      expect(libSrc).toContain(`'${iconName}':`)
    }
  })

  test('parses MEMORY.md index bullets and ignores traversal paths', () => {
    const md = [
      '# Project Memory',
      '- [Architecture Map](architecture-map.md) — module boundaries',
      '- [Sidebar Notes](./sidebar-notes.md) - layout details',
      '- [Unsafe](../secret.md) — ignored',
    ].join('\n')
    expect(parseMemoryIndexMarkdown(md, 'agent-memory')).toEqual([
      { path: 'agent-memory/architecture-map.md', title: 'Architecture Map', hook: 'module boundaries' },
      { path: 'agent-memory/sidebar-notes.md', title: 'Sidebar Notes', hook: 'layout details' },
    ])
  })

  test('strips redundant channel label prefix from channel conversation titles', () => {
    expect(stripChannelTitlePrefix('Feishu / Lark · 产品研发周报群', 'Feishu / Lark')).toBe('产品研发周报群')
    expect(stripChannelTitlePrefix('日常研发同步', 'WeChat')).toBe('日常研发同步')
  })

  test('formats scheduled-task conversation titles cleanly without repeating the task name', () => {
    const sampleTs = new Date(2026, 10, 22, 9, 5, 0).getTime()
    expect(formatCronSessionTitle('每日构建与门禁巡检', '每日构建与门禁巡检', sampleTs)).toBe('11-22 09:05')
    expect(formatCronSessionTitle('每日构建与门禁巡检 · 门禁全绿（耗时 2m14s）', '每日构建与门禁巡检', sampleTs)).toBe('门禁全绿（耗时 2m14s）')
    expect(formatCronSessionTitle('修复类型检查告警', '每日构建与门禁巡检', sampleTs)).toBe('修复类型检查告警')
  })

  test('index.html mounts the topbar section title and omits duplicate settings from user-menu', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const html = readFileSync(resolve(here, '../../../index.html'), 'utf8')
    expect(html).toContain('id="sidebar-top-title"')
    expect(html).not.toContain('id="menu-settings"')
    for (const module of ['chats', 'channels', 'cron', 'friends']) {
      const badge = html.match(new RegExp(`<span\\b[^>]*id="rail-${module}-badge"[^>]*>`))?.[0]
      expect(badge).toContain('primary-rail-badge')
      expect(badge).toContain('hidden')
      expect(badge).not.toMatch(/(?:title|data-klaus-tip)=/)
    }
  })

  test('scheduled-task and friend group rows omit redundant subtitles, count pills, and detail run history', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const panesSrc = readFileSync(resolve(here, './secondary-module-panes.tsx'), 'utf8')
    const cronSection = panesSrc.slice(panesSrc.indexOf('function CronSecondaryPane'), panesSrc.indexOf('function ChannelsSecondaryPane'))
    expect(cronSection).not.toContain('humanizeSchedule')
    expect(cronSection).not.toContain('styles.rowMeta')
    expect(cronSection).not.toContain('styles.countBadge')

    const friendsSection = panesSrc.slice(panesSrc.indexOf('function FriendsSecondaryPane'), panesSrc.indexOf('function SecondaryModulePanes'))
    const friendsScroll = friendsSection.slice(friendsSection.indexOf('<div className={styles.scroll}>'))
    expect(friendsScroll).not.toContain('styles.countBadge')

    const cronPageSrc = readFileSync(resolve(here, '../../pages/cron/CronPage.tsx'), 'utf8')
    expect(cronPageSrc).not.toContain('cron-detail-runs')
    expect(cronPageSrc).not.toContain('cron_previous_runs')

    const channelsSection = panesSrc.slice(panesSrc.indexOf('function ChannelsSecondaryPane'), panesSrc.indexOf('function MemorySecondaryPane'))
    expect(channelsSection).not.toContain('styles.dotOk')
    expect(channelsSection).not.toContain('{channelSessions.length}')
    expect(channelsSection).toContain('formatChannelUnreadBadge(sumChannelUnreadCount(channelSessions))')
  })

  test('win32 and darwin fullscreen titlebar controls align with the 48px primary rail', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const css = readFileSync(resolve(here, '../../../css/styles.css'), 'utf8')
    const rule = (selector: string): string => {
      const start = css.indexOf(selector)
      expect(start).toBeGreaterThanOrEqual(0)
      const end = css.indexOf('}', start)
      expect(end).toBeGreaterThan(start)
      return css.slice(start, end)
    }

    const controls = rule('.platform-win32 .app-titlebar-controls,\n.platform-darwin.window-fullscreen .app-titlebar-controls {')
    expect(controls).toContain('padding-left: calc((var(--primary-rail-width) - 28px) / 2);')

    const topTitle = rule('.platform-win32 .sidebar-top-title,\n.platform-darwin.window-fullscreen .sidebar-top-title {')
    expect(topTitle).toContain('margin-left: calc((var(--primary-rail-width) - 28px) / 2 + var(--sidebar-gutter));')

    const collapsedSearch = rule('.platform-win32 body.sidebar-collapsed .titlebar-search-btn,\n.platform-darwin.window-fullscreen body.sidebar-collapsed .titlebar-search-btn {')
    expect(collapsedSearch).toContain('left: calc(var(--primary-rail-width) + var(--sidebar-gutter));')

    const collapsedTitle = rule('.platform-win32 body.sidebar-collapsed .titlebar-session-title,\n.platform-darwin.window-fullscreen body.sidebar-collapsed .titlebar-session-title {')
    expect(collapsedTitle).toContain('left: calc(var(--primary-rail-width) + var(--sidebar-gutter) + 40px);')

    // Regression guard: prevent pre-rail offsets from returning or an unscoped
    // .window-fullscreen rule from overriding .platform-win32 on Windows F11.
    expect(css).not.toContain('.platform-win32 body.sidebar-collapsed .titlebar-search-btn {\n  left: 34px;')
    expect(css).not.toContain('.window-fullscreen body.sidebar-collapsed .titlebar-search-btn {\n  left: 48px;')
  })
})


describe('secondary module group expansion', () => {
  test('opens populated groups by default and only opens the designated empty group', () => {
    expect(isModuleGroupOpen({}, 'task-a', true)).toBe(true)
    expect(isModuleGroupOpen({ 'task-a': true }, 'task-a', false)).toBe(false)
    expect(isModuleGroupOpen({ 'task-a': false }, 'task-a', false, 'task-a')).toBe(true)
    expect(isModuleGroupOpen({}, 'task-a', false, 'task-b')).toBe(false)
  })

  test('toggles task and removed-task groups independently', () => {
    const removed = '__removed_cron_tasks__'
    const first = toggleModuleGroupExpansion({}, 'task-a')
    const both = toggleModuleGroupExpansion(first, removed)
    expect(both).toEqual({ 'task-a': false, [removed]: false })
    expect(toggleModuleGroupExpansion(both, 'task-a')).toEqual({ 'task-a': true, [removed]: false })
  })

  test('preserves folds unless navigation enters a session owned by that group', () => {
    const expansion = { 'task-a': false, '__removed_cron_tasks__': false }
    let state = reconcileModuleExpansionOnSessions({ expansion, lastActiveChatId: undefined }, 'session-a', 'task-a')
    expect(state).toEqual({ expansion, lastActiveChatId: 'session-a' })
    state = reconcileModuleExpansionOnSessions(state, 'session-a', 'task-a')
    expect(state.expansion).toBe(expansion)
    state = reconcileModuleExpansionOnSessions(state, null, undefined)
    expect(state).toEqual({ expansion, lastActiveChatId: null })
    state = reconcileModuleExpansionOnSessions(state, 'session-b', 'task-b')
    expect(state.expansion).toBe(expansion)
    state = reconcileModuleExpansionOnSessions(state, 'session-a', 'task-a')
    expect(state.expansion).toEqual({ 'task-a': true, '__removed_cron_tasks__': false })
  })
})

test('extracts multiple memory links with their shared note and rejects invalid entries', () => {
  expect(parseMemoryIndexMarkdown([
    '* [A](a.md#first)、[B](./b.md) — Shared note',
    '- [Duplicate](a.md) [Index](MEMORY.md) [Remote](https://example.org/c.md)',
  ].join('\n'), 'agent-memory')).toEqual([
    { path: 'agent-memory/a.md', title: 'A', hook: 'Shared note' },
    { path: 'agent-memory/b.md', title: 'B', hook: 'Shared note' },
  ])
})
