// Skills 页岛入口：page-view 注册 + 跨文件消费的本地化 helpers window 桥
//（plugins/agents/chat/ui-shared 消费）+ 数据空闲预热。
import { registerPageIsland } from '../../app/island'
import { SkillsPage } from './SkillsPage'
import { scheduleSkillsPrewarm } from './data'
import {
  getAgentIconName, getAgentIconToneVar,
  getMarketUiLang, getPluginBaseName, getPluginIconName, getSkillCategory,
  localizePluginBadge, localizePluginDescription, localizePluginName,
  localizeSkillDescription, localizeSkillName, normalizeMarketKey, renderLineIcon,
} from './localize'

Object.assign(window as any, {
  getAgentIconName,
  getAgentIconToneVar,
  getMarketUiLang,
  getPluginBaseName,
  getPluginIconName,
  getSkillCategory,
  localizePluginBadge,
  localizePluginDescription,
  localizePluginName,
  localizeSkillDescription,
  localizeSkillName,
  normalizeMarketKey,
  renderLineIcon,
})

registerPageIsland({
  name: 'skills',
  viewId: 'skills-view',
  containerId: 'skills-view-content',
  node: () => <SkillsPage />,
})

scheduleSkillsPrewarm()
