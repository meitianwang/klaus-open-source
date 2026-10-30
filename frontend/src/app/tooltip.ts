// Klaus tooltip — global delegated tooltip that replaces native [title] popups.
// Sidebar surfaces opt out by default. The five fixed side-rail entry points
// opt back in explicitly because their icons have no visible labels; the
// observer keeps every other dynamic and static sidebar control tooltip-free.
//（迁自 js/tooltip.js，逻辑原样。）
export {}

const SHOW_DELAY = 120
const HIDE_DELAY = 60
const TOOLTIP_FREE_ZONE_SELECTOR = '[data-klaus-tooltips="off"]'
const TOOLTIP_OPT_IN_SELECTOR = '#side-rail > [data-klaus-tooltips="on"]'
let tipEl: HTMLDivElement | null = null
let target: HTMLElement | null = null
let showT: ReturnType<typeof setTimeout> | null = null
let hideT: ReturnType<typeof setTimeout> | null = null

function ensureTip() {
  if (tipEl) return tipEl
  tipEl = document.createElement('div')
  tipEl.className = 'klaus-tip'
  tipEl.setAttribute('role', 'tooltip')
  document.body.appendChild(tipEl)
  return tipEl
}

function readText(el: HTMLElement) {
  if (el.closest(TOOLTIP_FREE_ZONE_SELECTOR) && !el.closest(TOOLTIP_OPT_IN_SELECTOR)) return ''
  if (el.dataset.klausTip) return el.dataset.klausTip
  const t = el.getAttribute('title')
  return t || ''
}

/**
 * An optional second, de-emphasized line for a tooltip.
 *
 * Paused-row and retry tips carry a remedy under the main sentence ("Retry,
 * edit, or delete it to continue the queue"). Keeping both in one
 * string reads as a run-on, so the second part rides its own attribute and is
 * rendered dimmer. It is deliberately NOT added to the sidebar policy observer's
 * attributeFilter: that filter guards the tooltip-free sidebar surfaces, which
 * never carry a detail line, and widening it would loosen that guard for nothing.
 */
function readDetail(el: HTMLElement) {
  if (el.closest(TOOLTIP_FREE_ZONE_SELECTOR) && !el.closest(TOOLTIP_OPT_IN_SELECTOR)) return ''
  return el.dataset.klausTipDetail || ''
}

function suppressNativeTitle(el: HTMLElement) {
  if ((el as any).__klausTipTitle === undefined && el.hasAttribute('title')) {
    ;(el as any).__klausTipTitle = el.getAttribute('title')
    el.setAttribute('title', '')
  }
}

function restoreNativeTitle(el: HTMLElement | null) {
  if (el && (el as any).__klausTipTitle !== undefined) {
    el.setAttribute('title', (el as any).__klausTipTitle)
    delete (el as any).__klausTipTitle
  }
}

function preferredPlacement(el: HTMLElement) {
  const host = el.closest?.('[data-klaus-tip-placement]') as HTMLElement | null
  const value = el.dataset?.klausTipPlacement || host?.dataset?.klausTipPlacement || ''
  return value === 'top' || value === 'bottom' || value === 'left' || value === 'right' ? value : ''
}

function position(el: HTMLElement) {
  const t = ensureTip()
  const rect = el.getBoundingClientRect()
  // Reset to measure natural size each time (text varies). The bubble wraps,
  // so its shrink-to-fit width depends on the room to the right of `left`:
  // measuring while the PREVIOUS hover's `left` is still applied squeezed a
  // tip near the window edge into a tall narrow column. Park it at the origin
  // first so the measurement sees the full viewport. Safe to do here because
  // position() only runs from show() while the bubble is still transparent,
  // and the layout read below happens before the frame paints.
  t.style.maxWidth = '240px'
  t.style.left = '0px'
  t.style.top = '0px'
  const tipRect = t.getBoundingClientRect()
  const margin = 6
  const preferred = preferredPlacement(el)
  if (preferred === 'left' || preferred === 'right') {
    const fitsLeft = rect.left - tipRect.width - margin >= 8
    const fitsRight = rect.right + margin + tipRect.width <= window.innerWidth - 8
    const placeLeft = preferred === 'left' ? fitsLeft || !fitsRight : !fitsRight && fitsLeft
    let x = placeLeft ? rect.left - tipRect.width - margin : rect.right + margin
    x = Math.max(8, Math.min(window.innerWidth - tipRect.width - 8, x))
    let y = rect.top + rect.height / 2 - tipRect.height / 2
    y = Math.max(8, Math.min(window.innerHeight - tipRect.height - 8, y))
    t.style.left = x + 'px'
    t.style.top = y + 'px'
    t.dataset.placement = placeLeft ? 'left' : 'right'
    return
  }
  const fitsAbove = rect.top - tipRect.height - margin >= 8
  const fitsBelow = rect.bottom + margin + tipRect.height <= window.innerHeight - 8
  let placeAbove = !fitsBelow
  if (preferred === 'top') placeAbove = fitsAbove || !fitsBelow
  if (preferred === 'bottom') placeAbove = !fitsBelow && fitsAbove
  let y = placeAbove ? rect.top - tipRect.height - margin : rect.bottom + margin
  y = Math.max(8, Math.min(window.innerHeight - tipRect.height - 8, y))
  let x = rect.left + rect.width / 2 - tipRect.width / 2
  x = Math.max(8, Math.min(window.innerWidth - tipRect.width - 8, x))
  t.style.left = x + 'px'
  t.style.top = y + 'px'
  t.dataset.placement = placeAbove ? 'top' : 'bottom'
}

