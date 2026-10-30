import { describe, expect, test } from 'bun:test'
import vectors from '../../../../contracts/vectors/composer-prediction-vectors.json'
import { predictionAcceptanceKey, createPredictionSessionSelector, createPredictionSourceResolver, type PredictionSession, type PredictionSourceReply, type PredictionSourceState } from './predictions'

describe('prediction adoption', () => {
  const key = (value: string, overrides: Record<string, unknown> = {}) => ({ key: value, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, keyCode: 0, ...overrides })
  test('all three unmodified adoption keys create a draft', () => {
    for (const value of ['Tab', 'ArrowRight', 'Enter']) expect(predictionAcceptanceKey(key(value))).toBe(true)
    for (const value of ['Escape', 'ArrowLeft', ' ', 'a']) expect(predictionAcceptanceKey(key(value))).toBe(false)
  })
  test('modifiers and composition leave keyboard ownership with the editor', () => {
    for (const value of ['Tab', 'ArrowRight', 'Enter']) {
      for (const modifier of ['shiftKey', 'altKey', 'ctrlKey', 'metaKey', 'isComposing']) expect(predictionAcceptanceKey(key(value, { [modifier]: true }))).toBe(false)
      expect(predictionAcceptanceKey(key(value, { keyCode: 229 }))).toBe(false)
    }
  })
})

describe('prediction source revisions', () => {
  const sourceState = (): PredictionSourceState => ({ history: [], historyGeneration: 1,
    turnStatuses: { terminal: 'completed' }, activeTurnId: null, liveTurnId: null, lastTerminalStatus: 'completed' })

  test('unrelated stream replacements cannot starve an in-flight source lookup', async () => {
    const select = createPredictionSessionSelector()
    let stream = sourceState()
    let resolve!: (reply: PredictionSourceReply) => void
    let reads = 0
    const resolver = createPredictionSourceResolver({
      session: () => select('a', stream),
      source: () => { reads++; return new Promise(done => { resolve = done }) },
    })
    const pending = resolver.resolve('live', 'terminal')
    await Promise.resolve()
    const revision = select('a', stream).sourceRevision
    for (let index = 0; index < 214; index++) {
      stream = { ...stream }
      expect(select('a', stream).sourceRevision).toBe(revision)
      expect(resolver.target()).toBeNull()
    }
    stream = { ...stream, ...{ agentTasks: {}, turnCollapseOverrides: {}, modelUpdate: null } }
    expect(select('a', stream).sourceRevision).toBe(revision)
    resolve({ turnId: 'terminal' })
    const result = await pending
    expect(result?.target).toEqual({ sessionId: 'a', turnId: 'terminal' })
    expect(resolver.takeTrigger(result!)).toBe('live')
    expect((await resolver.resolve())?.target.turnId).toBe('terminal')
    expect(reads).toBe(1)
  })

  test('history, lifecycle and session changes invalidate the source revision', () => {
    const patches: Partial<PredictionSourceState>[] = [
      { history: [] }, { historyGeneration: 2 }, { turnStatuses: { empty: 'failed' } },
      { activeTurnId: 'new' }, { liveTurnId: 'new' }, { lastTerminalStatus: 'failed' },
    ]
    for (const patch of patches) {
      const select = createPredictionSessionSelector()
      const stream = sourceState()
      const previous = select('a', stream)
      expect(select('a', { ...stream, ...patch }).sourceRevision).not.toBe(previous.sourceRevision)
    }
    const select = createPredictionSessionSelector()
    const stream = sourceState()
    const previous = select('a', stream)
    expect(select('b', stream).sessionId).toBe('b')
    expect(select('a', stream).sourceRevision).not.toBe(previous.sourceRevision)
  })
})

