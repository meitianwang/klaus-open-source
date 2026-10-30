// Klaus Desktop — unified custom dropdown (replaces native <select>).
// Extracted from cron.js's .cron-dd-* implementation so every page uses the
// same trigger/panel/check-icon styling instead of the OS-native picker.
//
// Usage:
//   window.klsSelect.bind(rootEl, { onChange, items?, value?, hideSelected? })
//   → returns { setValue, getValue, setItems, close, el }
//
// Markup (items can be inlined or passed via options.items and rendered later):
//   <div class="kls-select">
//     <button type="button" class="kls-select-trigger">
//       <span class="kls-select-text"></span>
//       (caret svg)
//     </button>
//     <div class="kls-select-panel" hidden></div>
//   </div>
//（迁自 js/ui-select.js，逻辑原样。）
import { icon } from '../icons/registry'
import { claimOverlay, overlayIdForElement, registerOverlay, unregisterOverlay } from './overlay-registry'

const CARET_SVG = `${icon('chevron-down', { cls: 'kls-select-caret', size: 12 })}`

interface SelectItem {
  value: string
  label?: string
  i18nKey?: string
  tooltip?: string
  tooltipKey?: string
  description?: string
  descriptionKey?: string
  iconHtml?: string
  /**
   * Option is shown but not selectable (for example an environment row that is
   * not available for this project). Pair it with `description`/`descriptionKey` for the reason:
   * composer surfaces carry no hover tooltips, so the reason reads as row text.
   */
  disabled?: boolean
}

export interface SelectApi {
  el: HTMLElement
  setValue: (v: unknown, opts?: { silent?: boolean }) => void
  getValue: () => string
  setItems: (next: SelectItem[], opts?: { value?: unknown }) => void
  refresh: () => void
  open: () => void
  close: () => void
  destroy: () => void
  // Adopt a fresh options object on an already-bound root. bind() routes here,
  // so re-binding is how a caller pushes new items/value/disabled state.
  applyOptions: (next: BindOptions) => void
}

export interface BindOptions {
  onChange?: (value: string) => void
  items?: SelectItem[]
  value?: unknown
  placeholder?: string
  hideSelected?: boolean
  disabled?: boolean
}

// Position a panel below its trigger in viewport coords. Flips horizontally
// when overflowing right, vertically when overflowing bottom. Same algorithm
// as cron.js's positionPopup so behavior matches across the app.
function positionPanel(trigger: HTMLElement, panel: HTMLElement) {
  const rect = trigger.getBoundingClientRect()
  // A transformed or filtered ancestor (a modal's entrance animation carries a
  // transform; overlays carry backdrop-filter) becomes the containing block
  // for this position:fixed panel, so style coordinates are relative to that
  // ancestor's box instead of the viewport. Derive the containing block's
  // viewport origin from where the panel actually sits for its current style
  // values — parking it at 0,0 on the very first placement, synchronously
  // before paint — and write style coordinates in that space. Without this a
  // dropdown opened inside an animating modal renders offset by the modal's
  // position until the animation drops its transform.
  if (panel.style.top === '' || panel.style.left === '') {
    panel.style.top = '0px'
    panel.style.left = '0px'
  }
  const current = panel.getBoundingClientRect()
  const originX = current.left - (parseFloat(panel.style.left) || 0)
  const originY = current.top - (parseFloat(panel.style.top) || 0)
  // The panel is position:fixed, so it cannot inherit the trigger's width and
  // would otherwise render at its content width — a menu visibly narrower than
  // the control it dropped out of. Floor it at the trigger width (a CSS
  // min-width on the panel still wins when it asks for more). The floor never
  // exceeds the panel's own CSS max-width: min-width beats max-width in the
  // cascade, so an unclamped floor on a full-width (block) trigger stretches
  // the panel across the form row even where the stylesheet capped it.
  const computedMax = parseFloat(getComputedStyle(panel).maxWidth)
  const floor = Number.isFinite(computedMax) && computedMax > 0 ? Math.min(rect.width, computedMax) : rect.width
  panel.style.minWidth = floor + 'px'
  // Flip synchronously: the panel is already visible and measurable in this
  // commit, so deferring the flip to a later frame only parks it at the
  // unflipped spot for a frame and races any transform that moves the trigger
  // right after open.
  let top = rect.bottom + 4 - originY
  let left = rect.left - originX
  panel.style.top = `${top}px`
  panel.style.left = `${left}px`
  panel.style.right = 'auto'
  const pr = panel.getBoundingClientRect()
  if (pr.right > window.innerWidth - 8) {
    left = Math.max(8, rect.right - pr.width) - originX
    panel.style.left = `${left}px`
  }
  if (pr.bottom > window.innerHeight - 8) {
    top = Math.max(8, rect.top - pr.height - 4) - originY
    panel.style.top = `${top}px`
  }
}

