import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

// The banner reads fork provenance from the sidebar ledger, the same way the
// sidebar's own branch icon does, so the test only needs that one window hook.
let knownSession: any = null
const previousWindow = (globalThis as any).window
const previousDocument = (globalThis as any).document
let BranchBanner: typeof import('./TranscriptView').BranchBanner
let LiveTail: typeof import('./TranscriptView').LiveTail
let foldTurnGroups: typeof import('./TranscriptView').foldTurnGroups
let unitsFromMessages: typeof import('./TranscriptView').unitsFromMessages
let renderMsgActionsHtml: typeof import('./factories').renderMsgActionsHtml
let chatStreamStore: typeof import('../stream-store').chatStreamStore
let getSessionStream: typeof import('../stream-store').getSessionStream

beforeAll(async () => {
  ;(globalThis as any).window = {
    ...previousWindow,
    addEventListener: () => {},
    removeEventListener: () => {},
    currentLang: 'en',
    getKnownSessionInfo: () => knownSession,
  }
  const el = (): any => new Proxy({ style: {}, dataset: {}, children: [], attributes: {}, classList: { add() {}, remove() {}, contains: () => false } }, {
    get(target, prop: string) {
      if (prop in target) return (target as any)[prop]
      if (prop === 'querySelectorAll') return () => []
      if (prop === 'querySelector') return () => null
      return () => {}
    },
    set(target, prop: string, value) { ;(target as any)[prop] = value; return true },
  })
  ;(globalThis as any).document = {
    documentElement: { style: {}, setAttribute() {} },
    getElementById: () => null,
    createElement: el,
    createElementNS: el,
    createDocumentFragment: el,
    createTreeWalker: () => ({ nextNode: () => null }),
  }
  ;({ BranchBanner, LiveTail, foldTurnGroups, unitsFromMessages } = await import('./TranscriptView'))
  ;({ renderMsgActionsHtml } = await import('./factories'))
  ;({ chatStreamStore, getSessionStream } = await import('../stream-store'))
})
afterAll(() => {
  if (previousDocument === undefined) delete (globalThis as any).document
  else (globalThis as any).document = previousDocument
  if (previousWindow === undefined) delete (globalThis as any).window
  else (globalThis as any).window = previousWindow
})

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

  test('in a forked transcript, the banner sits at the fork boundary between inherited and new turns', () => {
    knownSession = {
      id: 'fork-sess',
      title: 'Origin chat · Branch',
      forkedFrom: { sessionId: 'origin', threadId: 'origin', title: 'Origin chat' },
    }
    const history = [
      { uuid: 'u1', role: 'user', text: 'Inherited question 1', contentBlocks: [{ type: 'text', text: 'Inherited question 1' }], turnId: 'fork-sess-preamble' },
      { uuid: 'a1', role: 'assistant', isFinalReply: true, contentBlocks: [{ type: 'text', text: 'Inherited answer 1' }], turnId: 'fork-sess-preamble' },
      { uuid: 'u2', role: 'user', text: 'Inherited question 2', contentBlocks: [{ type: 'text', text: 'Inherited question 2' }], turnId: 'fork-sess-preamble' },
      { uuid: 'a2', role: 'assistant', isFinalReply: true, contentBlocks: [{ type: 'text', text: 'Inherited answer 2' }], turnId: 'fork-sess-preamble' },
      { uuid: 'u3', role: 'user', text: 'New question in fork', contentBlocks: [{ type: 'text', text: 'New question in fork' }], turnId: 'own-turn-1' },
      { uuid: 'a3', role: 'assistant', isFinalReply: true, contentBlocks: [{ type: 'text', text: 'New answer in fork' }], turnId: 'own-turn-1' },
    ]
    const initial = chatStreamStore.getInitialState()
    const previousSessions = initial.sessions
    initial.sessions = {
      ...previousSessions,
      'fork-sess': {
        ...getSessionStream('missing-fork-sess-fixture'),
        history,
        turnStartedAtMs: { 'own-turn-1': 1700000001000 },
      },
    }
    try {
      const unitProps = {
        archived: false,
        running: false,
        composerAuthored: true,
        readOnly: false,
        sessionId: 'fork-sess',
        streamSessionId: 'fork-sess',
        editTarget: null,
        isThinkingExpanded: () => false,
        onToggleThinking() {},
      }
      const groups = foldTurnGroups(unitsFromMessages(history), null, {}, {}, {}, {})
      const html = renderToStaticMarkup(
        <LiveTail
          sessionId="fork-sess"
          scroll="main"
          unitProps={unitProps}
          timeline={{
            groups,
            controller: null,
            renderNode: node => node.kind === 'unit'
              ? <div data-test-uuid={node.unit.msg?.uuid}>{node.unit.segment?.text || node.unit.msg?.text}</div>
              : null,
          }}
        />,
      )
      const inheritedEndAt = html.indexOf('Inherited answer 2')
      const bannerAt = html.indexOf('Branched from “Origin chat”')
      const newTurnAt = html.indexOf('New question in fork')
      expect(inheritedEndAt).toBeGreaterThan(-1)
      expect(bannerAt).toBeGreaterThan(inheritedEndAt)
      expect(newTurnAt).toBeGreaterThan(bannerAt)

      const actions = renderMsgActionsHtml({
        ts: 1,
        copyText: 'New answer in fork',
        uuid: 'a3',
        turnId: 'own-turn-1',
        kind: 'assistant',
        archived: false,
        running: false,
      })
      expect(actions).toContain('data-turn-id="own-turn-1"')
      expect(actions).toContain('data-message-uuid="a3"')
    } finally {
      initial.sessions = previousSessions
    }
  })
})
