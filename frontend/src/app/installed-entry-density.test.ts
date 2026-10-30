import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

const css = readFileSync(new URL('../../css/styles.css', import.meta.url), 'utf8')
const block = (selector: string) => {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) throw new Error(`Missing selector: ${selector}`)
  return css.slice(start, css.indexOf('}', start) + 1)
}

describe('installed entry density', () => {
  test('uses a compact shared row without scaling the application', () => {
    expect(block('.mcp-entry-main')).toContain('padding: 10px 14px;')
    expect(block('.mcp-entry-main')).toContain('gap: 10px;')
    expect(block('.mcp-entry-open > .mcp-logo')).toContain('width: 28px; height: 28px;')
    expect(block('.mcp-entry-desc')).toContain('font-size: var(--text-caption);')
    expect(block('.mcp-entry-name')).toContain('font-size: var(--text-body-sm);')
  })

  test('keeps the thumb within the compact switch in either state', () => {
    expect(block('.mcp-entry-controls .mcp-toggle')).toContain('width: 30px; height: 18px;')
    expect(block('.mcp-entry-controls .mcp-toggle-slider::before')).toContain('width: 12px; height: 12px;')
    expect(block('.mcp-entry-controls .mcp-toggle input:checked + .mcp-toggle-slider::before'))
      .toContain('translateX(12px)')
  })
})
