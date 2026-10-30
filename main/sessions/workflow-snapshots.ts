import type { GoalSnapshot, GoalTurnMetadata, PlanningSnapshot, ThreadGoal } from '../../contracts/planning-goals';
import { planningInputRequest } from './planning-input';
import { object } from '../ipc/arguments';

const safeInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value);
const integer = (value: unknown): value is number => safeInteger(value) && value >= 0;
const identity = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/** Turn provenance is accepted only as a complete authoritative pair. */
export function goalTurnMetadata(value: unknown): GoalTurnMetadata | undefined {
  const row = object(value);
  if (!row || typeof row.goalContinuation !== 'boolean' || row.inputOrigin !== 'user' && row.inputOrigin !== 'automatic'
    || row.goalId !== undefined && !identity(row.goalId)) return undefined;
  return { goalContinuation: row.goalContinuation, inputOrigin: row.inputOrigin, ...(typeof row.goalId === 'string' ? { goalId: row.goalId } : {}) };
}
export function goalTurnMetadataMap(value: unknown): Record<string, GoalTurnMetadata> {
  const result: Record<string, GoalTurnMetadata> = {};
  for (const [turnId, record] of Object.entries(object(value) ?? {})) {
    const metadata = goalTurnMetadata(record);
    if (turnId && metadata) Object.defineProperty(result, turnId, { value: metadata, enumerable: true, configurable: true, writable: true });
  }
  return result;
}

/** Reject malformed pushes instead of displaying invented state or counters. */
export function goalSnapshot(goal: unknown, goalRevision: unknown, goalPursuitEligible?: unknown, goalPursuitEligibilityNotice?: unknown): GoalSnapshot | undefined {
  if (!integer(goalRevision) || goalPursuitEligible !== undefined && typeof goalPursuitEligible !== 'boolean'
    || goalPursuitEligibilityNotice !== undefined && (typeof goalPursuitEligibilityNotice !== 'string' || !goalPursuitEligibilityNotice.trim() || goalPursuitEligibilityNotice.length > 4096)) return undefined;
  const eligibility = { ...(typeof goalPursuitEligible === 'boolean' ? { goalPursuitEligible } : {}), ...(typeof goalPursuitEligibilityNotice === 'string' ? { goalPursuitEligibilityNotice } : {}) };
  if (goal === null) return { goal: null, goalRevision, ...eligibility };
  const row = object(goal);
  if (!row || !identity(row.goalId) || !identity(row.threadId) || !identity(row.objective)
    || !['active', 'paused', 'blocked', 'usage_limited', 'budget_limited', 'complete'].includes(String(row.status))
    || !['tokensUsed', 'timeUsedSeconds'].every(key => integer(row[key]))
    || !['createdAtMs', 'updatedAtMs'].every(key => safeInteger(row[key]))
    || row.tokenBudget !== undefined && row.tokenBudget !== null && (!integer(row.tokenBudget) || row.tokenBudget <= 0)) return undefined;
  return { goal: row as unknown as ThreadGoal, goalRevision, ...eligibility };
}
export function planningSnapshot(value: unknown): PlanningSnapshot | undefined {
  const row = object(value);
  if (!row || !['default', 'plan'].includes(String(row.mode)) || !integer(row.revision) || !Array.isArray(row.plans)) return undefined;
  const ids = new Set<string>();
  for (const value of row.plans) {
    const plan = object(value);
    if (!plan || !['id', 'threadId', 'turnId'].every(key => identity(plan[key])) || typeof plan.content !== 'string' || !integer(plan.revision)
      || !['writing', 'proposed', 'accepted', 'superseded', 'interrupted'].includes(String(plan.status)) || ids.has(String(plan.id))
      || plan.reviewPending !== undefined && typeof plan.reviewPending !== 'boolean') return undefined;
    ids.add(String(plan.id));
  }
  if (row.questions !== undefined) {
    if (!Array.isArray(row.questions) || row.questions.some(value => !planningInputRequest(value, 'snapshot'))) return undefined;
    if (new Set(row.questions.map(value => object(value)?.requestId)).size !== row.questions.length) return undefined;
  }
  if (row.implementation != null) {
    const receipt = object(row.implementation);
    if (!receipt || !['clientRequestId', 'planId', 'implementationId'].every(key => identity(receipt[key]))
      || !integer(receipt.revision) || typeof receipt.input !== 'string'
      || !['pending', 'started', 'failed', 'cancelled'].includes(String(receipt.admission))) return undefined;
  }
  if (row.progress != null) {
    const progress = object(row.progress);
    if (!progress || progress.explanation !== undefined && typeof progress.explanation !== 'string' || !Array.isArray(progress.plan)
      || progress.plan.some(value => { const step = object(value); return !step || !identity(step.step) || !['pending', 'in_progress', 'completed'].includes(String(step.status)); })
      || progress.plan.filter(value => object(value)?.status === 'in_progress').length > 1) return undefined;
  }
  return row as unknown as PlanningSnapshot;
}

