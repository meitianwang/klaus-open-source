import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'bun:test'
import { I18N } from '../../i18n/messages'
import { PRIMARY_RAIL_WIDTH, computeWorkspaceWidth } from '../panel-layout'
import {
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

  test('clicking the active rail icon toggles secondary-pane collapse, while switching modules expands it', () => {
    expect(decidePrimaryRailClick({
      clicked: 'chats',
      currentSection: 'chats',
      sidebarCollapsed: false,
    })).toEqual({
      kind: 'toggle-collapse',
      nextCollapsed: true,
      targetSection: 'chats',
    })

    expect(decidePrimaryRailClick({
      clicked: 'chats',
      currentSection: 'chats',
      sidebarCollapsed: true,
    })).toEqual({
      kind: 'toggle-collapse',
      nextCollapsed: false,
      targetSection: 'chats',
    })

    expect(decidePrimaryRailClick({
      clicked: 'settings',
      currentSection: 'chats',
      sidebarCollapsed: true,
    })).toEqual({
      kind: 'activate-section',
      nextCollapsed: false,
      targetSection: 'settings',
    })
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
  })
})
