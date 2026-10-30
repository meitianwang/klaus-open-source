// Channels 页岛入口：共享 chrome（页头）+ page-view 注册。
// 模块求值时序与旧 js/pages/channels.js 一致（main.ts 同位 import）。
import { registerPageIsland } from '../../app/island'
import { ChannelsPage, bindChannelsSearchInput } from './ChannelsPage'

// 页头（moon · refresh · search · title · subtitle）走共享工厂，
// index.html 只有空壳 host；加载期执行，refresh/search 引用随后可解析。
;(window as any).klsPageHeader.mount('channels-header', {
  titleKey: 'channels',
  subtitleKey: 'channels_subtitle',
  topbar: {
    refresh: { id: 'channels-refresh', titleKey: 'channels_refresh' },
    search: { id: 'channels-search', placeholderKey: 'search_placeholder' },
  },
})
bindChannelsSearchInput()

registerPageIsland({
  name: 'channels',
  viewId: 'channels-view',
  containerId: 'channels-view-content',
  node: () => <ChannelsPage />,
})
