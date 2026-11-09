// Auto width for the embedded browser panel.
//
// The host measures the shown page's intrinsic content width (CSS pixels)
// after loads, attaches and viewport changes, reporting non-zero only while
// the content is wider than its viewport. This module turns that measurement
// into a right-panel width: widen to exactly the content width (plus a
// scrollbar margin), capped at what the window can still give the panel.
//
// Deliberately absent: shrinking on a "fits" reading of the SAME document.
// Widening changes the viewport, the host re-measures, and a fluid page then
// reports "fits" — shrinking on that would feed the two into an oscillation.
// A document that fits simply keeps whatever width it has.
//
// No module-level DOM references: every lookup happens per call so test
// doubles can drive the state machine without owning the module for the
// whole process.

const AUTO_WIDTH_PAD = 16
const AUTO_WIDTH_MAX = 1400
// Same meaning as chat.ts PANEL_RESIZE_MIN_MAIN_WIDTH: the transcript column
// keeps at least this much width.
const AUTO_WIDTH_MIN_MAIN = 420
const AUTO_WIDTH_MIN_PANEL = 260
const DEFAULT_SIDEBAR_WIDTH = 300

export interface AutoWidthReading {
  tabId?: string | null
  url?: string
  loading?: boolean
  contentWidth?: number
  contentRevision?: number
}

// The document the current widening is locked to (tab + url without hash).
// Switching documents or reloading unlocks it.
let docKey: string | null = null
let applied = false
let baseWidth = 0
let desiredWidth = 0
// A manual drag is explicit intent: no automatic widening for this document.
let manual = false

function docKeyOf(state: AutoWidthReading): string {
  return `${state.tabId ?? ''}|${(state.url || '').split('#')[0]}`
}

function currentWidth(): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--artifacts-panel-width')
  const value = parseFloat(raw)
  return Number.isFinite(value) && value > 0 ? value : 460
}

function setWidth(px: number): void {
  const width = Math.round(px)
  document.documentElement.style.setProperty('--artifacts-panel-width', `${width}px`)
  document.getElementById('artifacts-panel-resizer')?.setAttribute('aria-valuenow', String(width))
}

function revert(): void {
  if (applied && baseWidth > 0) setWidth(baseWidth)
  applied = false
}

function cap(): number {
  const app = document.getElementById('app')?.getBoundingClientRect().width || window.innerWidth
  const sidebar = document.getElementById('sidebar')
  const rectWidth = sidebar ? sidebar.getBoundingClientRect().width : 0
  const configuredWidth = parseFloat(document.documentElement.style.getPropertyValue('--sidebar-width')) || DEFAULT_SIDEBAR_WIDTH
  const sidebarWidth = sidebar && !sidebar.classList.contains('collapsed')
    ? (rectWidth > 0 ? rectWidth : configuredWidth)
    : 0
  return Math.max(AUTO_WIDTH_MIN_PANEL, Math.min(AUTO_WIDTH_MAX, app - sidebarWidth - AUTO_WIDTH_MIN_MAIN))
}

/** A manual drag of the panel width: automatic widening yields for this document. */
export function noteBrowserPanelManualResize(): void {
  manual = true
}

/** Back to the initial lock state; tests restore this between files. */
export function resetBrowserAutoWidth(): void {
  docKey = null
  applied = false
  baseWidth = 0
  desiredWidth = 0
  manual = false
}

/**
 * Re-apply the active document's cap when the window or left sidebar changes
 * the width available to the main chat column and right panel.
 */
export function reclampBrowserAutoWidth(panelVisible: boolean): boolean {
  if (!panelVisible) return false
  if (document.body.classList.contains('artifacts-maximized')) return false
  if (!applied || manual || desiredWidth <= 0) return false
  const target = Math.min(cap(), desiredWidth)
  if (Math.abs(target - currentWidth()) > 0.5) setWidth(target)
  return true
}

export function syncBrowserAutoWidth(state: AutoWidthReading, panelVisible: boolean): void {
  const key = docKeyOf(state)
  // Reload or a different document: back to the user's own width first, then
  // let the new document's measurements speak.
  if (state.loading || key !== docKey) {
    revert()
    manual = false
    desiredWidth = 0
    docKey = key
    if (state.loading) return
  }
  if (!panelVisible) return
  if (document.body.classList.contains('artifacts-maximized')) return
  if (manual) return
  if (!(Number(state.contentRevision) || 0)) return
  const content = Math.round(Number(state.contentWidth) || 0)
  if (content <= 0) return
  desiredWidth = content + AUTO_WIDTH_PAD
  const target = Math.min(cap(), desiredWidth)
  if (!applied) {
    baseWidth = currentWidth()
    applied = true
  }
  if (Math.abs(target - currentWidth()) > 0.5) setWidth(target)
}
