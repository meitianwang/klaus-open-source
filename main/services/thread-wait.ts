// `wait_threads` decision core.
//
// Split out of thread-tools.ts because this is the one conversation tool that
// BLOCKS: it polls and wakes on up to eight targets at once, and its whole
// value is in the wake rules and the cursor that suppresses already-delivered
// text. Those rules are pure, so they live here and are pinned by committed
// vectors; the I/O (reading a target's state, waiting for a change) is injected.
//
// Wake semantics: the first target
// that completes or needs attention wins, commentary never wakes the wait, an
// up-to-date cursor omits previously delivered final text, a timeout returns
// compact progress for ALL targets, and per-target failures come back in
// `errors` instead of failing the whole call.

/** One target's projected state, as read by the host. */
export interface ThreadWaitState {
  threadId: string;
  /** Engine thread status type: `active` | `idle` | `notLoaded` | `systemError`. */
  statusType: string;
  /**
   * `waitingOnApproval` / `waitingOnUserInput`. The engine derives these from
   * its pending reverse requests (`app_server/service.rs:444-459`) and omits
   * the field entirely when empty, so absence is the normal case.
   */
  activeFlags: string[];
  /** The newest turn, or null when the thread has none. */
  latestTurn: { id: string; status: string } | null;
  /** Newest assistant text, already bounded by the caller. */
  latestText: string | null;
  latestTextTruncated?: boolean;
  title?: string | null;
}

export type WaitWakeReason = 'turnCompleted' | 'actionableStatus' | 'inactiveStatus';
export interface WaitWake { reason: WaitWakeReason; turnId?: string }

/**
 * What a single target reports back. `wake` is null when nothing worth waking
 * for happened; `cursor` always advances so the caller can suppress repeats.
 */
export interface WaitTargetSnapshot {
  threadId: string;
  cursor: string;
  changed: boolean;
  wake: WaitWake | null;
  status: string;
  turnId: string | null;
  turnStatus: string | null;
  text: string | null;
  textTruncated?: boolean;
  title: string | null;
}

/** A per-target failure, reported alongside the snapshots that did succeed. */
export interface WaitTargetError { threadId: string; message: string }

export interface WaitOutcome {
  timedOut: boolean;
  wake: (WaitWake & { threadId: string }) | null;
  polls: WaitTargetSnapshot[];
  errors?: WaitTargetError[];
}

const CURSOR_SEPARATOR = ':';

/**
 * Encode a cursor from a target's newest turn identity.
 *
 * The cursor is a monotonic identity, but a thread has no single monotonic
 * revision counter, so the turn identity, status and actionable flags identify
 * the last state reported. Terminal cursors keep their original encoding.
 * A thread with no turns encodes an empty cursor,
 * which the decoder reads as "nothing seen yet" rather than as malformed.
 */
export function encodeWaitCursor(state: ThreadWaitState): string {
  if (!state.latestTurn) return '';
  const base = `${state.latestTurn.id}${CURSOR_SEPARATOR}${state.latestTurn.status}`;
  const flags = actionableFlags(state);
  return flags.length ? `${base}#${encodeURIComponent(JSON.stringify(flags))}` : base;
}

export interface DecodedWaitCursor { turnId: string; status: string; activeFlags?: string[] }

function actionableFlags(state: ThreadWaitState): string[] {
  return state.statusType === 'active' ? [...new Set(state.activeFlags)].sort() : [];
}

/**
 * Parse a caller-supplied cursor, including legacy `turnId:status` values and
 * the optional actionable-flags suffix. A malformed value degrades to "nothing
 * seen yet" instead of throwing — a stale cursor must never fail a wait.
 */
export function decodeWaitCursor(cursor: string | undefined): DecodedWaitCursor | null {
  if (typeof cursor !== 'string' || !cursor) return null;
  const index = cursor.lastIndexOf(CURSOR_SEPARATOR);
  if (index <= 0 || index === cursor.length - 1) return null;
  const turnId = cursor.slice(0, index), tail = cursor.slice(index + 1), suffix = tail.indexOf('#');
  if (suffix < 0) return { turnId, status: tail };
  try {
    const flags: unknown = JSON.parse(decodeURIComponent(tail.slice(suffix + 1)));
    if (!suffix || !Array.isArray(flags) || !flags.every(flag => typeof flag === 'string')) return null;
    return { turnId, status: tail.slice(0, suffix), activeFlags: [...new Set(flags as string[])].sort() };
  } catch { return null; }
}

