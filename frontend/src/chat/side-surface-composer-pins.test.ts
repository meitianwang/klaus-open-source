// Product pins for the side task surface: the background composer keeps its
// send affordance (the voice-chat launch presentation must never take over its
// send slot), and the side transcript hides the hanging sender-avatar columns
// its full-width rows cannot gutter.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

test('side composer never offers the voice-chat launch in its send slot', () => {
  const chat = read('chat.ts')
  const start = chat.indexOf('mountSideComposerVoice = () => {')
  expect(start).toBeGreaterThan(-1)
  const mount = chat.slice(start, start + 1200)
  expect(mount).toContain('mountVoiceChat({')
  expect(mount).toContain('canStart: () => false')
})

test('side transcript hides the hanging sender columns its rows cannot gutter', () => {
  const css = read('../../css/styles.css')
  const start = css.indexOf('.side-messages-slot [data-external-sender-col]')
  expect(start).toBeGreaterThan(-1)
  const rule = css.slice(start)
  const head = rule.slice(0, rule.indexOf('}'))
  for (const attr of ['data-external-sender-col', 'data-agent-sender-col', 'data-owner-sender-col']) {
    expect(head).toContain(`.side-messages-slot [${attr}]`)
  }
  expect(head).toContain('display: none')
})

test('voice-chat css still gates the send hide on the wrapper state only', () => {
  const css = read('voice-chat/voice-chat.css')
  expect(css).toContain('#side-input-wrapper[data-voice-chat="launch"] #side-send')
  expect(css).toContain('#side-input-wrapper[data-voice-chat="active-empty"] #side-send')
  expect(css).toContain('#side-input-wrapper:is([data-voice-chat="active-empty"], [data-voice-chat="active-draft"]) #side-voice-input-btn { display: none !important; }')
})
