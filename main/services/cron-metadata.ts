import type { Json } from '../ipc/contract';
import { IpcHandlerError } from '../ipc/registry';
import type { CronStore } from './cron-store';
import { isFailure, kvGet, kvSet } from './settings';
import { object, string } from './service-types';

const AUTOMATION_METADATA_BACKFILL_KEY = 'migrated.cron_automation_metadata_v1';

export interface CronAutomationMetadataWriter {
  backfillAutomationSessionMetadata(sessionId: string, automation: Record<string, Json>): Promise<void>;
}

export interface CronAutomationMetadataBackfillResult {
  skipped: boolean;
  updated: number;
  missing: number;
  retryNeeded: boolean;
}

/** Tag historical cron conversations without activating them or replacing existing metadata. */
export async function backfillCronAutomationSessionMetadata(
  store: CronStore,
  writer: CronAutomationMetadataWriter,
  log: (message: string) => void = () => {},
): Promise<CronAutomationMetadataBackfillResult> {
  const marker = kvGet(AUTOMATION_METADATA_BACKFILL_KEY, store.configRoot);
  if (isFailure(marker)) {
    log(`automation metadata backfill marker read failed: ${marker.message}`);
    return { skipped: false, updated: 0, missing: 0, retryNeeded: true };
  }
  if (marker === '1') return { skipped: true, updated: 0, missing: 0, retryNeeded: false };

  let sources: Record<string, Json>[];
  try {
    sources = store.sessionSources();
  } catch (error) {
    log(`automation metadata backfill source read failed: ${error instanceof Error ? error.message : String(error)}`);
    return { skipped: false, updated: 0, missing: 0, retryNeeded: true };
  }

  let updated = 0, missing = 0, retryNeeded = false;
  for (const raw of sources) {
    const source = object(raw), sessionId = string(source.sessionId), runId = Number(source.runId);
    try {
      await writer.backfillAutomationSessionMetadata(sessionId, {
        taskId: string(source.taskId),
        taskName: string(source.taskName),
        runId,
        triggerType: string(source.triggerType),
      });
      updated++;
    } catch (error) {
      if (error instanceof IpcHandlerError && error.code === 'SESSION_NOT_FOUND') missing++;
      else retryNeeded = true;
      log(`automation metadata backfill skipped session=${sessionId} run=${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (!retryNeeded) {
    const saved = kvSet(AUTOMATION_METADATA_BACKFILL_KEY, '1', store.configRoot);
    if (isFailure(saved)) {
      retryNeeded = true;
      log(`automation metadata backfill marker write failed: ${saved.message}`);
    }
  }
  return { skipped: false, updated, missing, retryNeeded };
}
