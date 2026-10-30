import { MobileError } from './protocol';

interface Pending { foreground: boolean; start(): void; cancel(): void }

/** Transcript reads never hold the ordered transport admission or mutation lane. */
export class MobileHydrationQueue {
  private activeBackground = 0;
  private activeForeground = 0;
  private readonly pending: Pending[] = [];

  run<T>(operation: () => Promise<T>, signal: AbortSignal, foreground = false): Promise<T> {
    signal.throwIfAborted();
    if (this.pending.length >= 64) return Promise.reject(new MobileError(429, 'too_many_history_requests', 'Too many pending transcript reads'));
    return new Promise<T>((resolve, reject) => {
      const entry: Pending = {
        foreground,
        start: () => {
          signal.removeEventListener('abort', entry.cancel);
          if (signal.aborted) { reject(signal.reason); this.drain(); return; }
          if (foreground) this.activeForeground++; else this.activeBackground++;
          void Promise.resolve().then(operation).then(resolve, reject).finally(() => { if (foreground) this.activeForeground--; else this.activeBackground--; this.drain(); });
        },
        cancel: () => {
          const index = this.pending.indexOf(entry);
          if (index >= 0) this.pending.splice(index, 1);
          signal.removeEventListener('abort', entry.cancel); reject(signal.reason);
        },
      };
      this.pending.push(entry); signal.addEventListener('abort', entry.cancel, { once: true }); this.drain();
    });
  }

  private drain(): void {
    for (const foreground of [true, false]) {
      while ((foreground ? this.activeForeground < 1 : this.activeBackground < 2)) {
        const index = this.pending.findIndex(entry => entry.foreground === foreground);
        if (index < 0) break;
        this.pending.splice(index, 1)[0]!.start();
      }
    }
  }
}
