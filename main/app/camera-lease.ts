// A short camera lease for the friends scan dialog.
//
// The main window's media gate is owned by the voice runtime and admits audio
// only, so a renderer can never open the camera on its own. The scan dialog
// asks the host for a lease before calling getUserMedia and releases it when
// the dialog closes; while a lease is live the gate also admits video from
// that one renderer. The gate still requires a trusted origin and the main
// frame, so a lease widens WHICH media kinds one trusted page may open, never
// WHO may open them.
import type { WebContents } from 'electron';

const leases = new Map<number, number>();

export function grantCameraLease(senderId: number): void {
  leases.set(senderId, (leases.get(senderId) ?? 0) + 1);
}

export function releaseCameraLease(senderId: number): void {
  const left = (leases.get(senderId) ?? 0) - 1;
  if (left > 0) leases.set(senderId, left);
  else leases.delete(senderId);
}

/** A crashed or navigated renderer must not keep its camera window open. */
export function dropCameraLease(senderId: number): void {
  leases.delete(senderId);
}

export function cameraLeaseHeld(contents: Pick<WebContents, 'id' | 'isDestroyed'> | null): boolean {
  return !!contents && !contents.isDestroyed() && (leases.get(contents.id) ?? 0) > 0;
}