/**
 * Whether the target moved past what the cursor already reported.
 *
 * An absent or undecodable cursor means the caller has seen NOTHING, so every
 * state is a change. That is not the same as "has a turn": an empty thread with
 * no turns is still news to a first-time waiter, and treating it as unchanged
 * would suppress an `actionableStatus` wake on a thread that is parked on an
 * approval before it ever ran a turn.
 */
export function waitCursorChanged(cursor: string | undefined, state: ThreadWaitState): boolean {
  const previous = decodeWaitCursor(cursor);
  if (!previous) return true;
  if (!state.latestTurn) return true;
  return previous.turnId !== state.latestTurn.id || previous.status !== state.latestTurn.status
    || JSON.stringify(previous.activeFlags ?? []) !== JSON.stringify(actionableFlags(state));
}

/**
 * The status-only wake rules.
 *
 * - `systemError` / `notLoaded`: the target is not doing anything and never
 *   will be without help, so it needs attention.
 * - `active` WITH flags: it is blocked on an approval or on user input. This is
 *   the "needs attention" case the coordinator exists to notice.
 * - `active` with no flags: work is progressing. Commentary never wakes a wait,
 *   so this returns null.
 * - `idle`: decided by the turn rules in {@link wakeReasonFor}, not here.
 */
export function statusWakeReason(statusType: string, activeFlags: string[]): WaitWake | null {
  if (statusType === 'systemError' || statusType === 'notLoaded') return { reason: 'inactiveStatus' };
  if (statusType === 'active') return activeFlags.length > 0 ? { reason: 'actionableStatus' } : null;
  return null;
}

/**
 * Whether an idle-or-unloaded target with a finished turn should be SUPPRESSED
 * because the caller already saw that exact terminal state. Without this,
 * polling such a thread would report the same completed turn forever.
 *
 * Covers `notLoaded` as well as `idle` on purpose: the engine reports `notLoaded`
 * for a thread whose durable history exists but which has no live status, which is
 * the NORMAL state of a sidebar thread nobody has open. Restricting suppression to
 * `idle` would make every repeated wait re-report those threads as news.
 */
function terminalTurn(state: ThreadWaitState): boolean {
  return state.latestTurn !== null && state.latestTurn.status !== 'inProgress';
}
function unloadedOrIdle(state: ThreadWaitState): boolean {
  return state.statusType === 'idle' || state.statusType === 'notLoaded';
}
function unchangedTerminal(cursor: string | undefined, state: ThreadWaitState, changed: boolean): boolean {
  return !changed && unloadedOrIdle(state) && terminalTurn(state);
}

/**
 * Decide whether one target should wake the wait.
 *
 * Order matters, and getting it wrong is not cosmetic:
 * 1. An `active` target with flags is blocked on a human. Highest priority,
 *    because nothing else will make progress until someone answers.
 * 2. A terminal turn is CONCRETE evidence the work finished, so it outranks a
 *    vague `notLoaded`/`systemError` status. This is the case the real engine
 *    produces for a finished sidebar thread — `status: notLoaded` plus a
 *    completed turn — and treating the status as authoritative reported
 *    "needs attention" for work that had simply completed.
 * 3. Only with no terminal turn does the status itself decide: `systemError` and
 *    `notLoaded` mean nothing is happening and nothing will without help.
 *
 * `ignoreUnchangedTerminal` is what makes a cursor useful: with it set, a target
 * whose latest turn already completed at the cursor's identity does not wake
 * again, so repeated waits report only new work.
 */
export function wakeReasonFor(state: ThreadWaitState, cursor: string | undefined, ignoreUnchangedTerminal: boolean): WaitWake | null {
  const changed = waitCursorChanged(cursor, state);
  // 1. Blocked on a human — but only if it is news, so a thread parked on the same
  //    approval since the last wait does not wake every poll.
  if (state.statusType === 'active' && state.activeFlags.length > 0) {
    return changed ? { reason: 'actionableStatus' } : null;
  }
  // 2. Finished work outranks an uninformative status.
  if (terminalTurn(state)) {
    if (ignoreUnchangedTerminal && !changed && unloadedOrIdle(state)) return null;
    return { reason: 'turnCompleted', turnId: state.latestTurn!.id };
  }
  // 3. Nothing finished: decide from the status.
  const fromStatus = statusWakeReason(state.statusType, state.activeFlags);
  if (fromStatus) return fromStatus;
  if (state.statusType !== 'idle') return null;
  // Idle with no turn at all: nothing has run and nothing is running.
  if (!state.latestTurn) return { reason: 'inactiveStatus' };
  return null;
}

