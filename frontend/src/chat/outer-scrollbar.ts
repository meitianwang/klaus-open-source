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
  /** Suspend visible-layout effects while keeping the proxy element and its owner. */
  setActive(active: boolean): void
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
  let active = true
  let destroyed = false
  let activation = 0

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
    if (!active || destroyed) return
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
    const owner = activation
    fadeTimer = window.setTimeout(() => {
      if (!active || destroyed || activation !== owner) return
      fadeTimer = 0
      proxy.classList.remove('is-scrolling')
    }, THUMB_FADE_MS)
  }

  // Source -> proxy. Programmatic stick-to-bottom writes land here too, which
  // is what makes the thumb track live output.
  const onSourceScroll = () => {
    if (!active || destroyed || syncingFrom === 'proxy') return
    onProxyScroll()
    syncingFrom = 'source'
    syncProxyPosition()
    syncingFrom = null
    armFade()
  }
  const onProxyScroll = () => {
    if (!active || destroyed || syncingFrom === 'source' || proxy.style.display === 'none' || proxy.clientHeight <= 0) return
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

  const observers: ResizeObserver[] = []
  const releaseListeners: Array<() => void> = []
  let contentObserver: MutationObserver | null = null
  const connect = () => {
    const owner = ++activation
    const current = () => active && !destroyed && activation === owner
    const listen = (target: EventTarget, type: string, callback: (event: any) => void) => {
      const listener = (event: Event) => { if (current()) callback(event) }
      target.addEventListener(type, listener, { passive: true })
      releaseListeners.push(() => target.removeEventListener(type, listener))
    }
    listen(scrollEl, 'scroll', onSourceScroll)
    listen(proxy, 'scroll', onProxyScroll)
    for (const type of ['touchstart', 'pointerdown']) listen(proxy, type, () => onUserScrollIntent?.())
    listen(proxy, 'wheel', (event: WheelEvent) => onUserScrollIntent?.(event.deltaY < 0 ? 'up' : 'down'))
    listen(window, 'resize', syncGeometry)
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => { if (current()) syncGeometry() })
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
        contentObserver = new MutationObserver(() => {
          if (!current()) return
          observeContent()
          syncGeometry()
        })
        contentObserver.observe(scrollEl, { childList: true })
      }
      observers.push(ro)
    }
  }
  const disconnect = () => {
    activation++
    if (fadeTimer) window.clearTimeout(fadeTimer)
    fadeTimer = 0
    for (const release of releaseListeners.splice(0)) release()
    for (const ro of observers.splice(0)) ro.disconnect()
    contentObserver?.disconnect()
    contentObserver = null
  }
  connect()
  syncGeometry()

  return {
    sync: syncGeometry,
    setActive(value) {
      if (destroyed || active === value) return
      active = value
      if (!active) { disconnect(); return }
      connect()
      // The restored source owns the position; a parked thumb is not reader input.
      syncingFrom = 'source'
      syncGeometry()
      syncingFrom = null
    },
    destroy() {
      if (destroyed) return
      destroyed = true
      active = false
      disconnect()
      proxy.remove()
    },
  }
}
