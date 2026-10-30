interface LifecycleTimes {
  updatedAtMs?: unknown
  completedAtMs?: unknown
}

export function lifecycleUpdatedAt(info: LifecycleTimes): number | undefined {
  const times = [info.updatedAtMs, info.completedAtMs]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
  return times.length ? Math.max(...times) : undefined
}

export function lifecycleIsOlder(
  previous: { lifecycleUpdatedAtMs?: unknown },
  incoming: LifecycleTimes,
): boolean {
  const before = previous.lifecycleUpdatedAtMs
  const after = lifecycleUpdatedAt(incoming)
  return typeof before === 'number' && Number.isFinite(before)
    && after !== undefined && after < before
}

// Presentation updates and optimistic stops must not version the engine's state.
export function lifecycleVersion(info: LifecycleTimes): { lifecycleUpdatedAtMs?: number } {
  const at = lifecycleUpdatedAt(info)
  return at === undefined ? {} : { lifecycleUpdatedAtMs: at }
}
