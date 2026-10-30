// The `::klaus-inline-vis{…}` renderer pass: parse directive lines out of the
// final reply, consume the paragraphs that carried them, and mount the page in
// a sandboxed iframe inside the message body.
//
// The page CONTENT arrives with the message: the host reads each directive's
// file once, under the visualization whitelist, while projecting history (and
// again at message settle for the live tail), and ships it as an `inlineVis`
// fragment array on the text block. This module therefore never touches the
// filesystem and never asks the host for a URL — there is exactly one
// authorization surface for inline pages, and it is the host's projection
// read. What remains here is mounting: the paragraph walk, the sandboxed frame,
// the injected host bridge, and the honest failure card a fragment without
// content renders instead of echoing the directive line.
//
// Contract (contracts/inline-visualization.ts): the whole line must be the
// directive; anything else stays as visible text.
import { createElement, useEffect, useRef, type ReactNode } from 'react'
import { RawHtml } from '../../components/RawHtml'
import { HighlightedHtml } from '../../components/HighlightedHtml'
import { t as tGlobal } from '../../i18n'
import { mountMediaPlayers } from './media-player'
import { INLINE_VIS_BRIDGE_DOWNLOAD, INLINE_VIS_BRIDGE_ERROR, INLINE_VIS_BRIDGE_HEIGHT, INLINE_VIS_BRIDGE_OPEN_EXTERNAL, INLINE_VIS_BRIDGE_READY, INLINE_VIS_DEFAULT_HEIGHT_PX, INLINE_VIS_MAX_HEIGHT_PX, INLINE_VIS_MIN_HEIGHT_PX, INLINE_VIS_PREFIX, INLINE_VIS_READY_TIMEOUT_MS, inlineVisFileEligible, parseInlineVisDirective, type InlineVisFragment } from '../../../../contracts/inline-visualization'

/** How many inline frames one message may mount. Nothing in the directive syntax caps it; a message that emits dozens of directives is a model bug, and the browser's own frame budget is the honest bound. */
const MAX_FRAMES_PER_MESSAGE = 8

/**
 * The runtime injected into every mounted page, ahead of its own markup. It
 * installs the `window.openai.callTool` bridge the page uses for the ready
 * handshake, intrinsic height, page-side errors, explicit external navigation
 * and explicit download requests; every other tool name is refused. The
 * runtime also OWNS the intrinsic-height report: it measures the page itself
 * and keeps the host frame sized to the content, so a finished page is never
 * trapped in a small scroll window and never has to opt in, and it carries
 * the host theme into the page. The page runs in an opaque origin (sandbox
 * without allow-same-origin), so this script is the ONLY channel between the
 * page and the transcript.
 */
