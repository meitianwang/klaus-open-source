type TimerHandle = ReturnType<typeof setTimeout>

interface TimerApi {
  set(callback: () => void, delayMs: number): TimerHandle
  clear(handle: TimerHandle): void
}

const defaultTimers: TimerApi = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: handle => clearTimeout(handle),
}

/** Low-frequency repair for missed terminal pushes; one timer is kept per active session. */
export function createBackgroundLifecyclePoller(
  poll: (sessionId: string) => boolean | Promise<boolean>,
  delayMs: number = 15_000,
  timers: TimerApi = defaultTimers,
) {
  const pending = new Map<string, TimerHandle>()

  function cancel(sessionId: string) {
    const handle = pending.get(sessionId)
    if (handle === undefined) return
    timers.clear(handle)
    pending.delete(sessionId)
  }

  function update(sessionId: string, active: boolean) {
    if (!sessionId || !active) {
      cancel(sessionId)
      return
    }
    if (pending.has(sessionId)) return
    const handle = timers.set(() => {
      pending.delete(sessionId)
      void Promise.resolve(poll(sessionId)).then(stillActive => update(sessionId, stillActive), () => update(sessionId, true))
    }, delayMs)
    pending.set(sessionId, handle)
  }

  return { cancel, update }
}
