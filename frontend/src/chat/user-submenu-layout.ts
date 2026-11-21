// Layout helper for sidebar user-menu submenus (theme, font size, language).
//
// Native child views (Design Canvas, Presentation, Browser, Canvas, Prototype,
// Video Editor) composite above every renderer DOM layer regardless of z-index.
// When the right panel is maximized or widened enough to reach past the user
// menu's right edge, placing a submenu at `anchor.right + 8` puts it directly
// behind the native view, making clicks on the row appear to do nothing.
//
// Prefer placing the submenu to the right of its trigger when that fits in the
// uncovered region; otherwise stack it directly above `#user-menu` inside the
// uncovered sidebar area so the native panel stays live without blanking. Only
// fall back to suspending native views when neither placement fits.

export interface SubmenuRect {
  left: number
  right: number
  top: number
  bottom: number
}

export interface SubmenuLayoutInput {
  anchorRect: SubmenuRect
  menuRect: SubmenuRect | null
  submenuSize: { width: number; height: number }
  viewport: { width: number; height: number }
  nativeInsetRight: number
}

export interface SubmenuLayoutResult {
  left: number
  top: number
  maxHeight: number | null
  placement: 'right' | 'above' | 'right-suspended'
  suspendNative: boolean
}

const MARGIN = 8
const GAP = 8
const MIN_STACKED_HEIGHT = 120

export function parseNativeOverlayInsetRight(raw: string | null | undefined): number {
  const parsed = Number.parseFloat(String(raw ?? ''))
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
}

export function readNativeOverlayInsetRight(): number {
  if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return 0
  const root = document.documentElement
  if (!root) return 0
  return parseNativeOverlayInsetRight(
    getComputedStyle(root).getPropertyValue('--klaus-native-panel-inset-right'),
  )
}

export function computeUserSubmenuPosition(input: SubmenuLayoutInput): SubmenuLayoutResult {
  const width = Math.max(0, Math.round(input.submenuSize.width))
  const height = Math.max(0, Math.round(input.submenuSize.height))
  const viewportWidth = Math.max(0, Math.round(input.viewport.width))
  const viewportHeight = Math.max(0, Math.round(input.viewport.height))
  const insetRight = Number.isFinite(input.nativeInsetRight) && input.nativeInsetRight > 0
    ? Math.round(input.nativeInsetRight)
    : 0
  const uncoveredRight = Math.max(0, viewportWidth - insetRight)

  const rightLeft = Math.round(input.anchorRect.right + GAP)
  if (rightLeft + width + MARGIN <= uncoveredRight) {
    const top = Math.max(MARGIN, Math.min(Math.round(input.anchorRect.top), viewportHeight - height - MARGIN))
    return { left: rightLeft, top, maxHeight: null, placement: 'right', suspendNative: false }
  }

  const refRect = input.menuRect ?? input.anchorRect
  const availableWidth = uncoveredRight - MARGIN * 2
  const availableAbove = Math.floor(refRect.top - GAP - MARGIN)
  const requiredHeight = Math.min(height, MIN_STACKED_HEIGHT)
  if (width <= availableWidth && availableAbove >= requiredHeight) {
    const preferredLeft = Math.round(refRect.left)
    const maxLeft = Math.max(MARGIN, uncoveredRight - width - MARGIN)
    const left = Math.max(MARGIN, Math.min(preferredLeft, maxLeft))
    const clampedHeight = Math.min(height, availableAbove)
    const top = Math.max(MARGIN, Math.round(refRect.top - clampedHeight - GAP))
    const maxHeight = height > availableAbove ? availableAbove : null
    return { left, top, maxHeight, placement: 'above', suspendNative: false }
  }

  const fallbackLeft = Math.max(MARGIN, Math.min(rightLeft, viewportWidth - width - MARGIN))
  const fallbackTop = Math.max(MARGIN, Math.min(Math.round(input.anchorRect.top), viewportHeight - height - MARGIN))
  return {
    left: fallbackLeft,
    top: fallbackTop,
    maxHeight: null,
    placement: 'right-suspended',
    suspendNative: insetRight > 0,
  }
}