function sandboxBridgeSource(theme: 'light' | 'dark'): string {
  return `
<script>
(() => {
  const post = detail => { try { parent.postMessage(Object.assign({ source: 'klaus-inline-vis' }, detail), '*'); } catch (_) {} };
  const notify = (name, payload) => post({ name, payload });
  let expanded = false;
  window.addEventListener('message', event => {
    if (event.source === parent && event.data?.source === 'klaus-inline-vis-host' && event.data.name === 'expanded') expanded = event.data.expanded === true;
  });
  const canScroll = (node, delta, axis) => {
    if (!(node instanceof Element) || !delta) return false;
    const style = getComputedStyle(node);
    const overflow = axis === 'y' ? style.overflowY : style.overflowX;
    const root = node === document.scrollingElement;
    if (root ? /hidden|clip/.test(overflow) : !/auto|scroll|overlay/.test(overflow)) return false;
    const position = axis === 'y' ? node.scrollTop : node.scrollLeft;
    const extent = axis === 'y' ? node.scrollHeight - node.clientHeight : node.scrollWidth - node.clientWidth;
    return delta < 0 ? position > 1 : position < extent - 1;
  };
  window.addEventListener('wheel', event => {
    if (expanded || event.ctrlKey || event.metaKey || event.defaultPrevented || !event.cancelable) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1;
    const deltaX = (event.shiftKey && !event.deltaX ? event.deltaY : event.deltaX) * unit;
    const deltaY = (event.shiftKey && !event.deltaX ? 0 : event.deltaY) * unit;
    if (!deltaY || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return;
    const nodes = event.composedPath();
    if (!nodes.includes(document.scrollingElement)) nodes.push(document.scrollingElement);
    if (nodes.some(node => canScroll(node, deltaY, 'y'))) return;
    // Minor horizontal drift must not trap a vertical reading gesture.
    if (Math.abs(deltaX) > Math.abs(deltaY) && nodes.some(node => canScroll(node, deltaX, 'x'))) return;
    // Cancel native cross-frame chaining so the transcript receives one move.
    event.preventDefault();
    notify('wheel', { deltaX, deltaY });
  }, { passive: false });
  // Pointer/touch drag over a non-scrollable inline page must scroll the
  // parent transcript, the same way wheel events do. Track the active pointer
  // and forward drag deltas as wheel messages when the guest cannot consume
  // the movement itself.
  let dragPointerId = null;
  let dragStartTarget = null;
  let lastDragX = 0;
  let lastDragY = 0;
  const dragSelector = 'input,textarea,select,button,a[href],[contenteditable=""],[contenteditable="true"],canvas,video,audio,[role="slider"],[role="button"],[role="textbox"],[draggable="true"]';
  const canForwardDrag = (x, y, deltaX, deltaY) => {
    if (!deltaY && !deltaX) return false;
    if (dragStartTarget && typeof dragStartTarget.closest === 'function' && dragStartTarget.closest(dragSelector)) return false;
    const nodes = typeof document.elementsFromPoint === 'function'
      ? document.elementsFromPoint(x, y)
      : [document.scrollingElement];
    if (!nodes.includes(document.scrollingElement)) nodes.push(document.scrollingElement);
    if (deltaY && nodes.some(node => canScroll(node, deltaY, 'y'))) return false;
    if (deltaX && Math.abs(deltaX) > Math.abs(deltaY) && nodes.some(node => canScroll(node, deltaX, 'x'))) return false;
    return true;
  };
  const startDrag = (x, y, id, target) => { dragPointerId = id; dragStartTarget = target; lastDragX = x; lastDragY = y; };
  const endDrag = () => { dragPointerId = null; dragStartTarget = null; };
  const moveDrag = (event, x, y) => {
    if (dragPointerId == null) return;
    const deltaX = x - lastDragX;
    const deltaY = y - lastDragY;
    lastDragX = x;
    lastDragY = y;
    // Check scrollability in the wheel-equivalent direction (drag inverted).
    if (!canForwardDrag(x, y, -deltaX, -deltaY)) return;
    // Drag direction is inverted to wheel convention: dragging down pulls
    // content down, i.e. the parent should scroll up (negative wheel deltaY).
    event.preventDefault();
    notify('wheel', { deltaX: -deltaX, deltaY: -deltaY });
  };
  window.addEventListener('pointerdown', event => { startDrag(event.clientX, event.clientY, event.pointerId, event.target); }, { passive: true });
  window.addEventListener('pointermove', event => {
    if (event.pointerId !== dragPointerId) return;
    moveDrag(event, event.clientX, event.clientY);
  }, { passive: false });
  window.addEventListener('pointerup', event => { if (event.pointerId === dragPointerId) endDrag(); }, { passive: true });
  window.addEventListener('pointercancel', event => { if (event.pointerId === dragPointerId) endDrag(); }, { passive: true });
  window.addEventListener('touchstart', event => {
    const touch = event.touches[0];
    if (touch) startDrag(touch.clientX, touch.clientY, 'touch', event.target);
  }, { passive: true });
  window.addEventListener('touchmove', event => {
    const touch = event.touches[0];
    if (touch) moveDrag(event, touch.clientX, touch.clientY);
  }, { passive: false });
  window.addEventListener('touchend', endDrag, { passive: true });
  window.addEventListener('touchcancel', endDrag, { passive: true });
  let ready = false;
  const timer = setTimeout(() => { if (!ready) notify('error', { message: 'The page did not finish loading.' }); }, ${INLINE_VIS_READY_TIMEOUT_MS});
  let lastHeight = -1;
  let scheduled = false;
  const measure = () => {
    const root = document.documentElement;
    const height = Math.max(root ? root.scrollHeight : 0, document.body ? document.body.scrollHeight : 0);
    if (height !== lastHeight) { lastHeight = height; notify('height', { height }); }
  };
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; measure(); });
  };
  const startMeasuring = () => {
    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(schedule);
      if (document.body) observer.observe(document.body);
      if (document.documentElement) observer.observe(document.documentElement);
    }
    window.addEventListener('load', schedule);
    window.addEventListener('resize', schedule);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule, () => {});
  };
  const markReady = () => { if (ready) return; ready = true; clearTimeout(timer); startMeasuring(); notify('ready', {}); };
  const openai = {
    callTool: (name, payload) => {
      switch (name) {
        case ${JSON.stringify(INLINE_VIS_BRIDGE_READY)}: markReady(); return Promise.resolve();
        case ${JSON.stringify(INLINE_VIS_BRIDGE_HEIGHT)}: notify('height', payload || {}); return Promise.resolve();
        case ${JSON.stringify(INLINE_VIS_BRIDGE_ERROR)}: notify('error', payload || {}); return Promise.resolve();
        case ${JSON.stringify(INLINE_VIS_BRIDGE_OPEN_EXTERNAL)}: notify('openExternal', payload || {}); return Promise.resolve();
        case ${JSON.stringify(INLINE_VIS_BRIDGE_DOWNLOAD)}: notify('download', payload || {}); return Promise.resolve();
        default: return Promise.reject(new Error('Inline visualizations cannot call tools.'));
      }
    },
  };
  try { Object.defineProperty(window, 'openai', { value: Object.freeze(openai), configurable: false }); } catch (_) { window.openai = openai; }
  try {
    document.documentElement.dataset.theme = ${JSON.stringify(theme)};
    document.documentElement.style.colorScheme = ${JSON.stringify(theme)};
  } catch (_) {}
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', markReady, { once: true });
  else markReady();
})();
</script>`
}

