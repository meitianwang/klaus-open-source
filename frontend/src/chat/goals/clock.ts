interface GoalClock {
  now(): number
  everySecond(tick: () => void): () => void
}

/** Return the cleanup so hidden panels and terminal goals never keep ticking. */
export function startGoalClock(tick: (now: number) => void, clock: GoalClock = {
  now: Date.now,
  everySecond(callback) {
    const interval = globalThis.setInterval(callback, 1000)
    return () => globalThis.clearInterval(interval)
  },
}): () => void {
  tick(clock.now())
  return clock.everySecond(() => tick(clock.now()))
}
