/**
 * Host-facing shapes for UI-triggered browser import jobs.
 *
 * ownerId is supplied by the host IPC context, never by a renderer payload.
 * Snapshots contain only bounded progress, category counts and structured
 * errors; cookie/password values never enter this contract.
 */

import type {
  BrowserDiscoveryResult,
  BrowserImportCounts,
  BrowserImportIssue,
  BrowserImportRequest,
  BrowserImportResult,
} from './browser-import';

export const BROWSER_IMPORT_JOB_STAGES = [
  'queued',
  'preparing',
  'importing',
  'closing',
  'cancelling',
  'completed',
  'cancelled',
  'failed',
] as const;
export type BrowserImportJobStage = typeof BROWSER_IMPORT_JOB_STAGES[number];

export interface BrowserImportJobSnapshot {
  jobId: string;
  sourceId: string;
  profileId: string;
  /** Monotonic per job; start returns revision 0. */
  revision: number;
  stage: BrowserImportJobStage;
  counts: BrowserImportCounts;
  errors: BrowserImportIssue[];
  startedAt: number;
  updatedAt: number;
}

export interface BrowserImportJobHandle {
  jobId: string;
  snapshot: BrowserImportJobSnapshot;
}

/**
 * Native backend that performs browser profile discovery and import. It is
 * initialized lazily by the importer factory and receives the service-owned
 * AbortSignal for cancellation.
 */
export interface BrowserProfileImportBackend {
  discover(signal: AbortSignal): Promise<BrowserDiscoveryResult>;
  importProfile(
    requestId: string,
    request: BrowserImportRequest,
    signal: AbortSignal,
  ): Promise<BrowserImportResult>;
}

export interface BrowserImportJobOptions {
  configRoot: string;
  /** Initialize the native backend for discovery or import. */
  importer(signal: AbortSignal): Promise<BrowserProfileImportBackend>;
  /** High-level stage/counts progress. Never receives row values. */
  emit(ownerId: string, snapshot: BrowserImportJobSnapshot): void;
  /** Number of terminal snapshots retained per owner. Default 10. */
  terminalLimit?: number;
}

export class BrowserImportJobError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BrowserImportJobError';
  }
}

/** Result of an explicit discovery call, before any import job starts. */
export type BrowserImportDiscovery = BrowserDiscoveryResult;
