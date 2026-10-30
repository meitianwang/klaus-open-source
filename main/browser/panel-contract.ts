import type { BrowserObject } from './types';

/**
 * A visual browser operation gives the renderer a short window to mount the
 * native page before the tool result is published. A slow or absent renderer
 * never turns successful browser work into a failed tool call.
 */
export const BROWSER_PANEL_OPEN_ACK_TIMEOUT_MS = 600;

const VISUAL_OPERATIONS = new Set([
  'navigate', 'back', 'forward', 'reload', 'click', 'type', 'form_input',
  'select_option', 'set_checked', 'computer',
]);

/** Reading the page stays in the background; only operations that change the
 * visible page ask the work panel to reveal it. */
export function browserOperationRequestsPanel(kind: string, fields: BrowserObject): boolean {
  if (kind === 'new_tab') return true;
  if (kind === 'tabs') return fields.action === 'new' || fields.action === 'select';
  return VISUAL_OPERATIONS.has(kind);
}
