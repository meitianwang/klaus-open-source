// Klaus Desktop — page-view registry（迁自 js/page-view.js，逻辑原样）。
// One convention for every full-screen sidebar view (Scheduled Tasks, Slash
// Commands, MCP, Skills, Plugins, Agents, Channels…): register() generates
// the show/hide/toggle handlers, the window.show<Name>View compatibility
// exports that chat.js navigation calls, and a single shared lang-change
// re-render hook — replacing the per-page copy-pasted boilerplate that used
// to live at the bottom of settings.js and inside cron.js.
//
// Usage:
//   const page = window.klsPageViews.register({
//     name: 'slash-commands',        // kebab-case → showSlashCommandsView etc.
//     viewId: 'slash-commands-view', // overlay root that toggles .active
//     reload,                        // re-render; called on show + lang change
//                                    // ⚠ pass a direct function reference (or a
//                                    // closure over non-global fns). A top-level
//                                    // "function reloadXView" IS the window
//                                    // property this registry overwrites — an
//                                    // arrow wrapping that bare name would call
//                                    // itself recursively after registration.
//     onShow,                        // optional extra work before reload
//     onHide,                        // optional cleanup (close modals, flags)
//   })
//   page.show() / page.hide() / page.toggle() / page.isActive()
//
// klsPageViews.scrollViewToTop(viewId) — 切档/切作用域时调用，见函数注释。

export interface PageViewOptions {
  name: string
  viewId: string
  reload?: () => void
  onShow?: () => void
  onHide?: () => void
}

export interface PageView {
  name: string
  viewId: string
  show: () => void
  hide: () => void
  toggle: () => void
  isActive: () => boolean
  reload?: () => void
}

const pages = new Map<string, PageView>()

const pascal = (name: string) => String(name)
  .split('-')
  .filter(Boolean)
  .map(s => s[0].toUpperCase() + s.slice(1))
  .join('')

function register(opts: PageViewOptions): PageView {
  const { name, viewId, reload, onShow, onHide } = opts
  const viewEl = () => document.getElementById(viewId)
  const isActive = () => !!viewEl()?.classList.contains('active')

  const show = () => {
    viewEl()?.classList.add('active')
    onShow?.()
    reload?.()
  }
  const hide = () => {
    viewEl()?.classList.remove('active')
    onHide?.()
  }
  const toggle = () => (isActive() ? hide() : show())

  const page: PageView = { name, viewId, show, hide, toggle, isActive, reload }
  pages.set(name, page)

  // Compatibility exports — chat.js sidebar navigation and cross-page
  // callers keep using window.show<Name>View / hide / reload / toggle.
  const p = pascal(name)
  const w = window as any
  w['show' + p + 'View'] = show
  w['hide' + p + 'View'] = hide
  w['toggle' + p + 'View'] = toggle
  if (reload) w['reload' + p + 'View'] = reload
  return page
}

// 切档/切作用域会把整块内容换掉，而滚动容器是页面根（#skills-view 等），
// scrollTop 不随 innerHTML 重置：新档更短时容器在布局时把 scrollTop 夹回，
// 新档更长时用户被丢在新列表中段——两种都表现为 tab 下方内容突然蹿一段。
// 由各页在写完 innerHTML 的同一轮里调用，切换后始终从顶部开始，只出一帧。
function scrollViewToTop(viewId: string) {
  const el = document.getElementById(viewId)
  if (el) el.scrollTop = 0
}

// One shared listener: whichever registered page is visible re-renders on
// language switch (their content is innerHTML-built, so the applyI18n DOM
// walk can't reach it).
window.addEventListener('klaus:lang-change', () => {
  for (const page of pages.values()) {
    if (page.isActive()) page.reload?.()
  }
})

;(window as any).klsPageViews = { register, get: (name: string) => pages.get(name), scrollViewToTop }
