import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { contextPieSvg } from '../icons/dynamic'

const STYLES_CSS = readFileSync(
  fileURLToPath(new URL('../../css/styles.css', import.meta.url)),
  'utf8',
)
const INDEX_HTML = readFileSync(
  fileURLToPath(new URL('../../index.html', import.meta.url)),
  'utf8',
)

function cssRule(selector: string): string {
  const start = STYLES_CSS.indexOf(selector)
  expect(start).toBeGreaterThanOrEqual(0)
  const end = STYLES_CSS.indexOf('}', start)
  expect(end).toBeGreaterThan(start)
  return STYLES_CSS.slice(start, end)
}

describe('composer send surface', () => {
  test('keeps send states inside the 30px target beside the passive usage ring', () => {
    const base = cssRule('#send, #side-send {')
    expect(base).toContain('width: 30px;')
    expect(base).toContain('height: 30px;')
    expect(base).toContain('padding: 7px;')
    expect(base).toContain('background-clip: content-box;')

    const contextIcon = contextPieSvg(50)
    expect(contextIcon).toContain('width="12" height="12"')
    const glyphs = cssRule('#send svg, #side-send svg {')
    expect(glyphs).toContain('width: 10px;')
    expect(glyphs).toContain('height: 10px;')

    for (const iconName of ['send-arrow', 'send-stop', 'send-stopping', 'send-continue']) {
      expect(INDEX_HTML).toContain(`data-kls-icon="${iconName}"`)
    }
    expect(INDEX_HTML).toContain('class="send-esc-hint"')
    const escHint = cssRule('#send.esc-armed .send-esc-hint, #side-send.esc-armed .send-esc-hint {')
    expect(escHint).toContain('font-size: var(--text-badge);')

    const colorOnlyStates = [
      '#send:hover:not(:disabled), #side-send:hover:not(:disabled)',
      '#send:disabled, #side-send:disabled',
      '#send.busy, #side-send.busy',
      '#send.busy:hover, #side-send.busy:hover',
      '#send.busy.stopping:hover, #side-send.busy.stopping:hover',
    ]
    for (const selector of colorOnlyStates) {
      const state = cssRule(selector)
      expect(state).toContain('background-color:')
      expect(state).not.toMatch(/background\s*:/)
    }

    const continueState = cssRule('#send.continue, #side-send.continue {')
    expect(continueState).toContain('padding: 7px;')
    expect(continueState).toContain('background-color: transparent;')

    // Running with composer content the button hands back to the accent send
    // face; only colour changes, the 30px target and glyph box stay put.
    const runningSubmit = cssRule('#send.busy.running-submit, #side-send.busy.running-submit {')
    expect(runningSubmit).toContain('background-color: var(--accent);')
    expect(runningSubmit).toContain('color: var(--accent-text);')
    expect(STYLES_CSS).toContain('#send.busy.running-submit .icon-send, #side-send.busy.running-submit .icon-send { display: block; }')
    expect(STYLES_CSS).toContain('#send.busy.running-submit .icon-stop, #side-send.busy.running-submit .icon-stop { display: none; }')
  })
})
