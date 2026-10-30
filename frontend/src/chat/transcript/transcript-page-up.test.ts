import { describe, expect, test } from 'bun:test'
import {
  createTranscriptPageUp,
  isNearTop,
  isPinnedTop,
  isShortContent,
  NEAR_TOP_MIN_OVERFLOW_PX,
  type PageUpMetrics,
} from './transcript-page-up'

// Transcript scroll-layout gates:
// pinned-top gate for wheel/key/drag, one-viewport near-top gate for the
// upward-scroll trigger and the loop condition, 64px overflow gate for the
// short-content observer, and a generation-guarded loop that stops on 'stop',
// on leaving the near-top band, or once the prepend grew the content past the
// overflow threshold.
//
// The loader is a deferred the test resolves by hand: the loop awaits it, so
// an uncontrolled stub that always resolves 'continue' would spin the loop
// on microtasks forever (the real loader always ends on a null cursor or
// a grown container, which the assertions below model explicitly).

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

function harness(initial: PageUpMetrics) {
  const metrics = { ...initial }
  const calls: number[] = []
  let pending: ((result: 'stop' | 'continue') => void) | null = null
  const pageUp = createTranscriptPageUp({
    getMetrics: () => metrics,
    loadOlderPage: () => {
      calls.push(metrics.scrollHeight)
      return new Promise<'stop' | 'continue'>(resolve => { pending = resolve })
    },
  })
  const resolveLoad = (result: 'stop' | 'continue') => {
    const resolve = pending
    pending = null
    resolve?.(result)
  }
  return { metrics, calls, pageUp, resolveLoad }
}

describe('page-up predicates', () => {
  test('pinned top is exactly scrollTop <= 0', () => {
    expect(isPinnedTop({ scrollTop: 0, scrollHeight: 4000, clientHeight: 800 })).toBe(true)
    expect(isPinnedTop({ scrollTop: 1, scrollHeight: 4000, clientHeight: 800 })).toBe(false)
  })
  test('near top keeps one viewport of headroom with a 64px floor', () => {
    expect(NEAR_TOP_MIN_OVERFLOW_PX).toBe(64)
    expect(isNearTop({ scrollTop: 800, scrollHeight: 4000, clientHeight: 800 })).toBe(true)
    expect(isNearTop({ scrollTop: 801, scrollHeight: 4000, clientHeight: 800 })).toBe(false)
    expect(isNearTop({ scrollTop: 64, scrollHeight: 400, clientHeight: 50 })).toBe(true)
    expect(isNearTop({ scrollTop: 65, scrollHeight: 400, clientHeight: 50 })).toBe(false)
  })
  test('short content is overflow <= 64 regardless of scroll position', () => {
    expect(isShortContent({ scrollTop: 0, scrollHeight: 864, clientHeight: 800 })).toBe(true)
    expect(isShortContent({ scrollTop: 0, scrollHeight: 865, clientHeight: 800 })).toBe(false)
  })
})

describe('page-up loop', () => {
  test('wheel up at pinned top pages once and stops when the prepend grows past the overflow threshold', async () => {
    const h = harness({ scrollTop: 0, scrollHeight: 4000, clientHeight: 800 })
    expect(h.pageUp.trigger('wheel')).toBe(true)
    expect(h.calls).toHaveLength(1)
    // Simulate the prepend: content grew well past 64px of overflow.
    h.metrics.scrollHeight = 8000
    h.metrics.scrollTop = 3000
    h.resolveLoad('continue')
    await settle()
    expect(h.calls).toHaveLength(1)
    expect(h.pageUp.isLoading()).toBe(false)
  })

  test('loop keeps paging while the fold stays starved, and ends on stop', async () => {
    const h = harness({ scrollTop: 0, scrollHeight: 700, clientHeight: 800 })
    expect(h.pageUp.trigger('wheel')).toBe(true)
    expect(h.calls).toHaveLength(1)
    // Prepend that leaves the content still short: loop continues.
    h.metrics.scrollHeight = 760
    h.resolveLoad('continue')
    await settle()
    expect(h.calls).toHaveLength(2)
    h.metrics.scrollHeight = 820
    h.resolveLoad('stop')
    await settle()
    expect(h.calls).toHaveLength(2)
    expect(h.pageUp.isLoading()).toBe(false)
  })

  test('wheel away from pinned top is rejected', () => {
    const h = harness({ scrollTop: 500, scrollHeight: 4000, clientHeight: 800 })
    expect(h.pageUp.trigger('wheel')).toBe(false)
    expect(h.calls).toHaveLength(0)
  })

  test('upward scroll triggers anywhere in the near-top band, not only pinned', () => {
    const h = harness({ scrollTop: 700, scrollHeight: 4000, clientHeight: 800 })
    expect(h.pageUp.trigger('scroll')).toBe(true)
    expect(h.calls).toHaveLength(1)
  })

  test('re-entrant triggers during an in-flight load are dropped', async () => {
    const h = harness({ scrollTop: 0, scrollHeight: 4000, clientHeight: 800 })
    expect(h.pageUp.trigger('wheel')).toBe(true)
    expect(h.pageUp.trigger('wheel')).toBe(false)
    expect(h.pageUp.trigger('scroll')).toBe(false)
    h.resolveLoad('stop')
    await settle()
    expect(h.calls).toHaveLength(1)
  })

  test('the failure-callout gate blocks every trigger until re-enabled', async () => {
    const h = harness({ scrollTop: 0, scrollHeight: 4000, clientHeight: 800 })
    h.pageUp.setEnabled(false)
    expect(h.pageUp.trigger('wheel')).toBe(false)
    expect(h.pageUp.trigger('observer')).toBe(false)
    expect(h.calls).toHaveLength(0)
    h.pageUp.setEnabled(true)
    expect(h.pageUp.trigger('wheel')).toBe(true)
    expect(h.calls).toHaveLength(1)
    h.resolveLoad('stop')
    await settle()
  })

  test('observer backfills short content until the fold is no longer starved', async () => {
    const h = harness({ scrollTop: 0, scrollHeight: 820, clientHeight: 800 })
    h.pageUp.observe()
    expect(h.calls).toHaveLength(1)
    // Same size echo (ResizeObserver reporting its own prepend) is deduped.
    h.pageUp.observe()
    await settle()
    expect(h.calls).toHaveLength(1)
    // Still short after the page lands: the loop pages again on its own.
    h.resolveLoad('continue')
    await settle()
    expect(h.calls).toHaveLength(2)
    // Prepend that finally fills the viewport ends the loop.
    h.metrics.scrollHeight = 4000
    h.resolveLoad('continue')
    await settle()
    expect(h.calls).toHaveLength(2)
    expect(h.pageUp.isLoading()).toBe(false)
    // Content no longer short: the observer stays silent.
    h.pageUp.observe()
    await settle()
    expect(h.calls).toHaveLength(2)
  })
})
