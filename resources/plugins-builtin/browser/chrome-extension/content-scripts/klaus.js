const ROOT_ID = 'klaus-agent-overlay-root'
const CURSOR_IMAGE_URL = chrome.runtime.getURL('images/cursor-chat.png')
const DEFAULT_STATE = { cursor: null, isVisible: false, sessionId: null, turnId: null }
const IS_TOP_FRAME = window.top === window.self
const FRAME_MS = 1000 / 60

let state = DEFAULT_STATE
let cursorView = null
let resizeRenderQueued = false

install()

function install() {
  document.getElementById(ROOT_ID)?.remove()
  registerMessages()
  installRoot()
  window.addEventListener('resize', queueResizeRender)
  window.visualViewport?.addEventListener('resize', queueResizeRender)

  if (IS_TOP_FRAME) {
    chrome.runtime.sendMessage({ type: 'GET_AGENT_CURSOR_STATE' })
      .then(response => {
        if (response?.ok) {
          state = normalizeState(response.state)
          render()
        }
      })
      .catch(() => {})
  }
}

function registerMessages() {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'CONTENT_PING') {
      sendResponse({ ok: true })
      return true
    }

    if (message?.type === 'AGENT_CURSOR_STATE') {
      state = normalizeState(message.state)
      if (!cursorView) {
        sendResponse({ ok: false })
        return true
      }
      render()
      sendResponse({ ok: true })
      return true
    }

    return false
  })
}

function installRoot() {
  const parent = document.documentElement || document.body
  if (!parent) {
    const observer = new MutationObserver(() => {
      const retryParent = document.documentElement || document.body
      if (!retryParent) return
      observer.disconnect()
      appendRoot(retryParent)
    })
    observer.observe(document, { childList: true, subtree: true })
    return
  }
  appendRoot(parent)
}

function appendRoot(parent) {
  const rootHost = document.createElement('div')
  rootHost.id = ROOT_ID
  parent.appendChild(rootHost)
  buildOverlay(rootHost)
}

function buildOverlay(host) {
  const shadow = host.attachShadow({ mode: 'closed' })
  const style = document.createElement('style')
  style.textContent = `
    .klaus-agent-overlay {
      all: initial;
      pointer-events: none;
      position: fixed;
      inset: 0;
      overflow: hidden;
      z-index: 2147483646;
    }
    .klaus-agent-cursor {
      position: absolute;
      left: 0;
      top: 0;
      width: 24px;
      height: 24px;
      opacity: 0;
      transform-origin: 12px 12px;
      will-change: transform, opacity, filter;
      filter: blur(5px) drop-shadow(0 2px 4px rgba(0, 0, 0, .24));
    }
    .klaus-agent-cursor-inner {
      transform: translate3d(12px, -2.5px, 0);
    }
    .klaus-agent-cursor img {
      display: block;
      width: 23px;
      height: 24px;
      transform: rotate(44deg);
      transform-origin: 0 0;
      user-select: none;
      -webkit-user-drag: none;
    }
    @media print {
      .klaus-agent-overlay { display: none; }
    }
  `

  const overlay = document.createElement('div')
  overlay.className = 'klaus-agent-overlay'
  overlay.setAttribute('aria-hidden', 'true')

  if (IS_TOP_FRAME) cursorView = createCursorView(overlay)

  shadow.appendChild(style)
  shadow.appendChild(overlay)
  render()
}

function createCursorView(overlay) {
  const cursor = document.createElement('div')
  cursor.className = 'klaus-agent-cursor'
  cursor.dataset.testid = 'browser-agent-cursor'

  const inner = document.createElement('div')
  inner.className = 'klaus-agent-cursor-inner'

  const image = document.createElement('img')
  image.src = CURSOR_IMAGE_URL
  image.alt = ''
  image.decoding = 'async'
  image.draggable = false
  image.dataset.browserAgentCursorAsset = ''
  image.dataset.testid = 'browser-agent-cursor-asset'

  inner.appendChild(image)
  cursor.appendChild(inner)
  overlay.appendChild(cursor)

  const target = cursorTarget()
  return {
    element: cursor,
    point: { x: target.x, y: target.y },
    rafId: null,
    activeMoveKey: null,
    arrivedMoveKey: null,
  }
}

function render() {
  if (!cursorView) return
  const target = cursorTarget()
  const moveKey = Number.isInteger(target.moveSequence) && target.sessionId && target.turnId
    ? `${target.sessionId}:${target.turnId}:${target.moveSequence}`
    : null

  const shouldAnimate = target.visible && target.animateMovement && moveKey !== cursorView.activeMoveKey
  cursorView.activeMoveKey = moveKey

  if (!shouldAnimate) {
    cancelCursorAnimation()
    cursorView.point = { x: target.x, y: target.y }
    applyCursorTransform(target, -44, 1)
    if (target.visible) notifyArrived(target, moveKey)
    return
  }

  animateCursor(target, moveKey)
}

