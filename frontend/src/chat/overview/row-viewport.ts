export interface RowViewportEnvironment {
  requestFrame(callback: FrameRequestCallback): number
  cancelFrame(handle: number): void
  observeResize(callback: () => void): Pick<ResizeObserver, 'observe' | 'disconnect'>
}

export interface RowViewport {
  render(identity: string, renderRows: () => HTMLElement[]): void
  reset(): void
  dispose(): void
}

function browserEnvironment(viewport: HTMLElement): RowViewportEnvironment {
  const view = viewport.ownerDocument.defaultView || window
  return {
    requestFrame: callback => view.requestAnimationFrame(callback),
    cancelFrame: handle => view.cancelAnimationFrame(handle),
    observeResize: callback => new ResizeObserver(callback),
  }
}

/** Keep every entry in the DOM while fitting the first six actual row heights. */
export function createRowViewport(
  viewport: HTMLElement,
  environment: RowViewportEnvironment = browserEnvironment(viewport),
): RowViewport {
  let identity: string | null = null
  let rows: HTMLElement[] = []
  let frame: number | null = null
  let disposed = false
  let rememberedScrollTop = viewport.scrollTop
  let pendingScrollTop: number | null = null

  const visible = () => viewport.getBoundingClientRect().width > 0
  const rememberScroll = () => {
    if (visible() && pendingScrollTop === null) rememberedScrollTop = viewport.scrollTop
  }

  function measure() {
    frame = null
    if (disposed) return
    if (rows.length <= 6) {
      viewport.style.removeProperty('max-height')
      viewport.style.removeProperty('overflow-y')
    } else {
      const bounds = viewport.getBoundingClientRect()
      const last = rows[5].getBoundingClientRect()
      // Display:none produces zero bounds. Keep the last cap and scroll until
      // ResizeObserver reports the section becoming visible again.
      if (bounds.width <= 0 || last.height <= 0) {
        pendingScrollTop ??= rememberedScrollTop
        return
      }
      // The sixth bottom includes each earlier row, gap, and top inset. Add
      // scrollTop to measure the content even while later entries are in view.
      const height = Math.ceil(last.bottom - bounds.top + viewport.scrollTop)
      if (!Number.isFinite(height) || height <= 0) return
      const cap = `${height}px`
      if (viewport.style.maxHeight !== cap) viewport.style.maxHeight = cap
      viewport.style.overflowY = 'auto'
    }
    if (!visible()) return
    if (pendingScrollTop !== null) {
      viewport.scrollTop = pendingScrollTop
      pendingScrollTop = null
    }
    rememberedScrollTop = viewport.scrollTop
  }

  function schedule() {
    if (!disposed && frame === null) frame = environment.requestFrame(measure)
  }

  const observer = environment.observeResize(schedule)
  viewport.addEventListener('scroll', rememberScroll, { passive: true })

  return {
    render(nextIdentity, renderRows) {
      if (disposed) return
      pendingScrollTop = identity === nextIdentity
        ? pendingScrollTop ?? (visible() ? viewport.scrollTop : rememberedScrollTop)
        : 0
      identity = nextIdentity
      rows = renderRows()
      // Replaced rows must no longer retain observers. Observe the viewport as
      // well so panel width changes and hidden-to-visible transitions remeasure.
      observer.disconnect()
      observer.observe(viewport)
      for (const row of rows) observer.observe(row)
      schedule()
    },
    reset() {
      identity = null
      rememberedScrollTop = 0
      pendingScrollTop = 0
      viewport.scrollTop = 0
      schedule()
    },
    dispose() {
      disposed = true
      if (frame !== null) environment.cancelFrame(frame)
      observer.disconnect()
      viewport.removeEventListener('scroll', rememberScroll)
      viewport.style.removeProperty('max-height')
      viewport.style.removeProperty('overflow-y')
    },
  }
}