/** The host theme a mounted page inherits, read the same way the app exposes it. */
function hostTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

type FrameState = {
  shell: HTMLDivElement
  loader: HTMLDivElement
  frame: HTMLDivElement
  toolbar: HTMLDivElement
  expandButton: HTMLButtonElement
  contents: string | null
  lastHeightPx: number
  expanded: boolean
  backdrop: HTMLDivElement | null
  onOpenExternal?: (url: string) => void
  escapeHandler: (event: KeyboardEvent) => void
}

/**
 * Reported intrinsic heights by page path, so a remount (session switch,
 * re-projection) starts at the height the page already measured instead of
 * the loading height.
 */
const inlineVisHeightCache = new Map<string, number>()

/** Run the mount only after RawHtml has committed its actual DOM. */
export function InlineVisualizationHtml({ html, fragments = [], className, sessionId, onOpenExternal, message, afterContent }: {
  html: string
  message?: { html: string; markdown: string; answer: boolean; className?: string; actionsHtml: string }
  afterContent?: ReactNode
  fragments?: readonly InlineVisFragment[]
  className: string
  sessionId: string
  onOpenExternal?: (url: string) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const body = ref.current?.querySelector(':scope > .msg.assistant') as HTMLElement | null
    if (!body) return
    if (fragments.length) mountInlineVisualizations(body, fragments, onOpenExternal)
    // Player shells carry their own session attribute; they mount even where
    // the bubble has no live session (read-only transcripts).
    mountMediaPlayers(body)
  }, [html, message?.html, fragments, onOpenExternal])
  if (message) {
    const actions = message.actionsHtml.match(/^<div class="msg-actions" data-copy-text="([^"]*)">([\s\S]*)<\/div>$/)
    return createElement('div', { key: sessionId, ref, className },
      createElement(HighlightedHtml, { className: message.className ?? 'msg assistant', html: message.html,
        ...{ 'data-md': message.markdown, 'data-nav-answer': message.answer ? 'true' : undefined } }),
      afterContent,
      actions ? createElement(RawHtml, { className: 'msg-actions', ...{ 'data-copy-text': message.markdown }, html: actions[2] }) : null)
  }
  return createElement(HighlightedHtml, { key: sessionId, ref, className, html })
}

