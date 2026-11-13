// Product pins for the side task surface: the background composer keeps its
// send affordance (the voice-chat launch presentation must never take over its
// send slot), and the side transcript hides the hanging sender-avatar columns
// its full-width rows cannot gutter.
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createSidePaneComposerFixture } from './test-support/side-pane-composer-fixture'

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

for (const running of [true, false]) test(`removing a side view preserves its runtime without sealing future frames: running=${running}`, async () => {
  const f = createSidePaneComposerFixture()
  try {
    await f.window.klausSideSurfaceActivate('removed-view', 'left')
    await f.window.klausSideSurfaceActivate('remaining-view', 'right')
    f.setRuntime('removed-view', { running, historyStale: !running, activeTurnId: 'owned-turn' })
    const before = f.streamFor('removed-view')
    const root = f.input('left').closest('[data-side-pane]')
    f.window.klausSideSurfaceRemove('removed-view')
    expect(root.isConnected).toBe(false)
    expect(f.document.querySelector('[data-sideid="removed-view"]')).toBeNull()
    expect(f.calls.retired).toEqual([])
    expect(f.streamFor('removed-view')).toBe(before)
    expect(f.window.klausSideSurfaceSessionId('right')).toBe('remaining-view')
    f.setRuntime('removed-view', { lastTerminalStatus: 'completed', running: false })
    await f.window.klausSideSurfaceActivate('removed-view', 'left')
    expect(f.streamFor('removed-view').lastTerminalStatus).toBe('completed')
    expect(f.window.klausSideSurfaceSessionId('left')).toBe('removed-view')
  } finally { await f.destroy() }
})

test('side composer failures and drafts keep user-visible parity', () => {
  const chat = read('chat.ts')
  // An unexpected escape from the submit net surfaces as an operational toast.
  expect(chat).toContain("showToast(tt('chat_send_failed_prefix')")
  // Side drafts persist across reloads through the shared local-value store.
  expect(chat).toContain('const SIDE_DRAFTS_KEY = windowStateKey(')
  expect(chat).toContain('persistSideDraft(sideDraftScope, outgoing)')
  expect(chat).toContain('persistedSideDraft(scope)')
  expect(chat).toContain('persistSideDraft(sid, null)')
  const messages = read('../i18n/messages.ts')
  expect(messages.match(/chat_send_failed_prefix:/g)?.length).toBe(2)
})
