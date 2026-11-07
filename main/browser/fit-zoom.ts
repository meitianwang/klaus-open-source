// Proportional fit for the embedded browser panel.
//
// The panel widens towards a page's intrinsic content width, but the window
// caps how wide it can get. The width the panel cannot give is recovered by
// scaling the page down, so the whole document width stays on screen instead
// of clipping behind a horizontal scrollbar. The fit never enlarges a page
// and never shrinks it below a readability floor.

/** Smallest page scale the proportional fit may apply. */
export const FIT_ZOOM_MIN = 0.25
/** Scales closer than this to each other are treated as unchanged. */
export const FIT_ZOOM_EPS = 0.01

/**
 * The page scale that fits `contentWidth` CSS pixels of document into
 * `viewportWidth` device-independent pixels of panel: 1 while the content
 * fits, proportionally smaller while it does not, floored at FIT_ZOOM_MIN.
 */
export function fitZoomForViewport(viewportWidth: number, contentWidth: number): number {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0) return 1
  if (!Number.isFinite(contentWidth) || contentWidth <= 0) return 1
  return Math.min(1, Math.max(FIT_ZOOM_MIN, viewportWidth / contentWidth))
}

/**
 * Intrinsic document width of a page whose horizontal overflow lives inside
 * scroll boxes (app shells): the widest box's offset from the document's left
 * edge plus its own scroll width. Document-level layout metrics report only
 * the viewport for such pages, so the probe takes the maximum of both.
 * Runs in the shown page; layout pixels, independent of the page scale.
 */
export const INTRINSIC_WIDTH_EXPRESSION = `(() => {
  let width = 0;
  for (const element of document.querySelectorAll('*')) {
    const style = getComputedStyle(element);
    if (style.overflowX !== 'auto' && style.overflowX !== 'scroll') continue;
    const need = element.getBoundingClientRect().left + element.scrollWidth;
    if (need > width) width = need;
  }
  return Math.ceil(width);
})()`

/** Resolves after two animation frames so a zoom change has laid out. */
export const SETTLE_FRAME_EXPRESSION = 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))'
