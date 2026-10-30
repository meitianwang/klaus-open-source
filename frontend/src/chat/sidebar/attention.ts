// Attention model for the sidebar.
//
// Every conversation carries one of four attention states, ranked so the list can
// sort "what needs me" above "what is running":
//   waiting > unread > active > idle
//
// - `waiting` — an approval or a question is parked on this conversation and the
//   engine (and its turn) cannot continue until the user replies. Split into two
//   row-level kinds: `approval` (permission/plan-review/execution-mode cards) and
//   `input` (elicit / AskUserQuestion cards). The snooze window is 60000 ms: a
//   Needs-input pill may be snoozed once per request and the wait returns after
//   the countdown.
// - `unread` — the turn completed but the conversation has not been seen.
// - `active` — a turn / sub-agent / background process is running.
// - `idle` — nothing pending.
export type SessionWaitingKind = 'approval' | 'input'

export type SessionAttentionState = 'waiting' | 'unread' | 'active' | 'idle'

/** Ascending sort rank of the four attention states. */
export const ATTENTION_RANK: Record<SessionAttentionState, number> = {
  waiting: 0,
  unread: 1,
  active: 2,
  idle: 3,
}

/** Sort comparator over attention rank, ties broken by recency (newest first). */
export function compareByAttention(
  left: { attention: SessionAttentionState; recencyAt: number },
  right: { attention: SessionAttentionState; recencyAt: number },
): number {
  const rank = ATTENTION_RANK[left.attention] - ATTENTION_RANK[right.attention]
  if (rank !== 0) return rank
  return right.recencyAt - left.recencyAt
}

/** Snooze window for a Needs-input pill: 60000 ms. */
export const INPUT_SNOOZE_MS = 60_000

export interface SessionAttention {
  waitingKind: SessionWaitingKind | null
  waitingCount: number
  unread: boolean
  working: boolean
  /** Completed-but-unseen turns accumulate; the badge caps at 99+. */
  unreadCount?: number
}

/** Collapse the per-session signals into one attention state. */
export function sessionAttentionState(a: SessionAttention): SessionAttentionState {
  if (a.waitingCount > 0) return 'waiting'
  if (a.unread) return 'unread'
  if (a.working) return 'active'
  return 'idle'
}

/** A row's trailing indicator: at most one is picked, in this order. */
export type RowIndicator =
  | { kind: 'unreadCount'; count: number }
  | { kind: 'spinner'; label: string }
  | { kind: 'unreadDot'; label: string }
  | null

export function rowIndicator(
  a: { waitingCount: number; unread: boolean; working: boolean; unreadCount?: number },
  labels: { spinner: string; unreadDot: string },
): RowIndicator {
  if (a.waitingCount > 0) return null
  if (a.unreadCount != null && a.unreadCount > 0) return { kind: 'unreadCount', count: Math.min(a.unreadCount, 99) }
  if (a.working) return { kind: 'spinner', label: labels.spinner }
  if (a.unread) return { kind: 'unreadDot', label: labels.unreadDot }
  return null
}

// --- Snooze ledger ---------------------------------------------------------
//
// The Needs-input pill may be snoozed for 60s: clicking hides the wait until
// the deadline passes, then the pending request resurfaces. The ledger is keyed
// per requestId — module-level so it survives row re-renders, dropped wholesale
// when a session is deleted.

const snoozedUntil = new Map<string, number>()

export function snoozeInputRequest(requestId: string, now: number = Date.now()): void {
  if (!requestId) return
  snoozedUntil.set(requestId, now + INPUT_SNOOZE_MS)
}

export function isInputRequestSnoozed(requestId: string, now: number = Date.now()): boolean {
  const until = snoozedUntil.get(requestId)
  if (until == null) return false
  if (until <= now) {
    snoozedUntil.delete(requestId)
    return false
  }
  return true
}

/** Remaining ms before a snoozed request wakes up, or null when not snoozed. */
export function inputSnoozeRemaining(requestId: string, now: number = Date.now()): number | null {
  const until = snoozedUntil.get(requestId)
  if (until == null) return null
  return Math.max(0, until - now)
}

/** A snoozed request whose deadline passed (its wait should resurface). */
export function takeExpiredSnooze(requestId: string, now: number = Date.now()): boolean {
  const until = snoozedUntil.get(requestId)
  if (until == null) return false
  if (until > now) return false
  snoozedUntil.delete(requestId)
  return true
}

export function forgetInputSnoozes(requestIds: Iterable<string>): void {
  for (const id of requestIds) snoozedUntil.delete(id)
}

// --- Enumeration of live approval cards ------------------------------------
//
// The stream store owns the live approval-card units; the sidebar reads them
// through this selector so the same shapes that render cards in the transcript
// drive the waiting state. The split: permission/plan-review/execution-mode are
// approvals; elicit and AskUserQuestion cards are user input.

export interface LiveApprovalView {
  requestId: string
  kind: SessionWaitingKind
}

export function liveApprovalsOf(units: ReadonlyArray<Record<string, unknown>> | undefined): LiveApprovalView[] {
  if (!units || units.length === 0) return []
  const seen = new Set<string>()
  const out: LiveApprovalView[] = []
  for (const unit of units) {
    const type = unit['type']
    if (type !== 'live-permission' && type !== 'live-plan-review' && type !== 'live-execution-mode'
      && type !== 'live-elicit' && type !== 'live-ask') continue
    const resolved = unit['resolved']
    if (resolved != null) continue
    const req = unit['req'] as { requestId?: unknown; toolName?: unknown } | undefined
    const requestId = typeof req?.requestId === 'string' ? req.requestId : ''
    if (!requestId || seen.has(requestId)) continue
    seen.add(requestId)
    const isInput = type === 'live-elicit' || type === 'live-ask'
      || (type === 'live-permission' && req?.toolName === 'AskUserQuestion')
    out.push({ requestId, kind: isInput ? 'input' : 'approval' })
  }
  return out
}

/** A parked waiting row that is also unseen still counts as unread once
 *  resolved — irrelevant for us today (waiting clears the unread marker neither
 *  way); kept as the explicit downgrade rule for pinned-thread ordering. */
export function downgradeWaitingForUnread(attention: SessionAttentionState, hasUnreadTurn: boolean): SessionAttentionState {
  if (attention === 'waiting' || !hasUnreadTurn) return attention
  return 'unread'
}
