// Deferred send: what to do when the user submits while attachments are still
// uploading.
//
// Why this exists: the Enter key calls send() directly and does not consult
// btnSend.disabled, so the "uploading" guard on the button only covers clicks.
// Pasting an image starts an async upload (read ArrayBuffer + IPC), which is
// easily still in flight while the user finishes typing and hits Enter. The
// guard used to drop that submit on the floor with no feedback at all, so the
// message was never sent and nothing on screen changed.
//
// The rule below keeps the intent instead of discarding it: park it, then let
// the last upload to settle release it.

/** A parked submit intent, carrying the options the original send() was given. */
export interface DeferredSendIntent {
  invertFollowUp: boolean
}

/** Minimal shape this module needs from a composer attachment entry. */
export interface UploadStateEntry {
  uploading?: boolean
}

export type DeferredSendDecision =
  /** Nothing was parked, or the composer no longer holds anything to send. */
  | { action: 'none' }
  /** Uploads are still in flight; keep waiting for a later settle. */
  | { action: 'wait' }
  /** Every upload settled and there is still something to send. */
  | { action: 'send'; intent: DeferredSendIntent }

/**
 * Decide what a parked submit intent should do now that an upload settled.
 *
 * `hasSendableContent` is the caller's own "is there anything to send" answer
 * (composer text or a surviving attachment). When every attachment failed to
 * upload and the composer is empty, the intent is dropped rather than replayed
 * into a no-op send.
 */
export function resolveDeferredSend(
  intent: DeferredSendIntent | null,
  entries: readonly UploadStateEntry[],
  hasSendableContent: boolean,
): DeferredSendDecision {
  if (!intent) return { action: 'none' }
  if (entries.some((entry) => entry?.uploading)) return { action: 'wait' }
  if (!hasSendableContent) return { action: 'none' }
  return { action: 'send', intent }
}

/** True when at least one composer attachment is still uploading. */
export function hasUploadInFlight(entries: readonly UploadStateEntry[]): boolean {
  return entries.some((entry) => entry?.uploading)
}
