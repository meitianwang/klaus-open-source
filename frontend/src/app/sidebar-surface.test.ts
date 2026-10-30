import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const STYLES_CSS = readFileSync(
  fileURLToPath(new URL('../../css/styles.css', import.meta.url)),
  'utf8',
)

function cssBlock(selector: string): string {
  const start = STYLES_CSS.indexOf(selector)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = STYLES_CSS.indexOf('\n}', start)
  expect(end).toBeGreaterThan(start)
  return STYLES_CSS.slice(start, end)
}

describe('sidebar surface', () => {
  test('uses the theme panel surface instead of exposing the transparent window', () => {
    const sidebar = cssBlock('#sidebar {')
    expect(sidebar).toContain('background: var(--bg-surface);')
    expect(sidebar).not.toContain('background: transparent;')
    expect(STYLES_CSS).not.toContain(':root.app-opaque #sidebar')
  })

  test('continues the chat background through the collapsed right-rail gutter', () => {
    const gutter = cssBlock('body:not(.artifacts-open):not(.settings-open):not(.non-chat-view) #app::after {')
    expect(gutter).toContain('position: absolute;')
    expect(gutter).toContain('inset: 0 0 0 auto;')
    expect(gutter).toContain('width: var(--side-rail-width);')
    expect(gutter).toContain('background: var(--bg);')
    expect(gutter).toContain('pointer-events: none;')
    expect(cssBlock('body:not(.artifacts-open):not(.settings-open):not(.non-chat-view) #main {'))
      .toContain('margin-right: var(--side-rail-width);')
  })
})
