// Pure presentation logic for the Computer History settings tab: payload
// parsing and entry labels. Kept free of DOM and React so it is unit-testable.

export interface ObservationEntry { observe: 'include' | 'exclude'; scope: 'app' | 'url'; target: string }
export interface HistoryEntry { kind: 'app' | 'window'; at: number; bundleId?: string; name?: string; title?: string; url?: string }
export interface HistorySnapshot {
  status: { state: 'running' | 'paused' | 'stopped'; unavailableReason?: string; entryCount: number; retentionMs: number; managedDisabled: boolean }
  settings: { enabled: boolean; policy: ObservationEntry[]; managedDisabled: boolean }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

export function parseHistorySnapshot(value: unknown): HistorySnapshot {
  if (!isRecord(value) || !isRecord(value.status) || !isRecord(value.settings)) throw new Error('Invalid Computer History payload')
  const status = value.status, settings = value.settings
  const state = status.state
  if (state !== 'running' && state !== 'paused' && state !== 'stopped') throw new Error('Invalid Computer History state')
  const policy = Array.isArray(settings.policy)
    ? settings.policy.flatMap((item): ObservationEntry[] => isRecord(item)
      && (item.observe === 'include' || item.observe === 'exclude')
      && (item.scope === 'app' || item.scope === 'url')
      && typeof item.target === 'string' && item.target.length > 0
      ? [{ observe: item.observe, scope: item.scope, target: item.target }] : [])
    : []
  return {
    status: { state,
      ...(typeof status.unavailableReason === 'string' && status.unavailableReason ? { unavailableReason: status.unavailableReason } : {}),
      entryCount: typeof status.entryCount === 'number' && Number.isFinite(status.entryCount) ? status.entryCount : 0,
      retentionMs: typeof status.retentionMs === 'number' && Number.isFinite(status.retentionMs) ? status.retentionMs : 0,
      managedDisabled: status.managedDisabled === true },
    settings: { enabled: settings.enabled === true, policy, managedDisabled: settings.managedDisabled === true },
  }
}

export function parseEntriesPayload(value: unknown): HistoryEntry[] {
  if (!isRecord(value) || !Array.isArray(value.entries)) return []
  return value.entries.flatMap((item): HistoryEntry[] => {
    if (!isRecord(item) || (item.kind !== 'app' && item.kind !== 'window')) return []
    if (typeof item.at !== 'number' || !Number.isFinite(item.at)) return []
    const text = (input: unknown): string | undefined => typeof input === 'string' && input.length > 0 ? input : undefined
    const entry: HistoryEntry = { kind: item.kind, at: item.at }
    const bundleId = text(item.bundleId), name = text(item.name), title = text(item.title), url = text(item.url)
    if (bundleId) entry.bundleId = bundleId
    if (name) entry.name = name
    if (title) entry.title = title
    if (url) entry.url = url
    return [entry]
  })
}

/** HH:MM in local time; the timeline is a same-device review surface. */
export function formatEntryTime(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function entrySource(entry: HistoryEntry): string {
  return entry.name ?? entry.bundleId ?? ''
}

export function entryDomain(entry: HistoryEntry): string | undefined {
  if (!entry.url) return undefined
  try {
    const url = new URL(entry.url)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : undefined
  } catch { return undefined }
}
