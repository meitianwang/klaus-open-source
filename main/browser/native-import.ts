import type {
  BrowserImportCookie, BrowserImportPassword, BrowserImportHistoryEntry,
} from '../../contracts/browser-import';

export interface NativeImportReceipt {
  /** Confirmed rows; history uses explicit indices when retention skips rows. */
  applied: number;
  /** History-only acknowledgement of a processed input prefix. */
  processed?: number;
  confirmedIndices?: number[];
  skippedExpired?: number;
  cancelled?: boolean;
  error?: string;
}

/** Low-level native store methods used by isolated native-runtime fixtures. */
export interface NativeProfileImportHandle {
  importCookies(id: string, rows: readonly BrowserImportCookie[]): Promise<NativeImportReceipt>;
  importPasswords(id: string, rows: readonly BrowserImportPassword[]): Promise<NativeImportReceipt>;
  importHistory(id: string, rows: readonly BrowserImportHistoryEntry[]): Promise<NativeImportReceipt>;
  cancelImport(id: string): void;
  loadExtension(path: string): Promise<{ id: string }>;
}
