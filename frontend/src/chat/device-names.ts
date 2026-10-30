// Device-name resolution for cross-computer conversation communication.
//
// A delegation envelope carries the sender's host id (`sourceHostId`) and a
// `send_message_to_thread` call can target another computer, but neither side
// stores a human-readable name with the message: the account device list is the
// only place names live, and it is fetched over the bridge. This module keeps a
// synchronous cache of `deviceId → name` plus this computer's own device id, so
// transcript rows can say WHICH machine a message came from or went to — the
// thing that makes two devices talking read as two agents talking rather than
// one machine talking to itself.
//
// The cache is best-effort by design. An unknown id renders as "another
// computer" rather than blocking the transcript on a network round trip, and a
// failed fetch leaves the previous cache intact. Names are untrusted display
// data (the user sets them per device), so callers escape them like any label.
import { useSyncExternalStore } from 'react'

interface DeviceRow {
  id: string
  name: string
  platform?: string
  status?: string
  isCurrent?: boolean
}

let names = new Map<string, string>()
let localId = ''
let version = 0
let load: Promise<void> | null = null
const refreshing = new Set<string>()
const lastAttemptAt = new Map<string, number>()
const DEVICE_RETRY_MS = 60_000
const listeners = new Set<() => void>()

function publish(): void {
  version += 1
  for (const listener of listeners) listener()
}

export function subscribeDeviceNames(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export function deviceNamesVersion(): number {
  return version
}

/** Re-render when the device-name cache changes (a name arrives late). */
export function useDeviceNamesVersion(): number {
  return useSyncExternalStore(subscribeDeviceNames, deviceNamesVersion, deviceNamesVersion)
}

function apply(rows: unknown): void {
  const list = Array.isArray(rows) ? rows : []
  const next = new Map<string, string>()
  let current = ''
  for (const row of list) {
    if (!row || typeof row !== 'object') continue
    const device = row as DeviceRow
    if (typeof device.id !== 'string' || !device.id) continue
    if (typeof device.name === 'string' && device.name.trim()) next.set(device.id, device.name.trim())
    if (device.isCurrent === true) current = device.id
  }
  names = next
  if (current) localId = current
  publish()
}

/**
 * Warm the cache once per page. Safe to call repeatedly: concurrent callers
 * share one in-flight fetch, and a settled cache is never refetched here —
 * unknown ids go through {@link requestDeviceName} instead.
 */
function fetchDeviceNames(api: { devices: () => Promise<unknown> }): Promise<void> {
  return Promise.resolve()
    .then(() => api.devices())
    .then((result: unknown) => {
      const body = (result && typeof result === 'object' ? result : {}) as { ok?: boolean; devices?: unknown }
      if (body.ok === true) apply(body.devices)
    })
    .catch(() => { /* offline or unlinked account: rows stay empty */ })
}

export function ensureDeviceNamesLoaded(): Promise<void> {
  if (load) return load
  const api = (typeof window !== 'undefined' ? (window as any).klaus : null)?.settings?.mobileBridge
  if (!api?.devices) return Promise.resolve()
  load = fetchDeviceNames(api)
  return load
}

/**
 * Ask for one unknown device in the background, at most once per id per page.
 * Called from render-adjacent code when a row meets a host id the cache cannot
 * name yet, so the label upgrades itself on the next version bump.
 */
export function requestDeviceName(hostId: string): void {
  if (!hostId || names.has(hostId) || hostId === localId || refreshing.has(hostId)) return
  const now = Date.now()
  const lastAttempt = lastAttemptAt.get(hostId)
  if (lastAttempt !== undefined && now - lastAttempt < DEVICE_RETRY_MS) return
  const api = (typeof window !== 'undefined' ? (window as any).klaus : null)?.settings?.mobileBridge
  if (!api?.devices) return
  refreshing.add(hostId)
  lastAttemptAt.set(hostId, now)
  void ensureDeviceNamesLoaded()
    .then(() => names.has(hostId) || hostId === localId ? undefined : fetchDeviceNames(api))
    .finally(() => { refreshing.delete(hostId) })
}

/** This computer's device id, or '' before the first successful fetch. */
export function localDeviceId(): string {
  return localId
}

/**
 * The display name for a host id, or '' when it cannot be resolved. `local`
 * and this computer's own id resolve to '' on purpose: callers word local
 * deliveries without a device qualifier, and naming your own machine would
 * read as if the message came from somewhere else.
 */
export function deviceNameForHost(hostId: string | undefined | null): string {
  if (!hostId || hostId === 'local' || hostId === localId) return ''
  const known = names.get(hostId)
  if (known) return known
  requestDeviceName(hostId)
  return ''
}

/** Test hook: replace the cache wholesale. */
export function setDeviceNamesForTest(rows: Array<{ id: string; name: string; isCurrent?: boolean }>, currentId = ''): void {
  apply(rows.map(row => ({ ...row, isCurrent: row.isCurrent ?? row.id === currentId })))
}

// Warm once at page load: the transcript needs names before the first remote
// row renders, and the fetch is cheap and cached. Guarded so module import in
// tests and non-desktop contexts stays side-effect free.
if (typeof window !== 'undefined' && (window as any).klaus?.settings?.mobileBridge?.devices) void ensureDeviceNamesLoaded()
