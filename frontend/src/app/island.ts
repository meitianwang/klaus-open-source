// React 页面岛：挂进 page-view 注册协议（Batch 3 绞杀式迁移的接缝）。
//
// 旧协议不变：window.klsPageViews.register 生成 show/hide/toggle 与
// window.show<Name>View 兼容导出，语言切换时对可见页调 reload。
// React 岛的 reload = root.render（幂等）；语言重渲染由 useT 订阅承担，
// 这里 reload 只负责首次挂载与「切回页面时兜底刷一次」。
import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'

interface PageIslandOptions {
  /** kebab-case 页名（沿 page-view 约定生成 window.showXxxView）。 */
  name: string
  /** 页面根元素 id（.active 切换的 overlay root）。 */
  viewId: string
  /** 岛内容挂载点 id（页面根内的容器元素）。 */
  containerId: string
  node: () => ReactNode
  onShow?: () => void
  onHide?: () => void
}

export function registerPageIsland(opts: PageIslandOptions): void {
  let root: Root | null = null
  const reload = () => {
    const host = document.getElementById(opts.containerId)
    if (!host) return
    if (!root) root = createRoot(host)
    root.render(opts.node())
  }
  ;(window as any).klsPageViews.register({
    name: opts.name,
    viewId: opts.viewId,
    reload,
    onShow: opts.onShow,
    onHide: opts.onHide,
  })
}
