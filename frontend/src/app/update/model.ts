// Pure update-notice model: no DOM, no window, no React. The host owns the
// transfer and its counters; this module decides which surface a status belongs
// on and how its numbers read, so both are testable without a renderer.

export type UpdateFailure = 'check-unavailable' | 'check-rejected' | 'download-failed' | 'install-failed' | 'unsupported'

export interface UpdateProgress {
  percent: number
  bytesPerSecond: number
  transferred: number
  total: number
  installing: boolean
}

export interface UpdateStatus {
  supported?: boolean
  state?: 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'error'
  currentVersion?: string
  availableVersion?: string | null
  error?: string | null
  errorKind?: UpdateFailure | null
  explicit?: boolean
  progress?: UpdateProgress | null
}

/** A dismissed offer stays quiet for half a day, then announces itself again. */
export const DISMISS_TTL_MS = 12 * 60 * 60 * 1000
export const DISMISS_STORAGE_KEY = 'klaus_update_dismissed'

export interface DismissRecord { version: string; timestamp: number }

export function parseDismissRecord(raw: string | null | undefined): DismissRecord | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as { version?: unknown; timestamp?: unknown }
    if (typeof value?.version !== 'string' || !value.version) return null
    if (typeof value.timestamp !== 'number' || !Number.isFinite(value.timestamp)) return null
    return { version: value.version, timestamp: value.timestamp }
  } catch { return null }
}

/** Only the same version inside its quiet window counts as dismissed. */
export function isDismissed(record: DismissRecord | null, version: string | null | undefined, now: number): boolean {
  if (!record || !version || record.version !== version) return false
  const age = now - record.timestamp
  return age >= 0 && age < DISMISS_TTL_MS
}

/** Binary units, two decimals, matching how the transfer counters are measured. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${parseFloat((bytes / Math.pow(1024, index)).toFixed(2))} ${units[index]}`
}

export type RemainingTime =
  | { kind: 'calculating' }
  | { kind: 'seconds'; count: number }
  | { kind: 'minutes'; count: number }
  | { kind: 'hoursMinutes'; hours: number; minutes: number }

/**
 * Remaining time from the smoothed speed, not the instantaneous one, so the
 * estimate does not jump with every chunk. An unknown or stalled speed reads as
 * "calculating" rather than a fabricated number.
 */
export function remainingTime(bytesPerSecond: number, transferred: number, total: number): RemainingTime {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0 || total <= 0) return { kind: 'calculating' }
  const seconds = Math.max(0, total - transferred) / bytesPerSecond
  if (!Number.isFinite(seconds)) return { kind: 'calculating' }
  if (seconds < 60) return { kind: 'seconds', count: Math.round(seconds) }
  if (seconds < 3600) return { kind: 'minutes', count: Math.round(seconds / 60) }
  return { kind: 'hoursMinutes', hours: Math.floor(seconds / 3600), minutes: Math.round((seconds % 3600) / 60) }
}

/** Whole percent for display; the bar itself keeps the fractional value. */
export function displayPercent(progress: UpdateProgress | null | undefined): number {
  const value = progress?.percent
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, Math.round(value)))
}

export type UpdateNotice =
  | { kind: 'up-to-date'; version: string }
  | { kind: 'failure'; failure: UpdateFailure; detail: string | null }

export interface NoticeState {
  /** Last status the model saw, so a repeated push is not a new event. */
  lastKey: string
  /** Version whose ready notice was already announced. */
  announcedReady: string | null
}

export function initialNoticeState(): NoticeState { return { lastKey: '', announcedReady: null } }

function statusKey(status: UpdateStatus): string {
  // Progress ticks share a key with their phase: only a phase change, a new
  // version or a new error is an event worth a notice. The running version is
  // part of the identity because an up-to-date result reports it.
  return [
    status.state ?? 'idle', status.currentVersion ?? '', status.availableVersion ?? '',
    status.errorKind ?? '', status.error ?? '',
  ].join('|')
}

