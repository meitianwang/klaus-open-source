import { describe, expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'

// The worktree-init row is a persistent transcript entry, not a toast: it
// renders from the live store status while the session is alive and from the
// managed workdir after a reload. These renders
// go through the real TranscriptView so the row's slot — below the first user
// bubble (the message that triggered the creation), outside any turn fold — is
// part of the assertion.
;(globalThis as any).window = {
  ...(globalThis as any).window,
  addEventListener: () => {}, removeEventListener: () => {}, currentLang: 'en',
  matchMedia: () => ({ matches: true }),
}
const sessionInfo: { workdir?: string; forkedFrom?: unknown; archived?: boolean } = {}
;(window as any).getKnownSessionInfo = () => sessionInfo

const { chatStreamStore, getSessionStream } = await import('../stream-store')
const { TranscriptView } = await import('./TranscriptView')

const MANAGED = '/Users/dev/.klaus/worktrees/klaus-20260922-115927-cae0d528'
const container = {} as HTMLElement

function renderTranscript(patch: Partial<ReturnType<typeof getSessionStream>>, info: typeof sessionInfo = {}) {
  ;(window as any).currentLang = 'en'
  for (const key of Object.keys(sessionInfo)) delete sessionInfo[key as keyof typeof sessionInfo]
  Object.assign(sessionInfo, info)
  const sessionId = 'worktree-init-row-test'
  const initial = chatStreamStore.getInitialState()
  const previous = initial.sessions
  initial.sessions = {
    ...previous,
    [sessionId]: { ...getSessionStream('missing-worktree-fixture'), history: [], ...patch },
  }
  // The legacy SSR build touches `document` while flowing markup, but bun's
  // test env has none and other suites (canvas) install their own shape. Keep
  // the stub scoped to this render so it cannot leak into them.
  const previousDocument = (globalThis as any).document
  ;(globalThis as any).document = {
    documentElement: { setAttribute: () => {} },
    getElementById: () => null,
    addEventListener: () => {}, removeEventListener: () => {},
  }
  try {
    return renderToStaticMarkup(<TranscriptView sessionId={sessionId} container={container} scroll="main" />)
  } finally {
    initial.sessions = previous
    if (previousDocument === undefined) delete (globalThis as any).document
    else (globalThis as any).document = previousDocument
  }
}

describe('worktree init row', () => {
  // Every real scenario that shows the row also shows the user message that
  // triggered the creation: in flight = the optimistic bubble, reload = the
  // persisted one. The fixtures mirror that.
  const USER = { id: 'u1', uuid: 'u1', role: 'user' as const, text: 'work in a worktree', contentBlocks: [{ type: 'text', text: 'work in a worktree' }] }

  test('shows the running label with a live status while creation is in flight', () => {
    const html = renderTranscript({ liveUnits: [{ type: 'live-user', key: 'u-live', msg: { role: 'user', text: 'work in a worktree' } }], worktreeInit: { status: 'running' }, running: true })
    expect(html).toContain('data-worktree-init="running"')
    expect(html).toContain('<span>Creating a worktree</span>')
    expect(html).toContain('role="status"')
  })

  test('settles to the completed label from the live status', () => {
    const html = renderTranscript({ liveUnits: [{ type: 'live-user', key: 'u-live', msg: { role: 'user', text: 'work in a worktree' } }], worktreeInit: { status: 'completed' } })
    expect(html).toContain('data-worktree-init="completed"')
    expect(html).toContain('<span>Worktree created</span>')
    expect(html).not.toContain('role="status"')
  })

  test('reports a failed creation in the danger tone', () => {
    const html = renderTranscript({ liveUnits: [{ type: 'live-user', key: 'u-live', msg: { role: 'user', text: 'work in a worktree' } }], worktreeInit: { status: 'failed' } })
    expect(html).toContain('data-worktree-init="failed"')
    expect(html).toContain('<span>Failed to create worktree</span>')
  })

  test('derives the settled row from the managed workdir after a reload', () => {
    // No live status: the store never saw the creation, exactly the state a
    // reopened session is in. The workdir is the only durable evidence.
    const html = renderTranscript({ history: [USER] }, { workdir: MANAGED })
    expect(html).toContain('data-worktree-init="completed"')
    expect(html).toContain('<span>Worktree created</span>')
  })

  test('renders nothing for ordinary sessions', () => {
    const html = renderTranscript({}, { workdir: '/Users/dev/workspace/klaus' })
    expect(html).not.toContain('data-worktree-init')
  })

  test('sits below the first user bubble, outside any turn fold', () => {
    const html = renderTranscript({
      history: [{ id: 'u1', uuid: 'u1', role: 'user', text: 'fix the login bug', contentBlocks: [{ type: 'text', text: 'fix the login bug' }] }],
    }, { workdir: MANAGED })
    const row = html.indexOf('data-worktree-init="completed"')
    const bubble = html.indexOf('fix the login bug')
    expect(row).toBeGreaterThanOrEqual(0)
    // The worktree-init activity item sits below the user message
    // that started the conversation, never above it.
    expect(row).toBeGreaterThan(bubble)
    // The row is a top-level system group, not fold content.
    expect(html.slice(Math.max(0, row - 200), row)).toContain('msg-group system')
  })

  test('renders nothing in history when the transcript has no user bubble yet', () => {
    // Running belongs to the live layer; a settled row without its user message
    // would float away from the turn it annotates.
    const html = renderTranscript({ worktreeInit: { status: 'completed' } })
    expect(html).not.toContain('data-worktree-init')
  })

  test('live running status renders below the optimistic user bubble', () => {
    const html = renderTranscript({
      liveUnits: [{ type: 'live-user', key: 'u-live', msg: { role: 'user', text: 'ship it in a worktree' } }],
      worktreeInit: { status: 'running' },
      running: true,
    })
    const row = html.indexOf('data-worktree-init="running"')
    const bubble = html.indexOf('ship it in a worktree')
    expect(row).toBeGreaterThanOrEqual(0)
    expect(bubble).toBeGreaterThanOrEqual(0)
    expect(row).toBeGreaterThan(bubble)
  })

  test('live layer keeps a completed row only while history has no user message', () => {
    // First turn still owned by the live layer: the settled row must not
    // vanish between creation and the history handoff.
    const html = renderTranscript({
      liveUnits: [{ type: 'live-user', key: 'u-live', msg: { role: 'user', text: 'ship it in a worktree' } }],
      worktreeInit: { status: 'completed' },
      running: false,
    })
    expect(html).toContain('data-worktree-init="completed"')
  })

  test('history takes over the settled row once it has the user message', () => {
    // After the handoff the live layer must not paint a second row beside the
    // history one.
    const html = renderTranscript({
      history: [{ id: 'u1', uuid: 'u1', role: 'user', text: 'fix the login bug', contentBlocks: [{ type: 'text', text: 'fix the login bug' }] }],
      worktreeInit: { status: 'completed' },
    }, { workdir: MANAGED })
    expect(html.match(/data-worktree-init="completed"/g)).toHaveLength(1)
  })
})
