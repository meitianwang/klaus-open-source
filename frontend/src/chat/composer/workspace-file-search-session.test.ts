import { describe, expect, test } from 'bun:test'
import { rejects } from 'node:assert/strict'
import { WorkspaceFileSearchSession } from './workspace-file-search-session'

// The session manager's guards are the load-bearing part: coalesced creation,
// latest-wins token, and a close that cannot be resurrected by an in-flight
// search. These need a controllable engine stub, so the tests drive the class
// directly rather than through React.

function stubEngine(overrides: Partial<Parameters<typeof makeEngine>[0]> = {}) {
  return makeEngine(overrides)
}

function makeEngine(opts: {
  startDelayMs?: number
  queryDelayMs?: number
  startFails?: boolean
  hits?: (query: string) => Array<{ rel: string; name: string; isDir: boolean }>
} = {}) {
  const calls: string[] = []
  let openedId: string | null = null
  const engine = {
    workspaceFileSearchSessionStart: async (sessionId: string | undefined) => {
      calls.push('start')
      if (opts.startDelayMs) await new Promise(r => setTimeout(r, opts.startDelayMs))
      if (opts.startFails) throw new Error('start_failed')
      openedId = `fss-${sessionId ?? 'none'}`
      return { sessionId: openedId }
    },
    workspaceFileSearchSessionQuery: async (nativeId: string, query: string) => {
      calls.push(`query:${query}`)
      if (opts.queryDelayMs) await new Promise(r => setTimeout(r, opts.queryDelayMs))
      const rows = opts.hits ? opts.hits(query) : [{ rel: `${query}.ts`, name: `${query}.ts`, isDir: false }]
      return rows
    },
    workspaceFileSearchSessionStop: async (nativeId: string) => {
      calls.push('stop')
      openedId = null
      return { ok: true }
    },
  }
  return { engine, calls, isOpen: () => openedId !== null }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('WorkspaceFileSearchSession', () => {
  test('a search opens the session once and re-ranks it', async () => {
    const { engine, calls } = stubEngine()
    const session = new WorkspaceFileSearchSession(engine, 'chat-1')
    expect(await session.search('app')).toEqual([{ rel: 'app.ts', name: 'app.ts', isDir: false }])
    // The tree is walked once; the second query re-ranks without a second start.
    expect(await session.search('readme')).toEqual([{ rel: 'readme.ts', name: 'readme.ts', isDir: false }])
    expect(calls).toEqual(['start', 'query:app', 'query:readme'])
    expect(calls.filter(c => c === 'start')).toHaveLength(1)
  })

  test('concurrent searches before the first open coalesce onto one creation', async () => {
    const { engine, calls } = stubEngine({ startDelayMs: 20 })
    const session = new WorkspaceFileSearchSession(engine, 'chat-1')
    // Two keystrokes land before the create resolves.
    const [a, b] = await Promise.all([session.search('a'), session.search('b')])
    // Only the latest (b) keeps its rows; the superseded a resolves empty.
    expect(b).toEqual([{ rel: 'b.ts', name: 'b.ts', isDir: false }])
    expect(a).toEqual([])
    expect(calls.filter(c => c === 'start')).toHaveLength(1, 'one native session for a burst of searches')
  })

  test('a newer search supersedes an older one in flight', async () => {
    const { engine } = stubEngine({ queryDelayMs: 20 })
    const session = new WorkspaceFileSearchSession(engine, 'chat-1')
    const first = session.search('slow')
    await flush()
    const second = session.search('fast')
    // The older token is invalidated, so its result is dropped even though it
    // resolves from the native side.
    expect(await first).toEqual([])
    expect(await second).toEqual([{ rel: 'fast.ts', name: 'fast.ts', isDir: false }])
  })

  test('close stops the native session and an in-flight search resolves empty', async () => {
    const { engine, calls, isOpen } = stubEngine({ queryDelayMs: 30 })
    const session = new WorkspaceFileSearchSession(engine, 'chat-1')
    const pending = session.search('app')
    await flush() // let ensureOpen start
    await session.close()
    expect(calls).toContain('stop')
    expect(isOpen()).toBe(false)
    // The search that was ranking when close() ran must not resurrect rows.
    expect(await pending).toEqual([])
  })

  test('close is idempotent and a post-close search resolves empty without reopening', async () => {
    const { engine, calls } = stubEngine()
    const session = new WorkspaceFileSearchSession(engine, 'chat-1')
    await session.search('app')
    await session.close()
    await session.close()
    expect(calls.filter(c => c === 'stop')).toHaveLength(1, 'a second close is a no-op')
    expect(await session.search('after')).toEqual([])
    expect(calls.filter(c => c === 'start')).toHaveLength(1, 'no reopen after close')
  })

  test('a close racing the create stops the session instead of orphaning it', async () => {
    const { engine, calls } = stubEngine({ startDelayMs: 30 })
    const session = new WorkspaceFileSearchSession(engine, 'chat-1')
    const pending = session.search('app') // triggers ensureOpen
    await session.close() // closes while create is still in flight
    expect(await pending).toEqual([])
    // The create's .then sees closing and stops the freshly-created session.
    await flush()
    expect(calls).toContain('stop')
  })

  test('a draft passes its selected root without creating a chat', async () => {
    const startedWith: unknown[][] = []
    const engine = {
      workspaceFileSearchSessionStart: async (...args: [string | undefined, number?, string?]) => { startedWith.push(args); return { sessionId: 'draft-search' } },
      workspaceFileSearchSessionQuery: async () => [{ rel: 'a.ts', name: 'a.ts', isDir: false }],
      workspaceFileSearchSessionStop: async () => ({ ok: true }),
    }
    const session = new WorkspaceFileSearchSession(engine, null, '/workspace/selected')
    expect(await session.search('a')).toEqual([{ rel: 'a.ts', name: 'a.ts', isDir: false }])
    expect(startedWith).toEqual([[undefined, 30_000, '/workspace/selected']])
    await session.close()
  })

  test('a failed create propagates so the file group can show the root error', async () => {
    const { engine } = stubEngine({ startFails: true })
    const session = new WorkspaceFileSearchSession(engine, 'chat-1')
    await rejects(session.search('app'), /start_failed/)
  })

  test('closing before the first search never opens a native session', async () => {
    const { engine, calls } = stubEngine()
    const session = new WorkspaceFileSearchSession(engine, null, '/workspace/selected')
    await session.close()
    expect(await session.search('app')).toEqual([])
    expect(calls).toEqual([])
  })

  test('a failed query propagates so the file group can show its own error', async () => {
    const engine = {
      workspaceFileSearchSessionStart: async () => ({ sessionId: 'fss-1' }),
      workspaceFileSearchSessionQuery: async () => { throw new Error('SEARCH_LIMIT_EXCEEDED') },
      workspaceFileSearchSessionStop: async () => ({ ok: true }),
    }
    const session = new WorkspaceFileSearchSession(engine, 'chat-1')
    // Unlike a superseded search, a genuine failure is NOT swallowed: the group
    // must be able to render its error line.
    await rejects(session.search('app'), /SEARCH_LIMIT_EXCEEDED/)
  })
})
