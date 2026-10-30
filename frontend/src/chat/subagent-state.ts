let version = 0
const listeners = new Set<() => void>()

export function notifySubagentsChanged(): void {
  version += 1
  for (const listener of listeners) listener()
}

export function subscribeSubagents(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function subagentsVersion(): number {
  return version
}
