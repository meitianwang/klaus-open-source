import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import { taskRendererSnapshot } from '../ipc/project';
import { errorMessage, object, string, type JsonObject } from '../services/service-types';
import type { HostState } from '../services/host-state';
import type { SessionService } from './service';
import { projectSessionHistoryForRenderer } from './history';
import { contextStats } from './context-stats';
import { goalSnapshot } from './workflow-snapshots';
import { GoalObjectives } from './goal-objectives';
import { isInternalMemoryMaintenance } from '../services/internal-memory-maintenance';

/** Runtime inspection keeps existing bindings and never activates saved conversations. */
export class SessionQueries {
  private readonly goalMutations = new Map<string, Promise<unknown>>();
  readonly objectives: GoalObjectives;
  constructor(readonly sessions: SessionService, readonly state: HostState, readonly configRoot: string) { this.objectives = new GoalObjectives(configRoot); }

  async request(id: string, method: string, extra: JsonObject = {}): Promise<JsonObject> {
    return this.sessions.requestExistingSession(id, method, extra);
  }

  async contextStats(id: string): Promise<Json> {
    if (!id) return null;
    let snapshot: JsonObject;
    try { snapshot = await this.request(id, 'session/contextSnapshot'); }
    catch (error) {
      // Monitor refreshes may overlap lifecycle changes. Preserve their failure
      // in diagnostics without adding a message to the user's conversation.
      this.sessions.logQueryFailure(id, 'session/contextSnapshot', error);
      return null;
    }
    try { return contextStats(snapshot); }
    catch (error) { this.sessions.notice(id, `Context statistics are unavailable: ${errorMessage(error)}`); return null; }
  }

  async tasks(id: string): Promise<Json> {
    if (!id) return { tasks: [] };
    attempts: for (let attempt = 0; attempt < 3; attempt++) {
      let cursor: string | undefined, identity: string | undefined;
      const tasks: Json[] = [], cursors = new Set<string>();
      for (let page = 0; page < 1024; page++) {
        const reply = await this.request(id, 'session/taskList', { options: { limit: 1000, ...(cursor ? { cursor } : {}) } });
        const snapshot = object(reply.taskList ?? reply);
        if (!Array.isArray(snapshot.tasks)) throw new IpcHandlerError('TASK_SNAPSHOT_INVALID', 'The engine returned an invalid task snapshot');
        const current = JSON.stringify(['taskListId', 'generation', 'revision', 'fingerprint'].map(key => snapshot[key] ?? null));
        if (cursor && snapshot.cursorStatus !== 'current' || identity && identity !== current) continue attempts;
        identity = current;
        tasks.push(...snapshot.tasks);
        cursor = string(snapshot.nextCursor) || undefined;
        if (!cursor) return taskRendererSnapshot({ ...snapshot, tasks, nextCursor: null });
        if (cursors.has(cursor)) throw new IpcHandlerError('TASK_CURSOR_INVALID', 'The task cursor did not advance');
        cursors.add(cursor);
      }
    }
    throw new IpcHandlerError('TASK_SNAPSHOT_CHANGED', 'The task list kept changing. Try again.');
  }

  async goal(id: string): Promise<JsonObject> {
    if (!id) return { goal: null, goalRevision: 0 };
    return await this.sessions.readGoalSnapshot(id) as unknown as JsonObject;
  }

  /** The engine validates inherited resource ownership against the current goal. */
  async readGoalObjective(id: string, objective: string): Promise<JsonObject> {
    const before = object((await this.goal(id)).goal);
    if (typeof before.goalId !== 'string' || before.objective !== objective) throw new IpcHandlerError('GOAL_CONFLICT', 'The goal objective changed before it could be opened');
    const reply = await this.sessions.requestThreadWorkflow(id, 'session/readGoalObjective', { expectedGoalId: before.goalId });
    if (reply.goalId !== before.goalId || typeof reply.objective !== 'string' || !reply.objective.trim()) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned an invalid goal objective document');
    const after = object((await this.goal(id)).goal);
    if (after.goalId !== before.goalId || after.objective !== before.objective) throw new IpcHandlerError('GOAL_CONFLICT', 'The goal objective changed while it was opening');
    return { content: reply.objective };
  }

  private installGoal(id: string, reply: JsonObject): JsonObject {
    const snapshot = goalSnapshot(reply.threadGoal ?? null, reply.goalRevision, reply.goalPursuitEligible, reply.goalPursuitEligibilityNotice);
    if (!snapshot) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned an invalid goal snapshot');
    return this.state.workflows.installGoal(id, snapshot) as unknown as JsonObject;
  }

  private goalMutation<T>(id: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.goalMutations.get(id) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    this.goalMutations.set(id, result);
    void result.finally(() => { if (this.goalMutations.get(id) === result) this.goalMutations.delete(id); }).catch(() => {});
    return result;
  }

