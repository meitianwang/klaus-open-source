// The delegated-message bubble and its provenance label.
//
// A cross-conversation delivery stores its prompt inside a `<klaus-delegation>`
// envelope, because the envelope has to reach the recipient MODEL (it carries the
// sender's id, which is what makes a reply possible). That means the raw markup
// lands in the recipient's stored history, and this pair of helpers is the only
// thing that stops the recipient's OWNER from reading protocol syntax instead of
// the sender's prose: `delegationEnvelopeInput` yields the prose for an ordinary
// user bubble, and `renderDelegationLabelHtml` yields the one-line "from another
// chat" label above it. The message keeps an ordinary bubble with a source
// label instead of a separate card.
//
// The parser itself is pinned by the delegation vectors against the host encoder;
// this file covers the rendering half, which the host tests cannot reach.
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

;(globalThis as any).window = { addEventListener: () => {}, currentLang: 'en', klaus: { media: { url: (p: string) => p } } }

const { renderDelegationLabelHtml, delegationEnvelopeInput } = await import('./factories')
const { makeTranscriptClickHandler } = await import('./TranscriptView')
const { encodeDelegationEnvelope, DELEGATION_TAG_OPEN, parseDelegationEnvelope } = await import('../../../../contracts/thread-delegation')
const { setDeviceNamesForTest } = await import('../device-names')

// CSS modules are not loaded under bun, so class names render as `undefined`
// (as in the sibling transcript tests). The stylesheet is checked separately,
// which is the assertion that actually catches a typo'd key.
const stylesheet = readFileSync(new URL('./transcript.module.css', import.meta.url), 'utf8')
const envelopeVectors = JSON.parse(readFileSync(new URL('../../../../contracts/vectors/thread-delegation-vectors.json', import.meta.url), 'utf8')) as {
  remoteRoundTrip: Array<{
    name: string; input: string; sourceThreadId: string | null; sourceHostId: string; expected: string
    expectedParsed: { sourceThreadId: string | null; sourceHostId?: string; input: string }
  }>
  remoteParseRejects: Array<{ name: string; text: string }>
}

describe('the delegation bubble text', () => {
  test('yields the sender prose for the bubble', () => {
    expect(delegationEnvelopeInput(encodeDelegationEnvelope('Please fix the parser.', 'thread-a'))).toBe('Please fix the parser.')
  })

  test('the protocol wrapper never reaches the reader', () => {
    const input = delegationEnvelopeInput(encodeDelegationEnvelope('Clean prose.', 'thread-a'))
    expect(input).toBe('Clean prose.')
    expect(input).not.toContain('<klaus-delegation>')
    expect(input).not.toContain('<source-thread-id>')
    expect(input).not.toContain('<input>')
    // The sender id is NOT surfaced as visible text — it lives only in the envelope
    // for the model, and the label says "another chat", never the id.
    expect(input).not.toContain('thread-a')
  })

  test('a remote source keeps its prose and drops the host id from the text', () => {
    const input = delegationEnvelopeInput(encodeDelegationEnvelope('Please inspect the result.', 'thread-a', 'device-b'))
    expect(input).toBe('Please inspect the result.')
    expect(input).not.toContain('device-b')
    expect(input).not.toContain('<source-host-id>')
  })

  test('anything that is not exactly one envelope falls back to null', () => {
    // The caller renders the ordinary user bubble with no label in this case.
    // Returning null is the safe direction: swallowing model-authored text is
    // worse than showing a wrapper that failed to parse.
    for (const text of [
      'plain user message',
      '',
      '<klaus-delegation><input>unclosed',
      'prose before <klaus-delegation><input>x</input></klaus-delegation>',
      '<klaus-delegation><input>one</input></klaus-delegation><klaus-delegation><input>two</input></klaus-delegation>',
    ]) {
      expect(delegationEnvelopeInput(text)).toBe(null)
    }
  })
})

