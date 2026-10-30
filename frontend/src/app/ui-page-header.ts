// Klaus Desktop — shared page-header factory (the sticky block every page opens with).
//
// One source for the four fixed parts of a page header: the moon glow, the
// action row, the title and the subtitle. Pages used to inline this markup —
// 21 copies, and the cold-start / error shells only carried the title pair, so
// first paint showed a bare heading and then jumped a whole row taller once the
// real header arrived. Declaring the header once per page kills that jump and
// makes a structural change a one-file change.
//
// This component also owns the header's vertical rhythm, so no page can drift:
// the action row is always present and height-pinned (.kls-topbar min-height),
// the title's line-height is pinned (.kls-title), and the top offset lives in
// .kls-page-header. Page content wrappers (.sk-section / .mcp-section /
// .cron-inner / …) must not add vertical padding of their own.
//
// Two entry points, because pages come in two shapes:
//   render(opts)         → returns the whole <div class="kls-page-header …">
//                          for pages that build their view as an HTML string.
//   mount(hostId, opts)  → prepends the four fixed parts into an existing
//                          .kls-page-header in index.html, leaving that host's
//                          own rows (tab bars, toolbars) untouched.
//
// i18n: prefers *Key options and emits data-i18n attributes, so statically
// hosted headers keep live language switching through applyI18n()'s DOM walk.
// Raw title/subtitleHtml stay for the dynamic cases (error text).
//
// opts:
//   titleKey | title            page title
//   subtitleKey | subtitleHtml  page subtitle (subtitleHtml is inserted as-is)
//   noteKey                     emphasised clause appended to the subtitle
//   topbar                      klsTopbar.render options (refresh · search · add)
//   topbarHtml                  raw action row for pages whose row is not that trio
//   bodyHtml                    extra rows after the subtitle (tabs, scope bars)
//（迁自 js/ui-page-header.js，逻辑原样。）
export {}

function t(key: string) { return (window as any).tt ? (window as any).tt(key) : key }
function escAttr(s: unknown) { return String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') }
function escHtml(s: unknown) { return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }

interface PageHeaderOptions {
  titleKey?: string
  title?: string
  subtitleKey?: string
  subtitleHtml?: string | null
  noteKey?: string
  topbar?: Record<string, unknown>
  topbarHtml?: string
  bodyHtml?: string
}

// The moon + action row + title + subtitle, in that order. Kept separate from
// render() so mount() can inject exactly the same thing into a static host.
//
// The action row is emitted unconditionally, even with nothing in it: the
// vertical rhythm must not depend on whether a page happens to have buttons,
// otherwise switching pages moves the moon and the title. Its height is
// pinned by .kls-topbar's min-height, and .kls-title's line-height is pinned
// so a CJK title does not sit lower than a Latin one.
function fixedParts(opts: PageHeaderOptions = {}) {
  const parts = ['<div class="memory-decor-moon" aria-hidden="true"></div>']

  const rowHtml = opts.topbarHtml || (opts.topbar ? (window as any).klsTopbar.render(opts.topbar) : '')
  parts.push(`<div class="kls-topbar">${rowHtml}</div>`)

  const titleAttr = opts.titleKey ? ` data-i18n="${escAttr(opts.titleKey)}"` : ''
  const titleText = opts.titleKey ? t(opts.titleKey) : (opts.title ?? '')
  parts.push(`<h1 class="kls-title"${titleAttr}>${escHtml(titleText)}</h1>`)

  if (opts.subtitleKey || opts.subtitleHtml != null) {
    const note = opts.noteKey
      ? ` <em data-i18n="${escAttr(opts.noteKey)}">${escHtml(t(opts.noteKey))}</em>`
      : ''
    const body = opts.subtitleKey
      ? `<span data-i18n="${escAttr(opts.subtitleKey)}">${escHtml(t(opts.subtitleKey))}</span>`
      : opts.subtitleHtml
    parts.push(`<p class="kls-subtitle">${body}${note}</p>`)
  }

  return parts.join('\n        ')
}

// kls-sticky-header is the behaviour-only primitive (sticky/top/z-index);
// kls-page-header is this header's skin. Split on purpose so a surface that
// only wants sticky behaviour does not inherit page-header visuals.
function render(opts: PageHeaderOptions = {}) {
  return `<div class="kls-page-header kls-sticky-header">
      ${fixedParts(opts)}
      ${opts.bodyHtml || ''}
    </div>`
}

// Static hosts keep their page-specific rows in index.html; only the fixed
// parts are injected, once, ahead of them. Idempotent: a second call on the
// same host is a no-op so a re-init cannot stack two moons and two titles.
function mount(hostId: string | HTMLElement, opts: PageHeaderOptions = {}) {
  const host = typeof hostId === 'string' ? document.getElementById(hostId) : hostId
  if (!host || host.dataset.pageHeader === 'ready') return host
  host.insertAdjacentHTML('afterbegin', fixedParts(opts))
  host.dataset.pageHeader = 'ready'
  return host
}

;(window as any).klsPageHeader = { render, mount }