  setGoal(id: string, value: JsonObject): Promise<Json> {
    return this.goalMutation(id, async () => {
      const extra: JsonObject = { origin: 'user' };
      if (value.objective !== undefined) {
        if (typeof value.objective !== 'string' || !value.objective.trim() || Array.from(value.objective.trim()).length > 4000) throw new IpcHandlerError('BAD_REQUEST', 'objective must contain 1 to 4000 characters');
        extra.objective = value.objective.trim();
      }
      if (value.status !== undefined) {
        if (value.status !== 'active' && value.status !== 'paused') throw new IpcHandlerError('BAD_REQUEST', 'status must be active or paused');
        extra.status = value.status;
      }
      if (value.tokenBudget !== undefined) {
        if (value.tokenBudget !== null && (typeof value.tokenBudget !== 'number' || !Number.isSafeInteger(value.tokenBudget) || value.tokenBudget <= 0)) throw new IpcHandlerError('BAD_REQUEST', 'tokenBudget must be a positive safe integer or null');
        extra.tokenBudget = value.tokenBudget;
      }
      if (value.submit !== undefined) {
        if (typeof value.submit !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'submit must be a boolean');
        extra.submit = value.submit;
      }
      if (value.displayText !== undefined) {
        if (typeof value.displayText !== 'string' || Array.from(value.displayText).length > 4000) throw new IpcHandlerError('BAD_REQUEST', 'Invalid goal display text');
        extra.displayText = value.displayText;
      }
      if (value.expectedGoalId !== undefined) extra.expectedGoalId = value.expectedGoalId === null ? null : required(value.expectedGoalId, 'expectedGoalId');
      if (value.expectedGoalRevision !== undefined) extra.expectedGoalRevision = goalRevision(value.expectedGoalRevision);
      if (value.clientRequestId !== undefined) extra.clientRequestId = required(value.clientRequestId, 'clientRequestId');
      if (value.submit === true && extra.clientRequestId === undefined) throw new IpcHandlerError('BAD_REQUEST', 'An explicit goal submission requires a stable clientRequestId');
      if (Object.keys(extra).length === 1) throw new IpcHandlerError('BAD_REQUEST', 'A goal mutation is required');
      if (value.objective !== undefined || value.tokenBudget !== undefined || value.status === 'active' || value.submit === true) await this.sessions.assertGoalPursuitEligible(id);
      const preparationId = value.preparationId === undefined ? undefined : required(value.preparationId, 'preparationId');
      let firstPreparedAttempt = false;
      if (preparationId) {
        try { extra.ownedResources = await this.objectives.ownedResources(id, preparationId, string(extra.objective), value.submit === true ? { clientRequestId: string(extra.clientRequestId), displayText: typeof extra.displayText === 'string' ? extra.displayText : undefined } : undefined) as unknown as Json; }
        catch (error) {
          if (!(error instanceof IpcHandlerError && error.code === 'GOAL_INTENT_CONFLICT')) {
            try { await this.objectives.discard(id, preparationId); } catch (cleanupError) { this.sessions.logQueryFailure(id, 'goal-objective-validation-cleanup', cleanupError); }
          }
          throw error;
        }
      }
      try {
        if (preparationId) firstPreparedAttempt = await this.objectives.markSubmitting(id, preparationId, string(extra.objective));
        const reply = value.submit === true || value.status === 'active'
          ? await this.sessions.requestActiveWorkflow(id, 'session/setGoal', extra)
          : await this.sessions.requestThreadWorkflow(id, 'session/setGoal', extra);
        if (preparationId) {
          if (object(reply.threadGoal).objective === extra.objective) await this.objectives.accept(id, preparationId, string(extra.objective));
          else await this.objectives.discard(id, preparationId);
        }
        // Goal submissions never pass a composer send, so the objective is the only
        // human-authored text available to seed a title from.
        const seededObjective = typeof extra.objective === 'string' ? extra.objective
          : typeof object(reply.threadGoal)?.objective === 'string' ? String(object(reply.threadGoal)?.objective) : '';
        if (seededObjective) await this.sessions.seedGoalTitle(id, seededObjective);
        return { ok: true, ...this.installGoal(id, reply),
          ...(reply.goalAdmission !== undefined ? { admission: reply.goalAdmission } : {}) };
      } catch (error) {
        if (preparationId && firstPreparedAttempt && error instanceof IpcHandlerError && error.code === 'GOAL_CONFLICT') {
          // The engine guarantees a conditional-write conflict committed no goal or receipt.
          await this.objectives.discardRejected(id, preparationId);
        }
        throw error;
      }
    });
  }

  clearGoal(id: string, value: JsonObject = {}): Promise<Json> {
    return this.goalMutation(id, async () => {
      if (value.origin !== undefined && value.origin !== 'user' && value.origin !== 'automatic') throw new IpcHandlerError('BAD_REQUEST', 'Invalid goal mutation origin');
      if (value.origin === 'automatic' && value.expectedGoalId === undefined) throw new IpcHandlerError('BAD_REQUEST', 'Automatic goal cleanup requires its goal identity');
      const reply = await this.sessions.requestThreadWorkflow(id, 'session/clearGoal', { origin: value.origin ?? 'user',
        ...(value.expectedGoalId !== undefined ? { expectedGoalId: value.expectedGoalId === null ? null : required(value.expectedGoalId, 'expectedGoalId') } : {}),
        ...(value.expectedGoalRevision !== undefined ? { expectedGoalRevision: goalRevision(value.expectedGoalRevision) } : {}) });
      return { ok: true, cleared: reply.goalCleared ?? false, ...this.installGoal(id, reply) };
    });
  }

