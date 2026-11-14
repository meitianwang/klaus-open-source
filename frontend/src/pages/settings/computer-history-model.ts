// Pure presentation logic for the Computer History settings tab: payload
// parsing, domain normalization, policy grouping, and day-grouped timelines.
// Kept free of DOM and React so it is directly unit-testable.

export interface ObservationEntry { observe: 'include' | 'exclude'; scope: 'app' | 'url'; target: string }
export interface HistoryEntry { kind: 'app' | 'window'; at: number; bundleId?: string; name?: string; title?: string; url?: string }
export interface HistorySnapshot {
  status: { state: 'running' | 'paused' | 'stopped'; unavailableReason?: string; entryCount: number; retentionMs: number; managedDisabled: boolean }
  settings: { enabled: boolean; policy: ObservationEntry[]; managedDisabled: boolean }
}

export interface TimelineDayGroup {
  key: string
  label: string
  entries: HistoryEntry[]
}

const DOMAIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)+$/u

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
    status: {
      state,
      ...(typeof status.unavailableReason === 'string' && status.unavailableReason ? { unavailableReason: status.unavailableReason } : {}),
      entryCount: typeof status.entryCount === 'number' && Number.isFinite(status.entryCount) ? status.entryCount : 0,
      retentionMs: typeof status.retentionMs === 'number' && Number.isFinite(status.retentionMs) ? status.retentionMs : 0,
      managedDisabled: status.managedDisabled === true,
    },
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

/**
 * Normalize a pasted URL or typed hostname to a bare lowercase domain suitable
 * for observation-policy rules, stripping scheme, port, path, and leading www.
 */
export function normalizeDomainInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  let host = trimmed
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)) {
    try {
      const parsed = new URL(trimmed)
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
      host = parsed.hostname
    } catch { return null }
  } else {
    const slashIndex = host.search(/[/?#]/u)
    if (slashIndex >= 0) host = host.slice(0, slashIndex)
    const colonIndex = host.indexOf(':')
    if (colonIndex >= 0) host = host.slice(0, colonIndex)
  }
  host = host.trim().toLowerCase().replace(/\.+$/u, '')
  if (host.startsWith('www.')) host = host.slice(4)
  if (!host || host.length > 253 || !DOMAIN_PATTERN.test(host)) return null
  return host
}

export function subdomainPreviewExample(domain: string): string {
  if (domain === 'github.com') return 'gist.github.com'
  return `app.${domain}`
}

export function splitPolicyGroups(policy: readonly ObservationEntry[]): {
  includeEntries: ObservationEntry[]
  excludeEntries: ObservationEntry[]
} {
  const includeEntries: ObservationEntry[] = []
  const excludeEntries: ObservationEntry[] = []
  for (const entry of policy) {
    if (entry.observe === 'include') includeEntries.push(entry)
    else excludeEntries.push(entry)
  }
  return { includeEntries, excludeEntries }
}

/** Collapse consecutive identical rows and return newest-first day groups. */
export function groupTimelineByDay(
  entries: readonly HistoryEntry[],
  nowMs: number,
  locale: string,
  labels: { today: string; yesterday: string },
): TimelineDayGroup[] {
  const chronological = [...entries].sort((left, right) => left.at - right.at)
  const collapsed: HistoryEntry[] = []
  for (const item of chronological) {
    const prev = collapsed[collapsed.length - 1]
    if (prev
      && prev.kind === item.kind
      && (prev.bundleId ?? '') === (item.bundleId ?? '')
      && (prev.name ?? '') === (item.name ?? '')
      && (prev.title ?? '') === (item.title ?? '')
      && (entryDomain(prev) ?? '') === (entryDomain(item) ?? '')) {
      collapsed[collapsed.length - 1] = item
    } else {
      collapsed.push(item)
    }
  }
  const newestFirst = collapsed.reverse()
  const now = new Date(nowMs)
  const dayKey = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
  const todayKey = dayKey(now)
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1)
  const yesterdayKey = dayKey(yesterday)

  const groups: TimelineDayGroup[] = []
  for (const item of newestFirst) {
    const date = new Date(item.at)
    const key = dayKey(date)
    let current = groups[groups.length - 1]
    if (!current || current.key !== key) {
      const label = key === todayKey
        ? labels.today
        : key === yesterdayKey
          ? labels.yesterday
          : new Intl.DateTimeFormat(locale, date.getFullYear() === now.getFullYear()
            ? { month: 'long', day: 'numeric' }
            : { year: 'numeric', month: 'long', day: 'numeric' }).format(date)
      current = { key, label, entries: [] }
      groups.push(current)
    }
    current.entries.push(item)
  }
  return groups
}