/**
 * Result notices belong to a person's own attempt. A background check that
 * finds nothing, or fails, stays silent; the same outcome from a manual check
 * is reported once.
 */
export function noticeFor(status: UpdateStatus, state: NoticeState): UpdateNotice | null {
  const key = statusKey(status)
  const changed = key !== state.lastKey
  state.lastKey = key
  if (!changed || status.explicit !== true) return null
  if (status.state === 'idle') return { kind: 'up-to-date', version: status.currentVersion ?? '' }
  if (status.state === 'error') {
    return { kind: 'failure', failure: status.errorKind ?? 'check-unavailable', detail: status.error ?? null }
  }
  return null
}

export interface UpdateSurfaces {
  /** Persistent sidebar card for available, downloading, and ready offers. */
  banner: boolean
  /** Centered modal raised only once installation begins. */
  installingOverlay: boolean
}

export interface SurfaceInput {
  status: UpdateStatus | null
  /**
   * The person postponed this version. That silences the sidebar card until
   * the quiet window expires, they check again, or a download begins.
   */
  dismissed: boolean
  /**
   * The person clicked install and the hand-off is verifying before the host
   * enters `installing`. Raising the overlay immediately avoids dead clicks.
   */
  installRequested?: boolean
}

export function surfacesFor({ status, dismissed, installRequested }: SurfaceInput): UpdateSurfaces {
  const state = status?.state ?? 'idle'
  const supported = status?.supported !== false
  if (state === 'installing') return { banner: false, installingOverlay: true }
  if (!supported) return { banner: false, installingOverlay: false }
  const available = state === 'available' && Boolean(status?.availableVersion)
  const transferring = state === 'downloading'
  const ready = state === 'downloaded' && Boolean(status?.availableVersion)
  // Clicking install opens the centered installation hand-off immediately while
  // the host re-verifies the release; downloading and ready stay in the card.
  if (installRequested === true && ready) return { banner: false, installingOverlay: true }
  if (transferring) return { banner: true, installingOverlay: false }
  return {
    banner: (available || ready) && !dismissed,
    installingOverlay: false,
  }
}

/** Settings-page action label: every phase names itself, never a neighbouring one. */
export type SettingsAction = 'check' | 'checking' | 'available' | 'downloading' | 'install' | 'installing'

export function settingsActionFor(
  status: UpdateStatus | null,
  checking: boolean,
  installing: boolean,
  downloading = false,
): SettingsAction {
  const state = status?.state ?? 'idle'
  if (installing || state === 'installing') return 'installing'
  if (state === 'downloaded' && status?.availableVersion) return 'install'
  if (downloading || state === 'downloading') return 'downloading'
  if (checking || state === 'checking') return 'checking'
  if (state === 'available' && status?.availableVersion) return 'available'
  return 'check'
}

/** The settings card keeps its own explanation for every outcome. */
export type SettingsHint =
  | 'action' | 'checking' | 'available' | 'downloading' | 'ready' | 'installing'
  | 'unsupported' | 'check-unavailable' | 'check-rejected' | 'download-failed' | 'install-failed'

export function settingsHintFor(status: UpdateStatus | null, checkError: boolean): SettingsHint {
  if (status && status.supported === false) return 'unsupported'
  const state = status?.state ?? 'idle'
  if (state === 'error' || checkError) {
    const kind = status?.errorKind
    if (kind === 'check-rejected') return 'check-rejected'
    if (kind === 'download-failed') return 'download-failed'
    if (kind === 'install-failed') return 'install-failed'
    if (kind === 'unsupported') return 'unsupported'
    return 'check-unavailable'
  }
  if (state === 'checking') return 'checking'
  if (state === 'downloading') return 'downloading'
  if (state === 'installing') return 'installing'
  if (state === 'downloaded' && status?.availableVersion) return 'ready'
  if (state === 'available' && status?.availableVersion) return 'available'
  return 'action'
}
