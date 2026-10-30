// Hand-off slot for a clicked add-me link.
//
// The host delivers `deep-link:friend-invite` to the chat shell, which queues
// the email here and shows the friends page. The friends island may not be
// mounted yet (it mounts on first show), so the email waits in this slot and
// the page consumes it when it mounts; a page that is already mounted hears
// the window event instead. Both paths consume, so one link opens one dialog.
export const FRIEND_INVITE_EVENT = 'klaus:friend-invite'

let queued: string | null = null

export function queueFriendInvite(email: string): void {
  queued = email
  window.dispatchEvent(new CustomEvent(FRIEND_INVITE_EVENT, { detail: { email } }))
}

export function takeQueuedFriendInvite(): string | null {
  const value = queued
  queued = null
  return value
}
