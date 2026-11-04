import { randomUUID } from 'node:crypto';
import type {
  BrowserImportCookie, BrowserImportPassword, BrowserImportHistoryEntry,
  BrowserImportTarget, BrowserImportBatchResult,
} from '../../contracts/browser-import';
import { BrowserError } from './types';

export interface NativeImportReceipt {
  /** Confirmed prefix of the submitted batch, including cancellation. */
  applied: number;
  cancelled?: boolean;
  error?: string;
}

export interface NativeProfileImportHandle {
  importCookies(id: string, rows: readonly BrowserImportCookie[]): Promise<NativeImportReceipt>;
  importPasswords(id: string, rows: readonly BrowserImportPassword[]): Promise<NativeImportReceipt>;
  importHistory(id: string, rows: readonly BrowserImportHistoryEntry[]): Promise<NativeImportReceipt>;
  cancelImport(id: string): void;
  loadExtension(path: string): Promise<{ id: string }>;
}

/** Keep values in the host and mirror only confirmed native history writes. */
export function nativeImportTarget(
  profile: NativeProfileImportHandle,
  signal: AbortSignal,
  historyApplied: (rows: readonly BrowserImportHistoryEntry[]) => void,
): BrowserImportTarget {
  const batch = async <T>(
    rows: readonly T[],
    apply: (id: string, batch: readonly T[]) => Promise<NativeImportReceipt>,
    confirmed?: (rows: readonly T[]) => void,
  ): Promise<BrowserImportBatchResult> => {
    let applied = 0;
    for (let offset = 0; offset < rows.length && !signal.aborted; offset += 250) {
      const input = rows.slice(offset, offset + 250);
      const id = randomUUID();
      const cancel = (): void => profile.cancelImport(id);
      signal.addEventListener('abort', cancel, { once: true });
      let receipt: NativeImportReceipt;
      try {
        // Register the native request before forwarding an already queued abort.
        const pending = apply(id, input);
        if (signal.aborted) cancel();
        receipt = await pending;
      } catch {
        // Earlier batches remain applied even when a later request is rejected.
        return { applied };
      } finally {
        signal.removeEventListener('abort', cancel);
      }
      if (!Number.isSafeInteger(receipt?.applied) || receipt.applied < 0 || receipt.applied > input.length) {
        throw new BrowserError('invalid_target_result', 'The native browser returned an invalid import receipt.');
      }
      confirmed?.(input.slice(0, receipt.applied));
      applied += receipt.applied;
      if (receipt.applied !== input.length || receipt.cancelled || receipt.error) break;
    }
    return { applied };
  };
  return {
    applyCookies: rows => batch(rows, (id, input) => profile.importCookies(id, input)),
    applyPasswords: rows => batch(rows, (id, input) => profile.importPasswords(id, input)),
    applyHistory: rows => batch(rows, (id, input) => profile.importHistory(id, input), historyApplied),
    installExtension: async extension => {
      signal.throwIfAborted();
      // Installation owns its original native operation. Await its receipt so a
      // cancellation cannot hide an installation that has already completed.
      const installed = await profile.loadExtension(extension.path);
      if (!installed || typeof installed.id !== 'string' || !/^[a-p]{32}$/.test(installed.id)) {
        throw new BrowserError('invalid_target_result', 'The native browser returned an invalid extension identifier.');
      }
      return { id: installed.id };
    },
  };
}
