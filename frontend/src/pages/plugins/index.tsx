// Plugins 页岛入口：page-view 注册。
// 依赖的本地化表（KLAUS_GLYPH_LIBRARY / PLUGIN_* / localizePluginName…）
// 仍住 settings.js / skills.js，经 window 桥消费；随 settings 批次一并 TS 化。
import { registerPageIsland } from '../../app/island'
import { PluginsPage } from './PluginsPage'
import { initializePluginNavigation } from './plugin-navigation'
import { pluginStore } from './plugin-store'

initializePluginNavigation()

registerPageIsland({
  name: 'plugins',
  viewId: 'plugins-view',
  containerId: 'plugins-view-content',
  node: () => <PluginsPage />,
  onShow: () => { void pluginStore.check() },
})
