/** One framed observation as the native watcher reports it. */
export interface ComputerHistoryFrame {
  event: 'appActivated' | 'windowTitle' | 'unavailable' | 'stopped';
  bundleId?: string;
  name?: string;
  title?: string;
  url?: string;
  pid?: number;
  reason?: string;
  at?: number;
}

/** One persisted timeline entry. */
export interface ComputerHistoryEntry {
  kind: 'app' | 'window';
  at: number;
  bundleId?: string;
  name?: string;
  title?: string;
  url?: string;
}

export interface ComputerHistoryStatus {
  state: 'running' | 'paused' | 'stopped';
  /** Present when observation degraded, e.g. a missing accessibility permission. */
  unavailableReason?: string;
  entryCount: number;
  retentionMs: number;
  managedDisabled: boolean;
}

export function isComputerHistoryFrame(value: unknown): value is ComputerHistoryFrame {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return row.event === 'appActivated' || row.event === 'windowTitle' || row.event === 'unavailable' || row.event === 'stopped';
}
