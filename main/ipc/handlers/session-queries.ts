import { readSessionModel } from '../../services/session-store';
import { payload, requiredString } from '../arguments';
import { IpcHandlerError, type ChannelRegistry } from '../registry';
import type { Json } from '../contract';
import { SessionQueries } from '../../sessions/queries';
import { SessionPlanning } from '../../sessions/planning';
import type { GoalObjectiveInput } from '../../../contracts/planning-goals';
import { SessionQueue } from '../../sessions/queue';
import type { HostState } from '../../services/host-state';
import type { SessionService } from '../../sessions/service';
import { profileActivitySnapshot } from '../../../contracts/profile';

export function registerSessionQueryHandlers(registry: ChannelRegistry, deps: { sessions: SessionService; state: HostState; configRoot: string; profileActivityLog?: (detail: string) => void }): SessionQueries {
  const queries = new SessionQueries(deps.sessions, deps.state, deps.configRoot), queue = new SessionQueue(deps.sessions, deps.state, id => readSessionModel(id, deps.configRoot).source), planning = new SessionPlanning(deps.sessions, deps.state, deps.configRoot);
  registry.registerAll({
    'profile:activity': async () => {
      // The renderer shows a plain retryable error for a failed aggregate read,
      // so the reason must survive in the diagnostic log instead.
      const reason = (stage: string, error: unknown) => JSON.stringify({ stage, error: error instanceof Error ? error.message : String(error) });
      let raw: unknown;
      try { raw = await deps.sessions.request('engine/profileActivity', {}); }
      catch (error) { deps.profileActivityLog?.(reason('engine', error)); throw error; }
      try { return profileActivitySnapshot(raw) as unknown as Json; }
      catch (error) { deps.profileActivityLog?.(reason('snapshot', error)); throw error; }
    },
    'engine:contextStats': context => queries.contextStats(typeof payload(context).sessionId === 'string' ? String(payload(context).sessionId) : ''),
    'engine:compactSession': context => { const value=payload(context); return deps.sessions.compactSession(typeof value.sessionId==='string'?value.sessionId:'',typeof value.customInstructions==='string'?value.customInstructions:''); },
    'tasks:list': context => queries.tasks(typeof payload(context).sessionId === 'string' ? String(payload(context).sessionId) : ''),
    'goal:get': context => queries.goal(typeof payload(context).sessionId === 'string' ? String(payload(context).sessionId) : ''),
    'goal:set': context => { const value = payload(context); return queries.setGoal(requiredString(value, 'sessionId'), value); },
    'goal:clear': context => { const value = payload(context); return queries.clearGoal(requiredString(value, 'sessionId'), value); },
    'goal:prepare-objective': async context => { const value = payload(context); const id = requiredString(value, 'sessionId'); await deps.sessions.assertExistingWorkflowThread(id); await deps.sessions.assertGoalPursuitEligible(id); return await queries.objectives.prepare(id, value.input as unknown as GoalObjectiveInput) as unknown as Json; },
    'goal:read-objective': context => { const value = payload(context); return queries.readGoalObjective(requiredString(value, 'sessionId'), requiredString(value, 'objective')); },
    'goal:discard-prepared-objective': async context => { const value = payload(context); deps.sessions.assertWorkflowThread(requiredString(value, 'sessionId')); await queries.objectives.discard(requiredString(value, 'sessionId'), requiredString(value, 'preparationId')); return { ok: true }; },
    'session:get-spec-mode': async context => { const reply = await planning.get(requiredString(payload(context), 'sessionId')); return { ...reply, enabled: (reply.planning as Record<string, Json>).mode === 'plan' }; },
    'session:set-spec-mode': async context => { const value = payload(context); if (typeof value.enabled !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'enabled must be a boolean'); const reply = await planning.setMode(requiredString(value, 'sessionId'), { mode: value.enabled ? 'plan' : 'default' }); return { ...reply, ok: true, revision: (reply.planning as Record<string, Json>).revision! }; },
    'session:get-collaboration-mode': context => planning.get(requiredString(payload(context), 'sessionId')),
    'session:set-collaboration-mode': context => { const value = payload(context); return planning.setMode(requiredString(value, 'sessionId'), value); },
    'plan:get': context => planning.plans(requiredString(payload(context), 'sessionId')),
    'plan:read-document': context => { const value = payload(context); return planning.readDocument(requiredString(value, 'sessionId'), value); },
    'plan:save-document': context => { const value = payload(context); return planning.saveDocument(requiredString(value, 'sessionId'), value); },
    'plan:accept': context => { const value = payload(context); return planning.action(requiredString(value, 'sessionId'), value, 'implementation', context.assertCurrent); },
    'plan:feedback': context => { const value = payload(context); return planning.action(requiredString(value, 'sessionId'), value, 'feedback', context.assertCurrent); },
    'plan:cancel': context => { const value = payload(context); return planning.cancel(requiredString(value, 'sessionId'), value); },
    'chat:queue-snapshot': context => queue.snapshot(requiredString(payload(context), 'sessionId')),
    'chat:queued-follow-ups': context => queue.followUps(typeof payload(context).sessionId === 'string' ? String(payload(context).sessionId) : ''),
    'chat:edit-queued': context => queue.mutate('edit', payload(context)),
    'chat:remove-queued': context => queue.mutate('remove', payload(context)),
    'chat:reorder-queued': context => queue.mutate('reorder', payload(context)),
    'chat:client-queue-snapshot': context => deps.sessions.clientQueueSnapshot(requiredString(payload(context), 'sessionId')),
    'chat:client-queue-add': context => { const value = payload(context); return deps.sessions.clientQueueAdd(requiredString(value, 'sessionId'), value, queueReceipt(value)); },
    'chat:client-queue-remove': context => { const value = payload(context); return deps.sessions.clientQueueRemove(requiredString(value, 'sessionId'), requiredString(value, 'id'), queueRevision(value.expectedRevision), queueReceipt(value)); },
    'chat:client-queue-restore': context => { const value = payload(context); return deps.sessions.clientQueueRestore(requiredString(value, 'sessionId'), value); },
    'chat:client-queue-reorder': context => { const value = payload(context); return deps.sessions.clientQueueReorder(requiredString(value, 'sessionId'), value); },
    'chat:client-queue-resume': context => { const value = payload(context); return deps.sessions.clientQueueResume(requiredString(value, 'sessionId'), value.dispatch !== false, queueRevision(value.expectedRevision)); },
    'chat:client-queue-deliver': context => { const value = payload(context); return deps.sessions.clientQueueDeliver(requiredString(value, 'sessionId'), requiredString(value, 'id'), queueRevision(value.expectedRevision), typeof value.expectedTurnId === 'string' ? value.expectedTurnId : undefined, value.requireExpectedTurn === true, value.allowUnconfirmedRetry === true); },
    'chat:client-queue-clear': context => { const value = payload(context); return deps.sessions.clientQueueClear(requiredString(value, 'sessionId'), queueRevision(value.expectedRevision)); },
    'session:background-processes': context => queries.request(requiredString(payload(context), 'sessionId'), 'session/backgroundProcesses'),
    'session:background-process-output': context => { const value = payload(context); return queries.backgroundOutput(requiredString(value, 'sessionId'), value); },
    'session:stop-background-process': context => { const value = payload(context); return queries.stopBackground(requiredString(value, 'sessionId'), value); },
    'agents:background-summaries': context => queries.agents(typeof payload(context).sessionId === 'string' ? String(payload(context).sessionId) : ''),
    'agents:history': context => { const value = payload(context); return queries.agentHistory(requiredString(value, 'sessionId'), requiredString(value, 'agentId')); },
    'agents:teammate-messages': context => { const value = payload(context); return queries.agentHistory(requiredString(value, 'sessionId'), requiredString(value, 'taskId')); },
  }, 'session-queries');
  return queries;
}

function queueRevision(value: Json | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new IpcHandlerError('BAD_REQUEST', 'expectedRevision must be a non-negative integer');
  return value;
}

function queueReceipt(payload: Record<string, Json>): { id: string; fingerprint: string } | undefined {
  if (payload.clientMutationId === undefined && payload.mutationFingerprint === undefined) return undefined;
  if (typeof payload.clientMutationId !== 'string' || !payload.clientMutationId || payload.clientMutationId.length > 256 || typeof payload.mutationFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(payload.mutationFingerprint)) throw new IpcHandlerError('BAD_REQUEST', 'A queue mutation needs its immutable mutation receipt');
  return { id: payload.clientMutationId, fingerprint: payload.mutationFingerprint };
}
