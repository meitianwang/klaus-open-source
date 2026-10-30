import type { ProfileActivity } from './activity'

let pending: Promise<ProfileActivity> | null = null

/** Share the local aggregate read across concurrent profile views and remounts. */
export function loadProfileActivity(): Promise<ProfileActivity> {
  if (pending) return pending
  const request = Promise.resolve().then(() => window.klaus.profile.activity())
  const shared = request.finally(() => { if (pending === shared) pending = null })
  pending = shared
  return shared
}
