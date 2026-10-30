import { describe, expect, test } from 'bun:test'
import { createBackgroundAgentPoller } from './background-agent-poll'

type TimerHandle = ReturnType<typeof setTimeout>

function fakeTimers() {
  let nextHandle = 1
  const callbacks = new Map<number, () => void>()
  const cleared: number[] = []
  const delays: number[] = []
  return {
    api: {
      set(callback: () => void, delayMs: number) {
        const handle = nextHandle++
        delays.push(delayMs)
        callbacks.set(handle, callback)
        return handle as unknown as TimerHandle
      },
      clear(handle: TimerHandle) {
        const value = handle as unknown as number
        cleared.push(value)
        callbacks.delete(value)
      },
    },
    callbacks,
    cleared,
    delays,
    run(handle: number) {
      const callback = callbacks.get(handle)
      callbacks.delete(handle)
      callback?.()
    },
  }
}

describe('background agent polling', () => {
  test('keeps independent polls alive for off-screen sessions', () => {
    const timers = fakeTimers()
    const polled: string[] = []
    const poller = createBackgroundAgentPoller(sessionId => { polled.push(sessionId) }, 1_500, timers.api)

    poller.update('visible', true)
    poller.update('background', true)

    expect([...timers.callbacks.keys()]).toEqual([1, 2])
    timers.run(2)
    expect(polled).toEqual(['background'])
    expect([...timers.callbacks.keys()]).toEqual([1])
  })

  test('stopping one session does not cancel another session poll', () => {
    const timers = fakeTimers()
    const poller = createBackgroundAgentPoller(() => {}, 1_500, timers.api)

    poller.update('first', true)
    poller.update('second', true)
    poller.update('first', false)

    expect(timers.cleared).toEqual([1])
    expect([...timers.callbacks.keys()]).toEqual([2])
  })

  test('rescheduling replaces only that session timer', () => {
    const timers = fakeTimers()
    const poller = createBackgroundAgentPoller(() => {}, 1_500, timers.api)

    poller.update('same', true)
    poller.update('same', true)

    expect(timers.cleared).toEqual([1])
    expect([...timers.callbacks.keys()]).toEqual([2])
  })

  test('a detached child recovers after failed pulls with bounded backoff', () => {
    const timers = fakeTimers()
    const polled: string[] = []
    const poller = createBackgroundAgentPoller(id => { polled.push(id) }, 1_500, timers.api)
    poller.update('child-only', true)
    timers.run(1)
    for (let round = 0; round < 7; round++) {
      poller.retry('child-only', true)
      timers.run(round + 2)
    }
    expect(polled).toEqual(Array(8).fill('child-only'))
    expect(timers.delays).toEqual([1_500, 3_000, 6_000, 12_000, 24_000, 30_000, 30_000, 30_000])
    poller.update('child-only', true)
    expect(timers.delays.at(-1)).toBe(1_500)
    poller.retry('child-only', false)
    expect(timers.callbacks.size).toBe(0)
  })
})
