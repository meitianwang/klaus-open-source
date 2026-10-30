import type { PetMainCapture } from '../../../../contracts/desktop-pet-appshot';
import type { PendingFileEntry } from '../engine-events';

export interface AppshotMainDependencies {
  currentSession(): string | null;
  lastSession(): string | null;
  newChat(): void;
  switchSession(id: string): Promise<void>;
  attach(entry: PendingFileEntry): void;
  focus(): void;
  accepted(captureId: string, accepted: boolean, error?: string): Promise<void>;
}
/** Routes completed captures using the renderer's real conversation selection. */
export function createAppshotMainConsumer(deps: AppshotMainDependencies): (value: PetMainCapture) => Promise<void> {
  const receipts = new Map<string, Promise<void>>();
  return value => {
    const prior = receipts.get(value.captureId); if (prior) return prior;
    const work = (async () => {
      try {
        if (!value.captureId || !value.attachment?.path || !value.attachment.name || value.attachment.mimeType !== 'image/png' || !Number.isFinite(value.attachment.size) || value.attachment.size <= 0) throw new Error('The application screenshot is unavailable');
        if (value.threadTarget === 'new-chat') deps.newChat();
        else if (value.threadTarget === 'last-chat' && !deps.currentSession()) { const target = deps.lastSession(); if (target) { await deps.switchSession(target); if (deps.currentSession() !== target) throw new Error('The screenshot target changed while its conversation was opening'); } }
        deps.attach({ file: { name: value.attachment.name, type: value.attachment.mimeType, size: value.attachment.size }, uploadPath: value.attachment.path, uploading: false, objectUrl: value.attachment.previewUrl ?? null, appshotContext: value.attachment.context });
        deps.focus(); await deps.accepted(value.captureId, true);
      } catch (error) { await deps.accepted(value.captureId, false, error instanceof Error ? error.message : String(error)); throw error; }
    })();
    receipts.set(value.captureId, work); if (receipts.size > 256) receipts.delete(receipts.keys().next().value!); return work;
  };
}