// Keep an open panel glued to its trigger. The panel is position:fixed, so an
// ancestor transform that moves the trigger after open — a modal entrance
// animation, a layout shift — leaves the panel at its stale coordinates while
// the trigger sits elsewhere, and clicks aimed at panel rows land on whatever
// is underneath. Re-position every frame while open; writes happen only when
// the trigger actually moved or the panel drifted, so an idle open menu costs
// one rect read per frame.
function trackPanel(trigger: HTMLElement, panel: HTMLElement): () => void {
  let last: { x: number; y: number; w: number; h: number; top: string; left: string } | null = null
  let frame = 0
  const tick = () => {
    const rect = trigger.getBoundingClientRect()
    if (!last || last.x !== rect.left || last.y !== rect.top || last.w !== rect.width || last.h !== rect.height
      || panel.style.top !== last.top || panel.style.left !== last.left) {
      positionPanel(trigger, panel)
      last = { x: rect.left, y: rect.top, w: rect.width, h: rect.height, top: panel.style.top, left: panel.style.left }
    }
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
  return () => cancelAnimationFrame(frame)
}

// Track every bound instance so outside-click / Escape / scroll close them
// all at once. Weakly held via the DOM node; detach on element removal.
const instances = new Set<SelectApi>()

document.addEventListener('click', (e) => {
  for (const inst of instances) {
    if (inst.el.classList.contains('open') && !inst.el.contains(e.target as Node)) inst.close()
  }
})
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  for (const inst of instances) if (inst.el.classList.contains('open')) inst.close()
})
// Close on scroll — a fixed-position panel would otherwise detach from its
// trigger when the page scrolls underneath it.
window.addEventListener('scroll', (e) => {
  const target = e.target
  for (const inst of instances) {
    if (!inst.el.classList.contains('open')) continue
    if (target instanceof Node && inst.el.contains(target)) continue
    inst.close()
  }
}, true)
// Re-translate items whose content came from an i18nKey (fired by i18n.js
// on setLanguage — the static [data-i18n] DOM walk can't reach items we
// rendered via innerHTML).
window.addEventListener('klaus:lang-change', () => {
  for (const inst of instances) inst.refresh()
})

function renderItems(
  panel: HTMLElement,
  items: SelectItem[],
  selectedValue: string,
  labelOf: (it: SelectItem) => string,
  tooltipOf: ((it: SelectItem) => string) | null,
  descriptionOf: ((it: SelectItem) => string) | null,
  hideSelected = false,
) {
  const visibleItems = hideSelected && items.length > 1
    ? items.filter(it => String(it.value) !== String(selectedValue))
    : items
  panel.innerHTML = visibleItems.map(it => {
    const sel = String(it.value) === String(selectedValue) ? ' is-selected' : ''
    const label = escapeHtml(labelOf(it))
    // Panel rows intentionally carry no native title tooltip — hover bubbles
    // over dropdown options read as noise (product decision, applies to every
    // kls-select consumer).
    const desc = descriptionOf ? descriptionOf(it) : ''
    const descHtml = desc ? `<span class="kls-select-item-desc">${escapeHtml(desc)}</span>` : ''
    // iconHtml is trusted (caller-supplied SVG markup, NOT user input). We
    // intentionally skip escapeHtml so the SVG renders. Don't pass
    // user-controlled strings here.
    const iconHtml = it.iconHtml ? `<span class="kls-select-icon" aria-hidden="true">${it.iconHtml}</span>` : ''
    const off = it.disabled ? ' is-disabled' : ''
    return `<button type="button" class="kls-select-item${sel}${off}" data-value="${escapeAttr(it.value)}"${it.disabled ? ' aria-disabled="true"' : ''}>${iconHtml}<span class="kls-select-item-copy"><span class="kls-select-item-label">${label}</span>${descHtml}</span></button>`
  }).join('')
}