/**
 * Replace directive paragraphs with mount placeholders, in the message's own
 * HTML, then fill each placeholder from the matching fragment's content.
 * Returns the number of mounts requested.
 *
 * Runs on the rendered DOM (post-markdown), so fenced code can never qualify:
 * `marked` keeps fence lines inside `<pre><code>`, and this walk only touches
 * top-level `<p>` elements. The rule mirrors `renderCreatedThreadCards` exactly
 * (same walk, same whole-paragraph consumption, same "partial match keeps the
 * paragraph" fallback) — a second decision tree here would drift from the one
 * transcript tests already pin.
 *
 * A paragraph whose directive has NO fragment (the host projected nothing for
 * it: unparsed, ineligible name) stays visible text, exactly as before. A
 * fragment whose `contents` is null renders the failure card: the page was
 * read and refused, and hiding that would turn a real failure into silence.
 */
export function mountInlineVisualizations(host: HTMLElement, fragments: readonly InlineVisFragment[], onOpenExternal?: (url: string) => void): number {
  const byPath = new Map<string, InlineVisFragment>()
  for (const fragment of fragments) if (!byPath.has(fragment.path)) byPath.set(fragment.path, fragment)
  let requested = 0
  for (const paragraph of [...host.querySelectorAll('p')]) {
    if (paragraph.querySelector('[data-klaus-inline-vis]')) continue
    if (!(paragraph.textContent ?? '').includes(INLINE_VIS_PREFIX)) continue
    const snapshot = paragraph.cloneNode(true) as HTMLElement
    for (const br of snapshot.querySelectorAll('br')) br.replaceWith('\n')
    const lines = (snapshot.textContent ?? '').split('\n').map(line => line.trim()).filter(line => line.length > 0)
    if (lines.length === 0) continue
    if (requested + lines.length > MAX_FRAMES_PER_MESSAGE) continue
    const directives = lines.map(line => parseInlineVisDirective(line))
    if (directives.some(d => d === null)) continue
    // The pure half of the whitelist before mounting: a name the contract
    // forbids keeps the directive as visible text.
    if (directives.some(d => !inlineVisFileEligible(d!.path.split(/[\\/]/).pop() || '', undefined))) continue
    // Every line must carry projected content or a projected refusal; a line
    // the host never projected (a foreign session's page, a removed feature)
    // stays text rather than silently vanishing.
    if (directives.some(d => !byPath.has(d!.path))) continue
    const mounts: HTMLElement[] = []
    const settle: Array<() => void> = []
    for (const directive of directives) {
      const fragment = byPath.get(directive!.path)!
      const state = createFrameShell(directive!.path)
      mounts.push(state.frame)
      requested++
      // The frame must be IN the document before either branch replaces or
      // fills it: replaceWith on a detached node is a silent no-op.
      settle.push(() => {
        if (fragment.contents === null) {
          replaceWithFailureCard(state, directive!.path, fragment.readError)
          return
        }
        attachSandboxedPage(state, fragment.contents, onOpenExternal)
      })
    }
    if (mounts.length) {
      paragraph.replaceWith(...mounts)
      for (const apply of settle) apply()
    }
  }
  return requested
}

const INLINE_VIS_EXPAND_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`
const INLINE_VIS_CLOSE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg>`

/**
 * The frame shell: the sized content shell plus the hover toolbar that owns
 * the wide preview. The toolbar is part of the frame, not a message action,
 * so it travels with the mount and disappears with it.
 */
function createFrameShell(path: string): FrameState {
  const frame = document.createElement('div')
  frame.className = 'klaus-inline-vis'
  frame.setAttribute('data-klaus-inline-vis', path)
  const shell = document.createElement('div')
  shell.className = 'klaus-inline-vis-shell'
  shell.style.height = `${inlineVisHeightCache.get(path) ?? INLINE_VIS_DEFAULT_HEIGHT_PX}px`
  const loader = document.createElement('div')
  loader.className = 'klaus-inline-vis-loader'
  shell.appendChild(loader)
  frame.appendChild(shell)
  const toolbar = document.createElement('div')
  toolbar.className = 'klaus-inline-vis-toolbar'
  const expandButton = document.createElement('button')
  expandButton.type = 'button'
  expandButton.className = 'klaus-inline-vis-tool'
  expandButton.setAttribute('data-klaus-inline-vis-expand', 'true')
  expandButton.innerHTML = INLINE_VIS_EXPAND_ICON
  toolbar.appendChild(expandButton)
  frame.appendChild(toolbar)
  const state: FrameState = {
    shell, loader, frame, toolbar, expandButton,
    contents: null, lastHeightPx: 0, expanded: false, backdrop: null,
    escapeHandler: (event: KeyboardEvent) => { if (event.key === 'Escape') setExpanded(state, false) },
  }
  relabelFrameTools(state)
  expandButton.addEventListener('click', () => setExpanded(state, !state.expanded))
  return state
}

