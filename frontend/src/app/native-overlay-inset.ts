// Viewport boundary helpers for non-modal popovers, menus, pickers, and tooltips.
//
// Native child WebContentsViews (Browser, Canvas, Prototype, VideoEditing, Ppt,
// Design, PhotoEditing, MotionGraphics, EquityResearch) dock to the right side of the window and composite above every DOM
// z-index. Each active panel publishes the width it covers through
// `--klaus-native-panel-inset-right` on `document.documentElement`. Non-modal
// floating elements anchored in the sidebar or chat column clamp against the
// uncovered right edge so they never extend underneath a native view.

const OVERLAY_INSET_PROPERTY = '--klaus-native-panel-inset-right'

export interface ViewportBoundaryWindow {
  innerWidth: number
  document?: { documentElement?: Element | null }
  getComputedStyle?: (element: Element) => { getPropertyValue(name: string): string }
}

function defaultWindow(): ViewportBoundaryWindow | undefined {
  return typeof window === 'undefined' ? undefined : window
}

export function uncoveredViewportRight(
  win: ViewportBoundaryWindow | undefined = defaultWindow(),
  minUncoveredWidth = 48,
): number {
  const vw = Number.isFinite(win?.innerWidth) ? Number(win!.innerWidth) : 0
  const root = win?.document?.documentElement
  const compute = win?.getComputedStyle
    ?? (typeof getComputedStyle === 'function' ? getComputedStyle : undefined)
  if (!root || !compute || vw <= 0) return vw
  const raw = compute(root).getPropertyValue(OVERLAY_INSET_PROPERTY)
  const inset = Number.parseFloat(raw)
  if (!Number.isFinite(inset) || inset <= 0) return vw
  const right = vw - inset
  return right >= minUncoveredWidth ? right : vw
}

/**
 * Right boundary for clamping a floating element anchored at `anchorLeft`.
 * Triggers inside the uncovered sidebar/chat region (`anchorLeft < uncovered`)
 * clamp against `uncovered` so they never cross into the native view; triggers
 * that already live in a header strip above the native view (`anchorLeft >= uncovered`)
 * clamp against the full window width.
 */
export function effectiveViewportRight(
  anchorLeft?: number,
  win: ViewportBoundaryWindow | undefined = defaultWindow(),
): number {
  const vw = Number.isFinite(win?.innerWidth) ? Number(win!.innerWidth) : 0
  const uncovered = uncoveredViewportRight(win)
  if (typeof anchorLeft === 'number' && Number.isFinite(anchorLeft) && anchorLeft >= uncovered) {
    return vw
  }
  return uncovered
}
