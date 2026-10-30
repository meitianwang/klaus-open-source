import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const readFrontendFile = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')

const index = readFrontendFile('index.html')
const styles = readFrontendFile('css/styles.css')
const icons = readFrontendFile('src/icons/library.ts')
const chat = readFrontendFile('src/chat/chat.ts')
const list = readFrontendFile('src/chat/sidebar/session-list.tsx')
const moduleStyles = readFrontendFile('src/chat/sidebar/sidebar.module.css')

// The activity view toggle is an icon-only button on the sidebar
// header row's trailing edge (left of the search entry) and the ordering menu
// is an icon-only action on a section head, revealed on hover. An earlier
// labelled toolbar row between the nav and the list did not survive the
// static-icon mount (the label flex-squeezed to one glyph). The contract below
// pins the icon-only placement.
describe('sidebar header controls (priority threads + sort menu)', () => {
  test('the toolbar row between nav and list is gone', () => {
    expect(index).not.toContain('sidebar-toolbar')
    expect(styles).not.toContain('.sidebar-toolbar')
  })

  test('the activity toggle is an icon-only titlebar button left of search', () => {
    const activity = index.indexOf('id="titlebar-activity"')
    const search = index.indexOf('id="titlebar-search"')
    expect(activity).toBeGreaterThan(0)
    expect(activity).toBeLessThan(search)
    const btnEnd = index.indexOf('</button>', activity)
    const btn = index.slice(activity, btnEnd)
    // Icon-only: no visible label span, aria-label carries the wording.
    expect(btn).not.toContain('sidebar-toolbar-label')
    expect(btn).toContain('data-kls-icon="sidebar-activity"')
    expect(btn).toContain('aria-pressed="false"')
    // Docked against the sidebar band's trailing edge, hidden when collapsed.
    expect(styles).toContain('.titlebar-activity-btn {')
    expect(styles).toContain('left: calc(var(--sidebar-width) - 76px);')
    expect(styles).toContain('body.sidebar-collapsed .titlebar-activity-btn')
    // Both states: attention recolor + pressed background.
    expect(styles).toContain('.titlebar-activity-btn.is-attention')
    expect(styles).toContain(".titlebar-activity-btn[aria-pressed='true']")
  })

  test('the toggle cycles three aria-labels: open, needs attention, turn off', () => {
    expect(chat).toContain("tt('sidebar_activity_view') || 'View activity'")
    expect(chat).toContain("tt('sidebar_activity_needs_attention') || 'View activity, needs attention'")
    expect(chat).toContain("tt('sidebar_activity_turn_off') || 'Turn off activity view'")
  })

  test('the sort entry is a hover-revealed section-head action, not a toolbar button', () => {
    expect(list).toContain("rawIconHtml('sidebar-sort')")
    expect(list).toContain("styles['sidebar-section-action']")
    expect(list).toContain('actions.openSortMenu(e.currentTarget)')
    // React owns the trigger's state attributes from the snapshot.
    expect(list).toContain('aria-expanded={snapshot.sortMenuOpen')
    expect(list).toContain("snapshot.sortMode === 'priority'")
    expect(chat).toContain('sortMenuOpen: sidebarSortMenuOpen')
    // The hover-reveal mechanism already used by the projects add action.
    expect(moduleStyles).toContain('.sidebar-section-head:hover .sidebar-section-action')
  })

  test('the icon entries carry no sizing class of their own', () => {
    // Both buttons are sized by their host surface (.artifacts-toggle-btn svg
    // / .sidebar-section-action svg); a baked class would fight those rules.
    expect(icons).toContain("'sidebar-activity': shell(bellSvg),")
    expect(icons).toContain("'sidebar-sort': shell(arrowsDownUpSvg),")
    expect(icons).not.toContain('sidebar-sort-caret')
  })
})
