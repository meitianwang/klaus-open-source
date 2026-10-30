import type { Json } from '../ipc/contract';

export type BrowserObject = { [key: string]: Json };
export interface BrowserBounds { x: number; y: number; width: number; height: number }
export interface BrowserScope { sessionId?: string; targetId?: string; focusRevision?: number }
export interface BrowserTabState {
  id: string; active: boolean; url: string; title: string; loading: boolean;
}
export interface BrowserState {
  enabled: boolean; visible: boolean; conversationId: string; focusRevision: number;
  url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean;
  browserUseActive: boolean; tabId?: string; tabs: BrowserTabState[];
  turnId?: string; source?: string; initiator?: string;
  tabInventoryChanged?: boolean;
  /**
   * Intrinsic CSS width of the shown page's content (ceil of the layout
   * metrics' content size), 0 when it has never been measured. The renderer
   * uses it to give a horizontally overflowing page exactly as much panel
   * width as the content needs.
   */
  contentWidth?: number;
  /** Monotonic counter bumped on every completed content measurement. */
  contentRevision?: number;
}

export class BrowserError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'BrowserError';
  }
}

export function object(value: unknown): BrowserObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as BrowserObject : {};
}

export function json(value: unknown): Json {
  // Strip undefined and reject values that cannot cross the renderer/engine wire.
  return JSON.parse(JSON.stringify(value ?? null)) as Json;
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new BrowserError('invalid_request', `${field} must be a non-empty string.`);
  return value;
}
