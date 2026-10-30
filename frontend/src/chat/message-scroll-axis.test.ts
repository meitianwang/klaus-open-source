// Regression gate: transcript surfaces scroll vertically only. Wide content
// owns horizontal scrolling inside its row instead of moving the whole chat.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const STYLES_CSS = readFileSync(fileURLToPath(new URL('../../css/styles.css', import.meta.url)), 'utf8')

function blockOf(selector: string): string {
  const start = STYLES_CSS.indexOf(selector)
  expect(start > -1).toBe(true)
  const end = STYLES_CSS.indexOf('}', start)
  return STYLES_CSS.slice(start, end)
}

describe('transcript scroll axes', () => {
  test('main and side transcripts disable surface-level horizontal scrolling', () => {
    for (const selector of ['#messages {', '.side-messages {']) {
      const block = blockOf(selector)
      expect(block).toContain('overflow-y: auto')
      expect(block).toContain('overflow-x: hidden')
    }
  })
})
