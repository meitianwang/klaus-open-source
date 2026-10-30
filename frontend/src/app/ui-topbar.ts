// Klaus Desktop — shared page-topbar factory (refresh · search · add).
// Every page that can create something (MCP / Skills / Slash Commands /
// Agents / Scheduled Tasks) renders its header from here, so ordering, icon
// language, button wording and dropdown behavior have exactly one source.
//
// The add control is always the same shape: one "Add" button (wording fixed by
// the shared `topbar_add` key — pages do not name their own) opening a menu of
// creation routes. Pages only declare which routes they offer.
//
// i18n: emits translated text at render time AND data-i18n* attributes, so
// statically-hosted pages (cron) keep live language switching through
// applyI18n()'s DOM walk; settings-hosted pages re-render on lang change.
//
// Usage:
//   html: window.klsTopbar.render({
//     refresh: { id, titleKey },
//     search:  { id, placeholderKey?, value? },
//     create:  { btnId, menuId, items: [{ action, labelKey, iconHtml }] },
//   })
//   wiring: window.klsTopbar.bindCreateMenu({ btnId, menuId, onAction })
//（迁自 js/ui-topbar.js，逻辑原样。）
import { icon } from '../icons/registry'

function t(key: string) { return (window as any).tt ? (window as any).tt(key) : key }
function escAttr(s: unknown) { return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') }
function escHtml(s: unknown) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

// Shared create-menu item icons (path-fill glyphs, same sources as the
// sidebar set). Kept here rather than per page so two pages offering the
// same creation route also show the same glyph:
//   form    = rounded card + field rows — fill in a form by hand
//   sparkle = the skills four-point star — let Klaus author it
//   code    = chevron pair — paste a raw config
//   upload  = tray with arrow out — bring in a local package
//   install = tray with arrow in — pull from a source/registry
//   record  = the record dot — demonstrate it live and record it
const icons = {
  form: icon('form'),
  sparkle: icon('sparkle'),
  code: icon('code'),
  upload: icon('upload'),
  install: icon('install'),
  record: icon('record'),
  // Scannable invite glyph — the friends page offers "my QR code" beside its
  // manual add route, and the filled code reads as one object at menu size.
  qr: icon('qr-code-fill'),
  // Person with a plus: invite one specific account, as the friends page does.
  'user-plus': icon('user-plus'),
  // Scan frame for the friends page's scan-to-add route.
  scan: icon('scan'),
}

export interface TopbarOptions {
  action?: { id: string; labelKey: string; disabled?: boolean };
  refresh?: { id: string; titleKey: string; disabled?: boolean }
  search?: { id: string; placeholderKey?: string; value?: string }
  create?: { btnId: string; menuId: string; disabled?: boolean; items?: Array<{ action: string; labelKey: string; iconHtml?: string }> }
}

// Returns the INNER markup of a .kls-topbar — callers keep their own
// wrapper div so static hosts and template hosts compose the same way.
function render(opts: TopbarOptions = {}) {
  const parts: string[] = []
  if (opts.refresh) {
    const { id, titleKey, disabled = false } = opts.refresh
    parts.push(`<button type="button" class="kls-icon-btn" id="${escAttr(id)}" data-i18n-title="${escAttr(titleKey)}" title="${escAttr(t(titleKey))}" aria-label="${escAttr(t(titleKey))}"${disabled ? ' disabled' : ''}>${icon('refresh')}</button>`)
  }
  if (opts.search) {
    const { id, placeholderKey = 'search_placeholder', value = '' } = opts.search
    parts.push(`<div class="kls-search">
      ${icon('search')}
      <input id="${escAttr(id)}" type="search" value="${escAttr(value)}" data-i18n-placeholder="${escAttr(placeholderKey)}" placeholder="${escAttr(t(placeholderKey))}" autocomplete="off">
    </div>`)
  }
  if (opts.action) {
    const { id, labelKey, disabled = false } = opts.action;
    parts.push(`<button type="button" class="kls-btn kls-btn-primary" id="${escAttr(id)}"${disabled ? ' disabled' : ''}>${icon('plus')}<span data-i18n="${escAttr(labelKey)}">${escHtml(t(labelKey))}</span></button>`);
  }
  if (opts.create) {
    // Label is deliberately not a per-page option: the button always reads
    // "Add", and the routes below it carry the page-specific wording.
    const { btnId, menuId, disabled = false, items = [] } = opts.create
    const itemsHtml = items.map(item => `
      <button type="button" class="kls-add-menu-item" role="menuitem" data-action="${escAttr(item.action)}">
        ${item.iconHtml || ''}
        <span data-i18n="${escAttr(item.labelKey)}">${escHtml(t(item.labelKey))}</span>
      </button>`).join('')
    parts.push(`<div class="kls-add-dropdown">
      <button type="button" class="kls-btn" id="${escAttr(btnId)}" aria-haspopup="menu" aria-expanded="false" aria-controls="${escAttr(menuId)}"${disabled ? ' disabled' : ''}>
        ${icon('plus')}<span data-i18n="topbar_add">${escHtml(t('topbar_add'))}</span>
        ${icon('topbar-add-caret')}
      </button>
      <div class="kls-add-menu" id="${escAttr(menuId)}" role="menu" aria-labelledby="${escAttr(btnId)}" hidden>${itemsHtml}</div>
    </div>`)
  }
  return parts.join('\n')
}

// Toggle + item dispatch. Outside-click closing lives in the single global
// listener below, NOT here — settings pages rebuild their headers on every
// load, so per-bind document listeners would pile up across reloads.
function bindCreateMenu({ btnId, menuId, onAction }: { btnId?: string; menuId?: string; onAction?: (action: string | undefined) => void } = {}) {
  const btn = btnId ? document.getElementById(btnId) as HTMLButtonElement | null : null
  const menu = menuId ? document.getElementById(menuId) as HTMLElement | null : null
  const items = () => Array.from(menu?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not([disabled])') ?? [])
  const setOpen = (open: boolean, focus: 'first' | 'last' | null = null) => {
    if (!menu || !btn) return
    menu.hidden = !open
    btn.setAttribute('aria-expanded', String(open))
    if (open && focus) {
      const available = items()
      ;(focus === 'last' ? available[available.length - 1] : available[0])?.focus()
    }
  }
  btn?.addEventListener('click', (e) => {
    e.stopPropagation()
    setOpen(menu?.hidden !== false)
  })
  btn?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true, e.key === 'ArrowUp' ? 'last' : 'first')
    } else if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
    }
  })
  menu?.addEventListener('click', (e) => {
    const item = (e.target as HTMLElement).closest<HTMLElement>('.kls-add-menu-item')
    if (!item) return
    setOpen(false)
    btn?.focus()
    onAction?.(item.dataset.action)
  })
  menu?.addEventListener('keydown', (e) => {
    const available = items()
    if (e.key === 'Escape') {
      e.preventDefault()
      setOpen(false)
      btn?.focus()
      return
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key) || !available.length) return
    e.preventDefault()
    const current = available.indexOf(document.activeElement as HTMLButtonElement)
    const next = e.key === 'Home' ? 0
      : e.key === 'End' ? available.length - 1
        : e.key === 'ArrowDown' ? (current + 1 + available.length) % available.length
          : (current - 1 + available.length) % available.length
    available[next]?.focus()
  })
}

// One global closer for every create menu on the page.
document.addEventListener('click', (e) => {
  document.querySelectorAll('.kls-add-menu:not([hidden])').forEach(menu => {
    const root = menu.closest('.kls-add-dropdown')
    if (!root || !root.contains(e.target as Node)) {
      (menu as HTMLElement).hidden = true
      root?.querySelector('[aria-haspopup="menu"]')?.setAttribute('aria-expanded', 'false')
    }
  })
})

;(window as any).klsTopbar = { render, bindCreateMenu, icons }
