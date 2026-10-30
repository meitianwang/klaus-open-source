import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { contextPieSvg } from '../icons/dynamic'

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

describe('context usage popover', () => {
  test('keeps the usage indicator passive and outside the keyboard tab order', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
    const indicator = html.match(/<span id="ctx-usage-chip"[^>]*>/)?.[0]
    expect(indicator).toContain('role="img"')
    expect(indicator).not.toContain('tabindex')
    expect(indicator).not.toContain('title=')
  })

  test('keeps hover details noninteractive and readable in both themes', () => {
    const pop = cssBlock('.ctx-pop {')
    expect(pop).toContain('pointer-events: none;')
    expect(pop).toContain('max-width: min(240px, calc(100vw - 16px));')
    expect(pop).toContain('font-size: var(--text-small);')
    expect(pop).toContain('font-weight: inherit;')
    expect(pop).toContain('line-height: 1.4;')
    expect(pop).toContain('letter-spacing: 0.01em;')
    expect(pop).toContain('text-align: center;')
    expect(pop).toContain('background: var(--fg);')
    expect(pop).toContain('color: var(--bg-elevated);')
    const dark = cssBlock('[data-theme="dark"] .ctx-pop {')
    expect(dark).toContain('background: var(--bg-elevated);')
    expect(dark).toContain('color: var(--fg);')
    expect(STYLES_CSS).not.toContain('.ctx-pop-compact')
  })

  test('the ring preserves a visible track at zero and caps invalid or excess usage', () => {
    for (const value of [-1, NaN, Infinity, 0]) {
      const svg = contextPieSvg(value)
      expect(svg).toContain('opacity="0.16"')
      expect(svg).toContain('stroke-dashoffset="100" opacity="0"')
    }
    for (const value of [100, 120]) {
      expect(contextPieSvg(value)).toContain('stroke-dashoffset="0" opacity="1"')
    }
    expect(contextPieSvg(0.1)).toContain('stroke-dashoffset="99.9" opacity="1"')
    expect(contextPieSvg(50)).toContain('stroke-dashoffset="50" opacity="1"')
    expect(contextPieSvg(50)).not.toContain('<path')
  })
})
