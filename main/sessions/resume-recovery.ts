// Restart recovery for sessions that were mid-turn when the app last quit.
//
// The engine restores a thread's durable queue, background-process records and
// subagent lifecycle on resume; what it never does on its own is re-run work.
// This recovery supplies the missing "please continue" the user would otherwise
// click per task after an update restart (or any relaunch): open each recorded
// thread (the implicit-resume history read), decide from the projected history
// whether its tail turn is unsettled, and continue that turn. The engine's
// durable queue then walks forward on its own, and the recovered turn rebuilds
// the background processes and subagents it still needs through normal tools.
//
// Deliberately conservative: unknown ids, deleted threads, private threads and
// side tasks are skipped with a log line; every per-session failure is contained;
// nothing here can delay startup beyond its own bounded delay because every
// step awaits engine calls that already carry timeouts.
import { object } from '../ipc/arguments';
import type { Json } from '../ipc/contract';
import { ResumeLedger } from './resume-ledger';

export interface ResumeRecoveryDeps {
  history(sessionId: string): Promise<Json>;
  continueTurn(sessionId: string): Promise<Json>;
  /** Host-minted renderer ids that must never be auto-resumed. */
  isRecoverable(sessionId: string): boolean;
  log(kind: string, message: string): void;
  onResolved?(sessionId: string): Promise<void>;
}

/** The projected history's tail turn is interrupted, failed, or started-but-unfinished. */
export function historyHasUnsettledTail(history: Json): boolean {
  const state = object(history) ?? {};
  const statuses = object(state.turnStatuses) ?? {};
  const started = object(state.turnStartedAtMs) ?? {};
  const finished = object(state.turnFinishedAtMs) ?? {};
  const unsettled = (turnId: string): boolean => {
    const status = statuses[turnId];
    return status === 'interrupted' || status === 'failed' || (started[turnId] !== undefined && finished[turnId] === undefined && status === undefined);
  };
  // Identify the tail turn by start time, then ask whether it left a transcript
  // row. This mirrors the renderer's Continue rule exactly: a turn killed before
  // it rendered anything puts no id on a row, so a row-based walk would land on
  // the turn BEFORE it and miss the recovery (the restart-for-a-permission case).
  let tailTurnId: string | undefined;
  let tailStartedAt = -1;
  for (const [turnId, value] of Object.entries(started)) {
    if (typeof value !== 'number' || value <= tailStartedAt) continue;
    tailStartedAt = value;
    tailTurnId = turnId;
  }
  if (tailTurnId !== undefined) return unsettled(tailTurnId);
  // No recorded start times at all: fall back to the newest row-carried turn.
  const messages = Array.isArray(state.messages) ? state.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const turnId = object(messages[index])?.turnId;
    if (typeof turnId !== 'string' || turnId.length === 0) continue;
    return unsettled(turnId);
  }
  return false;
}

export class ResumeRecovery {
  private consumed = false;

  constructor(private readonly deps: ResumeRecoveryDeps) {}

  /**
   * Continue every ledgered session whose tail turn is unsettled. Returns the
   * ids a continuation was actually started for. One real parallelism lane per
   * session; the engine serializes per-session work behind its own locks.
   */
  async recover(sessionIds: string[]): Promise<string[]> {
    if (this.consumed) return [];
    this.consumed = true;
    const resumed: string[] = [];
    await Promise.all(sessionIds.map(async sessionId => {
      try {
        if (!this.deps.isRecoverable(sessionId)) {
          this.deps.log('resume-recovery', `skip ${sessionId}: not a recoverable thread`);
          await this.deps.onResolved?.(sessionId);
          return;
        }
        // Opening the transcript performs the implicit resume of the thread.
        const history = await this.deps.history(sessionId);
        if (!historyHasUnsettledTail(history)) {
          this.deps.log('resume-recovery', `skip ${sessionId}: tail turn already settled`);
          await this.deps.onResolved?.(sessionId);
          return;
        }
        await this.deps.continueTurn(sessionId);
        resumed.push(sessionId);
        this.deps.log('resume-recovery', `continued ${sessionId}`);
        await this.deps.onResolved?.(sessionId);
      } catch (error) {
        this.deps.log('resume-recovery', `session ${sessionId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
    return resumed;
  }
}

/** Recover the previous snapshot without dropping this process's running turns. */
export async function runStartupResumeRecovery(ledger: ResumeLedger, deps: ResumeRecoveryDeps): Promise<string[]> {
  const ids = await ledger.takeStartupIds();
  if (ids.length === 0) return [];
  deps.log('resume-recovery', `recovering ${ids.length} ledgered session(s)`);
  const recovery = new ResumeRecovery({ ...deps, onResolved: sessionId => ledger.completeRecovery(sessionId) });
  return recovery.recover(ids);
}
