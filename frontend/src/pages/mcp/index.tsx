// MCP 页岛入口：page-view 注册 + 跨文件协议桥。
// - window.reloadMcpView：chat.js（项目级 MCP 弹窗提交后）消费的全量刷新入口，
//   必须在 registerPageIsland 之后覆盖——注册器会把 reload<Name>View 指到
//   root.render（仅重渲染，不重拉数据/不重探）。
// - window.mcpServersView / window.mcpSearch：settings.js 浏览器设置的跳转
//   协议仍写这两个全局（'builtin' 归一为市场档），页面 onShow 时读取同步。
// - mcp:status:updated：后台真探测跑完 → 页面正开着就读新缓存刷新
//   （stale-while-revalidate 的 revalidate 落地）。
import { registerPageIsland } from '../../app/island'
import { McpPage } from './McpPage'
import { MCP_PAGE_RELOAD_EVENT, reloadMcpView } from './data'

registerPageIsland({
  name: 'mcp',
  viewId: 'mcp-view',
  containerId: 'mcp-view-content',
  node: () => <McpPage />,
  // 页面进入都要重探（工具数、连接态会变），并同步跳转协议写下的档位/搜索词。
  onShow: () => {
    window.dispatchEvent(new CustomEvent(MCP_PAGE_RELOAD_EVENT, { detail: { refreshStatus: true, syncGlobals: true } }))
  },
})

;(window as any).reloadMcpView = reloadMcpView
if ((window as any).mcpServersView === undefined) (window as any).mcpServersView = 'market'
if ((window as any).mcpSearch === undefined) (window as any).mcpSearch = ''

;(window as any).klaus?.on?.mcpStatusUpdated?.(() => {
  reloadMcpView(80)
})
