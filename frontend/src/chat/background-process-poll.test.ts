import { describe, expect, test } from 'bun:test'
import { createBackgroundLifecyclePoller } from './background-lifecycle-poll'

type TimerHandle = ReturnType<typeof setTimeout>

function fakeTimers() {
  let nextHandle = 1
  const callbacks = new Map<number, () => void>()
  const cleared: number[] = []
  return {
    api: {
      set(callback: () => void) {
        const handle = nextHandle++
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
    run(handle: number) {
      const callback = callbacks.get(handle)
      callbacks.delete(handle)
      callback?.()
    },
  }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0))

describe('background process lifecycle polling', () => {
  test('keeps auditing an active session until an authoritative idle snapshot', async () => {
    const timers = fakeTimers()
    const results = [true, false]
    const polled: string[] = []
    const poller = createBackgroundLifecyclePoller(sessionId => {
      polled.push(sessionId)
      return results.shift() ?? false
    }, 15_000, timers.api)

    poller.update('session', true)
    poller.update('session', true)
    expect([...timers.callbacks.keys()]).toEqual([1])
    timers.run(1)
    await settle()
    expect(polled).toEqual(['session'])
    expect([...timers.callbacks.keys()]).toEqual([2])
    timers.run(2)
    await settle()
    expect([...timers.callbacks.keys()]).toEqual([])
  })

  test('a failed snapshot retries and a pushed terminal cancels the retry', async () => {
    const timers = fakeTimers()
    const poller = createBackgroundLifecyclePoller(async () => { throw new Error('temporary') }, 15_000, timers.api)

    poller.update('session', true)
    timers.run(1)
    await settle()
    expect([...timers.callbacks.keys()]).toEqual([2])
    poller.update('session', false)
    expect(timers.cleared).toEqual([2])
    expect([...timers.callbacks.keys()]).toEqual([])
  })
})
