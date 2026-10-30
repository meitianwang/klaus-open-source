// Desktop window, link and clipboard policy used by the trusted app documents.
// All privileged operations cross the isolated preload into the Electron host.
import { call } from './ipc.js'
import { installTextContextMenuPolicy } from './text-context-menu.js'

// ---------------------------------------------------------------------------
// Titlebar drag regions
// ---------------------------------------------------------------------------
// WKWebView does not implement the Chromium-only `-webkit-app-region` CSS
// property, so on a frameless window the UI's drag surfaces would be dead. The
// surfaces are the ones the CSS already declares:
//   * index.html:       .app-titlebar-controls (styles.css) — a fixed strip with
//                       pointer-events:none, so hits are GEOMETRIC (the mousedown
//                       target is whatever sits underneath the strip);
//   * quick-input.html: .qi-card, with .qi-row carved out as no-drag;
//   * artifact.html:    .aw-titlebar (artifact.css), the preview window's bar.
// The no-drag carve-outs mirror styles.css's global no-drag rule (interactive
// elements + .no-drag). Double-click zooms on mouseup with unmoved coordinates,
// which is the platform convention on macOS and lets a drag cancel the zoom.
const DRAG_SURFACES = '.app-titlebar-controls, .qi-card, .aw-titlebar'
const NO_DRAG =
  'button, input, textarea, select, a, [role="button"], [contenteditable="true"], .no-drag, .qi-row'

const host = () => (window as any).__KLAUS_DESKTOP__

// macOS traffic lights occupy the left side of an overlay titlebar in a normal
// window, but disappear in fullscreen. Keep a class in sync so CSS can align
// the sidebar toggle with the nav icon column only when that space is free.
if (document.documentElement.classList.contains('platform-darwin')) {
  const appWindow = host().window.getCurrentWindow()
  let fullscreenSyncVersion = 0
  const syncFullscreenClass = async () => {
    const version = ++fullscreenSyncVersion
    try {
      const fullscreen = await appWindow.isFullscreen()
      if (version === fullscreenSyncVersion) {
        document.documentElement.classList.toggle('window-fullscreen', fullscreen)
      }
    } catch {
      if (version === fullscreenSyncVersion) {
        document.documentElement.classList.remove('window-fullscreen')
      }
    }
  }

  void syncFullscreenClass()
  void appWindow.onResized(() => {
    void syncFullscreenClass()
  })
}

function dragHit(event: MouseEvent): boolean {
  const target = event.target
  if (target instanceof Element && target.closest(NO_DRAG)) return false
  for (const region of document.querySelectorAll(DRAG_SURFACES)) {
    // A pointer-events:none strip never appears in the event path — test the
    // point against its box instead. The region is geometry, not a DOM ancestor.
    if (getComputedStyle(region).pointerEvents === 'none') {
      const box = region.getBoundingClientRect()
      if (
        event.clientX >= box.left && event.clientX <= box.right &&
        event.clientY >= box.top && event.clientY <= box.bottom
      ) return true
    } else if (target instanceof Element && region.contains(target)) {
      return true
    }
  }
  return false
}

let dragDownX = 0
let dragDownY = 0
document.addEventListener('mousedown', (event) => {
  if (event.button !== 0 || !dragHit(event)) return
  if (event.detail === 2) {
    // Zoom lands on mouseup, cancellable by moving off.
    dragDownX = event.clientX
    dragDownY = event.clientY
    return
  }
  event.preventDefault()
  host().core.invoke('window:start-dragging').catch(() => {})
})
document.addEventListener('mouseup', (event) => {
  if (
    event.button === 0 && event.detail === 2 &&
    event.clientX === dragDownX && event.clientY === dragDownY &&
    dragHit(event)
  ) {
    host().core.invoke('window:toggle-maximize').catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// External links
// ---------------------------------------------------------------------------
// Open web links through the host's scheme policy and the system browser.
const nativeWindowOpen = window.open ? window.open.bind(window) : () => null
window.open = ((url?: string | URL, target?: string, features?: string) => {
  if (typeof url === 'string' && /^https?:/i.test(url)) {
    call('app:openExternal', { url }).catch(() => {})
    return null
  }
  return nativeWindowOpen(url as any, target, features)
}) as typeof window.open
document.addEventListener('click', (event) => {
  const anchor =
    event.target instanceof Element ? event.target.closest('a[target="_blank"]') : null
  if (anchor && /^https?:/i.test((anchor as HTMLAnchorElement).href || '')) {
    event.preventDefault()
    call('app:openExternal', { url: (anchor as HTMLAnchorElement).href }).catch(() => {})
  }
}, true)

// ---------------------------------------------------------------------------
// window.close
// ---------------------------------------------------------------------------
// The host owns close behavior: the main window hides, auxiliary windows close.
window.close = () => {
  host().window.getCurrentWindow().close().catch(() => {})
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------
// Bubble phase lets existing UI menus consume the event before native text actions.
installTextContextMenuPolicy()