  async agents(id: string): Promise<JsonObject> {
    if (!id) return { agents: [] };
    const reply = await this.sessions.requestExistingSession(id, 'session/subagentLifecycle', {}, undefined, { priority: 'background', source: 'thread', conversationId: id });
    const raw = object(reply.subagentLifecycle ?? reply).agents;
    if (!Array.isArray(raw)) throw new IpcHandlerError('AGENT_SNAPSHOT_INVALID', 'The engine returned an invalid sub-agent snapshot');
    const identities = new Set<string>();
    const agents = raw.filter(value => !isInternalMemoryMaintenance(object(value))).map(value => {
      const row = object(value), context = object(row.context), status = string(row.status);
      const id = string(row.agentId) || string(row.id);
      if (!id || identities.has(id) || !['spawned', 'running', 'idle', 'interrupted', 'completed', 'budget_limited', 'failed', 'cancelled'].includes(status)
        || !['foreground', 'background', 'persistent', 'workflow'].includes(string(row.kind))) {
        throw new IpcHandlerError('AGENT_SNAPSHOT_INVALID', 'The engine returned an invalid sub-agent identity, kind or status');
      }
      identities.add(id);
      const time = (name: string): Json => typeof row[name] === 'number' && Number.isSafeInteger(row[name]) && row[name] >= 0 ? row[name] : null;
      return {
        id, description: string(context.description) || string(row.description) || id,
        // A budget ceiling is a planned stop with usable partial work, so it
        // keeps its own status instead of folding into `failed` or `stopped`.
        status: ['completed', 'failed', 'budget_limited', 'running'].includes(status) ? status : ['interrupted', 'cancelled'].includes(status) ? 'stopped' : 'running',
        kind: row.kind!, agentType: string(context.agentType), teammate: row.kind === 'persistent', idle: status === 'idle',
        ...(string(context.parentAgentId) ? { parentAgentId: context.parentAgentId! } : {}),
        ...(string(context.spawnTurnId) ? { spawnTurnId: context.spawnTurnId! } : {}),
        ...(typeof context.depth === 'number' && Number.isSafeInteger(context.depth) && context.depth > 0 ? { depth: context.depth } : {}),
        transcript: string(row.lastResult) || string(row.transcript), outputFile: string(row.outputFile) || string(row.output_file),
        error: string(row.lastError),
        // The concrete model the child run resolved to at spawn time; rows
        // written before the engine stamped it simply omit it.
        ...(string(row.model) ? { model: string(row.model) } : {}),
        ...(string(row.modelSource) ? { modelSource: string(row.modelSource) } : {}),
        startedAtMs: time('startedAtMs'), updatedAtMs: time('updatedAtMs'), completedAtMs: time('completedAtMs'),
      };
    });
    return { agents };
  }

  async agentHistory(id: string, agentId: string): Promise<Json> {
    if (!id || !agentId) return { messages: [] };
    // Reopening a saved child must not initialize its parent's unavailable provider.
    if (!this.state.liveSession(id)) return this.sessions.storedHistory(id, agentId);
    const reply = await this.request(id, 'session/subagentTranscript', { threadId: id, agentId });
    const transcript = object(reply.subagentTranscript ?? reply), index = object(transcript.turnIndex ?? transcript);
    return projectSessionHistoryForRenderer({ ...index, messages: transcript.messages ?? [] }, agentId, this.configRoot);
  }

  async backgroundOutput(id: string, value: JsonObject): Promise<Json> {
    const extra: JsonObject = { shellId: required(value.shellId, 'shellId') };
    for (const key of ['afterOffset', 'maxBytes']) if (value[key] !== undefined) {
      if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] < 0) throw new IpcHandlerError('BAD_REQUEST', `${key} must be a nonnegative integer`);
      extra[key] = value[key];
    }
    const reply = await this.request(id, 'session/backgroundProcessOutput', extra);
    return reply.backgroundProcessOutput ?? reply;
  }

  async stopBackground(id: string, value: JsonObject): Promise<Json> {
    const extra: JsonObject = { shellId: required(value.shellId, 'shellId') };
    if (value.signal !== undefined) extra.signal = required(value.signal, 'signal');
    const reply = await this.request(id, 'session/stopBackgroundProcess', extra);
    return reply.backgroundProcessStop ?? reply;
  }
}

function required(value: Json | undefined, name: string): string {
  const result = string(value).trim();
  if (!result) throw new IpcHandlerError('BAD_REQUEST', `${name} is required`);
  return result;
}

function goalRevision(value: Json): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new IpcHandlerError('BAD_REQUEST', 'expectedGoalRevision must be a nonnegative safe integer');
  return value;
}
