// Saved transcript and change-record reads have independent lifetimes.
// A delayed change record must not hold the transcript in its loading state;
// per-session caches still seed completed change cards on a revisit.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'

let fileChangesRespond: (sessionId: string) => Promise<any> = async () => ({ turns: [] })
const fileChangesCalls: string[] = []
let currentSession: string | null = null

const turnRecord = (turnId: string, path = `/p/${turnId}.ts`) => ({
  turns: [{
    turnId,
    files: [{ path, name: `${turnId}.ts`, kind: 'modify', added: 3, removed: 1 }],
    stats: { linesAdded: 3, linesRemoved: 1 },
  }],
})

let savedWindow: any
let savedDocument: any
let store: typeof import('./stream-store')
let artifacts: typeof import('./overview/artifacts')
beforeAll(async () => {
  savedWindow = (globalThis as any).window
  savedDocument = (globalThis as any).document
  ;(globalThis as any).window = {
    addEventListener: () => {},
    currentLang: 'en',
    klaus: {
      session: {
        history: async (sessionId: string) => [
          { uuid: `u-${sessionId}`, role: 'user', text: 'q', turnId: 'turn-1' },
          { uuid: `a-${sessionId}`, role: 'assistant', turnId: 'turn-1', isFinalReply: true, text: 'a' },
        ],
        fileChanges: (sessionId: string) => {
          fileChangesCalls.push(sessionId)
          return fileChangesRespond(sessionId)
        },
      },
    },
  }
  ;(globalThis as any).document = { getElementById: () => null }
  const { setOverviewDeps } = await import('./overview/shared')
  store = await import('./stream-store')
  artifacts = await import('./overview/artifacts')
  setOverviewDeps({
    currentSessionId: () => currentSession,
    commandGroupKey: () => '',
    slashCommandDisplayName: () => '',
    specDocuments: () => [],
    subscribeSpecDocuments: () => () => {},
    openSpecDocument: () => {},
  })
})
afterAll(() => {
  if (savedWindow === undefined) delete (globalThis as any).window
  else (globalThis as any).window = savedWindow
  if (savedDocument === undefined) delete (globalThis as any).document
  else (globalThis as any).document = savedDocument
})

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(settle => { resolve = settle })
  return { promise, resolve }
}

