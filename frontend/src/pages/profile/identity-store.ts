let pending: Promise<unknown> = Promise.resolve()

/** Apply account events and explicit profile saves in arrival order. */
export function serializeIdentityWrite<T>(write: () => Promise<T>): Promise<T> {
  const result = pending.catch(() => {}).then(write)
  pending = result
  return result
}
