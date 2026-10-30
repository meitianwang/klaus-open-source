import { type ApprovalReview } from '../../../contracts/approval-review'
export interface DeniedApprovalReview { event: Record<string, unknown>; review: ApprovalReview }
interface DenialsState { rows: DeniedApprovalReview[]; consumed: Set<string>; pending: string | null; revision: number }
const sessions = new Map<string, DenialsState>()
const listeners = new Set<() => void>()
const stateFor = (sessionId: string) => {
  let state = sessions.get(sessionId)
  if (!state) { state = { rows: [], consumed: new Set(), pending: null, revision: 0 }; sessions.set(sessionId, state) }
  return state
}
function changed(state: DenialsState) { state.revision++; for (const listener of listeners) listener() }
/** Replace candidates with the reviews currently owned by the transcript. */
export function replaceApprovalReviewHistory(sessionId: string, rows: DeniedApprovalReview[]): void {
  const state = stateFor(sessionId)
  const seen = new Set<string>()
  const next = rows.filter(row => row.review.status === 'denied' && !seen.has(row.review.reviewId) && !!seen.add(row.review.reviewId))
  if (next.length === state.rows.length && next.every((row, index) => row.event === state.rows[index]?.event && row.review.rationale === state.rows[index]?.review.rationale)) return
  state.rows = next
  changed(state)
}
export function deniedApprovalReview(sessionId: string, reviewId: string) {
  const state = stateFor(sessionId)
  return state.consumed.has(reviewId) ? undefined : state.rows.find(row => row.review.reviewId === reviewId)
}
export function approvalReviewDenials(sessionId: string) {
  const state = stateFor(sessionId)
  return state.rows.filter(row => !state.consumed.has(row.review.reviewId)).slice(0, 10)
}
export function approvalReviewPending(sessionId: string) { return stateFor(sessionId).pending }
export function approvalReviewRevision(sessionId: string) { return stateFor(sessionId).revision }
export function subscribeApprovalReviews(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }
export function forgetApprovalReviewSession(sessionId: string): void {
  if (!sessions.delete(sessionId)) return
  for (const listener of listeners) listener()
}
export async function approveDeniedReview(sessionId: string, selected: DeniedApprovalReview, submit: (event: Record<string, unknown>) => Promise<unknown>): Promise<boolean> {
  const state = stateFor(sessionId)
  if (state.pending !== null || state.consumed.has(selected.review.reviewId)) return false
  state.pending = selected.review.reviewId
  changed(state)
  try {
    await submit(selected.event)
    state.consumed.add(selected.review.reviewId)
    changed(state)
    return true
  } finally { state.pending = null; changed(state) }
}
