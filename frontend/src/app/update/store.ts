// The one owner of update UI state. The host owns the transfer; this store owns
// only the person's choices about how it is presented: which offer they
// postponed, and whether a download or install request is in flight. Every
// surface (settings card, persistent sidebar card, installation overlay) reads
// this same snapshot, so no two surfaces can disagree about the phase.
import {
  DISMISS_STORAGE_KEY, initialNoticeState, isDismissed, noticeFor,
  parseDismissRecord, surfacesFor,
  type DismissRecord, type NoticeState, type UpdateNotice, type UpdateStatus, type UpdateSurfaces,
} from './model'

export interface UpdateSnapshot {
  status: UpdateStatus | null
  surfaces: UpdateSurfaces
  /** A download was requested and the host has not started transferring yet. */
  downloadRequested: boolean
  /** An install was accepted and the hand-off has not reached the host yet. */
  installRequested: boolean
}

type Listener = () => void

interface UpdaterBridge {
  status?: () => Promise<UpdateStatus>
  check?: (args?: { explicit?: boolean; download?: boolean }) => Promise<UpdateStatus>
  install?: () => Promise<{ ok?: boolean; error?: string }>
}
interface HostApi {
  updater?: UpdaterBridge
  on?: { updaterStatus?: (cb: (status: UpdateStatus | null) => void) => unknown }
}
/** The toast and translation helpers are window globals, not bridge members. */
interface NoticeApi {
  showToast?: (message: string, options?: { tone?: string }) => void
  tt?: (key: string) => string
}

function host(): HostApi {
  if (typeof window === 'undefined') return {}
  return (window as unknown as { klaus?: HostApi }).klaus ?? {}
}

function notices(): NoticeApi {
  if (typeof window === 'undefined') return {}
  return window as unknown as NoticeApi
}

function translate(key: string): string {
  return notices().tt?.(key) ?? key
}

const listeners = new Set<Listener>()
let status: UpdateStatus | null = null
let dismissedRecord: DismissRecord | null = null
let downloadRequested = false
let installRequested = false
let lastPhase = ''
let noticeState: NoticeState = initialNoticeState()
let snapshot: UpdateSnapshot = {
  status: null,
  surfaces: surfacesFor({ status: null, dismissed: false, installRequested: false }),
  downloadRequested: false,
  installRequested: false,
}

function storage(): Storage | null {
  try { return typeof window === 'undefined' ? null : window.localStorage } catch { return null }
}

function writeDismiss(record: DismissRecord | null): void {
  dismissedRecord = record
  const store = storage()
  if (!store) return
  try {
    if (record) store.setItem(DISMISS_STORAGE_KEY, JSON.stringify(record))
    else store.removeItem(DISMISS_STORAGE_KEY)
  } catch { /* Blocked storage only costs the quiet window, never the transfer. */ }
}

function dismissedNow(): boolean {
  return isDismissed(dismissedRecord, status?.availableVersion, Date.now())
}

function rebuild(): void {
  snapshot = {
    status,
    surfaces: surfacesFor({ status, dismissed: dismissedNow(), installRequested }),
    downloadRequested,
    installRequested,
  }
}

function emit(): void {
  rebuild()
  for (const listener of Array.from(listeners)) listener()
}

function fill(template: string, values: Record<string, string>): string {
  let text = template
  for (const [name, value] of Object.entries(values)) text = text.split(`{${name}}`).join(value)
  return text
}

function showNotice(notice: UpdateNotice): void {
  const toast = notices().showToast
  if (notice.kind === 'up-to-date') {
    toast?.(fill(translate('update_check_up_to_date'), { version: notice.version }), { tone: 'success' })
    return
  }
  const key = notice.failure === 'check-rejected' ? 'update_check_rejected'
    : notice.failure === 'download-failed' ? 'update_download_failed'
      : notice.failure === 'install-failed' ? 'update_install_failed'
        : notice.failure === 'unsupported' ? 'updates_unavailable'
          : 'update_check_unavailable'
  toast?.(translate(key), { tone: 'danger' })
}

