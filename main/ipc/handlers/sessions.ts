import { payload, requiredString } from '../arguments';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { ChannelRegistry, IpcHandlerError } from '../registry';
import type { HostState } from '../../services/host-state';
import type { SessionService } from '../../sessions/service';
import type { SessionEventPump } from '../../sessions/events';
import { exportThread } from '../../sessions/lifecycle';
import { sessionDir } from '../../services/session-init';
import type { Json } from '../contract';

export function registerSessionHandlers(registry: ChannelRegistry, deps: {
  sessions: SessionService;
  state: HostState;
  events: SessionEventPump;
  configRoot: string;
  chooseExportPath(defaultPath: string): Promise<string | undefined>;
  onAttentionResolved?(kind: 'permission' | 'elicit', payload: Json): void;
}): void {
  const { sessions, state, events } = deps;
  registry.registerAll({
    'session:new': context => {
      const value = payload(context);
      if (value.workdir != null && typeof value.workdir !== 'string') throw new IpcHandlerError('BAD_REQUEST', 'workdir must be a path');
      if (value.workspaceId != null && typeof value.workspaceId !== 'string') throw new IpcHandlerError('BAD_REQUEST', 'workspaceId must be a string');
      if (value.projectRoot != null && typeof value.projectRoot !== 'string') throw new IpcHandlerError('BAD_REQUEST', 'projectRoot must be a path');
      return sessions.newSession({ workdir: value.workdir as string | null | undefined, workspaceId: value.workspaceId as string | null | undefined,
        projectRoot: value.projectRoot as string | null | undefined });
    },
    'session:list': () => sessions.listSessions(),
    'session:mention-candidates': context => {
      const value = payload(context);
      if (value.query !== undefined && typeof value.query !== 'string') throw new IpcHandlerError('BAD_REQUEST', 'query must be a string');
      if (value.cursor !== undefined && typeof value.cursor !== 'string') throw new IpcHandlerError('BAD_REQUEST', 'cursor must be a string');
      if (value.limit !== undefined && typeof value.limit !== 'number') throw new IpcHandlerError('BAD_REQUEST', 'limit must be a number');
      return sessions.mentionCandidates({
        ...(typeof value.query === 'string' ? { query: value.query } : {}),
        ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
        ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
      }) as unknown as Promise<Json>;
    },
    'session:runtime-state': context => {
      const ids = payload(context).sessionIds;
      if (ids !== undefined && (!Array.isArray(ids) || ids.length > 256
        || ids.some(id => typeof id !== 'string' || !id || id.length > 512))) {
        throw new IpcHandlerError('BAD_REQUEST', 'sessionIds must be a bounded list of conversation identities');
      }
      return sessions.runtimeState(ids as string[] | undefined) as unknown as Promise<Json>;
    },
    'session:list-archived': () => sessions.listArchivedSessions(),
    'session:view-retain': context => {
      context.assertCurrent?.();
      const value = payload(context), id = requiredString(value, 'sessionId'), viewId = requiredString(value, 'viewId');
      if (!/^[a-zA-Z0-9_-]{1,256}$/.test(viewId)) throw new IpcHandlerError('BAD_REQUEST', 'Invalid conversation view token');
      return sessions.retainView(context.senderId, id, viewId);
    },
    'session:view-release': context => {
      context.assertCurrent?.();
      const value = payload(context), id = requiredString(value, 'sessionId'), viewId = requiredString(value, 'viewId');
      if (!/^[a-zA-Z0-9_-]{1,256}$/.test(viewId)) throw new IpcHandlerError('BAD_REQUEST', 'Invalid conversation view token');
      return sessions.releaseView(context.senderId, id, viewId);
    },
    'side-task:list': context => sessions.listSideTasks(requiredString(payload(context), 'parentSessionId')),
    'side-task:create': context => {
      const value = payload(context);
      return sessions.createSideTask(requiredString(value, 'parentSessionId'), value.initialTitleIndex);
    },
    'side-task:touch': context => sessions.touchSideTask(requiredString(payload(context), 'sessionId')),
    'side-task:close': context => sessions.closeSideTask(requiredString(payload(context), 'sessionId')),
    'session:rename': context => {
      const value = payload(context); return sessions.rename(requiredString(value, 'sessionId'), requiredString(value, 'title'));
    },
    'session:set-pinned': context => {
      const value = payload(context);
      if (typeof value.pinned !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'pinned must be a boolean');
      return sessions.setPinned(requiredString(value, 'sessionId'), value.pinned);
    },
    'session:archive': context => {
      const value = payload(context); return sessions.setArchived(requiredString(value, 'sessionId'), true, typeof value.displayTitle === 'string' ? value.displayTitle : undefined);
    },
    'session:unarchive': context => sessions.setArchived(requiredString(payload(context), 'sessionId'), false),
    'session:history': context => sessions.history(requiredString(payload(context), 'sessionId')),
    'session:history-page': context => {
      const value = payload(context);
      return sessions.historyPage(requiredString(value, 'sessionId'), {
        ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
        ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
        ...(typeof value.itemsView === 'string' ? { itemsView: value.itemsView } : {}),
        ...(typeof value.sortDirection === 'string' ? { sortDirection: value.sortDirection } : {}),
      });
    },
    'session:history-items': context => {
      const value = payload(context);
      return sessions.historyItems(requiredString(value, 'sessionId'), {
        turnId: requiredString(value, 'turnId'),
        ...(typeof value.beforeItemId === 'string' ? { beforeItemId: value.beforeItemId } : {}),
        ...(typeof value.cursor === 'string' ? { cursor: value.cursor } : {}),
        ...(typeof value.limit === 'number' ? { limit: value.limit } : {}),
        ...(typeof value.sortDirection === 'string' ? { sortDirection: value.sortDirection } : {}),
      });
    },
    'session:fork': context => {
      const value = payload(context);
      for (const field of ['beforeMessageUuid', 'afterMessageUuid', 'lastTurnId', 'beforeTurnId'] as const) {
        if (value[field] != null && typeof value[field] !== 'string') {
          throw new IpcHandlerError('BAD_REQUEST', `${field} must be a string`);
        }
      }
      if (value.inheritGoal !== undefined && typeof value.inheritGoal !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'inheritGoal must be a boolean');
      return sessions.forkSession(requiredString(value, 'sessionId'), {
        ...(typeof value.beforeMessageUuid === 'string' ? { beforeMessageUuid: value.beforeMessageUuid } : {}),
        ...(typeof value.afterMessageUuid === 'string' ? { afterMessageUuid: value.afterMessageUuid } : {}),
        ...(typeof value.lastTurnId === 'string' ? { lastTurnId: value.lastTurnId } : {}),
        ...(typeof value.beforeTurnId === 'string' ? { beforeTurnId: value.beforeTurnId } : {}),
        inheritGoal: value.inheritGoal === true,
      });
    },
    'session:export': context => {
      const id = requiredString(payload(context), 'sessionId');
      return exportThread({ read: () => sessions.exportMessages(id), assertCurrent: context.assertCurrent,
        choosePath: context.role === 'mobile' ? async defaultPath => {
          context.assertCurrent?.();
          const directory = join(deps.configRoot, 'exports', randomUUID());
          await mkdir(directory, { recursive: true, mode: 0o700 }); context.assertCurrent?.();
          return join(directory, basename(defaultPath));
        } : deps.chooseExportPath,
        directory: async () => { const path = await sessions.directory(id); return path.startsWith('ssh://') ? sessionDir(id, deps.configRoot) : path; } });
    },
    'chat:rewind-from': context => {
      const value = payload(context); return sessions.rewind(requiredString(value, 'sessionId'), typeof value.messageUuid === 'string' ? value.messageUuid : '', 'conversation', false, typeof value.turnId === 'string' ? value.turnId : '');
    },
    'chat:edit-prepare': context => {
      const value = payload(context);
      if (value.turnId != null && typeof value.turnId !== 'string') throw new IpcHandlerError('BAD_REQUEST', 'turnId must be a string');
      return sessions.editPrepare(requiredString(value, 'sessionId'), typeof value.messageUuid === 'string' ? value.messageUuid : '',
        typeof value.turnId === 'string' ? value.turnId : undefined);
    },
    'chat:edit-message': context => {
      const value = payload(context);
      if (value.text != null && typeof value.text !== 'string') throw new IpcHandlerError('BAD_REQUEST', 'text must be a string');
      const text = typeof value.text === 'string' ? value.text : '';
      if (value.displayMetadata != null && (typeof value.displayMetadata !== 'object' || Array.isArray(value.displayMetadata))) {
        throw new IpcHandlerError('BAD_REQUEST', 'displayMetadata must be an object');
      }
      if (value.media != null && !Array.isArray(value.media)) throw new IpcHandlerError('BAD_REQUEST', 'media must be an array');
      if (value.turnId != null && typeof value.turnId !== 'string') throw new IpcHandlerError('BAD_REQUEST', 'turnId must be a string');
      return sessions.editMessage(requiredString(value, 'sessionId'), typeof value.messageUuid === 'string' ? value.messageUuid : '',
        text, value.displayMetadata as Json | undefined, Array.isArray(value.media) ? value.media as Json[] : undefined,
        typeof value.turnId === 'string' ? value.turnId : undefined);
    },
    'session:delete': context => {
      const value = payload(context);
      if (value.wipeWorkspace !== undefined && typeof value.wipeWorkspace !== 'boolean') throw new IpcHandlerError('BAD_REQUEST', 'wipeWorkspace must be a boolean');
      return sessions.deleteSession(requiredString(value, 'sessionId'), value.wipeWorkspace === true);
    },
    'chat:send': context => {
      const value = payload(context);
      return sessions.send(requiredString(value, 'sessionId'), value);
    },
    'chat:continue': context => sessions.continueTurn(requiredString(payload(context), 'sessionId')),
    'chat:side-question': async (context): Promise<Json> => {
      const value = payload(context);
      try {
        return { ok: true, ...await sessions.sideQuestion(requiredString(value, 'sessionId'), requiredString(value, 'question'),
          { ownerId: context.senderId, requestId: requiredString(value, 'requestId') }) };
      } catch (error) {
        if (error instanceof IpcHandlerError && error.code === 'ABORTED') return { ok: false, cancelled: true, error: error.message };
        throw error;
      }
    },
    'chat:side-question:cancel': context => sessions.cancelSideQuestion({ ownerId: context.senderId, requestId: requiredString(payload(context), 'requestId') }),
    'chat:follow-up': context => {
      const value = payload(context);
      return sessions.followUp(requiredString(value, 'sessionId'), value);
    },
    'chat:interrupt': context => {
      const value = payload(context);
      if (value.origin !== undefined && value.origin !== 'user-stop' && value.origin !== 'targeted-turn') throw new IpcHandlerError('BAD_REQUEST', 'Invalid public interrupt origin');
      if (value.expectedTurnId != null && typeof value.expectedTurnId !== 'string') throw new IpcHandlerError('BAD_REQUEST', 'expectedTurnId must be a turn identity');
      const expected = value.origin === 'targeted-turn' ? requiredString(value, 'expectedTurnId') : typeof value.expectedTurnId === 'string' ? value.expectedTurnId : undefined;
      return sessions.interrupt(requiredString(value, 'sessionId'), expected, value.origin ?? 'user-stop');
    },
    'approval-review:approve': context => {
      const value = payload(context);
      if (!value.event || typeof value.event !== 'object' || Array.isArray(value.event)) throw new IpcHandlerError('BAD_REQUEST', 'A denied review event is required');
      context.assertCurrent?.();
      return sessions.requestSession(requiredString(value, 'sessionId'), 'session/approveApprovalReviewDenial', { event: value.event });
    },
    'permission:pending': context => state.pendingApprovalCards(requiredString(payload(context), 'sessionId')),
    'elicit:pending': context => state.pendingElicitCards(requiredString(payload(context), 'sessionId')),
    'permission:respond': async context => {
      const value = payload(context); const result = await events.respond(value, true, context.assertCurrent);
      deps.onAttentionResolved?.('permission', value); return result;
    },
    'elicit:respond': async context => {
      const value = payload(context); const result = await events.respond(value, false);
      deps.onAttentionResolved?.('elicit', value); return result;
    },
    'planning-input:pending': context => sessions.pendingPlanningInput(requiredString(payload(context), 'sessionId'), context.assertCurrent),
    'planning-input:answer': context => { const value = payload(context); return sessions.answerPlanningInput(requiredString(value, 'sessionId'), value, context.assertCurrent); },
    'question:pending': context => sessions.pendingQuestions(requiredString(payload(context), 'sessionId'), context.assertCurrent),
    'question:answer': context => {
      const value = payload(context);
      for (const key of ['requestId', 'turnId', 'clientResponseId']) requiredString(value, key);
      return sessions.answerQuestion(requiredString(value, 'sessionId'), value, context.assertCurrent);
    },
  }, 'sessions');
}
