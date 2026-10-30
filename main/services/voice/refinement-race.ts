export interface CompletedRefinement {
  text: string;
  rawText: string;
  polished: boolean;
  refinementComplete: boolean;
  refinementSource: 'native' | 'text-model';
}
interface Options {
  rawText: string;
  delayMs: number;
  refine(signal: AbortSignal): Promise<{ text: string; polished: boolean }>;
  complete(result: CompletedRefinement): Promise<void>;
  failed(code: string): Promise<void>;
}

/** A delay starts another complete-result route; it never commits raw text. */
export function refinementBackupDelay(audioMs: number): number {
  return 6000 + Math.ceil(Math.max(0, audioMs) / 30000) * 500;
}

/** Publish the first complete refinement while keeping the other route cancellable. */
export class RefinementRace {
  readonly done: Promise<void>;
  private resolveDone!: () => void;
  private readonly abort = new AbortController();
  private timer?: ReturnType<typeof setTimeout>;
  private terminal = false;
  private backupStarted = false;
  private backupFailed = false;
  private primaryError?: string;

  constructor(private readonly options: Options) {
    this.done = new Promise(resolve => { this.resolveDone = resolve; });
    this.timer = setTimeout(() => { void this.startBackup(); }, options.delayMs);
  }
  native(result: Omit<CompletedRefinement, 'refinementSource'>): void {
    if (this.terminal) return;
    if (!result.refinementComplete || !result.text.trim()) { this.failed('voice-finalization-failed'); return; }
    void this.finish({ ...result, rawText: result.rawText || this.options.rawText, refinementSource: 'native' });
  }
  failed(code: string): void {
    if (this.terminal) return;
    this.primaryError = code;
    this.clearTimer();
    if (this.backupFailed) void this.reject(code);
    else void this.startBackup();
  }
  cancel(): void {
    this.clearTimer(); this.abort.abort(new Error('voice-cancelled'));
    if (!this.terminal) { this.terminal = true; this.resolveDone(); }
  }
  private clearTimer(): void { clearTimeout(this.timer); this.timer = undefined; }
  private async startBackup(): Promise<void> {
    if (this.terminal || this.backupStarted) return;
    this.backupStarted = true; this.clearTimer();
    try {
      const result = await this.options.refine(this.abort.signal);
      if (this.terminal) return;
      if (result.polished && result.text.trim()) {
        await this.finish({ text: result.text, rawText: this.options.rawText, polished: true, refinementComplete: true, refinementSource: 'text-model' });
        return;
      }
    } catch { /* A failed backup cannot replace a pending complete primary result. */ }
    if (this.terminal) return;
    this.backupFailed = true;
    if (this.primaryError) await this.reject(this.primaryError);
  }
  private async finish(result: CompletedRefinement): Promise<void> {
    if (this.terminal) return;
    this.terminal = true; this.clearTimer(); this.abort.abort(new Error('voice-refinement-complete'));
    try { await this.options.complete(result); }
    catch { /* The owner fences publication and closes its physical resources. */ }
    finally { this.resolveDone(); }
  }
  private async reject(code: string): Promise<void> {
    if (this.terminal) return;
    this.terminal = true; this.clearTimer(); this.abort.abort(new Error('voice-refinement-failed'));
    try { await this.options.failed(code); }
    catch { /* The owner may have detached while an error was being delivered. */ }
    finally { this.resolveDone(); }
  }
}