function animateCursor(target, moveKey) {
  cancelCursorAnimation()
  const startPoint = { ...cursorView.point }
  const endPoint = { x: target.x, y: target.y }
  const distance = pointDistance(startPoint, endPoint)
  if (distance < 0.5) {
    cursorView.point = endPoint
    applyCursorTransform(target, -44, 1)
    notifyArrived(target, moveKey)
    return
  }

  const duration = clamp(140 + distance * 0.55, 180, 760)
  const startedAt = now()
  const normal = motionNormal(startPoint, endPoint)
  const arc = clamp(distance * 0.18, 24, 96)

  const frame = time => {
    const progress = clamp((time - startedAt) / duration, 0, 1)
    const eased = easeOutCubic(progress)
    const lift = Math.sin(progress * Math.PI) * arc
    const x = lerp(startPoint.x, endPoint.x, eased) + normal.x * lift
    const y = lerp(startPoint.y, endPoint.y, eased) + normal.y * lift
    cursorView.point = { x, y }
    applyCursorTransform({ ...target, x, y }, cursorAngle(startPoint, endPoint), eased)

    if (progress >= 1) {
      cursorView.rafId = null
      cursorView.point = endPoint
      applyCursorTransform(target, cursorAngle(startPoint, endPoint), 1)
      notifyArrived(target, moveKey)
      return
    }
    cursorView.rafId = requestAnimationFrame(frame)
  }

  cursorView.rafId = requestAnimationFrame(frame)
}

function applyCursorTransform(target, angle, progress) {
  const visible = target.visible ? 1 : 0
  const blur = Math.round((1 - visible) * 5 * 1000) / 1000
  const stretch = target.visible ? clamp(1 - Math.sin(progress * Math.PI) * 0.12, 0.82, 1) : 1
  cursorView.element.style.opacity = String(visible)
  cursorView.element.style.filter = `blur(${blur}px) drop-shadow(0 2px 4px rgba(0, 0, 0, .24))`
  cursorView.element.style.transform = [
    `translate3d(${round(target.x - 12)}px, ${round(target.y - 12)}px, 0)`,
    `rotate(${round(angle)}deg)`,
    `scale(${round(stretch)}, 1)`,
  ].join(' ')
}

function notifyArrived(target, moveKey) {
  if (!moveKey || cursorView.arrivedMoveKey === moveKey) return
  cursorView.arrivedMoveKey = moveKey
  chrome.runtime.sendMessage({
    type: 'AGENT_CURSOR_ARRIVED',
    sessionId: target.sessionId,
    turnId: target.turnId,
    moveSequence: target.moveSequence,
  }).catch(() => {})
}

function cancelCursorAnimation() {
  if (cursorView?.rafId != null) cancelAnimationFrame(cursorView.rafId)
  if (cursorView) cursorView.rafId = null
}

function cursorTarget() {
  const viewport = viewportSize()
  const cursor = state.cursor
  const x = finiteNumber(cursor?.x, Math.round(viewport.width * 0.58))
  const y = finiteNumber(cursor?.y, Math.round(viewport.height * 0.55))
  const sessionId = typeof state.sessionId === 'string' ? state.sessionId : null
  const turnId = typeof state.turnId === 'string' ? state.turnId : null
  return {
    x: clamp(x, 0, viewport.width),
    y: clamp(y, 0, viewport.height),
    visible: state.isVisible === true && sessionId != null && cursor?.visible !== false,
    animateMovement: cursor?.animateMovement !== false,
    moveSequence: Number.isInteger(cursor?.moveSequence) ? cursor.moveSequence : null,
    sessionId,
    turnId,
  }
}

function queueResizeRender() {
  if (resizeRenderQueued) return
  resizeRenderQueued = true
  requestAnimationFrame(() => {
    resizeRenderQueued = false
    render()
  })
}

function normalizeState(value) {
  if (!value || typeof value !== 'object') return DEFAULT_STATE
  const sessionId = typeof value.sessionId === 'string' ? value.sessionId : null
  const turnId = typeof value.turnId === 'string' ? value.turnId : null
  return {
    cursor: normalizeCursor(value.cursor),
    isVisible: value.isVisible === true && sessionId != null,
    sessionId,
    turnId,
  }
}

function normalizeCursor(value) {
  if (!value || typeof value !== 'object') return null
  const x = Number(value.x)
  const y = Number(value.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return {
    x,
    y,
    visible: value.visible === true,
    ...(value.animateMovement === false ? { animateMovement: false } : {}),
    ...(Number.isInteger(value.moveSequence) ? { moveSequence: value.moveSequence } : {}),
  }
}

function viewportSize() {
  return {
    width: window.visualViewport?.width || window.innerWidth || 0,
    height: window.visualViewport?.height || window.innerHeight || 0,
  }
}

function finiteNumber(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function pointDistance(left, right) {
  return Math.hypot(right.x - left.x, right.y - left.y)
}

function motionNormal(start, end) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  if (length < 0.001) return { x: 0, y: 0 }
  return { x: -dy / length, y: dx / length }
}

function cursorAngle(start, end) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  if (Math.hypot(dx, dy) < 0.001) return -44
  return Math.atan2(dy, dx) * (180 / Math.PI) + 45
}

function easeOutCubic(value) {
  return 1 - (1 - value) ** 3
}

function lerp(from, to, amount) {
  return from + (to - from) * amount
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function round(value) {
  return Math.round(value * 1000) / 1000
}

function now() {
  return typeof performance === 'undefined' ? Date.now() : performance.now()
}