function show(el: HTMLElement) {
  const text = readText(el)
  if (!text) return
  suppressNativeTitle(el)
  const t = ensureTip()
  const detail = readDetail(el)
  if (detail) {
    // Two lines: the main sentence and a dimmer remedy beneath it. Built with
    // textContent so neither line can carry markup.
    t.textContent = ''
    const main = document.createElement('span')
    main.textContent = text
    const sub = document.createElement('span')
    sub.className = 'klaus-tip-detail'
    sub.textContent = detail
    t.append(main, sub)
  } else {
    t.textContent = text
  }
  target = el
  // Position first (still opacity:0), then fade in next frame so the tooltip
  // never flashes at top-left during transition.
  position(el)
  requestAnimationFrame(() => {
    if (target === el) t.classList.add('show')
  })
}

function hide() {
  if (showT) clearTimeout(showT)
  showT = null
  if (tipEl) {
    tipEl.classList.remove('show')
    tipEl.dataset.placement = ''
  }
  restoreNativeTitle(target)
  target = null
}

function findTipHost(el: Element | null): HTMLElement | null {
  if (el?.closest?.(TOOLTIP_FREE_ZONE_SELECTOR) && !el.closest(TOOLTIP_OPT_IN_SELECTOR)) return null
  let node = el as HTMLElement | null
  while (node && node !== document.body && node.nodeType === 1) {
    if (node.dataset && node.dataset.klausTip) return node
    if (node.getAttribute && node.getAttribute('title')) return node
    node = node.parentElement
  }
  return null
}

function scrubTooltipFreeZone(root: Element): void {
  const candidates = [
    ...(root.matches('[title], [data-klaus-tip]') ? [root] : []),
    ...root.querySelectorAll('[title], [data-klaus-tip]'),
  ] as HTMLElement[]
  for (const el of candidates) {
    if (el.closest(TOOLTIP_OPT_IN_SELECTOR)) continue
    const title = el.getAttribute('title') || el.dataset.klausTip || ''
    if (title && !el.hasAttribute('aria-label') && el.matches('button, input, select, textarea, [role="button"], [role="tab"]')) {
      el.setAttribute('aria-label', title)
    }
    el.removeAttribute('title')
    delete el.dataset.klausTip
    delete el.dataset.klausTipDetail
  }
}

const tooltipFreeObserver = new MutationObserver((records) => {
  for (const record of records) {
    if (record.type === 'attributes') {
      scrubTooltipFreeZone(record.target as Element)
      continue
    }
    for (const node of record.addedNodes) {
      if (node instanceof Element) scrubTooltipFreeZone(node)
    }
  }
})

for (const zone of document.querySelectorAll(TOOLTIP_FREE_ZONE_SELECTOR)) {
  scrubTooltipFreeZone(zone)
  tooltipFreeObserver.observe(zone, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ['title', 'data-klaus-tip'],
  })
}

document.addEventListener('mouseover', (e) => {
  // Cursor is back inside the active tooltip's host (we cleared its `title`
  // attr to suppress native popup, so findTipHost would miss it now). Cancel
  // the pending hide and stay shown.
  if (target && target.contains(e.target as Node)) {
    if (hideT) clearTimeout(hideT)
    hideT = null
    return
  }
  const host = findTipHost(e.target as Element)
  if (!host || host === target) return
  if (hideT) clearTimeout(hideT)
  hideT = null
  if (target && target !== host) hide()
  if (showT) clearTimeout(showT)
  showT = setTimeout(() => show(host), SHOW_DELAY)
}, true)

document.addEventListener('mouseout', (e) => {
  // Active target's title is suppressed, so findTipHost would miss it; fall
  // back to the active target reference for the leave detection.
  let host = findTipHost(e.target as Element)
  if (!host && target && target.contains(e.target as Node)) host = target
  if (!host) return
  const related = e.relatedTarget as Node | null
  if (related && host.contains(related)) return
  if (showT) clearTimeout(showT)
  showT = null
  if (hideT) clearTimeout(hideT)
  hideT = setTimeout(hide, HIDE_DELAY)
}, true)

// Hide on click / scroll / blur — the tooltip should never linger
document.addEventListener('mousedown', hide, true)
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide() }, true)
window.addEventListener('blur', hide)
window.addEventListener('scroll', hide, true)
window.addEventListener('resize', hide)
