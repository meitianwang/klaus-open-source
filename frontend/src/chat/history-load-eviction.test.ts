import { describe, expect, test } from 'bun:test'
import vectors from '../../../contracts/vectors/history-load-ownership-vectors.json'

;(globalThis as any).window ||= {}
;(globalThis as any).window.addEventListener ||= () => {}
const stream = await import('./stream-store')

describe('opening a conversation while protected streams exceed the cache budget', () => {
  test('the first read commits instead of leaving the skeleton on screen', async () => {
    // Switching requests history before mounting the target. A protected large
    // conversation forces cache trimming during that otherwise idle interval.
    const mounted = 'eviction-mounted-large'
    const target = 'eviction-target'
    const previousApi = (window as any).klaus
    ;(window as any).klaus = { session: { history: async (sessionId: string) => [{
      role: 'user', uuid: sessionId, turnId: sessionId,
      text: sessionId === mounted ? 'x'.repeat(vectors.cachePressure.protectedTextBytes) : vectors.cachePressure.expectedText,
    }] } }
    const releaseMounted = stream.retainSessionStream(mounted)
    let releaseTarget = () => {}
    try {
      await stream.loadSessionHistory(mounted)
      // Same order as a sidebar switch: request history, then mount the transcript.
      const loading = stream.loadSessionHistory(target)
      releaseTarget = stream.retainSessionStream(target)
      await loading
      const state = stream.getSessionStream(target)
      expect(state.historyLoading).toBe(vectors.cachePressure.expectedHistoryLoadingAfterRead)
      expect(state.history?.[0]?.text).toBe(vectors.cachePressure.expectedText)
    } finally {
      releaseTarget(); releaseMounted()
      for (const id of [mounted, target]) stream.retireSessionStream(id)
      ;(window as any).klaus = previousApi
    }
  })
})