/** Keep the toolbar label and the expand/close glyph in step with the mode. */
function relabelFrameTools(state: FrameState): void {
  const expandKey = state.expanded ? 'inline_vis_collapse' : 'inline_vis_expand'
  state.expandButton.setAttribute('aria-label', tGlobal(expandKey))
  state.expandButton.title = tGlobal(expandKey)
  state.expandButton.innerHTML = state.expanded ? INLINE_VIS_CLOSE_ICON : INLINE_VIS_EXPAND_ICON
}

/**
 * The wide preview: the SAME frame node goes fixed-position over the
 * transcript, so the mounted page keeps its document and its state; a
 * backdrop, Esc or the close button return it to the column at its last
 * intrinsic height.
 */
function setExpanded(state: FrameState, expanded: boolean): void {
  if (state.expanded === expanded) return
  state.expanded = expanded
  state.frame.classList.toggle('klaus-inline-vis-expanded', expanded)
  if (expanded) {
    const backdrop = document.createElement('div')
    backdrop.className = 'klaus-inline-vis-backdrop'
    backdrop.addEventListener('click', () => setExpanded(state, false))
    document.body.appendChild(backdrop)
    state.backdrop = backdrop
    state.shell.style.height = '100%'
    document.addEventListener('keydown', state.escapeHandler)
  } else {
    state.backdrop?.remove()
    state.backdrop = null
    state.shell.style.height = `${state.lastHeightPx || INLINE_VIS_DEFAULT_HEIGHT_PX}px`
    document.removeEventListener('keydown', state.escapeHandler)
  }
  state.frame.querySelector('iframe')?.contentWindow?.postMessage({ source: 'klaus-inline-vis-host', name: 'expanded', expanded }, '*')
  relabelFrameTools(state)
}

/**
 * Mount one page: the injected bridge runtime first, then the page's own
 * markup, into an opaque-origin frame. Height settles on the page's reported
 * intrinsic height (bounded), the ready handshake flips the shell from
 * loader to content, and a page that never reports ready fails honestly after
 * the bounded wait.
 */
function attachSandboxedPage(state: FrameState, contents: string, onOpenExternal?: (url: string) => void): void {
  state.contents = contents
  state.onOpenExternal = onOpenExternal
  const iframe = document.createElement('iframe')
  // Same sandbox posture as the Files panel's HTML preview
  // (workspace-panel.ts renderWorkspaceFileHtmlPreview): allow-scripts
  // without allow-same-origin, so the page runs in an opaque origin with
  // no access to the host renderer's DOM/storage.
  iframe.setAttribute('sandbox', 'allow-scripts')
  iframe.setAttribute('referrerpolicy', 'no-referrer')
  iframe.setAttribute('aria-label', state.frame.getAttribute('data-klaus-inline-vis') || 'visualization')
  iframe.style.cssText = 'display:block;width:100%;height:100%;border:0;'
  // srcdoc keeps the page inside the opaque origin; a capability URL would be
  // a second read surface, which is exactly what this pass removed.
  iframe.srcdoc = `${sandboxBridgeSource(hostTheme())}\n${contents}`
  const cleanup = listenToPage(iframe, state, onOpenExternal)
  iframe.addEventListener('load', () => { /* readiness rides the bridge, not the load event */ })
  state.shell.appendChild(iframe)
  state.loader.remove()
  void cleanup
}

