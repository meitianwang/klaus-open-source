// Agents 页岛入口：page-view 注册 + buildAgentModelItems 的 window 桥
//（settings.js 的模型层级映射面仍消费它）。
import { registerPageIsland } from '../../app/island'
import { AgentsPage } from './AgentsPage'
import { buildAgentModelItems } from './model-items'

;(window as any).buildAgentModelItems = buildAgentModelItems

registerPageIsland({
  name: 'agents',
  viewId: 'agents-view',
  containerId: 'agents-view-content',
  node: () => <AgentsPage />,
  // 旧版 onHide 关编辑器弹窗；弹窗 state 在岛内，用事件把隐藏信号递进去。
  onHide: () => window.dispatchEvent(new CustomEvent('klaus:agents-page-hide')),
})
