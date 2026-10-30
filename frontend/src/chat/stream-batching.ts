import { createStore, type StateCreator, type StoreApi } from 'zustand/vanilla'

/** Keep synchronous reads while publishing one notification for an ordered batch. */
export function createTransactionalStore<T>(initialize: StateCreator<T>) {
  const store = createStore<T>(initialize)
  const listeners = new Set<(state: T, previous: T) => void>()
  let depth = 0
  let pending: { previous: T } | null = null
  store.subscribe((state, previous) => {
    if (depth) { pending ??= { previous }; return }
    for (const listener of listeners) listener(state, previous)
  })
  store.subscribe = (listener: Parameters<StoreApi<T>['subscribe']>[0]) => {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }
  return {
    store,
    transact(run: () => void) {
      depth++
      try { run() } finally {
        if (--depth === 0 && pending) {
          const previous = pending.previous
          pending = null
          for (const listener of listeners) listener(store.getState(), previous)
        }
      }
    },
  }
}

export interface FrameScheduler {
  frame(callback: () => void): () => void
  timeout(callback: () => void): () => void
  visible(): boolean
  watchVisibility?(callback: () => void): () => void
}

type QueuedEvent = { event: any; context: { userInterrupted?: boolean } }

function appendField(event: any): 'text' | 'thinking' | null {
  return event?.type === 'text_delta' ? 'text' : event?.type === 'thinking_delta' ? 'thinking' : null
}

function activity(event: any): any { return event?.type === 'agent_progress' ? event.event : event }

/** Structural boundaries always drain earlier text before becoming observable. */
export function createStreamFrameQueue(scheduler: FrameScheduler, apply: (events: QueuedEvent[]) => void) {
  let pending: QueuedEvent[] = []
  let cancelFrame: (() => void) | null = null
  let cancelTimeout: (() => void) | null = null
  let bufferedChars = 0
  let applying = false
  const cancel = () => { cancelFrame?.(); cancelTimeout?.(); cancelFrame = cancelTimeout = null }
  const flush = () => {
    if (applying || !pending.length) return
    cancel()
    const events = pending
    pending = []
    bufferedChars = 0
    applying = true
    try { apply(events) } finally { applying = false }
  }
  const stopVisibility = scheduler.watchVisibility?.(flush)
  return {
    flush,
    get applying() { return applying },
    enqueue(event: any, context: QueuedEvent['context'] = {}) {
      const value = activity(event)
      const field = appendField(value)
      // Progress keeps its individual records. Tool input is a JSON snapshot,
      // not concatenable text, and is intentionally a synchronous boundary.
      if (!field && value?.type !== 'progress') { flush(); apply([{ event, context }]); return }
      const previous = pending.at(-1)
      const priorValue = previous && activity(previous.event)
      if (field && previous && priorValue?.type === value.type && previous.context.userInterrupted === context.userInterrupted) {
        const withoutText = (source: any) => {
          if (source.type === 'agent_progress') return { ...source, event: { ...source.event, [field]: undefined } }
          return { ...source, [field]: undefined }
        }
        if (JSON.stringify(withoutText(previous.event)) === JSON.stringify(withoutText(event))) {
          const next = { ...value, [field]: String(priorValue[field] ?? '') + String(value[field] ?? '') }
          previous.event = event.type === 'agent_progress' ? { ...event, event: next } : next
        } else pending.push({ event, context })
      } else pending.push({ event, context })
      bufferedChars += field ? String(value[field] ?? '').length : 0
      if (bufferedChars >= 262_144 || pending.length >= 512) { flush(); return }
      if (!cancelTimeout) cancelTimeout = scheduler.timeout(flush)
      if (!cancelFrame && scheduler.visible()) cancelFrame = scheduler.frame(flush)
    },
    dispose() { flush(); cancel(); stopVisibility?.() },
  }
}