function listenToPage(iframe: HTMLIFrameElement, state: FrameState, onOpenExternal?: (url: string) => void): () => void {
  let settled = false
  const timer = window.setTimeout(() => {
    if (settled) return
    settled = true
    replaceWithFailureCard(state, state.frame.getAttribute('data-klaus-inline-vis') || '', 'the page did not become ready')
  }, INLINE_VIS_READY_TIMEOUT_MS)
  const onMessage = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return
    const data = event.data as { source?: string; name?: string; payload?: Record<string, unknown> } | null
    if (!data || data.source !== 'klaus-inline-vis' || !state.frame.isConnected) return
    if (data.name === 'ready' && !settled) {
      settled = true
      window.clearTimeout(timer)
      // The frame keeps its loading height until the page's first intrinsic
      // height report arrives; resetting here would fight the report.
      iframe.contentWindow?.postMessage({ source: 'klaus-inline-vis-host', name: 'expanded', expanded: state.expanded }, '*')
    } else if (data.name === 'wheel') {
      if (state.expanded) return
      const { deltaX, deltaY } = data.payload ?? {}
      if (typeof deltaX !== 'number' || typeof deltaY !== 'number' || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return
      forwardPageWheel(iframe, deltaX, deltaY)
    } else if (data.name === 'height' && typeof data.payload?.height === 'number') {
      const height = Math.max(INLINE_VIS_MIN_HEIGHT_PX, Math.min(INLINE_VIS_MAX_HEIGHT_PX, Math.round(data.payload.height)))
      state.lastHeightPx = height
      const path = state.frame.getAttribute('data-klaus-inline-vis')
      if (path) inlineVisHeightCache.set(path, height)
      if (!state.expanded) state.shell.style.height = `${height}px`
      state.frame.style.minHeight = '0'
    } else if (data.name === 'error') {
      if (settled) return
      settled = true
      window.clearTimeout(timer)
      replaceWithFailureCard(state, state.frame.getAttribute('data-klaus-inline-vis') || '', String(data.payload?.message ?? 'the page reported an error'))
    } else if (data.name === 'openExternal') {
      const url = String(data.payload?.url ?? '')
      if (/^https?:\/\//i.test(url) && window.confirm(tGlobal('inline_vis_open_external_confirm'))) onOpenExternal?.(url)
    } else if (data.name === 'download') {
      const name = String(data.payload?.name ?? 'visualization.html')
      downloadPageBlob(String(data.payload?.data ?? ''), name)
      notifyDownloadSaved(name)
    }
  }
  window.addEventListener('message', onMessage)
  const observer = new MutationObserver(() => {
    if (!state.frame.isConnected) {
      window.clearTimeout(timer)
      window.removeEventListener('message', onMessage)
      observer.disconnect()
      if (state.expanded) setExpanded(state, false)
    }
  })
  observer.observe(document.body, { childList: true, subtree: true })
  return () => {
    window.clearTimeout(timer)
    window.removeEventListener('message', onMessage)
    observer.disconnect()
  }
}

/** Relay boundary scrolling through the viewport's existing intent and paging listeners. */
function forwardPageWheel(iframe: HTMLIFrameElement, deltaX: number, deltaY: number): void {
  let viewport = iframe.parentElement
  while (viewport && !/(auto|scroll|overlay)/.test(getComputedStyle(viewport).overflowY)) viewport = viewport.parentElement
  if (!viewport) return
  // Synthetic wheel events carry intent but have no native scrolling action.
  // Deliver intent first so a pending follow write cannot undo the movement.
  const accepted = iframe.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaX, deltaY }))
  if (accepted) viewport.scrollBy({ left: deltaX, top: deltaY, behavior: 'instant' })
}

/** A page-authored download: the renderer is unsandboxed, so a plain anchor download is the honest surface. */
function downloadPageBlob(base64: string, name: string): void {
  try {
    const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = name || 'visualization.html'
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 5000)
  } catch { /* a malformed download payload is simply refused */ }
}

/** The app's global toast surface, reached through the window global the shared UI module publishes. */
function notifyDownloadSaved(name: string): void {
  const toast = (window as unknown as { showToast?: (msg: unknown) => void }).showToast
  toast?.(tGlobal('inline_vis_download_saved').replace('{filename}', name))
}

