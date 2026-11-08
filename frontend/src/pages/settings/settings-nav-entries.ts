// Settings 侧栏的条目表与平台裁剪。纯数据 + 纯函数，不碰 DOM 也不碰
// window.klaus，所以能被单测直接 import；渲染在 settings-nav.tsx。
export interface NavEntry {
  kind: 'group' | 'tab'
  i18n: string
  stab?: string
  id?: string
  icon?: string
  searchKeys?: string[]
  // 只有 macOS 才存在的能力面。逐 App 的隐私授权是 macOS TCC 独有的：
  // Windows / Linux 上读界面、点击、截屏、读本地文件都没有可以事先授予的
  // 对象，所以这类项在那些平台整条不出现，而不是让用户点进去看一句「不支持」。
  macOnly?: true
}

export const NAV_ENTRIES: NavEntry[] = [
  { kind: 'group', i18n: 'settings_group_account' },
  { kind: 'tab', stab: 'profile', i18n: 'profile', icon: 'settings-nav-profile' },
  // Friend task reception is account-level configuration that lives beside the
  // account itself, not inside the friends page or the profile card.
  { kind: 'tab', stab: 'friends', i18n: 'friends', icon: 'settings-nav-friends' },
  { kind: 'group', i18n: 'settings_group_general' },
  { kind: 'tab', stab: 'preferences', i18n: 'preferences', icon: 'settings-nav-preferences' },
  { kind: 'tab', stab: 'keyboard', i18n: 'keyboard_shortcuts_settings', icon: 'settings-nav-keyboard' },
  { kind: 'tab', stab: 'voiceInput', i18n: 'voice_settings', icon: 'settings-nav-voice-input' },
  { kind: 'tab', stab: 'storage', i18n: 'storage_settings', icon: 'settings-nav-storage' },
  { kind: 'tab', stab: 'worktrees', i18n: 'worktrees_settings', icon: 'settings-nav-worktrees' },
  { kind: 'tab', stab: 'pets', i18n: 'pets_settings', icon: 'settings-nav-pets' },
  { kind: 'tab', stab: 'externalImport', i18n: 'external_import_settings', icon: 'settings-nav-external-import' },
  { kind: 'tab', stab: 'archivedSessions', i18n: 'archived_sessions', icon: 'settings-nav-archived-sessions' },
  { kind: 'group', i18n: 'settings_group_engine' },
  { kind: 'tab', stab: 'models', i18n: 'providers_settings', icon: 'settings-nav-models', searchKeys: ['models', 'model_sources_tab', 'model_defaults_tab', 'voice_engine_label'] },
  { kind: 'tab', stab: 'modelTiers', i18n: 'model_mapping_title', icon: 'settings-nav-model-tiers', searchKeys: ['advisor_settings'] },
  { kind: 'tab', stab: 'multimodal', i18n: 'multimodal_models_settings', icon: 'settings-nav-multimodal', searchKeys: ['image_tier_title', 'audio_gen_settings', 'music_gen_settings', 'video_gen_settings'] },
  { kind: 'tab', stab: 'engineWeb', i18n: 'settings_engine_web', icon: 'settings-nav-engine-web' },
  { kind: 'tab', stab: 'permissions', i18n: 'perm_rules_tab', icon: 'settings-nav-permissions' },
  { kind: 'tab', stab: 'hooks', i18n: 'hooks_settings', icon: 'settings-nav-hooks' },
  { kind: 'tab', stab: 'engineMemory', i18n: 'settings_engine_memory', icon: 'settings-nav-engine-memory' },
  { kind: 'group', i18n: 'settings_group_integrations' },
  { kind: 'tab', stab: 'browser', i18n: 'browser_use_title', icon: 'browser', searchKeys: ['browser_settings', 'browser_use_desc'] },
  // The connector switch remains on the connectors page.
  { kind: 'tab', stab: 'computerUse', i18n: 'computer_use_title', icon: 'computer-use-pip' },
  { kind: 'tab', stab: 'computerHistory', i18n: 'computer_history_title', icon: 'computer-use-pip', macOnly: true },
  { kind: 'tab', stab: 'mobile', i18n: 'mobile_bridge_settings', icon: 'settings-nav-mobile' },
  { kind: 'group', i18n: 'settings_group_system' },
  { kind: 'tab', stab: 'systemAuth', id: 'nav-system-auth', i18n: 'system_auth', icon: 'settings-nav-system-auth', macOnly: true },
  // About is every platform's home for version + the changelog link + manual
  // update control; the macOS-only About menu row is not, so this entry
  // carries no platform gate.
  { kind: 'tab', stab: 'about', i18n: 'about_settings', icon: 'settings-nav-about' },
]

// 平台不匹配的 tab 移除后，分组标题可能一个 tab 都不剩——它只是一行文字，
// 留下就是悬空的标题。表里分组之间从不相邻，所以「下一条不是 tab」等价于
// 「本组已空」。
export function visibleNavEntries(isMac: boolean, entries: NavEntry[] = NAV_ENTRIES): NavEntry[] {
  const kept = entries.filter(entry => entry.kind !== 'tab' || !entry.macOnly || isMac)
  return kept.filter((entry, index) => entry.kind !== 'group' || kept[index + 1]?.kind === 'tab')
}

// Search localized tab and group names, retaining only groups with matching tabs.
export function filterNavEntries(entries: NavEntry[], query: string, label: (key: string) => string): NavEntry[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/u).filter(Boolean)
  if (!words.length) return entries
  let groupLabel = ''
  const kept = entries.filter(entry => {
    if (entry.kind === 'group') {
      groupLabel = label(entry.i18n)
      return true
    }
    const text = `${groupLabel} ${label(entry.i18n)} ${(entry.searchKeys || []).map(label).join(' ')}`.toLocaleLowerCase()
    return words.every(word => text.includes(word))
  })
  return kept.filter((entry, index) => entry.kind !== 'group' || kept[index + 1]?.kind === 'tab')
}