describe('the delegation provenance label', () => {
  test('a local source provides one navigable label without exposing its id as prose', () => {
    const html = renderDelegationLabelHtml(encodeDelegationEnvelope('hi', 'thread-a'))
    expect(html).toContain('Sent by Klaus from another chat')
    expect(html).toContain('<svg')
    expect(html.split('<button').length - 1).toBe(1)
    expect(html).toContain('data-delegation-source-id="thread-a"')
    expect(html.match(/<span>[^<]*<\/span>/)?.[0]).not.toContain('thread-a')
  })

  test('a remote source names the sending computer, never the raw host id', () => {
    // A cross-computer delivery qualifies the provenance line with the device
    // name when the account device list resolves it, and says "another
    // computer" when it cannot. The raw host id is model/relay-authored and
    // must never reach the label in either case.
    const unresolved = renderDelegationLabelHtml(encodeDelegationEnvelope('Please inspect the result.', 'thread-a', 'device-b'))
    expect(unresolved).toContain('Sent by a chat on another computer')
    expect(unresolved).not.toContain('device-b')
    expect(unresolved).not.toContain('<button')
    expect(unresolved).not.toContain('data-delegation-source-id')
    setDeviceNamesForTest([{ id: 'device-b', name: 'Mac mini' }], 'device-pro')
    const resolved = renderDelegationLabelHtml(encodeDelegationEnvelope('Please inspect the result.', 'thread-a', 'device-b'))
    expect(resolved).toContain('Sent by a chat on Mac mini')
    expect(resolved).not.toContain('device-b')
    setDeviceNamesForTest([], 'device-pro')
  })

  test('a missing source id keeps the label but has no dead navigation button', () => {
    const withoutSource = renderDelegationLabelHtml(encodeDelegationEnvelope('hi', null))
    expect(withoutSource).toContain('Sent by Klaus from another chat')
    expect(withoutSource).not.toContain('<button')
    expect(withoutSource).not.toContain('data-delegation-source-id')
  })

  test('a known local source names the sending chat', () => {
    ;(window as any).getKnownSessionInfo = (id: string) => id === 'thread-a' ? { title: 'Research' } : null
    try {
      const html = renderDelegationLabelHtml(encodeDelegationEnvelope('hi', 'thread-a'))
      expect(html).toContain('Sent by Klaus from Research')
      expect(html).toContain('data-delegation-source-id="thread-a"')
    } finally {
      delete (window as any).getKnownSessionInfo
    }
  })

  test('markup in the source id stays escaped in the button attribute', () => {
    const hostile = '"><script>alert(1)</script>'
    const html = renderDelegationLabelHtml(encodeDelegationEnvelope('hi', hostile))
    expect(html).not.toContain('<script>')
    expect(html).not.toContain(hostile)
    expect(html).toContain('data-delegation-source-id="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;"')
  })

  test('clicking a local source uses the sending chat, not the receiving chat', () => {
    const navigated: string[] = []
    ;(window as any).klausSwitchSession = (id: string) => { navigated.push(id) }
    const originalElement = (globalThis as any).Element
    class SourceButton {
      dataset = { delegationSourceId: 'thread-a' }
      closest(selector: string) { return selector === 'button[data-delegation-source-id]' ? this : null }
    }
    ;(globalThis as any).Element = SourceButton
    try {
      let stopped = false
      makeTranscriptClickHandler('receiver')({ target: new SourceButton(), stopPropagation: () => { stopped = true } } as unknown as Event)
      expect(navigated).toEqual(['thread-a'])
      expect(stopped).toBe(true)
    } finally {
      if (originalElement === undefined) delete (globalThis as any).Element
      else (globalThis as any).Element = originalElement
      delete (window as any).klausSwitchSession
    }
  })

  test('a malformed envelope yields no label', () => {
    expect(renderDelegationLabelHtml('plain user message')).toBe('')
    expect(renderDelegationLabelHtml('')).toBe('')
    expect(renderDelegationLabelHtml('<klaus-delegation><input>unclosed')).toBe('')
  })

  test('no tooltip is added, per the frontend interaction policy', () => {
    const html = renderDelegationLabelHtml(encodeDelegationEnvelope('hi', 'thread-a'))
    expect(html).not.toContain('title=')
    expect(html).not.toContain('data-klaus-tip')
  })

  test('the label follows the UI language', () => {
    ;(window as any).currentLang = 'zh'
    try {
      const html = renderDelegationLabelHtml(encodeDelegationEnvelope('你好', 'thread-a'))
      expect(html).toContain('由 Klaus 从另一个对话发送')
    } finally {
      ;(window as any).currentLang = 'en'
    }
  })

  test('references only class names that exist in the stylesheet', () => {
    expect(stylesheet).toContain('.delegation-label-row ')
    // The card-era classes are gone; nothing may still reference them.
    for (const name of ['delegation-card', 'delegation-header', 'delegation-source', 'delegation-body']) {
      expect(stylesheet).not.toContain(`.${name} `)
    }
  })
})

