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
  BrowserImportTarget,
  BrowserPasswordDecryptor,
  BrowserSourceRoot,
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

/** A decryptor that owns helper/process resources and must be closed. */
export interface ManagedDecryptor extends BrowserPasswordDecryptor {
  close(): Promise<void>;
}

export type BrowserImportJobRoots =
  | readonly BrowserSourceRoot[]
  | (() => readonly BrowserSourceRoot[]);

export interface BrowserImportJobOptions {
  /**
   * Root list or path-producing function. Discovery is not performed here;
   * only the explicit discover/start entry points read Local State.
   */
  roots: BrowserImportJobRoots;
  configRoot: string;
  /** Initialize the runtime target for this import. */
  target(request: BrowserImportRequest, signal: AbortSignal): Promise<BrowserImportTarget>;
  /** Create the decryption adapter lazily on the first encrypted value. */
  createDecryptor(
    source: BrowserSourceRoot,
    signal: AbortSignal,
  ): ManagedDecryptor;
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
