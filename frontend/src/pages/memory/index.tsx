// Memory 页岛入口：page-view 注册 + dream:event 模块级订阅。
// 注册器生成 window.showMemoryView / hideMemoryView / toggleMemoryView
// （chat.js 导航与互斥关闭路径消费，与旧版手写导出同名同语义）。
// dream:event 订阅住模块级：页面未打开时也要驱动侧栏「梦中」红点。
import { registerPageIsland } from '../../app/island'
import { MemoryPage, MEMORY_PAGE_VISIBLE_EVENT } from './MemoryPage'
import { MEMORY_DREAM_EVENT, setCurrentDream, updateSidebarDot } from './data'
import type { DreamRun } from './data'

const w = window as any

if (w.klaus?.dream && w.klaus?.memory) {
  registerPageIsland({
    name: 'memory',
    viewId: 'memory-view',
    containerId: 'memory-view-content',
    node: () => <MemoryPage />,
    onShow: () => {
      // 从设置视图切过来时摘掉它的可见态（旧版同款手动摘 class 路径）。
      document.getElementById('settings-view')?.classList.remove('active')
      document.body.classList.remove('settings-open')
      document.querySelector('.main-content')?.classList.remove('settings-open')
      window.dispatchEvent(new CustomEvent(MEMORY_PAGE_VISIBLE_EVENT, { detail: { visible: true } }))
    },
    onHide: () => {
      // 组件侧停掉 synapse 脉冲循环（隐藏时不烧 CPU）。
      window.dispatchEvent(new CustomEvent(MEMORY_PAGE_VISIBLE_EVENT, { detail: { visible: false } }))
    },
  })

  // Live dream:event → 模块级快照 + 侧栏点；页面开着时经事件驱动卡片/历史刷新。
  w.klaus?.on?.dreamEvent?.((snap: DreamRun | null) => {
    if (!snap) return
    setCurrentDream(snap)
    updateSidebarDot(snap.status === 'running')
    window.dispatchEvent(new CustomEvent(MEMORY_DREAM_EVENT, { detail: snap }))
  })
} else {
  console.warn('[memory-view] dream/memory IPC not exposed')
}
