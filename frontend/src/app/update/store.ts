// The one owner of update UI state. The host owns the transfer; this store owns
// only the person's choices about how it is presented: whether the detail is
// collapsed, and which offer they postponed. Every surface (settings card,
// progress detail, persistent card, ready decision, installation overlay) reads
// this same snapshot, so no two surfaces can disagree about the phase.
import {
  DISMISS_STORAGE_KEY, PROGRESS_DIALOG_DELAY_MS, initialNoticeState, isDismissed, noticeFor,
  parseDismissRecord, surfacesFor,
  type DismissRecord, type NoticeState, type UpdateNotice, type UpdateStatus, type UpdateSurfaces,
} from './model'

export interface UpdateSnapshot {
  status: UpdateStatus | null
  surfaces: UpdateSurfaces
  /** True once a download has outlived the delay gate. */
  progressEligible: boolean
  /** An install was accepted and the hand-off has not reached the host yet. */
  installRequested: boolean
}

type Listener = () => void

interface UpdaterBridge {
  status?: () => Promise<UpdateStatus>
  check?: (args?: { explicit?: boolean }) => Promise<UpdateStatus>
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
let progressHidden = false
let dismissedRecord: DismissRecord | null = null
let progressEligible = false
let observedTransfer = false
let installRequested = false
let progressTimer: ReturnType<typeof setTimeout> | null = null
let lastPhase = ''
let noticeState: NoticeState = initialNoticeState()
let snapshot: UpdateSnapshot = {
  status: null,
  surfaces: surfacesFor({ status: null, progressHidden: false, dismissed: false, observedTransfer: false }),
  progressEligible: false,
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
  const surfaces = surfacesFor({ status, progressHidden, dismissed: dismissedNow(), observedTransfer })
  snapshot = {
    status,
    // The detail waits for the gate so a check that answers immediately never
    // flashes a dialog on screen.
    surfaces: { ...surfaces, progressDialog: surfaces.progressDialog && progressEligible },
    progressEligible,
    installRequested,
  }
}

function emit(): void {
  rebuild()
  for (const listener of Array.from(listeners)) listener()
}

function clearProgressTimer(): void {
  if (progressTimer !== null) { clearTimeout(progressTimer); progressTimer = null }
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

/** Applies one host push: phase transitions reset presentation, ticks do not. */
export function applyUpdateStatus(next: UpdateStatus | null): void {
  const previousPhase = lastPhase
  status = next
  // Only a transfer this renderer actually watched earns the completion dialog.
  // An offer already cached when the app started gets the card, not a modal on
  // every launch.
  if (next?.state === 'downloading') observedTransfer = true
  const phase = `${next?.state ?? 'idle'}|${next?.availableVersion ?? ''}`
  lastPhase = phase
  if (phase !== previousPhase) {
    // A new phase or a new offer starts uncollapsed; progress ticks inside one
    // phase must never reopen what the person collapsed.
    progressHidden = false
    clearProgressTimer()
    progressEligible = false
    if (next?.state !== 'downloading' && next?.state !== 'downloaded' && next?.state !== 'installing') observedTransfer = false
    // The hand-off is over once the host reports any new phase, including the
    // failure that replaces it.
    if (next?.state !== 'downloaded') installRequested = false
    if (next?.state === 'downloading') {
      progressTimer = setTimeout(() => { progressTimer = null; progressEligible = true; emit() }, PROGRESS_DIALOG_DELAY_MS)
    }
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

/** Collapse the detail. The transfer keeps running and the card stays reachable. */
export function hideUpdateProgress(): void {
  progressHidden = true
  emit()
}

export function showUpdateProgress(): void {
  progressHidden = false
  emit()
}

/**
 * Postpone this offer: detail and card both stand down, and the same version
 * stays quiet until its window expires or the person checks again.
 */
export function deferUpdate(): void {
  const version = status?.availableVersion
  progressHidden = true
  if (version) writeDismiss({ version, timestamp: Date.now() })
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
  clearProgressTimer()
  unsubscribeHost?.()
  unsubscribeHost = null
  started = false
  status = null
  progressHidden = false
  dismissedRecord = null
  progressEligible = false
  observedTransfer = false
  installRequested = false
  lastPhase = ''
  noticeState = initialNoticeState()
  listeners.clear()
  rebuild()
}