/** A read belongs to one request and the exact snapshot it observed. */
export interface GoalSnapshotRead {
  readonly token: symbol;
  readonly snapshot: GoalSnapshot | undefined;
}

/** Responses and pushes share one ordering guard, including null clears. */
export class WorkflowSnapshots {
  private readonly goals = new Map<string, GoalSnapshot>();
  private readonly goalReads = new Map<string, symbol>();
  private readonly planning = new Map<string, PlanningSnapshot>();
  beginGoalRead(sessionId: string): GoalSnapshotRead {
    const token = Symbol();
    this.goalReads.set(sessionId, token);
    return { token, snapshot: this.goals.get(sessionId) };
  }
  isCurrentGoalRead(sessionId: string, read: GoalSnapshotRead): boolean {
    return this.goalReads.get(sessionId) === read.token && this.goals.get(sessionId) === read.snapshot;
  }
  endGoalRead(sessionId: string, read: GoalSnapshotRead): void {
    if (this.goalReads.get(sessionId) === read.token) this.goalReads.delete(sessionId);
  }
  invalidateGoalReads(sessionId?: string): void {
    if (sessionId === undefined) this.goalReads.clear(); else this.goalReads.delete(sessionId);
  }
  installGoal(sessionId: string, snapshot: GoalSnapshot): GoalSnapshot {
    const previous = this.goals.get(sessionId);
    if (previous && previous.goalRevision > snapshot.goalRevision) return previous;
    const current = previous && previous.goalRevision >= snapshot.goalRevision ? previous : snapshot;
    const eligible = snapshot.goalPursuitEligible ?? previous?.goalPursuitEligible;
    const notice = snapshot.goalPursuitEligible === undefined ? previous?.goalPursuitEligibilityNotice : snapshot.goalPursuitEligibilityNotice;
    if (current.goalPursuitEligible === eligible && current.goalPursuitEligibilityNotice === notice) {
      this.goals.set(sessionId, current); return current;
    }
    const result: GoalSnapshot = { ...current, ...(eligible !== undefined ? { goalPursuitEligible: eligible } : {}) };
    if (notice === undefined) delete result.goalPursuitEligibilityNotice; else result.goalPursuitEligibilityNotice = notice;
    this.goals.set(sessionId, result);
    return result;
  }
  installPlanning(sessionId: string, snapshot: PlanningSnapshot): PlanningSnapshot {
    const previous = this.planning.get(sessionId);
    if (previous && previous.revision >= snapshot.revision) return previous;
    this.planning.set(sessionId, snapshot);
    return snapshot;
  }
  goal(sessionId: string): GoalSnapshot | undefined { return this.goals.get(sessionId); }
  mode(sessionId: string): PlanningSnapshot | undefined { return this.planning.get(sessionId); }
  forget(sessionId: string): void { this.invalidateGoalReads(sessionId); this.goals.delete(sessionId); this.planning.delete(sessionId); }
}