/** Build one target's snapshot, applying the cursor suppression rules. */
export function snapshotFor(state: ThreadWaitState, cursor: string | undefined, ignoreUnchangedTerminal: boolean): WaitTargetSnapshot {
  const changed = waitCursorChanged(cursor, state);
  const wake = wakeReasonFor(state, cursor, ignoreUnchangedTerminal);
  // The final text is withheld when the cursor already covered this exact
  // terminal turn — that is the whole point of passing a cursor back in.
  const suppressed = !changed && terminalTurn(state) && unloadedOrIdle(state) && wake === null;
  return {
    threadId: state.threadId,
    cursor: encodeWaitCursor(state),
    changed,
    wake,
    status: state.statusType,
    turnId: state.latestTurn?.id ?? null,
    turnStatus: state.latestTurn?.status ?? null,
    text: suppressed ? null : state.latestText,
    ...(!suppressed && state.latestTextTruncated ? { textTruncated: true } : {}),
    title: state.title ?? null,
  };
}

/**
 * Combine per-target outcomes into one result.
 *
 * The FIRST target with a wake wins (that is the contract the tool description
 * makes), but every target's snapshot is returned so a timeout still carries
 * compact progress for all of them. Failures are collected, not thrown: one
 * unreadable target must not hide the seven that answered.
 */
export function combineWaitOutcomes(
  targets: string[],
  results: Array<WaitTargetSnapshot | WaitTargetError | null>,
  timedOut: boolean,
): WaitOutcome {
  const polls: WaitTargetSnapshot[] = [];
  const errors: WaitTargetError[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    const result = results[index];
    if (!result) continue;
    if ('message' in result) errors.push(result);
    else polls.push(result);
  }
  const woke = polls.find(poll => poll.wake !== null);
  const outcome: WaitOutcome = {
    timedOut,
    wake: woke ? { ...woke.wake!, threadId: woke.threadId } : null,
    polls,
  };
  return errors.length ? { ...outcome, errors } : outcome;
}

/** An error entry for one target, message-bounded like every model-facing string. */
export function waitTargetError(threadId: string, error: unknown, limit = 2000): WaitTargetError {
  const message = error instanceof Error ? error.message : String(error);
  return { threadId, message: message.slice(0, limit) };
}

/**
 * Why a wait ended early. `interrupted` means "new user input ends the
 * wait early": the COORDINATOR got fresh input, so waiting further would answer
 * inside a turn the user did not ask for.
 */
export type WaitEndReason = 'wake' | 'timeout' | 'interrupted' | 'aborted';

/**
 * Why the inner "look again" wait returned. Deliberately a SEPARATE type from
 * {@link WaitEndReason}: `again` means a tick elapsed or an event arrived, and
 * the caller must re-check the deadline before concluding anything. Reusing
 * `timeout` here would let one tick report a spurious timeout for a wait that
 * still had time left.
 */
type WaitSignalReason = 'again' | 'interrupted' | 'aborted';

export interface WaitDeps {
  /** Network failures need attention immediately, without retrying a peer for the entire wait. */
  stopOnError?: boolean;
  /** Read one target's projected state, or throw when it is unreadable. */
  readState(threadId: string): Promise<ThreadWaitState>;
  /**
   * Subscribe to "something may have changed". Fires on turn terminals and on
   * reverse requests (an approval or elicitation), which are exactly the two
   * things that can make a target actionable. Returns an unsubscribe.
   */
  onChange(listener: () => void): () => void;
  /**
   * Subscribe to "this conversation accepted new user input". The caller's own
   * id is the one that matters: a human typing into the coordinator outranks the
   * wait it started. Returns an unsubscribe.
   */
  onInput(threadId: string, listener: () => void): () => void;
  /**
   * Fallback tick, because not every state transition emits an event (a thread
   * going `notLoaded` → `idle` on resume does not). Without it a target could
   * sit unseen until the whole timeout expired.
   */
  tickMs?: number;
  now?(): number;
}

