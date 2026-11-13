type VisibilityEffect = (current: () => boolean) => (() => void) | void

/** Keep view state while disconnecting effects that belong only to a visible view. */
export function createVisibilityScope() {
  const effects = new Map<VisibilityEffect, (() => void) | void>()
  let active = true, disposed = false, activation = {}
  const startEffect = (start: VisibilityEffect) => {
    const owner = activation
    const stop = start(() => !disposed && active && activation === owner && effects.has(start))
    if (!disposed && active && activation === owner && effects.has(start)) effects.set(start, stop)
    else stop?.()
  }
  return {
    add(start: VisibilityEffect) {
      if (disposed || effects.has(start)) return
      effects.set(start, undefined)
      if (active) startEffect(start)
    },
    setActive(value: boolean) {
      if (disposed || active === value) return
      active = value
      activation = {}
      for (const [start, stop] of [...effects]) {
        if (!effects.has(start)) continue
        if (value) startEffect(start)
        else { effects.set(start, undefined); stop?.() }
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      active = false
      activation = {}
      const stops = [...effects.values()]
      effects.clear()
      for (const stop of stops) stop?.()
    },
  }
}
