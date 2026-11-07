import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Pins the scroll surface: the scroll-to-latest arrow floats at
// the transcript's bottom edge (seam above the composer) instead of living in
// the composer activity rail, and the transcript columns hide their native
// scrollbar in favour of the outer proxy scrollbar at the column's right edge.

const INDEX_HTML = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8')
const STYLES_CSS = readFileSync(fileURLToPath(new URL('../../css/styles.css', import.meta.url)), 'utf8')
const CHAT_TS = readFileSync(fileURLToPath(new URL('./chat.ts', import.meta.url)), 'utf8')
const OUTER_TS = readFileSync(fileURLToPath(new URL('./outer-scrollbar.ts', import.meta.url)), 'utf8')

function cssRule(source: string, selector: string): string {
  const start = source.indexOf(selector)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('}', start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('scroll-to-latest arrow placement', () => {
  test('lives in the composer wrapper, not the activity rail', () => {
    const wrapperStart = INDEX_HTML.search(/<div\b[^>]*\bid="input-wrapper"[^>]*>/)
    const button = INDEX_HTML.indexOf('<button id="scroll-to-bottom"', wrapperStart)
    const rail = INDEX_HTML.indexOf('<div class="composer-activity-rail">', wrapperStart)
    expect(wrapperStart).toBeGreaterThanOrEqual(0)
    expect(button).toBeGreaterThan(wrapperStart)
    expect(button).toBeLessThan(rail)
    // Both glyphs mount statically so the running-state swap never reflows.
    const buttonEnd = INDEX_HTML.indexOf('</button>', button)
    const buttonHtml = INDEX_HTML.slice(button, buttonEnd)
    expect(buttonHtml).toContain('data-kls-icon="chat-scroll-to-bottom"')
    expect(buttonHtml).toContain('data-kls-icon="chat-scroll-to-bottom-spin"')
    // The rail no longer hosts the arrow.
    const railEnd = INDEX_HTML.indexOf('</div>', rail)
    expect(INDEX_HTML.slice(rail, railEnd)).not.toContain('scroll-to-bottom')
  })

  test('floats on the seam above the composer, pill-shaped and shadow-free', () => {
    const rule = cssRule(STYLES_CSS, '#scroll-to-bottom, :is(#side-scroll-to-bottom, #left-side-scroll-to-bottom) {')
    expect(rule).toContain('position: absolute;')
    expect(rule).toContain('bottom: 100%;')
    expect(rule).toContain('left: 50%;')
    expect(rule).toContain('border-radius: 9999px;')
    expect(rule).not.toContain('box-shadow')
    const visible = cssRule(STYLES_CSS, '#scroll-to-bottom.visible, :is(#side-scroll-to-bottom, #left-side-scroll-to-bottom).visible {')
    expect(visible).toContain('opacity: 1;')
    expect(visible).toContain('pointer-events: auto;')
  })

  test('swaps to a spinner glyph while the turn runs', () => {
    const hidden = cssRule(STYLES_CSS, '#scroll-to-bottom .scroll-to-bottom-spin,\n:is(#side-scroll-to-bottom, #left-side-scroll-to-bottom) .scroll-to-bottom-spin {')
    expect(hidden).toContain('display: none;')
    const generating = cssRule(STYLES_CSS, '#scroll-to-bottom[data-generating] .scroll-to-bottom-spin,')
    expect(generating).toContain('display: block;')
    expect(generating).toContain('animation: kls-spin 0.8s linear infinite;')
    expect(CHAT_TS).toContain("scrollToBottomBtn?.toggleAttribute('data-generating', busy)")
  })
})

describe('titlebar and transcript drag regions', () => {
  test('the titlebar drag region spans both sidebar and conversation', () => {
    const rule = cssRule(STYLES_CSS, '.app-titlebar-controls {')
    expect(rule).toContain('position: fixed;')
    expect(rule).toContain('left: 0;')
    expect(rule).toContain('right: 0;')
    expect(rule).toContain('height: var(--titlebar-height);')
    expect(rule).toContain('-webkit-app-region: drag;')
  })

  test('the overlapping transcript leaves the titlebar draggable without making messages draggable', () => {
    const rule = cssRule(STYLES_CSS, '#messages {')
    expect(rule).toContain('padding: calc(var(--titlebar-height) + 14px)')
    expect(rule).not.toMatch(/-webkit-app-region\s*:/)
    const controls = cssRule(STYLES_CSS, '.app-titlebar-controls button,')
    expect(controls).toContain('-webkit-app-region: no-drag !important;')
    expect(controls).toContain('pointer-events: auto;')
  })
})

describe('outer proxy scrollbar', () => {
  test('transcript columns hide their native scrollbar', () => {
    expect(cssRule(STYLES_CSS, '#messages {')).toContain('overflow-anchor: none;')
    expect(cssRule(STYLES_CSS, '#messages {')).toContain('scrollbar-width: none;')
    expect(cssRule(STYLES_CSS, '#messages::-webkit-scrollbar {')).toContain('display: none;')
    expect(cssRule(STYLES_CSS, '.side-messages {')).toContain('scrollbar-width: none;')
    expect(cssRule(STYLES_CSS, '.side-messages::-webkit-scrollbar {')).toContain('display: none;')
  })

  test('proxy is a 6px scroller pinned to the region right edge', () => {
    const rule = cssRule(STYLES_CSS, '.chat-outer-scrollbar {')
    expect(rule).toContain('position: absolute;')
    expect(rule).toContain('right: 0;')
    expect(rule).toContain('width: 6px;')
    expect(rule).toContain('overflow-y: scroll;')
    const thumb = cssRule(STYLES_CSS, '.chat-outer-scrollbar::-webkit-scrollbar-thumb {')
    expect(thumb).toContain('background: transparent;')
    expect(thumb).toContain('min-height: 30px;')
    const scrolling = cssRule(STYLES_CSS, '.chat-outer-scrollbar.is-scrolling::-webkit-scrollbar-thumb {')
    expect(scrolling).toContain('background: var(--border);')
  })

  test('mounts for both columns and feeds directional input to their controllers', () => {
    expect(CHAT_TS).toContain("region: document.getElementById('main')")
    expect(CHAT_TS).toContain("region: document.getElementById('side-chat-panel')")
    // An actual proxy movement records its direction before writing the column.
    expect(CHAT_TS).toContain("mainScrollController.noteUserScrollIntent(direction === 'up' ? 'away' : 'toward')")
    expect(CHAT_TS).toContain("sideScrollController?.noteUserScrollIntent(direction === 'up' ? 'away' : 'toward')")
    expect(CHAT_TS).toContain('registerTranscriptScrollController(mainScrollController)')
    expect(CHAT_TS).toContain('registerTranscriptScrollController(sideScrollController)')
    expect(CHAT_TS).toContain('registerTranscriptScrollController(teammateScrollController)')
    expect(OUTER_TS).toContain('onUserScrollIntent?.(direction)')
    expect(OUTER_TS).toContain('scrollEl.scrollHeight > scrollEl.clientHeight + 1')
    // Two-way sync keeps a loop guard on both directions.
    expect(OUTER_TS).toContain("syncingFrom === 'proxy'")
    expect(OUTER_TS).toContain("syncingFrom === 'source'")
  })
})
