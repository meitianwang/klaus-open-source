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
const DYNAMIC_SOURCES = [
  'src/chat/sidebar/session-list.tsx',
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
]

function section(start: string, end: string): string {
  const from = INDEX_HTML.indexOf(start)
  const to = INDEX_HTML.indexOf(end, from)
  expect(from).toBeGreaterThanOrEqual(0)
  expect(to).toBeGreaterThan(from)
  return INDEX_HTML.slice(from, to)
}

describe('sidebar tooltip policy', () => {
  test('sidebar surfaces opt out except for the five fixed side-rail entries', () => {
    const sideRailMarkup = section('<div id="side-rail"', '<!-- Sidebar -->')
    const sideRailWithoutOptIns = sideRailMarkup.replace(
      /<button(?=[^>]*data-klaus-tooltips="on")[^>]*>/g,
      '<button>',
    )
    const protectedMarkup = [
      sideRailWithoutOptIns,
      section('<div id="sidebar"', '<!-- Sidebar width is fixed'),
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
    expect(sideRailMarkup.match(/data-klaus-tooltips="on"/g)?.length).toBe(RAIL_TOOLTIP_IDS.length)
    expect(sideRailMarkup.indexOf('id="monitor-panel-toggle"')).toBeLessThan(sideRailMarkup.indexOf('id="side-task-new"'))
    expect(INDEX_HTML).toContain('id="sidebar-toggle" data-i18n-aria-label="toggle_sidebar" aria-label="Toggle sidebar"')
    expect(INDEX_HTML).toContain('id="artifacts-panel-toggle" class="artifacts-toggle-btn" data-i18n-aria-label="artifacts_toggle" aria-label="Toggle artifacts panel"')
  })

  test('dynamic content added to a tooltip-free surface is scrubbed', () => {
    expect(TOOLTIP_TS).toContain("const TOOLTIP_FREE_ZONE_SELECTOR = '[data-klaus-tooltips=\"off\"]'")
    expect(TOOLTIP_TS).toContain("const TOOLTIP_OPT_IN_SELECTOR = '#side-rail > [data-klaus-tooltips=\"on\"]'")
    expect(TOOLTIP_TS).toContain('if (el.closest(TOOLTIP_OPT_IN_SELECTOR)) continue')
    expect(TOOLTIP_TS).toContain("attributeFilter: ['title', 'data-klaus-tip']")
    expect(TOOLTIP_TS).toContain("el.removeAttribute('title')")
    expect(TOOLTIP_TS).toContain('delete el.dataset.klausTip')
  })

  test('sidebar renderers do not author tooltip attributes', () => {
    const violations: string[] = []
    for (const source of DYNAMIC_SOURCES) {
      const text = readFrontendFile(source)
      for (const [index, line] of text.split('\n').entries()) {
        const authoredAttribute = /\stitle=(?:["']|\{)/.test(line) && !line.includes('title={sidebarLabel(')
        const domSetter = /setAttribute\(\s*['"]title['"]/.test(line)
        const dataTip = /data-i18n-title|data-klaus-tip|dataset\.klausTip/.test(line)
        const propertyOwner = line.match(/\b([A-Za-z_$][\w$]*)\.title\s*=/)?.[1]
        const domProperty = !!propertyOwner && propertyOwner !== 'tab' && propertyOwner !== 'current'
        if (authoredAttribute || domSetter || dataTip || domProperty) {
          violations.push(`${source}:${index + 1}: ${line.trim()}`)
        }
      }
    }
    expect(violations).toEqual([])
  })
})
