// Slash Commands 页岛入口：page-view 注册 + 跨文件消费的纯函数 window 桥
//（classifySlashCommand / slashCommandTypeLabel 被 ui-shared.js 的 composer
// 搜索面消费）。
import { registerPageIsland } from '../../app/island'
import { SLASH_COMMANDS_RELOAD_EVENT, SlashCommandsPage } from './SlashCommandsPage'
import { classifySlashCommand, slashCommandTypeLabel } from './helpers'

Object.assign(window as any, { classifySlashCommand, slashCommandTypeLabel })

registerPageIsland({
  name: 'slash-commands',
  viewId: 'slash-commands-view',
  containerId: 'slash-commands-view-content',
  node: () => <SlashCommandsPage />,
  onShow: () => {
    window.dispatchEvent(new CustomEvent(SLASH_COMMANDS_RELOAD_EVENT))
  },
})
