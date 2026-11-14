// Renderer mirror of the `friends.enabled` preference so the sidebar navigation
// entry and composer mention picker react immediately when the user or an
// external preference write turns Friends on or off.
import { useEffect, useSyncExternalStore } from 'react'
import { FRIENDS_ENABLED_KEY, isFriendsFeatureEnabled } from '../../../../shared/friends'

type Listener = () => void

let enabledState = false
let revision = 0
const listeners = new Set<Listener>()
let boundOn: unknown = null
let unsubscribePreferences: (() => void) | null = null

function notify(): void {
  for (const listener of [...listeners]) listener()
}

function applyValue(next: boolean): void {
  if (enabledState === next) return
  enabledState = next
  notify()
}

function hostWindow(): any {
  return typeof window === 'undefined' ? null : (window as any)
}

export function readFriendsFeatureEnabledFromHost(): Promise<boolean> | null {
  const w = hostWindow()
  const kv = w?.klaus?.settings?.kv ?? w?.settingsApi?.kv
  const get = kv?.get
  if (typeof get === 'function') {
    return Promise.resolve(get.call(kv, FRIENDS_ENABLED_KEY)).then(raw =>
      isFriendsFeatureEnabled(raw == null ? undefined : String(raw)),
    )
  }
  if (typeof w?.klaus?.friends?.list === 'function') {
    return Promise.resolve(true)
  }
  return null
}

function bindHostSubscription(): void {
  const on = hostWindow()?.klaus?.on ?? null
  if (on === boundOn) return
  unsubscribePreferences?.()
  unsubscribePreferences = null
  boundOn = on
  if (typeof on?.appPreferencesChanged === 'function') {
    unsubscribePreferences = on.appPreferencesChanged((payload?: { key?: string }) => {
      if (payload?.key === FRIENDS_ENABLED_KEY) void refreshFriendsFeatureEnabled()
    }) ?? null
  }
}

export function getFriendsFeatureEnabled(): boolean {
  return enabledState
}

export function setFriendsFeatureEnabled(next: boolean): void {
  revision += 1
  applyValue(next)
}

export async function refreshFriendsFeatureEnabled(): Promise<boolean> {
  bindHostSubscription()
  const pending = readFriendsFeatureEnabledFromHost()
  if (!pending) return enabledState
  const token = ++revision
  try {
    const resolved = await pending
    if (token === revision) applyValue(resolved)
    return token === revision ? resolved : enabledState
  } catch {
    return enabledState
  }
}

export function subscribeFriendsFeatureEnabled(listener: Listener): () => void {
  bindHostSubscription()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useFriendsFeatureEnabled(): boolean {
  const enabled = useSyncExternalStore(subscribeFriendsFeatureEnabled, getFriendsFeatureEnabled, () => false)
  useEffect(() => {
    void refreshFriendsFeatureEnabled()
  }, [])
  return enabled
}

export interface FriendsSidebarGateDeps {
  setEntryVisible(visible: boolean): void
  onFriendsDisabled(): void
}

export function initFriendsSidebarGate(deps: FriendsSidebarGateDeps): { refresh(): Promise<boolean>; dispose(): void } {
  const sync = () => {
    const enabled = getFriendsFeatureEnabled()
    deps.setEntryVisible(enabled)
    if (!enabled) deps.onFriendsDisabled()
  }
  sync()
  const unsubscribe = subscribeFriendsFeatureEnabled(sync)
  return {
    refresh: async () => {
      const enabled = await refreshFriendsFeatureEnabled()
      deps.setEntryVisible(enabled)
      if (!enabled) deps.onFriendsDisabled()
      return enabled
    },
    dispose: () => unsubscribe(),
  }
}

export function resetFriendsFeatureEnabledForTest(initial = false): void {
  unsubscribePreferences?.()
  unsubscribePreferences = null
  boundOn = null
  revision += 1
  enabledState = initial
  listeners.clear()
}