/** The menu download saves the projected page bytes under the file's own name. */
function reloadFrame(state: FrameState): void {
  const contents = state.contents
  if (contents === null) return
  if (state.expanded) setExpanded(state, false)
  state.frame.removeAttribute('data-klaus-inline-vis-failure')
  state.frame.removeAttribute('data-klaus-inline-vis-failure-reason')
  state.frame.querySelector('[data-klaus-inline-vis-banner]')?.remove()
  state.shell.replaceChildren()
  state.loader = document.createElement('div')
  state.loader.className = 'klaus-inline-vis-loader'
  state.shell.appendChild(state.loader)
  attachSandboxedPage(state, contents, state.onOpenExternal)
}

/**
 * The honest failure state: a banner across the top of the frame area with a
 * reload action when there is content to reload, never the raw directive
 * line and never the raw refusal text. This is what a removed file, an
 * over-cap page or a page that never signals ready looks like in the
 * transcript.
 */
function replaceWithFailureCard(state: FrameState, path: string, reason?: string): void {
  if (state.expanded) setExpanded(state, false)
  state.frame.setAttribute('data-klaus-inline-vis-failure', path)
  if (reason) state.frame.setAttribute('data-klaus-inline-vis-failure-reason', reason)
  if (state.frame.querySelector('[data-klaus-inline-vis-banner]')) return
  const banner = document.createElement('div')
  banner.className = 'klaus-inline-vis-banner'
  banner.setAttribute('data-klaus-inline-vis-banner', 'true')
  banner.setAttribute('role', 'alert')
  const text = document.createElement('span')
  text.textContent = tGlobal('inline_vis_error_banner')
  banner.appendChild(text)
  if (state.contents !== null) {
    const reload = document.createElement('button')
    reload.type = 'button'
    reload.className = 'klaus-inline-vis-banner-button'
    reload.setAttribute('data-klaus-inline-vis-reload', 'true')
    reload.textContent = tGlobal('inline_vis_reload')
    reload.addEventListener('click', () => reloadFrame(state))
    banner.appendChild(reload)
  }
  state.frame.appendChild(banner)
}

/**
 * Streaming rule: an unfinished directive line is HIDDEN during
 * streaming, not shown raw and not mounted. Both halves matter — mid-stream
 * lines vanish, complete lines render only at the end. Here "mid-stream" means
 * the whole paragraph never left the
 * streaming pass, so hiding is a text-level rewrite of the markdown output:
 * paragraphs that are exactly one directive (or a run of them) are dropped,
 * everything else survives untouched.
 */
export function stripInlineVisLines(html: string): string {
  if (!html.includes(INLINE_VIS_PREFIX)) return html
  return html.replace(/<p>([^]*?)<\/p>/g, (whole, inner: string) => {
    const text = inner.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
    if (lines.length === 0) return whole
    return lines.every(line => parseInlineVisDirective(line) !== null) ? '' : whole
  })
}

/**
 * The testable twin of `mountInlineVisualizations`' paragraph-consumption rule,
 * structured exactly like `postProcessHtmlForTests`: pre-split top-level blocks
 * in, blocks-to-keep plus mount descriptors out. The DOM walk above and this
 * function are the same decision tree in two runtimes; the paired assertions in
 * the vector test pin that they stay in step.
 */
export function inlineVisForTests(paragraphs: readonly string[]): { kept: string[]; mounts: Array<{ path: string }> } {
  const kept: string[] = []
  const mounts: Array<{ path: string }> = []
  for (const paragraph of paragraphs) {
    const text = paragraph.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')
      .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    const lines = text.split('\n').map(line => line.trim()).filter(line => line.length > 0)
    if (lines.length === 0 || mounts.length + lines.length > MAX_FRAMES_PER_MESSAGE) { kept.push(paragraph); continue }
    const directives = lines.map(line => parseInlineVisDirective(line))
    if (directives.some(d => d === null)) { kept.push(paragraph); continue }
    if (directives.some(d => !inlineVisFileEligible(d!.path.split(/[\\/]/).pop() || '', undefined))) { kept.push(paragraph); continue }
    for (const directive of directives) mounts.push({ path: directive!.path })
  }
  return { kept, mounts }
}
