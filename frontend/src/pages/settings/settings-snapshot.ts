import { useCallback, useEffect, useRef, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react'

interface Snapshot<T> { value: T; revision: number; generation: object }
const snapshots = new Map<string, Snapshot<unknown>>()
const listeners = new Map<string, Set<() => void>>()

function readSnapshot<T>(key: string, initialValue: T): Snapshot<T> {
  if (!snapshots.has(key)) snapshots.set(key, { value: initialValue, revision: 0, generation: {} })
  return snapshots.get(key) as Snapshot<T>
}

/** Retain view data across tab mounts while subscriptions follow mounted views. */
export function useSettingsSnapshot<T>(key: string, initialValue: T): [
  T, Dispatch<SetStateAction<T>>, () => (value: SetStateAction<T>) => boolean,
] {
  const subscribe = useCallback((listener: () => void) => {
    if (!listeners.has(key)) listeners.set(key, new Set())
    const group = listeners.get(key)!
    group.add(listener)
    return () => { group.delete(listener); if (!group.size) listeners.delete(key) }
  }, [key])
  const getSnapshot = useCallback(() => readSnapshot(key, initialValue), [key])
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
  const generation = snapshot.generation
  const mounted = useRef(false)
  const keyRef = useRef(key)
  keyRef.current = key
  const sequence = useRef(0)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const publish = useCallback((value: SetStateAction<T>, edit: boolean) => {
    const current = snapshots.get(key) as Snapshot<T> | undefined
    if (!current || current.generation !== generation) return false
    const next = typeof value === 'function' ? (value as (previous: T) => T)(current.value) : value
    // An unchanged resolved edit can mark a mutation barrier. An empty value
    // remains eligible for its first read when a subscription fires at startup.
    if (Object.is(next, current.value) && (!edit || next === null)) return true
    snapshots.set(key, { value: next, revision: current.revision + (edit ? 1 : 0), generation })
    // A save can settle after navigation; notify the newer mounted view too.
    for (const listener of [...(listeners.get(key) ?? [])]) listener()
    return true
  }, [key, generation])
  const update = useCallback<Dispatch<SetStateAction<T>>>(value => { publish(value, true) }, [publish])
  const beginRead = useCallback(() => {
    const revision = snapshots.get(key)?.revision
    const request = ++sequence.current
    return (value: SetStateAction<T>) => {
      const current = snapshots.get(key)
      // Reject prior-account, prior-scope and prior-edit background responses.
      if (!mounted.current || keyRef.current !== key || request !== sequence.current
        || current?.generation !== generation || current.revision !== revision) return false
      return publish(value, false)
    }
  }, [key, generation, publish])
  return [snapshot.value, update, beginRead]
}

/** Account boundaries invalidate cached identity data and restart active reads. */
export function clearSettingsSnapshots(prefix: string): void {
  for (const key of [...snapshots.keys()]) {
    if (!key.startsWith(prefix)) continue
    snapshots.delete(key)
    for (const listener of [...(listeners.get(key) ?? [])]) listener()
  }
}