describe('cross-host delegation envelope vectors', () => {
  for (const item of envelopeVectors.remoteRoundTrip) {
    test(item.name, () => {
      const encoded = encodeDelegationEnvelope(item.input, item.sourceThreadId, item.sourceHostId)
      expect(encoded).toBe(item.expected)
      const parsed = parseDelegationEnvelope(encoded)
      expect(parsed).toEqual(item.expectedParsed)
      expect(parseDelegationEnvelope(encodeDelegationEnvelope(parsed!.input, parsed!.sourceThreadId, parsed!.sourceHostId))).toEqual(item.expectedParsed)
      // The bubble text helper agrees with the parser on the prose.
      expect(delegationEnvelopeInput(encoded)).toBe(item.expectedParsed.input)
    })
  }

  for (const item of envelopeVectors.remoteParseRejects) {
    test(item.name, () => {
      expect(parseDelegationEnvelope(item.text)).toBe(null)
      expect(delegationEnvelopeInput(item.text)).toBe(null)
      expect(renderDelegationLabelHtml(item.text)).toBe('')
    })
  }

  test('an omitted host preserves local encoding and does not add a parsed property', () => {
    const legacy = '<klaus-delegation>\n  <source-thread-id>thread-a</source-thread-id>\n  <input>hi</input>\n</klaus-delegation>'
    for (const host of [undefined, null, '']) {
      expect(encodeDelegationEnvelope('hi', 'thread-a', host)).toBe(legacy)
      const parsed = parseDelegationEnvelope(legacy)
      expect(parsed).toEqual({ sourceThreadId: 'thread-a', input: 'hi' })
      expect(Object.hasOwn(parsed!, 'sourceHostId')).toBe(false)
    }
  })
})

/**
 * The classifier/renderer coupling.
 *
 * `TranscriptView.tsx` decides a user message is a delegation by a substring test
 * — `text.includes(DELEGATION_TAG_OPEN)` — and only then are these helpers called.
 * Both halves must therefore agree on ONE spelling of the opening tag, and that
 * spelling must be what the host encoder actually emits. Today both derive from the
 * single `DELEGATION_TAG` constant, so drift is structurally impossible; these
 * assertions are what keep it that way, because a rename that touched only one
 * side would silently show raw `<klaus-delegation>` markup to users.
 */
describe('the delegation tag the renderer looks for is the tag the host writes', () => {
  test('DELEGATION_TAG_OPEN matches the opening line of a real envelope', () => {
    expect(DELEGATION_TAG_OPEN).toBe('<klaus-delegation>')
    const envelope = encodeDelegationEnvelope('Anything.', 'thread-a')
    expect(envelope.startsWith(DELEGATION_TAG_OPEN)).toBe(true)
    expect(envelope.trimEnd().endsWith('</klaus-delegation>')).toBe(true)
  })

  test('every envelope the host can produce is both classified and parseable', () => {
    // Covers the two encoder shapes (with and without a source id) so neither can
    // slip past the classifier: a message that parses but does not match the tag
    // check would render as raw protocol text.
    for (const source of ['thread-a', null]) {
      const envelope = encodeDelegationEnvelope('Work on the parser.', source)
      expect(envelope.includes(DELEGATION_TAG_OPEN)).toBe(true)
      expect(parseDelegationEnvelope(envelope)).not.toBe(null)
      expect(delegationEnvelopeInput(envelope)).toBe('Work on the parser.')
    }
  })

  test('the helpers fold the envelope the classifier matched', () => {
    const envelope = encodeDelegationEnvelope('Finish the migration.', 'thread-caller')
    expect(delegationEnvelopeInput(envelope)).toBe('Finish the migration.')
    const label = renderDelegationLabelHtml(envelope)
    expect(label).toContain('Sent by Klaus from another chat')
    expect(label).not.toContain('klaus-delegation')
    expect(label).toContain('data-delegation-source-id="thread-caller"')
    expect(label.match(/<span>[^<]*<\/span>/)?.[0]).not.toContain('thread-caller')
  })
})
