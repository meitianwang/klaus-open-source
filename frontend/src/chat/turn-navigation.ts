// Navigation owns cached transcript geometry and the accessible marker rail.
import styles from './chat.module.css'
import { icon } from '../icons/registry'
export const MIN_TURNS = 2
const RAIL_CLEARANCE_PX = 48
export const READING_LINE_RATIO = 0.25
const QUERY_PREVIEW_LIMIT = 120
const ANSWER_PREVIEW_LIMIT = 320
const HOVER_PREVIEW_DELAY_MS = 150
const MARKER_ROW_HEIGHT = 10
const MARKER_GROUP_SIZE = 64
const ANCHOR_SELECTOR = '[data-nav-turn="true"]'

export function findActiveTurnIndex(anchorTops: number[], readingLine: number): number {
  if (!Array.isArray(anchorTops) || anchorTops.length === 0) return -1
  let low = 0
  let high = anchorTops.length - 1
  let result = 0
  while (low <= high) {
    const mid = (low + high) >> 1
    if (anchorTops[mid] <= readingLine) {
      result = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return result
}

export function resolveActiveTurnIndex(anchorTops: number[], scrollTop: number, clientHeight: number, scrollHeight: number): number {
  if (!Array.isArray(anchorTops) || anchorTops.length === 0) return -1
  const bottomDistance = scrollHeight - scrollTop - clientHeight
  if (bottomDistance <= 2) return anchorTops.length - 1
  return findActiveTurnIndex(anchorTops, scrollTop + clientHeight * READING_LINE_RATIO)
}

export function findVisibleTurnRange(anchorTops: number[], scrollTop: number, clientHeight: number): [number, number] {
  if (!anchorTops.length || clientHeight <= 0) return [-1, -1]
  return [findActiveTurnIndex(anchorTops, scrollTop), findActiveTurnIndex(anchorTops, scrollTop + clientHeight - 0.5)]
}

export interface SuspensionLease {
  id: number
  reason: string
}

export function createSuspensionGate() {
  const leases = new Set<SuspensionLease>()
  let nextId = 0
  return Object.freeze({
    suspend(reason = ''): SuspensionLease {
      const lease = Object.freeze({ id: ++nextId, reason })
      leases.add(lease)
      return lease
    },
    release(lease: SuspensionLease): boolean {
      if (!leases.delete(lease)) return false
      return leases.size === 0
    },
    isSuspended(): boolean {
      return leases.size > 0
    },
  })
}

export function normalizePreviewText(value: unknown, limit = QUERY_PREVIEW_LIMIT): string {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim()
  if (normalized.length <= limit) return normalized
  return `${normalized.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

function formatLabel(template: string, index: number, total: number): string {
  return String(template || '')
    .replace('{index}', String(index + 1))
    .replace('{total}', String(total))
}

export interface TurnWebsiteOutput {
  title: string
  url: string
}

/** Website output belongs to the existing user turn, including repeated cards. */
export function websiteOutputForTurn(anchor: HTMLElement): TurnWebsiteOutput | null {
  const turn = anchor.closest<HTMLElement>('[data-klaus-transcript-turn]')
  if (!turn) return null
  const identity = turn.getAttribute('data-klaus-transcript-turn-id')
  const scope = turn.closest<HTMLElement>('[data-klaus-transcript-content]') ?? turn.parentElement
  const segments = identity && scope ? Array.from(scope.querySelectorAll<HTMLElement>('[data-klaus-transcript-turn]'))
    .filter(segment => segment.getAttribute('data-klaus-transcript-turn-id') === identity) : [turn]
  const firstAnchor = segments.flatMap(segment => Array.from(segment.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR)))
    .find(element => !element.closest('[hidden], [aria-hidden="true"], [inert]'))
  if (firstAnchor !== anchor) return null
  const card = segments.flatMap(segment => Array.from(segment.querySelectorAll<HTMLElement>('[data-site-reference]')))
    .find(element => !element.closest('[hidden], [aria-hidden="true"], [inert]'))
  if (!card) return null
  return { title: card.dataset.siteTitle || '', url: card.dataset.siteUrl || '' }
}

export interface TurnNavigationOptions {
  scrollEl?: HTMLElement | null
  railEl?: HTMLElement | null
  listEl?: HTMLElement | null
  tooltipEl?: HTMLElement | null
  translate?: (key: string, fallback?: string) => string
  onNavigate?: (anchor: HTMLElement, detail: { behavior: string; index: number; sessionId: string | null }) => unknown
}

export function createTurnNavigationController(options: TurnNavigationOptions) {
  const scrollEl = options?.scrollEl
  const railEl = options?.railEl
  const listEl = options?.listEl
  const tooltipEl = options?.tooltipEl
  if (!scrollEl || !railEl || !listEl || !tooltipEl) return null

  const doc = scrollEl.ownerDocument
  const win = doc.defaultView as any
  const gate = createSuspensionGate()
  const translate = typeof options.translate === 'function'
    ? options.translate
    : ((key: string, fallback?: string) => fallback || key)
  const onNavigate = typeof options.onNavigate === 'function'
    ? options.onNavigate
    : (() => false)

  let destroyed = false
  let generation = 0
  let activeSessionId: string | null = null
  let chatActive = false
  let anchors: HTMLElement[] = []
  let markerButtons: HTMLButtonElement[] = []
  let markerGroups: HTMLElement[] = []
  let websiteOutputs: Array<TurnWebsiteOutput | null> = []
  let anchorTops: number[] = []
  let activeIndex = -1
  let visibleStart = -1
  let visibleEnd = -1
  let rovingIndex = -1
  let refreshFrame = 0
  let scrollFrame = 0
  let pendingStructureRefresh = false
  let pendingGeometryRefresh = false
  let mutationObserver: MutationObserver | null = null
  let resizeObserver: ResizeObserver | null = null
  let targetFlash: HTMLElement | null = null
  let targetFlashTimer = 0
  let hoverTimer = 0
  let scrubButton: HTMLElement | null = null
  let captureButton: HTMLElement | null = null
  let scrubPointerId = -1
  let pointerStartButton: HTMLElement | null = null
  let pointerMoved = false
  let suppressPointerClick = false
  let emphasisIndex = -1
  let tooltipIndex = -1
  let listViewportHeight = 0
  let scrollViewportHeight = 0
  let scrollContentHeight = 0
  let observing = false
  let contentEl: HTMLElement | null = null
  let contentWidth = 0
  const observedElements = new Set<Element>()
  const dirtyAnchorIndices = new Set<number>()

  function validAnchor(anchor: HTMLElement | undefined): boolean {
    return !!anchor &&
      anchor.isConnected &&
      scrollEl!.contains(anchor) &&
      !anchor.closest('[hidden], [aria-hidden="true"], [inert]') &&
      anchor.dataset.navTurn === 'true'
  }

  function clearTargetFlash() {
    if (targetFlashTimer) win.clearTimeout(targetFlashTimer)
    targetFlashTimer = 0
    targetFlash?.classList.remove(styles['turn-navigation-target'])
    targetFlash = null
  }

  function cancelHoverTimer() {
    if (hoverTimer) win.clearTimeout(hoverTimer)
    hoverTimer = 0
  }

  function hideTooltip() {
    cancelHoverTimer()
    tooltipEl!.hidden = true
    tooltipEl!.textContent = ''
    tooltipEl!.style.removeProperty('top')
    tooltipIndex = -1
  }

  function onWindowBlur() {
    hideTooltip()
    endScrub()
  }

  function endScrub(pointerId?: number) {
    if (!captureButton || (pointerId !== undefined && scrubPointerId !== pointerId)) return
    const captured = captureButton
    const capturedId = scrubPointerId
    scrubButton?.removeAttribute('data-scrub-target')
    scrubButton = null
    captureButton = null
    scrubPointerId = -1
    pointerStartButton = null
    pointerMoved = false
    listEl!.removeAttribute('data-scrubbing')
    setEmphasis(-1)
    hideTooltip()
    // Clear state before releasing capture: lostpointercapture may dispatch here.
    if (captured.hasPointerCapture(capturedId)) captured.releasePointerCapture(capturedId)
  }

  function setRailVisible(visible: boolean) {
    const show = !!visible && chatActive && !gate.isSuspended() && !destroyed
    railEl!.hidden = !show
    railEl!.inert = !show
    if (!show) {
      endScrub()
      hideTooltip()
      setEmphasis(-1)
    }
  }

  function stopNativeSmoothScroll() {
    if (typeof scrollEl!.scrollTo !== 'function') return
    try {
      scrollEl!.scrollTo({ top: scrollEl!.scrollTop, behavior: 'auto' })
    } catch {}
  }

  function cancelFrames() {
    if (refreshFrame) win.cancelAnimationFrame(refreshFrame)
    if (scrollFrame) win.cancelAnimationFrame(scrollFrame)
    refreshFrame = 0
    scrollFrame = 0
    pendingStructureRefresh = false
    pendingGeometryRefresh = false
    dirtyAnchorIndices.clear()
  }

  function stopObserving() {
    if (!observing) return
    observing = false
    scrollEl!.removeEventListener('scroll', onScroll)
    win.removeEventListener('resize', onWindowResize)
    mutationObserver?.disconnect()
    resizeObserver?.disconnect()
    observedElements.clear()
  }

  function releaseModel() {
    anchors = []
    markerButtons = []
    markerGroups = []
    websiteOutputs = []
    anchorTops = []
    activeIndex = -1
    visibleStart = -1
    visibleEnd = -1
    rovingIndex = -1
    listViewportHeight = 0
    scrollViewportHeight = 0
    scrollContentHeight = 0
    listEl!.removeAttribute('data-scrubbing')
    listEl!.replaceChildren()
  }

  function suspend(reason = '') {
    const lease = gate.suspend(reason)
    generation += 1
    endScrub()
    cancelFrames()
    stopObserving()
    stopNativeSmoothScroll()
    clearTargetFlash()
    hideTooltip()
    releaseModel()
    setRailVisible(false)
    return lease
  }

  function resume(lease: SuspensionLease, sessionId?: string | null) {
    if (!gate.release(lease)) return false
    activeSessionId = sessionId || null
    generation += 1
    startObserving()
    scheduleRefresh(true)
    return true
  }

  function affectsAnchorPositions(target: Element) {
    if (target === scrollEl) return true
    const lastAnchor = anchors[anchors.length - 1]
    if (!lastAnchor || target === lastAnchor || lastAnchor.contains(target)) return false
    return !!(target.compareDocumentPosition(lastAnchor) & win.Node.DOCUMENT_POSITION_FOLLOWING)
  }

  function observeCurrentChildren() {
    if (!resizeObserver) return
    const content = scrollEl!.querySelector<HTMLElement>(':scope > [data-klaus-transcript-content]')
    if (content !== contentEl) {
      contentEl = content
      contentWidth = content?.clientWidth || 0
    }
    const next = new Set<Element>([scrollEl!, ...Array.from(scrollEl!.children), ...(content ? Array.from(content.children) : [])])
    for (const element of observedElements) {
      if (!next.has(element)) { resizeObserver.unobserve(element); observedElements.delete(element) }
    }
    for (const element of next) {
      if (!observedElements.has(element)) { resizeObserver.observe(element); observedElements.add(element) }
    }
  }

  function markChangedAnchors(target: Element) {
    let low = 0
    let high = anchors.length
    while (low < high) {
      const mid = (low + high) >> 1
      if (target.contains(anchors[mid]) || (target.compareDocumentPosition(anchors[mid]) & win.Node.DOCUMENT_POSITION_FOLLOWING)) high = mid
      else low = mid + 1
    }
    // Measure anchors inside a resized wrapper and the first following anchor.
    // Between those breakpoints, a single-column transcript shifts uniformly.
    while (low < anchors.length && target.contains(anchors[low])) dirtyAnchorIndices.add(low++)
    if (low < anchors.length) dirtyAnchorIndices.add(low)
  }

  function measureChangedAnchors() {
    const rect = scrollEl!.getBoundingClientRect()
    const top = scrollEl!.scrollTop
    const changes = new Map<number, number>()
    for (const index of dirtyAnchorIndices) {
      if (validAnchor(anchors[index])) changes.set(index, anchors[index].getBoundingClientRect().top - rect.top + top)
      else { dirtyAnchorIndices.clear(); scheduleRefresh(true); return }
    }
    const first = Math.min(...changes.keys())
    let shift = 0
    for (let index = first; index < anchorTops.length; index += 1) {
      if (changes.has(index)) shift = changes.get(index)! - anchorTops[index]
      anchorTops[index] += shift
    }
    dirtyAnchorIndices.clear()
    scrollContentHeight = scrollEl!.scrollHeight
    updateActiveFromScroll()
  }

  function startObserving() {
    if (destroyed || observing || gate.isSuspended()) return
    observing = true
    scrollEl!.addEventListener('scroll', onScroll, { passive: true })
    win.addEventListener('resize', onWindowResize, { passive: true })
    if (typeof win.MutationObserver === 'function') {
      mutationObserver = new win.MutationObserver((records: MutationRecord[]) => {
        const hasAnchor = (node: Node) => node.nodeType === 1 &&
          ((node as Element).matches(ANCHOR_SELECTOR) || !!(node as Element).querySelector(ANCHOR_SELECTOR))
        const hasWebsite = (node: Node) => node.nodeType === 1 &&
          ((node as Element).matches('[data-site-reference]') || !!(node as Element).querySelector('[data-site-reference]'))
        if (records.some(record => record.target === scrollEl || record.target === contentEl ||
          (record.type === 'attributes' && (hasAnchor(record.target) || hasWebsite(record.target))) ||
          Array.from(record.addedNodes).some(node => hasAnchor(node) || hasWebsite(node)) ||
          Array.from(record.removedNodes).some(node => hasAnchor(node) || hasWebsite(node)))) {
          scheduleRefresh(true)
        } else if (tooltipIndex >= 0) scheduleRefresh(false, false)
      })
      mutationObserver!.observe(scrollEl!, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'aria-hidden', 'inert', 'data-site-reference', 'data-site-title', 'data-site-url', 'data-klaus-transcript-turn-id'] })
    }
    if (typeof win.ResizeObserver === 'function') {
      resizeObserver = new win.ResizeObserver((entries: ResizeObserverEntry[]) => {
        if (destroyed || gate.isSuspended()) return
        const changes = entries.filter(entry => {
          if (entry.target !== contentEl) return true
          if (Math.abs(entry.contentRect.width - contentWidth) > 0.5) {
            contentWidth = entry.contentRect.width
            scheduleRefresh(false)
          }
          return false
        })
        if (changes.length > 8 || changes.some(entry => entry.target === scrollEl)) scheduleRefresh(false)
        else {
          for (const entry of changes) markChangedAnchors(entry.target)
          if (pendingStructureRefresh || pendingGeometryRefresh) scheduleRefresh(false, false)
          else {
            // ResizeObserver runs after layout. Reading geometry here avoids
            // forcing the next streaming frame to lay out before its paint.
            if (dirtyAnchorIndices.size) measureChangedAnchors()
            else {
              scrollContentHeight = scrollEl!.scrollHeight
              updateActiveFromScroll()
            }
            if (tooltipIndex >= 0) scheduleRefresh(false, false)
          }
        }
      })
      observeCurrentChildren()
    }
  }

  function scheduleRefresh(structureChanged: boolean, geometryChanged = true) {
    if (destroyed || gate.isSuspended()) return
    pendingStructureRefresh = pendingStructureRefresh || structureChanged
    pendingGeometryRefresh = pendingGeometryRefresh || geometryChanged
    if (refreshFrame) return
    const scheduledGeneration = generation
    refreshFrame = win.requestAnimationFrame(() => {
      refreshFrame = 0
      if (destroyed || gate.isSuspended() || scheduledGeneration !== generation) return
      const rebuild = pendingStructureRefresh
      const measure = pendingGeometryRefresh
      pendingStructureRefresh = false
      pendingGeometryRefresh = false
      if (rebuild) rebuildMarkers()
      else if (measure) measureGeometry()
      else if (dirtyAnchorIndices.size) measureChangedAnchors()
      else {
        // Growth after the last user changes the bottom, not any anchor top.
        scrollContentHeight = scrollEl!.scrollHeight
        updateActiveFromScroll()
      }
      if (tooltipIndex >= 0 && validAnchor(anchors[tooltipIndex])) showTooltip(markerButtons[tooltipIndex])
    })
  }

  function translated(key: string, fallback: string) {
    const value = translate(key, fallback)
    return value && value !== key ? value : fallback
  }

  function refreshLabels() {
    railEl!.setAttribute('aria-label', translated('turn_navigation_label', 'User message navigation'))
    const template = translated('turn_navigation_item', 'User message {index} of {total}')
    markerButtons.forEach((button, index) => {
      const type = websiteOutputs[index] ? translated('site_reference_website', 'Website') : ''
      button.setAttribute('aria-label', [formatLabel(template, index, anchors.length), type].filter(Boolean).join(' · '))
    })
  }

  function rebuildMarkers() {
    const nextAnchors = Array.from(scrollEl!.querySelectorAll<HTMLElement>(ANCHOR_SELECTOR)).filter(validAnchor)
    const unchanged = nextAnchors.length === anchors.length &&
      nextAnchors.every((anchor, index) => anchor === anchors[index])
    if (!unchanged) {
      const focused = markerButtons.indexOf(doc.activeElement as HTMLButtonElement)
      const rovingAnchor = anchors[focused >= 0 ? focused : rovingIndex]
      endScrub()
      hideTooltip()
      setEmphasis(-1)
      const previous = new Map(anchors.map((anchor, index) => [anchor, markerButtons[index]]))
      anchors = nextAnchors
      markerButtons = anchors.map((anchor, index) => {
        let button = previous.get(anchor)
        if (!button) {
          const created = doc.createElement('button')
          created.type = 'button'
          created.className = styles['turn-navigation-marker']
          created.setAttribute('aria-describedby', tooltipEl!.id)
          button = created
        }
        button.tabIndex = -1
        button.removeAttribute('aria-current')
        button.removeAttribute('data-visible')
        button.dataset.turnIndex = String(index)
        return button
      })
      // Stable, fixed-height groups skip offscreen rendering while keeping all
      // buttons in the accessibility tree and preserving appended node identity.
      const groupCount = Math.ceil(markerButtons.length / MARKER_GROUP_SIZE)
      while (markerGroups.length > groupCount) markerGroups.pop()!.remove()
      for (let groupIndex = 0; groupIndex < groupCount; groupIndex += 1) {
        let group = markerGroups[groupIndex]
        if (!group) {
          group = doc.createElement('div')
          group.className = styles['turn-navigation-marker-group']
          markerGroups.push(group)
          listEl!.appendChild(group)
        }
        const buttons = markerButtons.slice(groupIndex * MARKER_GROUP_SIZE, (groupIndex + 1) * MARKER_GROUP_SIZE)
        for (let offset = 0; offset < buttons.length; offset += 1) {
          if (group.children[offset] !== buttons[offset]) group.insertBefore(buttons[offset], group.children[offset] || null)
        }
        while (group.children.length > buttons.length) group.lastElementChild!.remove()
        group.style.height = `${buttons.length * MARKER_ROW_HEIGHT}px`
      }
      activeIndex = -1
      visibleStart = -1
      visibleEnd = -1
      rovingIndex = -1
      const restored = anchors.indexOf(rovingAnchor)
      if (restored >= 0) setRovingIndex(restored, focused >= 0)
    }
    refreshWebsiteOutputs()
    refreshLabels()
    observeCurrentChildren()
    measureGeometry()
  }

  function refreshWebsiteOutputs() {
    websiteOutputs = anchors.map(websiteOutputForTurn)
    markerButtons.forEach((button, index) => {
      const output = websiteOutputs[index]
      if (!output) {
        button.removeAttribute('data-turn-output')
        return
      }
      button.setAttribute('data-turn-output', 'website')
    })
  }

  function measureGeometry() {
    if (destroyed || gate.isSuspended()) return
    dirtyAnchorIndices.clear()
    if (anchors.some(anchor => !validAnchor(anchor))) {
      scheduleRefresh(true)
      return
    }
    if (anchors.length < MIN_TURNS) {
      anchorTops = []
      setRailVisible(false)
      return
    }

    const scrollRect = scrollEl!.getBoundingClientRect()
    const scrollTop = scrollEl!.scrollTop
    scrollViewportHeight = scrollEl!.clientHeight
    scrollContentHeight = scrollEl!.scrollHeight
    const rects = anchors.map(anchor => anchor.getBoundingClientRect())
    anchorTops = rects.map(rect => rect.top - scrollRect.top + scrollTop)
    railEl!.style.removeProperty('left')
    // The rail sits at a fixed CSS left offset. When the transcript gutter is
    // too narrow to clear it (small windows / wide bubbles), showing it would
    // overlap message content — hide it instead of repositioning at runtime.
    if (rects[0].left - scrollRect.left < RAIL_CLEARANCE_PX) {
      setRailVisible(false)
      return
    }
    setRailVisible(true)
    listViewportHeight = listEl!.clientHeight
    updateActiveFromScroll(true)
  }

  function updateMarker(index: number) {
    const button = markerButtons[index]
    if (!button) return
    // Keep a single accessible current turn and highlight the visible range.
    if (index === activeIndex) button.setAttribute('aria-current', 'location')
    else button.removeAttribute('aria-current')
    if (index >= visibleStart && index <= visibleEnd) button.setAttribute('data-visible', '')
    else button.removeAttribute('data-visible')
  }

  function setRovingIndex(index: number, focus = false) {
    if (anchors.length === 0) return
    const next = Math.max(0, Math.min(index, anchors.length - 1))
    if (rovingIndex >= 0 && markerButtons[rovingIndex]) markerButtons[rovingIndex].tabIndex = -1
    rovingIndex = next
    const button = markerButtons[next]
    if (!button) return
    button.tabIndex = 0
    if (focus) {
      revealMarker(next)
      button.focus({ preventScroll: true })
    }
  }

  function revealMarker(index: number) {
    if (index < 0 || !listViewportHeight) return
    const itemTop = index * MARKER_ROW_HEIGHT + 4
    const itemBottom = itemTop + MARKER_ROW_HEIGHT
    if (itemTop < listEl!.scrollTop) listEl!.scrollTop = itemTop
    else if (itemBottom > listEl!.scrollTop + listViewportHeight) {
      listEl!.scrollTop = itemBottom - listViewportHeight
    }
  }

  function updateActiveFromScroll(force = false) {
    if (anchorTops.length === 0 || railEl!.hidden) return
    const next = resolveActiveTurnIndex(
      anchorTops,
      scrollEl!.scrollTop,
      scrollViewportHeight,
      scrollContentHeight,
    )
    const [nextStart, nextEnd] = findVisibleTurnRange(anchorTops, scrollEl!.scrollTop, scrollViewportHeight)
    if (!force && next === activeIndex && nextStart === visibleStart && nextEnd === visibleEnd) return
    const previous = activeIndex
    activeIndex = next
    const affected = new Set<number>([previous, activeIndex])
    for (let index = visibleStart; index >= 0 && index <= visibleEnd; index += 1) affected.add(index)
    for (let index = nextStart; index >= 0 && index <= nextEnd; index += 1) affected.add(index)
    visibleStart = nextStart
    visibleEnd = nextEnd
    for (const index of affected) {
      if (index >= 0 && index < anchors.length) updateMarker(index)
    }
    if (!listEl!.contains(doc.activeElement)) setRovingIndex(activeIndex)
    if (!captureButton && !listEl!.contains(doc.activeElement)) revealMarker(activeIndex)
  }

  function onScroll() {
    if (scrollFrame || destroyed || gate.isSuspended()) return
    const scheduledGeneration = generation
    scrollFrame = win.requestAnimationFrame(() => {
      scrollFrame = 0
      if (scheduledGeneration !== generation || destroyed || gate.isSuspended()) return
      updateActiveFromScroll()
    })
  }

  function onWindowResize() {
    scheduleRefresh(false)
  }

  function extractText(root: HTMLElement | null, limit: number): string {
    if (!root) return ''
    const ignored = '[hidden], [aria-hidden="true"], .file-badge, .msg-actions, .code-copy, .streaming-dots'
    const walker = doc.createTreeWalker(root, win.NodeFilter.SHOW_TEXT)
    const chunks: string[] = []
    let length = 0
    let node: Node | null
    while ((node = walker.nextNode()) && length < limit) {
      const parent = node.parentElement
      if (!parent || parent.closest(ignored)) continue
      const text = normalizePreviewText(node.nodeValue, limit - length)
      if (!text) continue
      chunks.push(text)
      length += text.length + 1
    }
    return normalizePreviewText(chunks.join(' '), limit)
  }

  function extractQueryPreview(anchor: HTMLElement) {
    const bubble = anchor.querySelector<HTMLElement>('.sent-user-stack > .msg.user')
    if (!bubble) return translated('turn_navigation_attachment', 'Image or attachment message')
    return extractText(bubble, QUERY_PREVIEW_LIMIT) ||
      translated('turn_navigation_attachment', 'Image or attachment message')
  }

  function extractAnswerPreview(anchor: HTMLElement) {
    const walker = doc.createTreeWalker(scrollEl!, win.NodeFilter.SHOW_ELEMENT)
    walker.currentNode = anchor
    let answer = ''
    let node: Node | null
    // Read only this turn on demand. Commentary/tool controls do not contribute
    // to the final assistant excerpt, and the next user bounds the traversal.
    while ((node = walker.nextNode())) {
      const element = node as HTMLElement
      if (element !== anchor && element.matches(ANCHOR_SELECTOR)) break
      if (anchor.contains(element) || !element.matches('.msg.assistant[data-nav-answer="true"]') || element.closest('[hidden], [aria-hidden="true"]')) continue
      const text = extractText(element, ANSWER_PREVIEW_LIMIT)
      if (text) answer = text
    }
    return answer
  }

  function renderTooltipContent(anchor: HTMLElement) {
    const query = doc.createElement('div')
    query.className = styles['turn-navigation-tooltip-query']
    query.textContent = extractQueryPreview(anchor)
    const website = websiteOutputForTurn(anchor)
    const output = website ? doc.createElement('div') : null
    if (output && website) {
      output.className = styles['turn-navigation-tooltip-output']
      const mark = doc.createElement('span')
      mark.className = styles['turn-navigation-tooltip-output-icon']
      mark.setAttribute('data-turn-output-icon', '')
      mark.setAttribute('aria-hidden', 'true')
      mark.innerHTML = icon('tc-globe')
      const label = doc.createElement('span')
      label.className = styles['turn-navigation-tooltip-output-label']
      label.textContent = `${translated('site_reference_website', 'Website')} · ${website.title || website.url}`
      output.appendChild(mark)
      output.appendChild(label)
    }
    const answer = extractAnswerPreview(anchor)
    if (answer) {
      const response = doc.createElement('div')
      response.className = styles['turn-navigation-tooltip-answer']
      response.textContent = answer
      tooltipEl!.replaceChildren(query, ...(output ? [output] : []), response)
    } else tooltipEl!.replaceChildren(query, ...(output ? [output] : []))
  }

  function markerFromEvent(event: Event): HTMLElement | null {
    const button = (event.target as HTMLElement | null)?.closest?.(`.${styles['turn-navigation-marker']}`) as HTMLElement | null
    return button && listEl!.contains(button) ? button : null
  }

  function showTooltip(button: HTMLElement) {
    const index = Number(button?.dataset.turnIndex)
    const anchor = anchors[index]
    if (!Number.isInteger(index) || !validAnchor(anchor)) {
      hideTooltip()
      scheduleRefresh(true)
      return
    }
    renderTooltipContent(anchor)
    tooltipIndex = index
    tooltipEl!.hidden = false
    const railRect = railEl!.getBoundingClientRect()
    const buttonRect = button.getBoundingClientRect()
    const halfHeight = tooltipEl!.getBoundingClientRect().height / 2
    const center = Math.max(halfHeight + 8, Math.min(buttonRect.top + buttonRect.height / 2, win.innerHeight - halfHeight - 8))
    const top = center - railRect.top
    tooltipEl!.style.top = `${Math.round(top)}px`
  }

  function activateMarker(button: HTMLElement, behavior: 'smooth' | 'instant' = 'smooth') {
    const index = Number(button?.dataset.turnIndex)
    const anchor = anchors[index]
    if (!Number.isInteger(index) || !validAnchor(anchor) || gate.isSuspended()) {
      scheduleRefresh(true)
      return
    }
    const reducedMotion = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    const navigated = onNavigate(anchor, {
      behavior: behavior === 'instant' || reducedMotion ? 'auto' : 'smooth',
      index,
      sessionId: activeSessionId,
    })
    if (navigated === false) return
    clearTargetFlash()
    targetFlash = anchor
    anchor.classList.add(styles['turn-navigation-target'])
    const flashGeneration = generation
    targetFlashTimer = win.setTimeout(() => {
      if (flashGeneration === generation) clearTargetFlash()
    }, reducedMotion ? 500 : 900)
    hideTooltip()
  }

  function onPointerOver(event: Event) {
    const button = markerFromEvent(event)
    if (!button || captureButton || button.contains((event as PointerEvent).relatedTarget as Node | null)) return
    setEmphasis(Number(button.dataset.turnIndex))
    cancelHoverTimer()
    // Preserve the fast preview delay while ignoring a quick pass over the rail.
    hoverTimer = win.setTimeout(() => {
      hoverTimer = 0
      if (!captureButton) showTooltip(button)
    }, HOVER_PREVIEW_DELAY_MS)
  }

  function onPointerOut(event: Event) {
    const button = markerFromEvent(event)
    const related = (event as PointerEvent).relatedTarget as Node | null
    if (related && button?.contains(related)) return
    if (captureButton) return
    setEmphasis(-1)
    cancelHoverTimer()
    hideTooltip()
  }

  function setEmphasis(index: number) {
    if (index === emphasisIndex) return
    for (let distance = -3; distance <= 3; distance += 1) markerButtons[emphasisIndex + distance]?.removeAttribute('data-neighbor-distance')
    emphasisIndex = index
    if (index >= 0) {
      for (let distance = -3; distance <= 3; distance += 1) {
        markerButtons[index + distance]?.setAttribute('data-neighbor-distance', String(Math.abs(distance)))
      }
      listEl!.setAttribute('data-previewing', '')
    } else listEl!.removeAttribute('data-previewing')
  }

  function setScrubTarget(button: HTMLElement) {
    scrubButton?.removeAttribute('data-scrub-target')
    scrubButton = button
    button.setAttribute('data-scrub-target', '')
    setEmphasis(Number(button.dataset.turnIndex))
    listEl!.setAttribute('data-scrubbing', '')
  }

  function onPointerDown(event: Event) {
    const ev = event as PointerEvent
    const button = markerFromEvent(event)
    if (!button || ev.isPrimary === false || captureButton) return
    if (ev.button !== 0) {
      event.preventDefault()
      return
    }
    event.preventDefault()
    cancelHoverTimer()
    hideTooltip()
    pointerStartButton = button
    captureButton = button
    scrubPointerId = ev.pointerId
    pointerMoved = false
    suppressPointerClick = false
    setEmphasis(Number(button.dataset.turnIndex))
    button.setPointerCapture(scrubPointerId)
  }

  function onPointerMove(event: Event) {
    if (!captureButton) return
    const ev = event as PointerEvent
    if (ev.pointerId !== scrubPointerId) return
    if (!(ev.buttons & 1)) {
      suppressPointerClick = true
      endScrub(ev.pointerId)
      return
    }
    event.preventDefault()
    const target = doc.elementFromPoint(ev.clientX, ev.clientY)
    const button = target ? (target.closest?.(`.${styles['turn-navigation-marker']}`) as HTMLElement | null) : null
    if (!button || !listEl!.contains(button)) {
      pointerMoved = true
      suppressPointerClick = true
      return
    }
    if ((!pointerMoved && button === pointerStartButton) || button === scrubButton) return
    pointerMoved = true
    suppressPointerClick = true
    setScrubTarget(button)
    activateMarker(button, 'instant')
    showTooltip(button)
  }

  function onPointerEnd(event: Event) {
    if (!captureButton || (event as PointerEvent).pointerId !== scrubPointerId) return
    if (event.type !== 'pointerup') suppressPointerClick = true
    endScrub((event as PointerEvent).pointerId)
  }

  function onClick(event: MouseEvent) {
    const button = markerFromEvent(event)
    if (!button || event.button !== 0) return
    if (suppressPointerClick && event.detail > 0) {
      suppressPointerClick = false
      return
    }
    activateMarker(button)
  }

  function onFocusIn(event: Event) {
    const button = markerFromEvent(event)
    if (!button) return
    setRovingIndex(Number(button.dataset.turnIndex))
    revealMarker(Number(button.dataset.turnIndex))
    setEmphasis(Number(button.dataset.turnIndex))
    showTooltip(button)
  }

  function onFocusOut(event: Event) {
    if (!listEl!.contains((event as FocusEvent).relatedTarget as Node | null)) {
      hideTooltip()
      setEmphasis(-1)
    }
  }

  function onKeyDown(event: KeyboardEvent) {
    const button = markerFromEvent(event)
    if (!button) return
    const index = Number(button.dataset.turnIndex)
    let next: number | null = null
    if (event.key === 'ArrowDown') next = index + 1
    else if (event.key === 'ArrowUp') next = index - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = anchors.length - 1
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      activateMarker(button)
      return
    } else {
      return
    }
    event.preventDefault()
    setRovingIndex(next, true)
  }

  function onEscape(event: KeyboardEvent) {
    if (event.key !== 'Escape' || (!hoverTimer && tooltipEl!.hidden && !captureButton)) return
    event.preventDefault()
    event.stopPropagation()
    suppressPointerClick = true
    endScrub()
    hideTooltip()
    setEmphasis(-1)
    if (listEl!.contains(doc.activeElement)) scrollEl!.focus({ preventScroll: true })
  }

  function setChatActive(nextActive: boolean) {
    const normalized = !!nextActive
    if (chatActive === normalized) return
    chatActive = normalized
    if (!chatActive) {
      setRailVisible(false)
      return
    }
    scheduleRefresh(false)
  }

  function invalidateLayout(target?: Element | null) {
    scheduleRefresh(false, !target || affectsAnchorPositions(target))
  }

  function destroy() {
    if (destroyed) return
    destroyed = true
    generation += 1
    cancelFrames()
    stopObserving()
    stopNativeSmoothScroll()
    clearTargetFlash()
    hideTooltip()
    endScrub()
    releaseModel()
    setRailVisible(false)
    listEl!.removeEventListener('pointerover', onPointerOver)
    listEl!.removeEventListener('pointerout', onPointerOut)
    listEl!.removeEventListener('focusin', onFocusIn)
    listEl!.removeEventListener('focusout', onFocusOut)
    listEl!.removeEventListener('pointerdown', onPointerDown)
    listEl!.removeEventListener('pointermove', onPointerMove)
    listEl!.removeEventListener('pointerup', onPointerEnd)
    listEl!.removeEventListener('pointercancel', onPointerEnd)
    listEl!.removeEventListener('lostpointercapture', onPointerEnd)
    listEl!.removeEventListener('click', onClick)
    listEl!.removeEventListener('keydown', onKeyDown)
    win.removeEventListener('blur', onWindowBlur)
    win.removeEventListener('keydown', onEscape, true)
  }

  listEl.addEventListener('pointerover', onPointerOver)
  listEl.addEventListener('pointerout', onPointerOut)
  listEl.addEventListener('focusin', onFocusIn)
  listEl.addEventListener('focusout', onFocusOut)
  // Capture stays on the original button for the complete pointer lifetime.
  listEl.addEventListener('pointerdown', onPointerDown)
  listEl.addEventListener('pointermove', onPointerMove)
  listEl.addEventListener('pointerup', onPointerEnd)
  listEl.addEventListener('pointercancel', onPointerEnd)
  listEl.addEventListener('lostpointercapture', onPointerEnd)
  listEl.addEventListener('click', onClick)
  listEl.addEventListener('keydown', onKeyDown)
  win.addEventListener('blur', onWindowBlur)
  win.addEventListener('keydown', onEscape, true)

  railEl.inert = true
  setRailVisible(false)
  startObserving()
  scheduleRefresh(true)

  return Object.freeze({
    suspend,
    resume,
    setChatActive,
    invalidateLayout,
    refresh: () => scheduleRefresh(true),
    refreshLabels,
    destroy,
  })
}

const api = Object.freeze({
  MIN_TURNS,
  READING_LINE_RATIO,
  findActiveTurnIndex,
  resolveActiveTurnIndex,
  findVisibleTurnRange,
  createSuspensionGate,
  normalizePreviewText,
  createTurnNavigationController,
})

if (typeof window !== 'undefined') (window as any).KlausTurnNavigation = api
