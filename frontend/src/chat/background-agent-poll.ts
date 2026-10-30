type TimerHandle = ReturnType<typeof setTimeout>

interface TimerApi {
  set(callback: () => void, delayMs: number): TimerHandle
  clear(handle: TimerHandle): void
}

const defaultTimers: TimerApi = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: handle => clearTimeout(handle),
}

export function createBackgroundAgentPoller(
  poll: (sessionId: string) => void | Promise<void>,
  delayMs: number = 1_500,
  timers: TimerApi = defaultTimers,
) {
  const pending = new Map<string, TimerHandle>()
  const failures = new Map<string, number>()

  function cancel(sessionId: string) {
    const handle = pending.get(sessionId)
    if (handle === undefined) return
    timers.clear(handle)
    pending.delete(sessionId)
  }

  function schedule(sessionId: string, shouldPoll: boolean, delay: number) {
    cancel(sessionId)
    if (!sessionId || !shouldPoll) return
    const handle = timers.set(() => {
      pending.delete(sessionId)
      void poll(sessionId)
    }, delay)
    pending.set(sessionId, handle)
  }

  function update(sessionId: string, shouldPoll: boolean) {
    failures.delete(sessionId)
    schedule(sessionId, shouldPoll, delayMs)
  }

  function retry(sessionId: string, shouldPoll: boolean) {
    if (!shouldPoll) { update(sessionId, false); return }
    const count = Math.min((failures.get(sessionId) ?? 0) + 1, 5)
    failures.set(sessionId, count)
    schedule(sessionId, true, Math.min(delayMs * 2 ** count, 30_000))
  }

  return { cancel, update, retry }
}
