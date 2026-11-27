import type { CronStore } from './cron-store';
import { object } from './service-types';

export interface CronCleanupDeps {
  cancelTask?: (id: string) => Promise<string | null>;
  automationThreadIds?: (id: string) => Promise<string[]>;
  deleteSession?: (id: string) => Promise<unknown>;
  onSessionsDeleted?: (ids: string[]) => void;
  onChanged: () => void | Promise<void>;
  log?: (message: string) => void;
}

export async function deleteCronTaskWithSessions(store: CronStore, id: string, mode: 'settings' | 'tool', deps: CronCleanupDeps) {
  const deletedSessionIds: string[] = [];
  const missing = { deleted: false, sessionCount: 0, deletedSessionIds };
  if (mode === 'tool' && !store.toolTasks().some(task => task.id === id)) return missing;
  const cancelledSessionId = await deps.cancelTask?.(id);
  const runSessionIds = store.taskSessionIds(id);
  const result = mode === 'tool' ? { deleted: store.deleteToolTask(id), sessionCount: runSessionIds.length } : object(store.deleteTask(id));
  if (mode === 'tool' && !result.deleted) return missing;
  const metadataSessionIds = await deps.automationThreadIds?.(id).catch(() => []) ?? [];
  for (const sessionId of new Set([cancelledSessionId, ...runSessionIds, ...metadataSessionIds])) {
    if (!sessionId || sessionId.startsWith('cron-run-') || !deps.deleteSession) continue;
    try {
      await deps.deleteSession(sessionId);
      deletedSessionIds.push(sessionId);
    } catch (error) {
      const code = (error as { code?: string } | null)?.code;
      const message = error instanceof Error ? error.message : String(error);
      if (code !== 'SESSION_NOT_FOUND' && code !== 'UNKNOWN_SESSION' && !/session .+ not found/i.test(message)) {
        deps.log?.(`delete run conversation ${sessionId}: ${message}`);
      }
    }
  }
  if (deletedSessionIds.length) deps.onSessionsDeleted?.(deletedSessionIds);
  await deps.onChanged();
  return { deleted: result.deleted === true, sessionCount: Number(result.sessionCount), deletedSessionIds };
}