/** Applies one host push: phase transitions reset in-flight flags, ticks do not. */
export function applyUpdateStatus(next: UpdateStatus | null): void {
  const previousPhase = lastPhase
  status = next
  const phase = `${next?.state ?? 'idle'}|${next?.availableVersion ?? ''}`
  lastPhase = phase
  if (phase !== previousPhase) {
    // Starting a download or running an explicit check clears a prior postpone
    // so the finished transfer can present its install action in the sidebar.
    if (next?.state === 'downloading' || (next?.explicit === true && next?.state === 'checking')) {
      writeDismiss(null)
    }
    if (next?.state !== 'available') downloadRequested = false
    // The hand-off is over once the host reports any new phase, including the
    // failure that replaces it.
    if (next?.state !== 'downloaded') installRequested = false
  }
  const notice = noticeFor(next ?? {}, noticeState)
  emit()
  if (notice) showNotice(notice)
}

export function updateSnapshot(): UpdateSnapshot { return snapshot }

export function subscribeUpdate(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Postpone this offer: the sidebar card stands down, and the same version stays
 * quiet until its window expires, the person checks again, or a download begins.
 */
export function deferUpdate(): void {
  const version = status?.availableVersion
  if (version) writeDismiss({ version, timestamp: Date.now() })
  emit()
}

export function clearPostponedUpdate(): void {
  if (!dismissedRecord) return
  writeDismiss(null)
  emit()
}

/**
 * A person asking for a check clears any postponed offer first: asking again is
 * an explicit request to hear about the update they previously postponed.
 */
export async function checkForUpdate(): Promise<UpdateStatus | null> {
  const api = host().updater
  if (!api?.check) return null
  writeDismiss(null)
  const next = await api.check({ explicit: true })
  applyUpdateStatus(next ?? null)
  return next ?? null
}

/**
 * Explicitly download an available offer when automatic downloads are turned off.
 */
export async function downloadUpdate(): Promise<UpdateStatus | null> {
  const api = host().updater
  if (!api?.check || downloadRequested || installRequested) return null
  writeDismiss(null)
  downloadRequested = true
  emit()
  try {
    const next = await api.check({ explicit: true, download: true })
    downloadRequested = false
    applyUpdateStatus(next ?? null)
    return next ?? null
  } catch (error) {
    downloadRequested = false
    emit()
    throw error
  }
}

/**
 * Ask the host to install. A successful hand-off quits this process, so the
 * pending state is only cleared when the attempt is refused or throws.
 */
export async function installUpdate(): Promise<{ ok?: boolean; error?: string }> {
  const api = host()
  if (!api.updater?.install || installRequested) return { ok: false, error: 'update_operation_in_progress' }
  installRequested = true
  emit()
  try {
    const result = await api.updater.install() ?? { ok: false }
    if (result.ok === false) {
      installRequested = false
      emit()
      notices().showToast?.(translate(result.error === 'update_install_modified_app' ? 'update_install_modified_app' : 'update_install_failed'), { tone: 'danger' })
    }
    return result
  } catch (error) {
    installRequested = false
    emit()
    notices().showToast?.(translate('update_install_failed'), { tone: 'danger' })
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

let started = false
let unsubscribeHost: (() => void) | null = null

/** Boot once per renderer: read the current status, then follow host pushes. */
export function startUpdateNotices(): void {
  if (started || typeof window === 'undefined') return
  started = true
  dismissedRecord = parseDismissRecord(storage()?.getItem(DISMISS_STORAGE_KEY))
  const api = host()
  void api.updater?.status?.().then(next => applyUpdateStatus(next ?? null)).catch(() => {})
  const subscription = api.on?.updaterStatus?.(next => applyUpdateStatus(next ?? null))
  if (typeof subscription === 'function') unsubscribeHost = subscription as () => void
}

/** Test seam: drops all presentation state without touching the host. */
export function resetUpdateNotices(): void {
  unsubscribeHost?.()
  unsubscribeHost = null
  started = false
  status = null
  dismissedRecord = null
  downloadRequested = false
  installRequested = false
  lastPhase = ''
  noticeState = initialNoticeState()
  listeners.clear()
  rebuild()
}
