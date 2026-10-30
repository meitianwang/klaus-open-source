import type { Json } from '../ipc/contract';
import { object } from '../ipc/arguments';
import { IpcHandlerError } from '../ipc/registry';
import type { RpcRequestOptions } from '../engine/request-scheduler';
import type { EngineClientLike } from './service';
import { rawHistoryMessages } from './lifecycle';
import { goalTurnMetadataMap } from './workflow-snapshots';

/** The largest turn page the engine accepts; one history read stays bounded by it. */
const HISTORY_PAGE_LIMIT = 100;

/** Read the original transcript without starting a provider or acquiring a writer. */
export async function readStoredHistory(
  client: EngineClientLike, threadId: string, current: () => void, agentId?: string, scheduling?: RpcRequestOptions,
): Promise<Record<string, Json>> {
  // Pages arrive newest-first (each page's rows oldest-first inside it), so the
  // assembled transcript reverses the page order. A whole history therefore
  // crosses the wire as bounded frames instead of one reply sized by the
  // conversation, which is what kept a 90 MB image-bearing rollout from ever
  // being a single frame on the engine's stdout.
  const pages: Json[][] = [];
  // Paged reads carry the turn metadata of THEIR window only, so the assembled
  // whole merges every page's maps instead of keeping the last page's.
  const MERGED_TURN_FIELDS = ['historyTurnIds', 'turnFinalMessageIds', 'turnStatuses', 'turnStartedAtMs', 'turnFinishedAtMs', 'turnDurations', 'turnCancelledTools', 'turnErrors', 'turnErrorKinds'] as const;
  const mergedMaps: Record<string, Record<string, Json>> = Object.fromEntries(MERGED_TURN_FIELDS.map(field => [field, {}]));
  const mergedErrorDetails: Record<string, Json> = {};
  let sawErrorDetails = false;
  const savedNotifications: Json[] = [];
  const goalCompletions = new Map<string, Json>();
  const turnGoalMetadata: Record<string, Json> = Object.create(null);
  let cursor: string | undefined, reply: Record<string, Json> | undefined;
  for (let page = 0; page < 1024; page++) {
    const one = object(await client.requestWithTimeout(
      agentId === undefined ? 'engine/readThreadHistory' : 'engine/readSubagentHistory',
      { threadId, ...(agentId === undefined ? { limit: HISTORY_PAGE_LIMIT, itemsView: 'full', ...(cursor ? { cursor } : {}) } : { agentId }) }, 30_000, scheduling,
    ));
    current();
    if (one?.error != null) throw new IpcHandlerError('ENGINE_REQUEST_FAILED', typeof one.error === 'string' ? one.error : 'Stored conversation history is unavailable');
    if (!one || one.threadId !== threadId || (agentId !== undefined && one.agentId !== agentId)) {
      throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned history for a different conversation');
    }
    pages.push(rawHistoryMessages(one));
    for (const field of MERGED_TURN_FIELDS) {
      const value = object(one[field]);
      if (!value) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', `The engine omitted the stored history field ${field}`);
      const bucket = mergedMaps[field];
      if (!bucket) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', `The engine omitted the stored history field ${field}`);
      Object.assign(bucket, value);
    }
    if (one.turnErrorDetails !== undefined) {
      const value = object(one.turnErrorDetails);
      if (!value) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned invalid saved error details');
      Object.assign(mergedErrorDetails, value);
      sawErrorDetails = true;
    }
    if (!Array.isArray(one.agentNotifications)) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine omitted saved agent notifications');
    savedNotifications.push(...(Array.isArray(one.agentNotifications) ? one.agentNotifications : []));
    Object.assign(turnGoalMetadata, goalTurnMetadataMap(one.turnGoalMetadata));
    if (one.goalCompletions !== undefined && !Array.isArray(one.goalCompletions)) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned invalid saved goal completions');
    for (const value of Array.isArray(one.goalCompletions) ? one.goalCompletions : []) {
      const record = object(value), goal = object(record?.goal);
      if (typeof goal?.goalId === 'string') goalCompletions.set(JSON.stringify([goal.goalId, record?.goalRevision]), value);
    }
    reply = one;
    const pageInfo = object(one.page) ?? {}, next = typeof pageInfo.nextCursor === 'string' ? pageInfo.nextCursor : undefined;
    if (pageInfo.hasMore !== true || !next) break;
    if (next === cursor) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned an unchanged history cursor');
    cursor = next;
  }
  if (!reply) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned no history page');
  reply = { ...reply, history: pages.reverse().flat(), ...mergedMaps, ...(sawErrorDetails ? { turnErrorDetails: mergedErrorDetails } : {}), agentNotifications: savedNotifications, ...(Object.keys(turnGoalMetadata).length ? { turnGoalMetadata } : {}), ...(goalCompletions.size ? { goalCompletions: [...goalCompletions.values()] } : {}) };
  for (const field of ['historyTurnIds', 'turnFinalMessageIds', 'turnStatuses', 'turnStartedAtMs', 'turnFinishedAtMs', 'turnDurations', 'turnCancelledTools', 'turnErrors', 'turnErrorKinds']) {
    if (!object(reply[field])) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', `The engine omitted the stored history field ${field}`);
  }
  if (reply.turnErrorDetails !== undefined && !object(reply.turnErrorDetails)) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine returned invalid saved error details');
  if (!Array.isArray(reply.agentNotifications)) throw new IpcHandlerError('INVALID_ENGINE_RESPONSE', 'The engine omitted saved agent notifications');
  return reply;
}
