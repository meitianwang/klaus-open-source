// Auto page-up for long transcripts.
//
// The old Klaus design hung a "Show N earlier messages" pill on top of the
// transcript and paged rendered messages on click. The current design has no
// such button: the loader is driven by reaching the top of the scroll
// container, loops while the viewport is still near the top, and the only
// visible chrome is a failure callout with a Retry action. This module is that
// state machine, parameterised over scroll metrics and an async loader so it
// stays unit-testable without a DOM.
//
// Predicates (distance from top = scrollHeight - clientHeight -
// distanceFromBottom = scrollTop):
// - pinned top (`scrollTop <= 0`): wheel-up / key-up / drag-up triggers only
//   fire while the container cannot scroll further up.
// - near top (`scrollTop <= max(clientHeight, 64)`): the upward-scroll trigger
//   and the loader loop condition; one viewport of headroom.
// - short content (the resize/content observer's condition, inverted): the
//   observer triggers while the content barely overflows the viewport
//   (scrollHeight - clientHeight <= 64), which is how a transcript shorter
//   than the window backfills without any scrolling.
// - the 64px overflow threshold doubles as both bounds above. No separate
//   at-top pixel threshold is needed here because our scroll source reports
//   direction itself.
// Loop body: while same generation and near top, await one page
// load; 'stop' ends it; after the prepend, break once the content grew past
// the 64px overflow threshold. A re-entrant trigger during an in-flight loop
// is dropped, and setEnabled(false) (failure callout state) gates everything.

export const NEAR_TOP_MIN_OVERFLOW_PX = 64

export type PageUpTrigger = 'wheel' | 'scroll' | 'key' | 'drag' | 'observer'

export interface PageUpMetrics {
  scrollTop: number
  scrollHeight: number
  clientHeight: number
}

export interface TranscriptPageUp {
  /** Returns true when the trigger started a load loop. */
  trigger(source: PageUpTrigger): boolean
  /** Content or viewport resized: re-evaluate the short-content trigger. */
  observe(): void
  /** Disable/enable the loop (the failure callout state disables it). */
  setEnabled(enabled: boolean): void
  /** True while a load loop is in flight. */
  isLoading(): boolean
  destroy(): void
}

export function isPinnedTop(metrics: PageUpMetrics): boolean {
  return metrics.scrollTop <= 0
}

export function isNearTop(metrics: PageUpMetrics): boolean {
  return metrics.scrollTop <= Math.max(metrics.clientHeight, NEAR_TOP_MIN_OVERFLOW_PX)
}

export function isShortContent(metrics: PageUpMetrics): boolean {
  return metrics.scrollHeight - metrics.clientHeight <= NEAR_TOP_MIN_OVERFLOW_PX
}

export function createTranscriptPageUp(options: {
  getMetrics: () => PageUpMetrics | null
  /** Load one older page. Resolves 'stop' when paging must not continue. */
  loadOlderPage: () => Promise<'stop' | 'continue'>
  enabled?: boolean
}): TranscriptPageUp {
  const { getMetrics, loadOlderPage } = options
  let enabled = options.enabled !== false
  let loading = false
  let generation = 0
  // Observer dedupe: the last clientHeight/scrollHeight pair is remembered so
  // a ResizeObserver echo of its own prepend does not retrigger.
  let lastObserverSize: { client: number; scroll: number } | null = null

  const runLoop = async (myGeneration: number) => {
    try {
      for (;;) {
        if (generation !== myGeneration) return
        const metrics = getMetrics()
        if (metrics == null || !isNearTop(metrics)) return
        const heightBefore = metrics.scrollHeight
        if (await loadOlderPage() === 'stop') return
        if (generation !== myGeneration) return
        const after = getMetrics()
        if (after == null) return
        // Break condition: the prepend pushed real content past the
        // overflow threshold (and, with a live tail above, actually grew).
        if (after.scrollHeight - after.clientHeight > NEAR_TOP_MIN_OVERFLOW_PX
          && after.scrollHeight > heightBefore) return
      }
    } finally {
      if (generation === myGeneration) {
        loading = false
        generation += 1
      }
    }
  }

  const trigger = (source: PageUpTrigger): boolean => {
    if (!enabled || loading) return false
    const metrics = getMetrics()
    if (metrics == null) return false
    const gate = source === 'observer' ? isShortContent(metrics)
      : source === 'scroll' ? isNearTop(metrics)
        : isPinnedTop(metrics)
    if (!gate) return false
    loading = true
    void runLoop(generation)
    return true
  }

  const observe = () => {
    const metrics = getMetrics()
    if (metrics == null) return
    if (lastObserverSize
      && lastObserverSize.client === metrics.clientHeight
      && lastObserverSize.scroll === metrics.scrollHeight) return
    lastObserverSize = { client: metrics.clientHeight, scroll: metrics.scrollHeight }
    trigger('observer')
  }

  return {
    trigger,
    observe,
    setEnabled(next: boolean) { enabled = next },
    isLoading: () => loading,
    destroy() { generation += 1; loading = false },
  }
}