export interface WaitRequest {
  targets: Array<{ threadId: string; afterCursor?: string }>;
  timeoutMs: number;
  signal: AbortSignal;
  /** The waiting conversation; it may not wait on itself. */
  callerId: string;
}

/** How often to re-read targets when no event arrived. */
const DEFAULT_TICK_MS = 1000;

/**
 * Drive one `wait_threads` call.
 *
 * Event-driven, not busy-polled: a poll happens on a change signal or on the
 * fallback tick, whichever comes first, and the whole thing resolves as soon as
 * any target wakes. `timeoutMs: 0` short-circuits to a single snapshot pass and
 * never subscribes, which is what makes it usable as a cheap status probe.
 */
export class ThreadWaitCoordinator {
  constructor(private readonly deps: WaitDeps) {}

  async wait(request: WaitRequest): Promise<WaitOutcome & { endReason: WaitEndReason }> {
    const { targets, timeoutMs, signal } = request;
    if (signal.aborted) throw new Error('The wait was cancelled.');
    const now = this.deps.now ?? (() => Date.now());

    // One pass over every target. Failures are collected per target so one
    // unreadable thread cannot hide the others.
    const poll = async (): Promise<Array<WaitTargetSnapshot | WaitTargetError>> => {
      return Promise.all(targets.map(async target => {
        try {
          const state = await this.deps.readState(target.threadId);
          return snapshotFor(state, target.afterCursor, true);
        } catch (error) {
          return waitTargetError(target.threadId, error);
        }
      }));
    };

    const finish = (
      results: Array<WaitTargetSnapshot | WaitTargetError>,
      endReason: WaitEndReason,
    ): WaitOutcome & { endReason: WaitEndReason } => {
      const ids = targets.map(target => target.threadId);
      return { ...combineWaitOutcomes(ids, results, endReason === 'timeout'), endReason };
    };

    if (timeoutMs === 0) {
      const results = await poll();
      // An immediate snapshot still reports a wake when one is already true, so
      // a coordinator probing status learns "this one is done" without waiting.
      const woke = results.some(result => result !== null && !('message' in result) && result.wake !== null);
      return finish(results, woke ? 'wake' : 'timeout');
    }

    const deadline = now() + timeoutMs;
    let unsubscribe: Array<() => void> = [];
    try {
      // Re-poll until something wakes, the caller gets new input, the deadline
      // passes, or the caller's own turn ends and aborts the signal.
      for (;;) {
        signal.throwIfAborted();
        const results = await poll();
        const woke = results.some(result => !('message' in result) && result.wake !== null);
        if (this.deps.stopOnError && results.some(result => 'message' in result)) return finish(results, 'wake');
        if (woke) return finish(results, 'wake');
        const remaining = deadline - now();
        if (remaining <= 0) return finish(results, 'timeout');

        // Wait for a reason to look again. The reason is the promise's VALUE
        // rather than a captured mutation: TypeScript's control-flow analysis
        // does not follow assignments made inside a callback, so a mutated flag
        // narrows to its initial literal and the `interrupted` branch below
        // would be reported unreachable.
        //
        // `again` deliberately means "a tick elapsed or something changed" and
        // NOT "the deadline passed" — the deadline is re-checked at the top of
        // the loop, so conflating the two would report a spurious timeout.
        const reason = await new Promise<WaitSignalReason>(resolve => {
          let settled = false;
          const done = (why: WaitSignalReason): void => {
            if (settled) return;
            settled = true;
            for (const off of unsubscribe) off();
            unsubscribe = [];
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            resolve(why);
          };
          const onAbort = (): void => done('aborted');
          const timer = setTimeout(() => done('again'), Math.min(this.deps.tickMs ?? DEFAULT_TICK_MS, remaining));
          unsubscribe = [
            this.deps.onChange(() => done('again')),
            this.deps.onInput(request.callerId, () => done('interrupted')),
          ];
          if (signal.aborted) { done('aborted'); return; }
          signal.addEventListener('abort', onAbort, { once: true });
        });
        if (reason === 'interrupted') {
          // The caller has fresh input, so the wait yields without
          // claiming any target finished.
          return { timedOut: false, wake: null, polls: [], endReason: 'interrupted' };
        }
        if (reason === 'aborted') throw new Error('The wait was cancelled.');
      }
    } finally {
      for (const off of unsubscribe) off();
    }
  }
}