describe('session-owned turn change records', () => {
  test('starts the change record while saved history is still pending', async () => {
    const sessionId = 'parallel-history-and-changes'
    const history = deferred<any[]>()
    const api = (window as any).klaus.session
    const previous = api.history
    api.history = () => history.promise
    fileChangesCalls.length = 0
    fileChangesRespond = async () => turnRecord('parallel-turn')
    try {
      const loading = store.loadSessionHistory(sessionId)
      expect(fileChangesCalls).toEqual([sessionId])
      expect(store.getSessionStream(sessionId).history).toBeNull()
      history.resolve([{ uuid: 'parallel-user', role: 'user', text: 'q' }])
      await loading
      expect(store.getSessionStream(sessionId).history).toHaveLength(1)
    } finally { api.history = previous }
  })

  test('late history fetches its own record, not the visible chat', async () => {
    currentSession = 'visible-chat'
    fileChangesCalls.length = 0
    fileChangesRespond = async id => turnRecord('turn-1', `/p/${id}.ts`)
    await store.loadSessionHistory('background-history')
    expect(fileChangesCalls).toEqual(['background-history'])
    expect(artifacts.artifactTurn('background-history', 'turn-1')?.files[0].path).toBe('/p/background-history.ts')
    expect(artifacts.artifactTurn('visible-chat', 'turn-1')).toBeNull()
  })

  test('reversed replies retain both caches even with the same turn id', async () => {
    const a = deferred<any>()
    const b = deferred<any>()
    fileChangesRespond = id => id === 'race-a' ? a.promise : b.promise
    currentSession = 'race-a'
    const loadA = artifacts.reloadArtifacts()
    currentSession = 'race-b'
    const loadB = artifacts.reloadArtifacts()
    b.resolve(turnRecord('shared-turn', '/p/b.ts'))
    await loadB
    a.resolve(turnRecord('shared-turn', '/p/a.ts'))
    await loadA
    expect(artifacts.artifactTurn('race-a', 'shared-turn')?.files[0].path).toBe('/p/a.ts')
    expect(artifacts.artifactTurn('race-b', 'shared-turn')?.files[0].path).toBe('/p/b.ts')
  })

  test('A to B to A reuses A without losing its in-flight response', async () => {
    const a = deferred<any>()
    const b = deferred<any>()
    fileChangesCalls.length = 0
    fileChangesRespond = id => id === 'return-a' ? a.promise : b.promise
    currentSession = 'return-a'
    const loadA = artifacts.reloadArtifacts()
    currentSession = 'return-b'
    const loadB = artifacts.reloadArtifacts()
    currentSession = 'return-a'
    const returnA = artifacts.reloadArtifacts()
    b.resolve(turnRecord('shared-turn', '/p/return-b.ts'))
    await loadB
    a.resolve(turnRecord('shared-turn', '/p/return-a.ts'))
    await Promise.all([loadA, returnA])
    expect(fileChangesCalls).toEqual(['return-a', 'return-b'])
    expect(artifacts.artifactTurn('return-a', 'shared-turn')?.files[0].path).toBe('/p/return-a.ts')
  })
  test('first-open history publishes while the change record is still pending', async () => {
    const sessionId = 'same-frame-first-open'
    currentSession = sessionId
    let settle!: (value: any) => void
    fileChangesRespond = () => new Promise(resolve => { settle = resolve })
    fileChangesCalls.length = 0

    const loading = store.loadSessionHistory(sessionId)
    await flush()
    await loading
    expect(store.getSessionStream(sessionId).history).toHaveLength(2)
    expect(store.getSessionStream(sessionId).historyLoading).toBe(false)
    expect(artifacts.artifactTurn(sessionId, 'turn-1')).toBeNull()
    // Concurrent reads share the independent change-record request.
    const second = artifacts.ensureArtifactsForSession(sessionId)
    expect(fileChangesCalls).toEqual([sessionId])

    settle(turnRecord('turn-1'))
    await second
    expect(store.getSessionStream(sessionId).history).toHaveLength(2)
    expect(artifacts.artifactTurn(sessionId, 'turn-1')?.files).toHaveLength(1)
  })

  test('重访会话：缓存同步播种，history 加载不再发记录请求', async () => {
    const sessionId = 'same-frame-first-open'
    expect(artifacts.artifactsReady(sessionId)).toBe(true)
    fileChangesRespond = async () => ({ turns: [] })

    // 切走：新会话拉它自己的（空）记录。
    currentSession = 'some-other-session'
    await artifacts.reloadArtifacts()
    expect(artifacts.artifactTurn(currentSession, 'turn-1')).toBeNull()

    // 切回：缓存同步播种，切换落地的当帧卡片数据就在；随后 history 加载命中
    // 缓存，不再发记录请求。
    currentSession = sessionId
    const refresh = artifacts.reloadArtifacts()
    expect(artifacts.artifactTurn(sessionId, 'turn-1')?.files).toHaveLength(1)
    const callsBefore = fileChangesCalls.length
    await store.loadSessionHistory(sessionId)
    expect(store.getSessionStream(sessionId).history).toHaveLength(2)
    expect(fileChangesCalls.length).toBe(callsBefore)
    await refresh
  })

  test('记录读取失败不挡转录', async () => {
    const sessionId = 'same-frame-record-fails'
    currentSession = sessionId
    fileChangesRespond = () => Promise.reject(new Error('record endpoint down'))

    await store.loadSessionHistory(sessionId)
    expect(store.getSessionStream(sessionId).history).toHaveLength(2)
    expect(store.getSessionStream(sessionId).historyLoadFailed).toBe(false)
  })
})
