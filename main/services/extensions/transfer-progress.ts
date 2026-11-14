export type ExtensionTransferStage = 'downloading' | 'verifying' | 'extracting' | 'installing';

export type ExtensionTransferEvent = {
  id: string;
  action: 'install' | 'update';
  stage: ExtensionTransferStage;
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
  cancellable: boolean;
};

export interface TransferTrackerOptions {
  onProgress?: (event: ExtensionTransferEvent) => void;
  progressIntervalMs?: number;
  now?: () => number;
}

const DEFAULT_PROGRESS_INTERVAL_MS = 150;
const SPEED_SMOOTHING_ALPHA = 0.3;
const DOWNLOAD_PROGRESS_CEILING = 82;
const STAGE_PERCENT: Record<Exclude<ExtensionTransferStage, 'downloading'>, number> = {
  verifying: 86,
  extracting: 92,
  installing: 97,
};

interface ActiveEntry {
  id: string;
  controller: AbortController;
  cancellable: boolean;
  cancelledByUser: boolean;
}

export interface TrackedAcquisition {
  readonly signal: AbortSignal;
  setId(id: string): void;
  isCancelledByUser(): boolean;
  lockCommit(): void;
  emit(stage: ExtensionTransferStage, transferred?: number, total?: number): void;
  finish(): void;
}

/**
 * Shared host-side transfer progress & cancellation tracker for plugins, skills
 * and sub-agents: 150ms throttling, EMA speed smoothing (alpha=0.3), strictly
 * monotonic cross-stage percentage, and pre-commit user cancellation.
 */
export class ExtensionTransferTracker {
  private closed = false;
  private readonly active = new Set<ActiveEntry>();

  constructor(private readonly options: TransferTrackerOptions = {}) {}

  begin(initialId: string, action: 'install' | 'update'): TrackedAcquisition {
    const entry: ActiveEntry = {
      id: initialId,
      controller: new AbortController(),
      cancellable: true,
      cancelledByUser: false,
    };
    this.active.add(entry);
    const clock = this.options.now ?? (() => Date.now());
    const interval = this.options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
    let lastSampleAt: number | undefined;
    let lastSampleBytes: number | undefined;
    let smoothedSpeed: number | undefined;
    let lastEmittedAt: number | undefined;
    let knownTotal = 0;
    let highestPercent = 0;

    return {
      signal: entry.controller.signal,
      setId: (id: string) => { entry.id = id; },
      isCancelledByUser: () => entry.cancelledByUser,
      lockCommit: () => { entry.cancellable = false; },
      emit: (stage: ExtensionTransferStage, transferred = 0, total = 0) => {
        if (this.closed || !entry.id || entry.cancelledByUser) return;
        if (total > 0) knownTotal = total;
        if (stage === 'downloading') {
          const at = clock();
          if (lastSampleAt !== undefined && lastSampleBytes !== undefined) {
            const elapsed = at - lastSampleAt, delta = transferred - lastSampleBytes;
            if (delta < 0) {
              smoothedSpeed = undefined;
              highestPercent = 0;
            } else if (elapsed > 0 && delta > 0) {
              const instant = (delta / elapsed) * 1000;
              smoothedSpeed = smoothedSpeed === undefined
                ? instant
                : smoothedSpeed * (1 - SPEED_SMOOTHING_ALPHA) + instant * SPEED_SMOOTHING_ALPHA;
            }
          }
          lastSampleAt = at;
          lastSampleBytes = transferred;
          const ratio = total > 0 ? Math.max(0, Math.min(1, transferred / total)) : 0;
          const complete = total > 0 && transferred >= total;
          if (!complete && lastEmittedAt !== undefined && at - lastEmittedAt < interval) return;
          lastEmittedAt = at;
          highestPercent = Math.max(highestPercent, ratio * DOWNLOAD_PROGRESS_CEILING);
          this.options.onProgress?.({
            id: entry.id,
            action,
            stage,
            percent: highestPercent,
            transferred,
            total,
            bytesPerSecond: smoothedSpeed ?? 0,
            cancellable: entry.cancellable,
          });
          return;
        }
        highestPercent = Math.max(highestPercent, STAGE_PERCENT[stage]);
        this.options.onProgress?.({
          id: entry.id,
          action,
          stage,
          percent: highestPercent,
          transferred: knownTotal || transferred,
          total: knownTotal || total,
          bytesPerSecond: 0,
          cancellable: entry.cancellable,
        });
      },
      finish: () => { this.active.delete(entry); },
    };
  }

  cancel(id: string): { ok: boolean; id: string; cancelled: boolean; active: boolean } {
    const matching = [...this.active].filter(entry => entry.id === id);
    const cancellable = matching.filter(entry => entry.cancellable);
    for (const entry of cancellable) {
      entry.cancelledByUser = true;
      entry.controller.abort();
    }
    return { ok: cancellable.length > 0, id, cancelled: cancellable.length > 0, active: matching.length > 0 };
  }

  abortAll(): void {
    this.closed = true;
    for (const entry of this.active) entry.controller.abort();
  }
}
