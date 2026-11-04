// Outer proxy scrollbar for a transcript column.
//
// The transcript scrollers (#messages, .side-messages) hide their native
// scrollbar so the column keeps its full width; this module draws the thumb
// they would have shown, as a 6px scroller pinned to the column's right edge
// inside its layout region (#main / .side-chat-panel). The region reaches the
// window edge, so the thumb reads as window-level even though it only spans
// the scroll element's own height.
//
// It is a real scrollable element (a 1px-wide spacer sized to scrollHeight),
// not a painted div: dragging the thumb is native behaviour, keyboard and
// wheel work for free, and the two-way scrollTop sync only needs a 0.5px loop
// guard. Visibility follows scrolling: the thumb is transparent at
// rest and paints while either side is scrolling, fading 700ms after settle.

const THUMB_FADE_MS = 700

export interface OuterScrollbarHandle {
  /** Re-measure geometry (region visibility flips, window resizes). */
  sync(): void
  destroy(): void
}

export function mountOuterScrollbar(options: {
  scrollEl: HTMLElement | null
  /** The positioned ancestor the proxy is pinned to (must be position:relative). */
  region: HTMLElement | null
  /** Reader input on the proxy. Scroll and wheel events carry their direction;
   *  pointer and touch starts carry no direction until the viewport moves. */
  onUserScrollIntent?: (direction?: 'up' | 'down') => void
}): OuterScrollbarHandle | null {
  const { scrollEl, region, onUserScrollIntent } = options
  if (!scrollEl || !region) return null

  const proxy = document.createElement('div')
  proxy.className = 'chat-outer-scrollbar'
  proxy.setAttribute('aria-hidden', 'true')
  proxy.tabIndex = -1
  const spacer = document.createElement('div')
  spacer.setAttribute('aria-hidden', 'true')
  spacer.style.width = '1px'
  proxy.appendChild(spacer)
  region.appendChild(proxy)

  let fadeTimer = 0
  let syncingFrom: 'proxy' | 'source' | null = null
  let lastProxyTop = 0

  const scrollable = () => scrollEl.scrollHeight > scrollEl.clientHeight + 1

  const syncProxyPosition = () => {
    // Update the range first, or the new position clamps to the old bottom.
    spacer.style.height = `${scrollEl.scrollHeight}px`
    if (Math.abs(proxy.scrollTop - scrollEl.scrollTop) > 0.5) proxy.scrollTop = scrollEl.scrollTop
    // Scroll events arrive asynchronously, after syncingFrom has reset. The
    // applied position also identifies delayed echoes and geometry clamps.
    lastProxyTop = proxy.scrollTop
  }

  const syncGeometry = () => {
    // Consume a queued thumb movement before changing its range/position.
    // Geometry clamps created below get recorded by syncProxyPosition.
    onProxyScroll()
    const sourceRect = scrollEl.getBoundingClientRect()
    const regionRect = region.getBoundingClientRect()
    const height = sourceRect.height
    proxy.style.display = (!scrollable() || height <= 0 || regionRect.height <= 0) ? 'none' : ''
    proxy.style.top = `${sourceRect.top - regionRect.top}px`
    proxy.style.height = `${height}px`
    syncProxyPosition()
  }

  const armFade = () => {
    proxy.classList.add('is-scrolling')
    if (fadeTimer) window.clearTimeout(fadeTimer)
    fadeTimer = window.setTimeout(() => {
      fadeTimer = 0
      proxy.classList.remove('is-scrolling')
    }, THUMB_FADE_MS)
  }

  // Source -> proxy. Programmatic stick-to-bottom writes land here too, which
  // is what makes the thumb track live output.
  const onSourceScroll = () => {
    if (syncingFrom === 'proxy') return
    onProxyScroll()
    syncingFrom = 'source'
    syncProxyPosition()
    syncingFrom = null
    armFade()
  }
  const onProxyScroll = () => {
    if (syncingFrom === 'source' || proxy.style.display === 'none' || proxy.clientHeight <= 0) return
    const top = proxy.scrollTop
    if (Math.abs(top - lastProxyTop) <= 0.5) return
    const direction = top < lastProxyTop ? 'up' : 'down'
    lastProxyTop = top
    onUserScrollIntent?.(direction)
    syncingFrom = 'proxy'
    if (Math.abs(scrollEl.scrollTop - top) > 0.5) scrollEl.scrollTop = top
    syncingFrom = null
    armFade()
  }

  scrollEl.addEventListener('scroll', onSourceScroll, { passive: true })
  proxy.addEventListener('scroll', onProxyScroll, { passive: true })
  for (const type of ['touchstart', 'pointerdown'] as const) {
    proxy.addEventListener(type, () => onUserScrollIntent?.(), { passive: true })
  }
  // Wheel input records direction before the proxy scroll event arrives.
  proxy.addEventListener('wheel', (event: WheelEvent) => {
    onUserScrollIntent?.(event.deltaY < 0 ? 'up' : 'down')
  }, { passive: true })

  const observers: ResizeObserver[] = []
  let contentObserver: MutationObserver | null = null
  if (typeof ResizeObserver === 'function') {
    const ro = new ResizeObserver(syncGeometry)
    ro.observe(scrollEl)
    ro.observe(region)
    let observedContent: Element | null = null
    const observeContent = () => {
      const content = scrollEl.firstElementChild
      if (content === observedContent) return
      if (observedContent) ro.unobserve(observedContent)
      observedContent = content
      if (content) ro.observe(content)
    }
    observeContent()
    if (typeof MutationObserver === 'function') {
      contentObserver = new MutationObserver(() => { observeContent(); syncGeometry() })
      contentObserver.observe(scrollEl, { childList: true })
    }
    observers.push(ro)
  }
  const onWindowResize = () => syncGeometry()
  window.addEventListener('resize', onWindowResize)

  syncGeometry()

  return {
    sync: syncGeometry,
    destroy() {
      if (fadeTimer) window.clearTimeout(fadeTimer)
      scrollEl.removeEventListener('scroll', onSourceScroll)
      proxy.removeEventListener('scroll', onProxyScroll)
      window.removeEventListener('resize', onWindowResize)
      for (const ro of observers) ro.disconnect()
      contentObserver?.disconnect()
      proxy.remove()
    },
  }
}
