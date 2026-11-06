/**
 * Product-facing shapes for the built-in browser's local data pages.
 *
 * Visits and downloads are stored on this machine only. The ids are stable
 * across restarts so a page can replace or remove a row without conflating it
 * with a later visit to the same URL.
 */

export type BrowserHistorySource = 'all' | 'agent' | 'other';
export type BrowserVisitSource = Exclude<BrowserHistorySource, 'all'>;

export interface BrowserHistoryEntry {
  id: string;
  url: string;
  title: string;
  visitTime: number;
  isActorVisit: boolean;
  faviconDataUrl?: string;
}

export interface BrowserHistoryQuery {
  query?: string;
  source?: BrowserHistorySource;
  cursor?: string;
  limit?: number;
}

export interface BrowserHistoryPage {
  items: BrowserHistoryEntry[];
  nextCursor: string | null;
}

export type BrowserDownloadStatus =
  | 'in_progress'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'canceled';

export interface BrowserDownloadEntry {
  id: string;
  url: string;
  filename: string;
  path?: string;
  state: BrowserDownloadStatus;
  receivedBytes: number;
  totalBytes: number;
  startedAt: number;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  /** A terminal row whose file has since been moved or deleted. */
  exists?: boolean;
}

export interface BrowserDownloadQuery {
  query?: string;
  cursor?: string;
  limit?: number;
}

export interface BrowserDownloadPage {
  items: BrowserDownloadEntry[];
  nextCursor: string | null;
}

/** Bounded state notification for an open settings surface. */
export interface BrowserDownloadChangedEvent {
  id: string;
  sessionId: string;
  url: string;
  filename: string;
  path?: string;
  state: BrowserDownloadStatus;
  receivedBytes: number;
  totalBytes: number;
  exists?: boolean;
}

export type BrowserDataKind =
  | 'all'
  | 'cookies'
  | 'siteData'
  | 'cache'
  | 'downloads'
  | 'history';

export type BrowserDownloadAction =
  | 'open'
  | 'reveal'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'remove';

export const BROWSER_HISTORY_PAGE_SIZE = 100;
export const BROWSER_HISTORY_REMOVE_LIMIT = 500;
