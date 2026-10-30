import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

// The banner reads fork provenance from the sidebar ledger, the same way the
// sidebar's own branch icon does, so the test only needs that one window hook.
let knownSession: any = null
;(globalThis as any).window = {
  addEventListener: () => {},
  removeEventListener: () => {},
  currentLang: 'en',
  getKnownSessionInfo: () => knownSession,
}

const { BranchBanner } = await import('./TranscriptView')

const render = (sessionId: string) => renderToStaticMarkup(<BranchBanner sessionId={sessionId} />)

describe('fork provenance banner over the main transcript', () => {
  test('an ordinary conversation shows no banner', () => {
    knownSession = { id: 'plain', title: 'Plain chat' }
    expect(render('plain')).toBe('')
  })

  test('a fork names its source conversation', () => {
    knownSession = {
      id: 'fork',
      title: 'Retained source title · Branch',
      forkedFrom: { sessionId: 'source', threadId: 'source', title: 'Retained source title' },
    }
    const html = render('fork')
    expect(html).toContain('Branched from “Retained source title”')
    // CSS module class names are empty under bun test; the element shape is the contract.
    expect(html.startsWith('<button')).toBe(true)
  })

  test('a fork whose source title is missing still says it is a branch', () => {
    knownSession = { id: 'fork', title: 'Chat · Branch', forkedFrom: { sessionId: 'source', threadId: 'source' } }
    expect(render('fork')).toContain('Branch conversation')
  })

  test('a session recorded as its own source shows no banner', () => {
    knownSession = { id: 'self', title: 'Self · Branch', forkedFrom: { sessionId: 'self', threadId: 'self', title: 'Self' } }
    expect(render('self')).toBe('')
  })

  test('an unknown session shows no banner', () => {
    knownSession = null
    expect(render('missing')).toBe('')
  })
})