describe('prediction source turns', () => {
  function fixture() {
    let session: PredictionSession | null = { sessionId: 'a', sourceRevision: {} }
    const reads: Array<{ sessionId: string; resolve(reply: PredictionSourceReply): void; reject(error: Error): void }> = []
    const resolver = createPredictionSourceResolver({
      session: () => session,
      source: sessionId => new Promise((resolve, reject) => { reads.push({ sessionId, resolve, reject }) }),
    })
    return { resolver, reads, session: (value: PredictionSession | null) => { session = value } }
  }

  test('the host selects an empty terminal turn despite tied clocks and unordered metadata', async () => {
    const f = fixture()
    f.session({ sessionId: 'a', sourceRevision: { history: [{ turnId: 'old' }],
      turnStatuses: { empty: 'failed', old: 'completed' }, turnStartedAtMs: { old: 100, empty: 100 }, turnFinishedAtMs: { old: 100, empty: 100 } } })
    const read = f.resolver.resolve()
    await Promise.resolve()
    f.reads[0]!.resolve({ turnId: 'empty' })
    expect((await read)?.target).toEqual({ sessionId: 'a', turnId: 'empty' })
    expect(f.resolver.target()).toEqual({ sessionId: 'a', turnId: 'empty' })
  })

  test('source reads are single-flight and a live request survives later catch-up refreshes', async () => {
    const f = fixture()
    const first = f.resolver.resolve('live', 'terminal')
    const second = f.resolver.resolve('catch_up')
    await Promise.resolve()
    expect(f.reads.length).toBe(1)
    f.reads[0]!.resolve({ turnId: 'terminal' })
    const source = await first
    await second
    expect(f.resolver.takeTrigger(source!)).toBe('live')
    await f.resolver.resolve()
    expect(f.reads.length).toBe(1)
  })

  test('a rollback revision ignores the old source without transferring its live trigger', async () => {
    const f = fixture()
    const old = f.resolver.resolve('live', 'removed')
    await Promise.resolve()
    f.session({ sessionId: 'a', sourceRevision: { rollback: true } })
    expect(f.resolver.target()).toBeNull()
    const current = f.resolver.resolve('catch_up')
    await Promise.resolve()
    f.reads[1]!.resolve({ turnId: 'retained' })
    const source = await current
    f.reads[0]!.resolve({ turnId: 'removed' })
    expect(await old).toBeNull()
    expect(f.resolver.target()).toEqual({ sessionId: 'a', turnId: 'retained' })
    expect(f.resolver.takeTrigger(source!)).toBe('catch_up')
  })

  test('hydration of the same actual turn preserves its pending live trigger', async () => {
    const f = fixture()
    const old = f.resolver.resolve('live', 'terminal')
    await Promise.resolve()
    f.session({ sessionId: 'a', sourceRevision: { historyLoaded: true } })
    const current = f.resolver.resolve('catch_up')
    await Promise.resolve()
    f.reads[0]!.resolve({ turnId: 'terminal' })
    expect(await old).toBeNull()
    f.reads[1]!.resolve({ turnId: 'terminal' })
    const source = await current
    expect(f.resolver.takeTrigger(source!)).toBe('live')
  })

  test('switching away and back cannot adopt a late read from the earlier scope', async () => {
    const f = fixture()
    const revision = {}
    f.session({ sessionId: 'a', sourceRevision: revision })
    const old = f.resolver.resolve()
    await Promise.resolve()
    f.session({ sessionId: 'b', sourceRevision: {} })
    const other = f.resolver.resolve()
    await Promise.resolve()
    f.reads[1]!.resolve({ turnId: 'b-turn' })
    await other
    f.session({ sessionId: 'a', sourceRevision: revision })
    const current = f.resolver.resolve()
    await Promise.resolve()
    f.reads[0]!.resolve({ turnId: 'stale-a' })
    expect(await old).toBeNull()
    expect(f.resolver.target()).toBeNull()
    f.reads[2]!.resolve({ turnId: 'current-a' })
    expect((await current)?.target.turnId).toBe('current-a')
  })

  test('invalidating and closing ignore pending source replies', async () => {
    const f = fixture()
    const invalidated = f.resolver.resolve()
    await Promise.resolve()
    f.resolver.invalidate('a')
    f.reads[0]!.resolve({ turnId: 'invalidated' })
    expect(await invalidated).toBeNull()
    const closing = f.resolver.resolve()
    await Promise.resolve()
    f.resolver.dispose()
    f.reads[1]!.resolve({ turnId: 'closed' })
    expect(await closing).toBeNull()
    expect(f.resolver.target()).toBeNull()
  })

  test('closing before dispatch does not start a queued source lookup', async () => {
    const f = fixture()
    const closing = f.resolver.resolve()
    f.resolver.dispose()
    expect(await closing).toBeNull()
    expect(f.reads.length).toBe(0)
  })

  test('a live refresh without a terminal identity uses catch-up sampling', async () => {
    const f = fixture()
    const read = f.resolver.resolve('live')
    await Promise.resolve()
    f.reads[0]!.resolve({ turnId: 'terminal' })
    expect(f.resolver.takeTrigger((await read)!)).toBe('catch_up')
  })

  test('ordinary refreshes leave null and failed source reads settled', async () => {
    const f = fixture()
    const empty = f.resolver.resolve()
    await Promise.resolve()
    f.reads[0]!.resolve({ turnId: null, reason: 'running' })
    expect(await empty).toBeNull()
    await f.resolver.resolve()
    expect(f.reads.length).toBe(1)
    f.session({ sessionId: 'a', sourceRevision: {} })
    const failed = f.resolver.resolve()
    await Promise.resolve()
    f.reads[1]!.reject(new Error('unavailable'))
    expect(await failed).toBeNull()
    await f.resolver.resolve()
    expect(f.reads.length).toBe(2)
  })

  for (const reason of vectors.sourceTurn.recovery.retryableReasons) {
    test(`focus recovery rechecks a ${reason} source without restarting on unrelated updates`, async () => {
      const select = createPredictionSessionSelector()
      let stream: PredictionSourceState = { history: [], historyGeneration: 1, turnStatuses: {},
        activeTurnId: null, liveTurnId: 'terminal', lastTerminalStatus: 'completed' }
      let reads = 0
      const resolver = createPredictionSourceResolver({
        session: () => select('a', stream),
        source: async () => ++reads === 1 ? { turnId: null, reason } : { turnId: 'terminal' },
      })
      expect(await resolver.resolve('live', 'terminal')).toBeNull()
      for (let index = 0; index < 214; index++) {
        stream = { ...stream }
        expect(await resolver.resolve()).toBeNull()
      }
      expect(reads).toBe(1)
      expect(resolver.retryFailed()).toBe(true)
      const recovered = await resolver.resolve()
      expect(recovered?.target).toEqual({ sessionId: 'a', turnId: 'terminal' })
      expect(resolver.takeTrigger(recovered!)).toBe('catch_up')
      expect(resolver.retryFailed()).toBe(false)
      await resolver.resolve()
      expect(reads).toBe(2)
    })
  }

  test('rejected source reads recover once and share the new in-flight lookup', async () => {
    const f = fixture()
    const failed = f.resolver.resolve()
    await Promise.resolve()
    f.reads[0]!.reject(new Error('Source RPC failed'))
    expect(await failed).toBeNull()
    expect(f.resolver.retryFailed()).toBe(true)
    const first = f.resolver.resolve()
    expect(f.resolver.retryFailed()).toBe(false)
    const second = f.resolver.resolve()
    await Promise.resolve()
    expect(f.reads.length).toBe(2)
    f.reads[1]!.resolve({ turnId: 'terminal' })
    expect((await first)?.target.turnId).toBe('terminal')
    expect((await second)?.target.turnId).toBe('terminal')
  })

  test('a recovery failure waits for another explicit focus before reading again', async () => {
    const f = fixture()
    for (let attempt = 0; attempt < 2; attempt++) {
      const pending = f.resolver.resolve()
      await Promise.resolve()
      f.reads[attempt]!.resolve({ turnId: null, reason: 'unavailable' })
      expect(await pending).toBeNull()
      expect(await f.resolver.resolve()).toBeNull()
      expect(f.reads.length).toBe(attempt + 1)
      expect(f.resolver.retryFailed()).toBe(true)
    }
    const recovered = f.resolver.resolve()
    await Promise.resolve()
    f.reads[2]!.resolve({ turnId: 'terminal' })
    expect((await recovered)?.target.turnId).toBe('terminal')
    expect(f.resolver.retryFailed()).toBe(false)
  })

  for (const reason of vectors.sourceTurn.recovery.settledReasons) {
    test(`focus preserves a settled ${reason ?? 'empty'} source`, async () => {
      const f = fixture()
      const pending = f.resolver.resolve()
      expect(f.resolver.retryFailed()).toBe(false)
      await Promise.resolve()
      f.reads[0]!.resolve({ turnId: null, ...(reason ? { reason } : {}) })
      expect(await pending).toBeNull()
      expect(f.resolver.retryFailed()).toBe(false)
      expect(await f.resolver.resolve()).toBeNull()
      expect(f.reads.length).toBe(1)
    })
  }

  test('a recovery lookup cannot adopt a late source after invalidation', async () => {
    const f = fixture()
    const failed = f.resolver.resolve()
    await Promise.resolve()
    f.reads[0]!.resolve({ turnId: null, reason: 'unavailable' })
    await failed
    expect(f.resolver.retryFailed()).toBe(true)
    const recovery = f.resolver.resolve()
    await Promise.resolve()
    f.resolver.invalidate('a')
    f.reads[1]!.resolve({ turnId: 'retired' })
    expect(await recovery).toBeNull()
    expect(f.resolver.target()).toBeNull()
  })
})
