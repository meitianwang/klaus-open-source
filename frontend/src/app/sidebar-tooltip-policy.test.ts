import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const readFrontendFile = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')

const INDEX_HTML = readFrontendFile('index.html')
const TOOLTIP_TS = readFrontendFile('src/app/tooltip.ts')
const RAIL_TOOLTIP_IDS = [
  'monitor-panel-toggle',
  'workspace-panel-toggle',
  'browser-panel-toggle',
  'btn-diff',
  'terminal-toggle',
]
const PRIMARY_RAIL_TOOLTIP_IDS = [
  'btn-rail-chats',
  'btn-team-collaboration',
  'btn-extensions',
  'btn-channels',
  'btn-cron',
  'btn-memory',
  'btn-friends',
  'sidebar-user-usage',
  'btn-rail-settings',
  'sidebar-user-settings',
]
const DYNAMIC_SOURCES = [
  'src/chat/sidebar/session-list.tsx',
  'src/chat/sidebar/secondary-module-panes.tsx',
  'src/chat/overview/plan.ts',
  'src/chat/overview/subagents.ts',
  'src/chat/overview/background-processes.ts',
  'src/chat/overview/artifacts.ts',
  'src/chat/overview/context-refs.ts',
  'src/chat/panels/panel-tabs.tsx',
  'src/chat/background-process-monitor.ts',
  'src/chat/panels/side-tasks.ts',
  'src/chat/terminal.ts',
  'src/chat/workspace-panel.ts',
  'src/chat/workspace-office-viewer.ts',
  'src/chat/markdown-toc.ts',
  'src/chat/spec-document-panel.ts',
]

function section(start: string, end: string): string {
  const from = INDEX_HTML.indexOf(start)
  const to = INDEX_HTML.indexOf(end, from)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return INDEX_HTML.slice(from, to)
}

describe('sidebar tooltip policy', () => {
  test('sidebar surfaces opt out except for the fixed icon-only rail entries', () => {
    const sideRailMarkup = section('<div id="side-rail"', '<!-- Sidebar -->')
    const sideRailWithoutOptIns = sideRailMarkup.replace(
      /<button(?=[^>]*data-klaus-tooltips="on")[^>]*>/g,
      '<button>',
    )
    const sidebarMarkup = section('<div id="sidebar"', '<!-- Sidebar width is fixed')
    const primaryRailMarkup = section('<nav id="primary-rail"', '<!-- Level-2 contextual sidebar pane')
    const primaryRailWithoutOptIns = primaryRailMarkup
      .replace(/<nav[^>]*>/, '<nav>')
      .replace(/<button(?=[^>]*data-klaus-tooltips="on")[^>]*>/g, '<button>')
    const sidebarWithoutPrimaryOptIns = sidebarMarkup.replace(primaryRailMarkup, primaryRailWithoutOptIns)
    const protectedMarkup = [
      sideRailWithoutOptIns,
      sidebarWithoutPrimaryOptIns,
      section('<aside id="artifacts-panel"', '<!-- Artifact preview'),
    ].join('\n')

    expect(protectedMarkup.match(/data-klaus-tooltips="off"/g)?.length).toBe(3)
    expect(protectedMarkup.match(/\s(?:title|data-i18n-title|data-klaus-tip(?:-placement)?)=/g) || []).toEqual([])
    for (const id of RAIL_TOOLTIP_IDS) {
      const tag = sideRailMarkup.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0] || ''
      expect(tag).toContain('data-klaus-tooltips="on"')
      expect(tag).toContain('data-klaus-tip-placement="left"')
      expect(tag).toContain('data-i18n-title=')
      expect(tag).toContain('title=')
    }
    for (const id of PRIMARY_RAIL_TOOLTIP_IDS) {
      const tag = primaryRailMarkup.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0] || ''
      expect(tag).toContain('data-klaus-tooltips="on"')
      expect(tag).toContain('data-klaus-tip-placement="right"')
      expect(tag).toContain('data-i18n-title=')
      expect(tag).toContain('title=')
      expect(tag).toContain('aria-label=')
    }
    expect(sideRailMarkup.match(/data-klaus-tooltips="on"/g)?.length).toBe(RAIL_TOOLTIP_IDS.length)
    expect(primaryRailMarkup.match(/data-klaus-tooltips="on"/g)?.length).toBe(PRIMARY_RAIL_TOOLTIP_IDS.length)
    expect(sideRailMarkup.indexOf('id="monitor-panel-toggle"')).toBeLessThan(sideRailMarkup.indexOf('id="side-task-new"'))
    expect(INDEX_HTML).toContain('id="sidebar-toggle" data-i18n-aria-label="toggle_sidebar" aria-label="Toggle sidebar"')
    expect(INDEX_HTML).toContain('id="artifacts-panel-toggle" class="artifacts-toggle-btn" data-i18n-aria-label="artifacts_toggle" aria-label="Toggle artifacts panel"')
  })

  test('dynamic content added to a tooltip-free surface is scrubbed', () => {
    expect(TOOLTIP_TS).toContain("const TOOLTIP_FREE_ZONE_SELECTOR = '[data-klaus-tooltips=\"off\"]'")
    expect(TOOLTIP_TS).toContain("const TOOLTIP_OPT_IN_SELECTOR = '#side-rail > [data-klaus-tooltips=\"on\"], #primary-rail [data-klaus-tooltips=\"on\"], #sidebar [data-session-action][data-klaus-tooltips=\"on\"]'")
    expect(TOOLTIP_TS).toContain('if (el.closest(TOOLTIP_OPT_IN_SELECTOR)) continue')
    expect(TOOLTIP_TS).toContain("attributeFilter: ['title', 'data-klaus-tip']")
    expect(TOOLTIP_TS).toContain("el.removeAttribute('title')")
    expect(TOOLTIP_TS).toContain('delete el.dataset.klausTip')
  })

  test('sidebar renderers do not author tooltip attributes outside session-row inline icon actions', () => {
    const violations: string[] = []
    for (const source of DYNAMIC_SOURCES) {
      const text = readFrontendFile(source)
      for (const [index, line] of text.split('\n').entries()) {
        const trimmed = line.trim()
        const allowedRowActionTip = source === 'src/chat/sidebar/session-list.tsx'
          && (trimmed === 'data-klaus-tip={pinLabel}' || trimmed === 'data-klaus-tip={archiveLabel}' || trimmed === 'data-klaus-tip-placement="top"')
        if (allowedRowActionTip) continue
        const authoredAttribute = /\stitle=(?:["']|\{)/.test(line) && !line.includes('title={sidebarLabel(')
        const domSetter = /setAttribute\(\s*['"]title['"]/.test(line)
        const dataTip = /data-i18n-title|data-klaus-tip|dataset\.klausTip/.test(line)
        const propertyOwner = line.match(/\b([A-Za-z_$][\w$]*)\.title\s*=/)?.[1]
        const domProperty = !!propertyOwner && propertyOwner !== 'tab' && propertyOwner !== 'current'
        if (authoredAttribute || domSetter || dataTip || domProperty) {
          violations.push(`${source}:${index + 1}: ${trimmed}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
