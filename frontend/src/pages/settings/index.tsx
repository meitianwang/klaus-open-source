// Settings tab 绞杀入口：全部 tab 的 React 挂载器，经 window 供 loadSettingsTab 分发。
// 视图壳（open/close/nav）住 ./shell，市场数据表住 ./market-tables，
// 渲染器产品契约住 ./contracts——js/settings.js 已整体退役。
import './contracts'
import './market-tables'
import './shell'
import { mountSettingsSidebar } from './settings-nav'
import { mountSettingsTab } from './kv'
import { DreamSettingsTab, EngineWebTab } from './engine-tabs'
import { SystemAuthTab } from './misc-tabs'
import { AboutTab } from './about-tab'
import { PermissionRulesTab, PreferencesTab } from './prefs-tabs'
import { ArchivedSessionsTab } from './archived-tab'
import { StorageTab } from './storage-tab'
import { WorktreesTab } from './worktrees-tab'
import { HooksSettingsTab } from './hooks-tab'
import { MobileBridgeSettingsTab } from './capability-tabs'
import { VoiceInputSettingsTab } from './voice-tab'
import { KeyboardShortcutsTab } from './keyboard-shortcuts-tab'
import { ComputerUseSettingsTab } from './computer-use-tab'
import { BrowserSettingsTab } from './browser-tab'
import { applyAvatar, bootstrapProfile } from './profile-tab'
import { ProfilePage } from '../profile/ProfilePage'
import { FriendsSettingsTab } from './friends-tab'
import { PetsSettingsTab } from './pets-tab'
import { ModelsTab, setModelSettingsCategory } from './models-tab'
import { ModelTiersSettingsTab } from './model-tiers-tab'
import { MultimodalSettingsTab } from './multimodal-tab'
import { MODEL_TIERS, loadGlobalModelTierMappings, normalizeAuthMode } from './model-shared'

Object.assign(window as any, {
  loadEngineWebTab: (container: HTMLElement) => mountSettingsTab(container, <EngineWebTab />),
  loadDreamSettingsTab: (container: HTMLElement) => mountSettingsTab(container, <DreamSettingsTab />),
  loadSystemAuthTab: (container: HTMLElement) => mountSettingsTab(container, <SystemAuthTab />),
  loadAboutTab: (container: HTMLElement) => mountSettingsTab(container, <AboutTab />),
  loadPreferencesTab: (container: HTMLElement) => mountSettingsTab(container, <PreferencesTab />),
  loadPermissionRulesTab: (container: HTMLElement) => mountSettingsTab(container, <PermissionRulesTab />),
  loadArchivedSessionsTab: (container: HTMLElement) => mountSettingsTab(container, <ArchivedSessionsTab />),
  loadStorageSettingsTab: (container: HTMLElement) => mountSettingsTab(container, <StorageTab />),
  loadWorktreesSettingsTab: (container: HTMLElement) => mountSettingsTab(container, <WorktreesTab />),
  loadHooksSettingsTab: (container: HTMLElement) => mountSettingsTab(container, <HooksSettingsTab />),
  loadMobileBridgeSettingsTab: (container: HTMLElement) => mountSettingsTab(container, <MobileBridgeSettingsTab />),
  loadVoiceInputSettingsTab: (container: HTMLElement) => mountSettingsTab(container, <VoiceInputSettingsTab />),
  loadKeyboardShortcutsTab: (container: HTMLElement) => mountSettingsTab(container, <KeyboardShortcutsTab />),
  loadComputerUseSettingsTab: (container: HTMLElement) => mountSettingsTab(container, <ComputerUseSettingsTab />),
  loadBrowserSettingsTab: (container: HTMLElement) => mountSettingsTab(container, <BrowserSettingsTab />),
  loadProfileTab: (container: HTMLElement) => mountSettingsTab(container, <ProfilePage embedded />),
  loadFriendsSettingsTab: (container: HTMLElement) => mountSettingsTab(container, <FriendsSettingsTab />),
  loadPetsSettingsTab: (container: HTMLElement) => mountSettingsTab(container, <PetsSettingsTab />),
  loadModelsTab: (container: HTMLElement) => mountSettingsTab(container, <ModelsTab />),
  loadModelTiersSettingsTab: (container: HTMLElement) => mountSettingsTab(container, <ModelTiersSettingsTab />),
  loadMultimodalSettingsTab: (container: HTMLElement) => mountSettingsTab(container, <MultimodalSettingsTab />),
  // 侧栏资料同步（chat.js 云端回写后调）与聊天页模型菜单的落点预设。
  bootstrapProfile,
  // 向后兼容旧名字
  bootstrapAvatar: bootstrapProfile,
  applyAvatar,
  setModelSettingsCategory,
  // agents 页模型菜单经 window 垫片消费的模型层级基座。
  MODEL_TIERS,
  loadGlobalModelTierMappings,
  normalizeAuthMode,
})

// 侧栏骨架（返回键 + tab 导航 + 字形）首挂。
mountSettingsSidebar()
