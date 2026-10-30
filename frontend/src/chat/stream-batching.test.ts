import { describe, expect, test } from 'bun:test'
import { createStreamFrameQueue, createTransactionalStore, type FrameScheduler } from './stream-batching'

function scheduler() {
  let visible = true
  const frames = new Set<() => void>()
  const timers = new Set<() => void>()
  let visibility = () => {}
  const api: FrameScheduler = {
    visible: () => visible,
    frame: callback => { frames.add(callback); return () => { frames.delete(callback) } },
    timeout: callback => { timers.add(callback); return () => { timers.delete(callback) } },
    watchVisibility: callback => { visibility = callback; return () => { visibility = () => {} } },
  }
  return { api, frames, timers, frame: () => [...frames].forEach(run => run()), timer: () => [...timers].forEach(run => run()), hide: () => { visible = false; visibility() } }
}

describe('stream frame publication', () => {
  test('coalesces compatible text while preserving turn, inference and lifecycle boundaries', () => {
    const time = scheduler()
    const seen: any[] = []
    const queue = createStreamFrameQueue(time.api, events => seen.push(...events.map(item => item.event)))
    for (const text of ['one', ' two', ' three']) queue.enqueue({ sessionId: 'chat', type: 'text_delta', turnId: 'turn', text })
    expect(seen).toEqual([])
    queue.enqueue({ sessionId: 'chat', type: 'tool_start', toolCallId: 'tool' })
    expect(seen).toEqual([{ sessionId: 'chat', type: 'text_delta', turnId: 'turn', text: 'one two three' }, { sessionId: 'chat', type: 'tool_start', toolCallId: 'tool' }])
    queue.enqueue({ sessionId: 'chat', type: 'text_delta', turnId: 'turn', text: 'old', inference: { revision: 1 } })
    queue.enqueue({ sessionId: 'chat', type: 'text_delta', turnId: 'turn', text: 'new', inference: { revision: 2 } })
    time.frame()
    expect(seen.slice(-2).map(event => event.text)).toEqual(['old', 'new'])
    expect(time.timers.size).toBe(0)
  })

  test('drains on hidden-window transition and uses the timer while animation frames are unavailable', () => {
    const time = scheduler()
    const seen: any[] = []
    const queue = createStreamFrameQueue(time.api, events => seen.push(...events))
    queue.enqueue({ sessionId: 'chat', type: 'thinking_delta', thinking: 'before' })
    time.hide()
    expect(seen).toHaveLength(1)
    expect(time.frames.size).toBe(0)
    queue.enqueue({ sessionId: 'chat', type: 'thinking_delta', thinking: 'hidden' })
    expect(time.frames.size).toBe(0)
    time.timer()
    expect(seen).toHaveLength(2)
    queue.dispose()
  })

  test('keeps progress records and JSON argument snapshots intact', () => {
    const time = scheduler()
    const seen: any[] = []
    const queue = createStreamFrameQueue(time.api, events => seen.push(...events.map(item => item.event)))
    queue.enqueue({ sessionId: 'chat', type: 'progress', content: 'a' })
    queue.enqueue({ sessionId: 'chat', type: 'progress', content: 'b' })
    queue.enqueue({ sessionId: 'chat', type: 'tool_input_delta', delta: '{"a":1}' })
    queue.enqueue({ sessionId: 'chat', type: 'tool_input_delta', delta: '{"a":2}' })
    expect(seen.map(event => event.content ?? event.delta)).toEqual(['a', 'b', '{"a":1}', '{"a":2}'])
  })

  test('publishes one consistent previous/current state for a transaction with synchronous reads', () => {
    const { store, transact } = createTransactionalStore(() => ({ count: 0 }))
    const seen: number[][] = []
    store.subscribe((state, previous) => seen.push([previous.count, state.count]))
    transact(() => {
      store.setState({ count: 1 })
      expect(store.getState().count).toBe(1)
      transact(() => store.setState({ count: 2 }))
      expect(seen).toEqual([])
    })
    expect(seen).toEqual([[0, 2]])
  })
})