function escapeHtml(s: unknown) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}
function escapeAttr(s: unknown) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function bind(root: HTMLElement, opts: BindOptions = {}): SelectApi {
  if (!root) throw new Error('klsSelect.bind: root element is required')
  // Already bound: keep the scaffold and listeners, but the options passed in are
  // the caller's current view of the control, so they take effect. Discarding
  // them froze every React-hosted picker at whatever it was bound with on first
  // mount — the model-tier pickers bound while the custom model list was still
  // empty stayed empty and disabled after a model was added.
  const bound = (root as any).__klsSelect as SelectApi | undefined
  if (bound) {
    bound.applyOptions(opts)
    return bound
  }

  // The live options. Every later read goes through this binding, never through
  // the first `opts` snapshot, so a re-bind swaps behavior wholesale.
  let currentOpts = opts
  // Per-frame panel tracking while open; cancelled on close/destroy.
  let stopTracking: (() => void) | null = null

  let trigger = root.querySelector<HTMLElement>('.kls-select-trigger')
  let textEl = root.querySelector<HTMLElement>('.kls-select-text')
  let panel = root.querySelector<HTMLElement>('.kls-select-panel')

  // Auto-scaffold when only the wrapper was provided
  if (!trigger) {
    root.innerHTML = `
      <button type="button" class="kls-select-trigger">
        <span class="kls-select-text"></span>
        ${CARET_SVG}
      </button>
      <div class="kls-select-panel" hidden></div>`
    trigger = root.querySelector<HTMLElement>('.kls-select-trigger')
    textEl = root.querySelector<HTMLElement>('.kls-select-text')
    panel = root.querySelector<HTMLElement>('.kls-select-panel')
  } else if (!root.querySelector('.kls-select-caret')) {
    trigger.insertAdjacentHTML('beforeend', CARET_SVG)
  }

  // Internal item model: array of { value, label, i18nKey? }. i18nKey wins
  // over label — on language change we re-resolve tt(i18nKey). Initial items
  // can come from HTML (each item can carry data-i18n) or opts.items.
  let items: SelectItem[] | undefined = opts.items
  if (!items) {
    items = [...panel!.querySelectorAll<HTMLElement>('.kls-select-item')].map(b => ({
      value: b.dataset.value || '',
      label: b.textContent || '',
      i18nKey: b.dataset.i18n || undefined,
      tooltip: b.title || undefined,
      tooltipKey: b.dataset.i18nTooltip || undefined,
      description: b.dataset.description || undefined,
      descriptionKey: b.dataset.i18nDescription || undefined,
      iconHtml: undefined,  // HTML-sourced items have no icon by default
    }))
  }
  // Normalize: resolve i18nKey → label at bind time.
  const resolveLabel = (it: SelectItem) => (it.i18nKey && typeof (window as any).tt === 'function')
    ? (window as any).tt(it.i18nKey)
    : (it.label ?? String(it.value))
  const resolveTooltip = (it: SelectItem) => (it.tooltipKey && typeof (window as any).tt === 'function')
    ? (window as any).tt(it.tooltipKey)
    : (it.tooltip ?? '')
  const resolveDescription = (it: SelectItem) => (it.descriptionKey && typeof (window as any).tt === 'function')
    ? (window as any).tt(it.descriptionKey)
    : (it.description ?? '')
  let value = opts.value != null ? String(opts.value) : (items[0]?.value ?? '')
  const placeholder = () => currentOpts.placeholder ?? ''
  const hideSelected = () => currentOpts.hideSelected === true

  function open() {
    // One dropdown at a time: claiming closes every other registered overlay,
    // sibling ui-selects and the composer/sidebar popovers included.
    claimOverlay(overlayIdForElement(root, 'ui-select'))
    root.classList.add('open')
    trigger!.setAttribute('aria-expanded', 'true')
    panel!.hidden = false
    positionPanel(trigger!, panel!)
    stopTracking?.()
    stopTracking = trackPanel(trigger!, panel!)
  }
  function close() {
    root.classList.remove('open')
    trigger!.setAttribute('aria-expanded', 'false')
    panel!.hidden = true
    stopTracking?.()
    stopTracking = null
  }
  function destroy() {
    close()
    instances.delete(api)
    unregisterOverlay(overlayIdForElement(root, 'ui-select'))
    delete (root as any).__klsSelect
  }
  function refresh() {
    renderItems(panel!, items!, value, resolveLabel, resolveTooltip, resolveDescription, hideSelected())
    const match = items!.find(it => String(it.value) === String(value))
    textEl!.textContent = match ? resolveLabel(match) : placeholder()
    textEl!.classList.toggle('is-placeholder', !match && !!placeholder())
    // Mirror the selected item's icon onto the trigger so the closed pill
    // shows the same glyph as the panel row (matches the toolbar reference
    // where each mode pill renders its own icon next to the label).
    let triggerIcon = trigger!.querySelector<HTMLElement>('.kls-select-trigger-icon')
    if (match?.iconHtml) {
      if (!triggerIcon) {
        triggerIcon = document.createElement('span')
        triggerIcon.className = 'kls-select-trigger-icon'
        triggerIcon.setAttribute('aria-hidden', 'true')
        trigger!.insertBefore(triggerIcon, textEl!)
      }
      triggerIcon.innerHTML = match.iconHtml
    } else if (triggerIcon) {
      triggerIcon.remove()
    }
  }
  function setValue(v: unknown, { silent = true }: { silent?: boolean } = {}) {
    value = v == null ? '' : String(v)
    refresh()
    if (!silent) currentOpts.onChange?.(value)
  }
  function setItems(next: SelectItem[], { value: nextValue }: { value?: unknown } = {}) {
    items = Array.isArray(next)
      ? next.map(it => ({
          value: String(it.value), label: it.label, i18nKey: it.i18nKey,
          tooltip: it.tooltip, tooltipKey: it.tooltipKey,
          description: it.description, descriptionKey: it.descriptionKey,
          iconHtml: it.iconHtml, disabled: it.disabled === true,
        }))
      : []
    if (nextValue !== undefined) value = nextValue == null ? '' : String(nextValue)
    // If the current value no longer exists in the new list, reset to first.
    if (!items.some(it => it.value === value)) value = items[0]?.value ?? ''
    refresh()
  }

  function setDisabled(disabled: boolean) {
    root.classList.toggle('is-disabled', disabled)
    trigger!.setAttribute('aria-disabled', disabled ? 'true' : 'false')
  }

  // A re-bind describes the control in full: items, selection and disabled state
  // all follow the new options. Fields the caller left out keep what is rendered
  // (items can come from the HTML scaffold, and an omitted value means "keep the
  // current selection").
  function applyOptions(next: BindOptions) {
    currentOpts = next
    if (next.items) setItems(next.items, next.value !== undefined ? { value: next.value } : {})
    else if (next.value !== undefined) setValue(next.value)
    else refresh()
    setDisabled(next.disabled === true)
  }

  trigger!.setAttribute('aria-haspopup', 'listbox')
  trigger!.setAttribute('aria-expanded', 'false')
  panel!.setAttribute('role', 'listbox')
  setDisabled(opts.disabled === true)

  trigger!.addEventListener('click', (e) => {
    e.stopPropagation()
    if (root.classList.contains('is-disabled')) return
    root.classList.contains('open') ? close() : open()
  })
  panel!.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.kls-select-item')
    if (!item) return
    // A disabled row is informational — the reason it cannot be picked is the
    // description under its label (composer rows have no hover tooltips).
    if (item.classList.contains('is-disabled')) return
    const next = item.dataset.value || ''
    if (next === value) { close(); return }
    value = next
    refresh()
    close()
    currentOpts.onChange?.(value)
  })

  const api: SelectApi = {
    el: root,
    setValue,
    getValue: () => value,
    setItems,
    refresh,
    open,
    close,
    destroy,
    applyOptions,
  }
  ;(root as any).__klsSelect = api
  instances.add(api)
  registerOverlay(overlayIdForElement(root, 'ui-select'), close)

  // Mirror <select>.value so helpers like gv(id)=el.value keep working
  // without every caller having to know about the new API.
  Object.defineProperty(root, 'value', {
    configurable: true,
    get: () => value,
    set: (v) => setValue(v),
  })

  refresh()
  return api
}

;(window as any).klsSelect = { bind }
