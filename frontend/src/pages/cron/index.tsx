// Cron 页岛入口：page-view 注册。show/hide/toggle 与 window.showCronView 一族
// 兼容导出由注册器生成（chat.js 侧栏导航与运行行入会话路径消费 hideCronView）。
import { registerPageIsland } from '../../app/island'
import { CronPage } from './CronPage'
import { CRON_PAGE_RELOAD_EVENT, CRON_PAGE_VISIBLE_EVENT } from './data'

registerPageIsland({
  name: 'cron',
  viewId: 'cron-view',
  containerId: 'cron-view-content',
  node: () => <CronPage />,
  onShow: () => {
    // 从设置视图直接切过来时关掉它：走 closeSettings() 正门，保证
    // settingsVisible 状态/可见性事件/浏览器面板恢复的完整语义。
    ;(window as any).closeSettings?.()
    window.dispatchEvent(new CustomEvent(CRON_PAGE_VISIBLE_EVENT, { detail: { visible: true } }))
    window.dispatchEvent(new CustomEvent(CRON_PAGE_RELOAD_EVENT))
  },
  onHide: () => {
    window.dispatchEvent(new CustomEvent(CRON_PAGE_VISIBLE_EVENT, { detail: { visible: false } }))
  },
})
