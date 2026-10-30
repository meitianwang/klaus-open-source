// The Klaus command registry: every user action a keyboard shortcut can drive.
//
// Shared by the host (os-global registration + native-menu accelerators) and the
// renderer (settings page, read-only dialog, in-window dispatch). Keeping the
// DATA here and the HANDLER WIRING in the renderer splits the two on purpose:
// this table stays inert data and a separate fallback map holds the behaviour.
//
// Field shape follows contracts/keybindings.ts (`KeybindingCommand`). Groups are
// ordered `thread, navigation, panels, workspace, skills, configure, app`, then
// general. Default key bindings stick to the accelerators users already expect
// from a desktop agent client where the action has an equivalent, so the muscle
// memory carries over; Klaus-only actions get bindings that do not collide.
//
// i18n keys are listed here as strings and resolved in the renderer's message
// dictionary (frontend/src/i18n/messages.ts).

import type { KeybindingCommand } from './keybindings';

/** Commands that live only in the main process (Electron globalShortcut). They
 *  fire from any application, not just when Klaus is focused. */
export const HOST_COMMAND_IDS = ['summonMainWindow', 'openQuickInput', 'toggleDesktopPet', 'toggleVoiceChat'] as const;

/** Native Find-next/previous keys remain reserved for the active content surface.
 * Opening content Find is a normal command with a configurable shortcut. */
export const FIND_COMMAND_ID: string | null = null;

export const KLAUS_COMMANDS: KeybindingCommand[] = [
  ...[
    ['findInThread', 'find_in_content', 'navigation', 'CmdOrCtrl+F'],
    ['closeContentFind', 'close_content_find', 'navigation', undefined],
    ['newProject', 'new_project', 'thread', undefined],
    ['navigateBack', 'navigate_back', 'navigation', 'CmdOrCtrl+['],
    ['navigateForward', 'navigate_forward', 'navigation', 'CmdOrCtrl+]'],
    ['previousTab', 'previous_tab', 'workspace', 'Ctrl+Shift+Tab'],
    ['nextTab', 'next_tab', 'workspace', 'Ctrl+Tab'],
    ['newBrowserTab', 'new_browser_tab', 'panels', 'CmdOrCtrl+T'],
    ['focusBrowserAddressBar', 'focus_browser_address', 'panels', 'CmdOrCtrl+L'],
    ['reloadBrowserPage', 'reload_browser_page', 'panels', undefined],
  ].map(([id, key, group, binding]): KeybindingCommand => ({
    id: id!, titleI18n: `kb_cmd_${key}`, descriptionI18n: `kb_cmd_${key}_desc`,
    kind: 'renderer', group: group as KeybindingCommand['group'],
    ...(binding ? { defaultKeybindings: [{ key: binding }] } : {}),
  })),
  // ---------------------------------------------------------------- thread ---
  {
    id: 'newChat',
    titleI18n: 'kb_cmd_new_chat',
    descriptionI18n: 'kb_cmd_new_chat_desc',
    kind: 'renderer',
    group: 'thread',
    defaultKeybindings: [{ key: 'CmdOrCtrl+N' }],
    menuTitleI18n: 'kb_menu_new_chat',
  },
  {
    id: 'openFolder',
    titleI18n: 'kb_cmd_open_folder',
    descriptionI18n: 'kb_cmd_open_folder_desc',
    kind: 'renderer',
    group: 'thread',
    defaultKeybindings: [{ key: 'CmdOrCtrl+O' }],
  },
  {
    id: 'renameThread',
    titleI18n: 'kb_cmd_rename_thread',
    descriptionI18n: 'kb_cmd_rename_thread_desc',
    kind: 'renderer',
    group: 'thread',
    defaultKeybindings: [{ key: 'CmdOrCtrl+Alt+R' }],
  },
  {
    id: 'archiveThread',
    titleI18n: 'kb_cmd_archive_thread',
    descriptionI18n: 'kb_cmd_archive_thread_desc',
    kind: 'renderer',
    group: 'thread',
    defaultKeybindings: [{ key: 'CmdOrCtrl+Shift+A' }],
  },
  {
    id: 'toggleThreadPin',
    titleI18n: 'kb_cmd_toggle_thread_pin',
    descriptionI18n: 'kb_cmd_toggle_thread_pin_desc',
    kind: 'renderer',
    group: 'thread',
    defaultKeybindings: [{ key: 'CmdOrCtrl+Alt+P' }],
  },
  {
    id: 'forkThread',
    titleI18n: 'kb_cmd_fork_thread',
    descriptionI18n: 'kb_cmd_fork_thread_desc',
    kind: 'renderer',
    group: 'thread',
  },

  // ------------------------------------------------------------ navigation ---
  {
    id: 'previousThread',
    titleI18n: 'kb_cmd_previous_thread',
    descriptionI18n: 'kb_cmd_previous_thread_desc',
    kind: 'renderer',
    group: 'navigation',
    platformDefaultKeybindings: {
      macOS: [{ key: 'Command+Shift+[' }, { key: 'Command+Alt+Left' }],
      default: [{ key: 'Ctrl+Shift+[' }, { key: 'Ctrl+PageUp' }],
    },
  },
  {
    id: 'nextThread',
    titleI18n: 'kb_cmd_next_thread',
    descriptionI18n: 'kb_cmd_next_thread_desc',
    kind: 'renderer',
    group: 'navigation',
    platformDefaultKeybindings: {
      macOS: [{ key: 'Command+Shift+]' }, { key: 'Command+Alt+Right' }],
      default: [{ key: 'Ctrl+Shift+]' }, { key: 'Ctrl+PageDown' }],
    },
  },
  {
    // `nextThreadNeedingAttention`: jump to the first waiting/unread chat.
    id: 'nextThreadNeedingAttention',
    titleI18n: 'kb_cmd_next_needing_attention',
    descriptionI18n: 'kb_cmd_next_needing_attention_desc',
    kind: 'renderer',
    group: 'navigation',
  },
  {
    id: 'openCommandMenu',
    titleI18n: 'kb_cmd_open_command_menu',
    descriptionI18n: 'kb_cmd_open_command_menu_desc',
    kind: 'renderer',
    group: 'navigation',
    // Chat and command search has a separate shortcut from current-content Find.
    defaultKeybindings: [{ key: 'CmdOrCtrl+K' }],
  },
  {
    id: 'searchFiles',
    titleI18n: 'kb_cmd_search_files',
    descriptionI18n: 'kb_cmd_search_files_desc',
    kind: 'renderer',
    group: 'navigation',
    defaultKeybindings: [{ key: 'CmdOrCtrl+P' }],
  },
  ...Array.from({ length: 9 }, (_, index): KeybindingCommand => ({
    id: `thread${index + 1}`,
    titleI18n: `kb_cmd_thread_${index + 1}`,
    descriptionI18n: 'kb_cmd_thread_desc',
    kind: 'renderer',
    group: 'navigation',
    defaultKeybindings: [{ key: `CmdOrCtrl+${index + 1}` }],
  })),

  // ---------------------------------------------------------------- panels ---
  {
    id: 'toggleSidebar',
    titleI18n: 'kb_cmd_toggle_sidebar',
    descriptionI18n: 'kb_cmd_toggle_sidebar_desc',
    kind: 'renderer',
    group: 'panels',
    defaultKeybindings: [{ key: 'CmdOrCtrl+B' }],
  },
  {
    id: 'toggleWorkPanel',
    titleI18n: 'kb_cmd_toggle_work_panel',
    descriptionI18n: 'kb_cmd_toggle_work_panel_desc',
    kind: 'renderer',
    group: 'panels',
    defaultKeybindings: [{ key: 'CmdOrCtrl+J' }],
  },
  {
    id: 'toggleTerminal',
    titleI18n: 'kb_cmd_toggle_terminal',
    descriptionI18n: 'kb_cmd_toggle_terminal_desc',
    kind: 'renderer',
    group: 'panels',
    capability: 'terminal',
    defaultKeybindings: [{ key: 'Control+`' }],
  },
  {
    id: 'toggleFilesPanel',
    titleI18n: 'kb_cmd_toggle_files_panel',
    descriptionI18n: 'kb_cmd_toggle_files_panel_desc',
    kind: 'renderer',
    group: 'panels',
    defaultKeybindings: [{ key: 'CmdOrCtrl+Shift+E' }],
  },
  {
    id: 'toggleChangesPanel',
    titleI18n: 'kb_cmd_toggle_changes_panel',
    descriptionI18n: 'kb_cmd_toggle_changes_panel_desc',
    kind: 'renderer',
    group: 'panels',
  },
  {
    id: 'toggleOverviewPanel',
    titleI18n: 'kb_cmd_toggle_overview_panel',
    descriptionI18n: 'kb_cmd_toggle_overview_panel_desc',
    kind: 'renderer',
    group: 'panels',
  },
  {
    id: 'toggleBrowserPanel',
    titleI18n: 'kb_cmd_toggle_browser_panel',
    descriptionI18n: 'kb_cmd_toggle_browser_panel_desc',
    kind: 'renderer',
    group: 'panels',
    capability: 'browser',
  },

  // ------------------------------------------------------------- workspace ---
  {
    id: 'workspaceSave',
    titleI18n: 'kb_cmd_workspace_save',
    descriptionI18n: 'kb_cmd_workspace_save_desc',
    kind: 'renderer',
    group: 'workspace',
    shortcutScope: 'app',
    defaultKeybindings: [{ key: 'CmdOrCtrl+S' }],
  },
  {
    id: 'workspaceCloseTab',
    titleI18n: 'kb_cmd_workspace_close_tab',
    descriptionI18n: 'kb_cmd_workspace_close_tab_desc',
    kind: 'renderer',
    group: 'workspace',
    shortcutScope: 'app',
    // No macOS default for `closeTab`: on macOS ⌘W belongs to
    // the application menu's window-close item, and a menu accelerator is
    // consumed by the main process BEFORE the renderer ever sees the keydown — so
    // a renderer binding there could never fire. Windows and Linux install no
    // application menu at all, so Ctrl+W is free for the renderer.
    platformDefaultKeybindings: { macOS: [], default: [{ key: 'Ctrl+W' }] },
  },
  {
    // The tab context menu has always DISPLAYED ⌥⌘T for "close other tabs" but no
    // listener implemented it, so the hint was dead. Now that every key hint must
    // resolve to a registry command (otherwise the settings page could not show
    // or edit it), the hint becomes real.
    id: 'workspaceCloseOthers',
    titleI18n: 'kb_cmd_workspace_close_others',
    descriptionI18n: 'kb_cmd_workspace_close_others_desc',
    kind: 'renderer',
    group: 'workspace',
    shortcutScope: 'app',
    defaultKeybindings: [{ key: 'CmdOrCtrl+Alt+T' }],
  },
  {
    id: 'workspaceCloseAll',
    titleI18n: 'kb_cmd_workspace_close_all',
    descriptionI18n: 'kb_cmd_workspace_close_all_desc',
    kind: 'renderer',
    group: 'workspace',
    shortcutScope: 'app',
    // The work panel's pre-existing chord: ⌘K then a BARE W. Keeping the bare
    // second segment preserves the binding users already have and the "⌘K U"
    // label the panel's context menu shows.
    defaultKeybindings: [{ key: 'CmdOrCtrl+K W' }],
  },
  {
    id: 'workspaceCloseUnsaved',
    titleI18n: 'kb_cmd_workspace_close_unsaved',
    descriptionI18n: 'kb_cmd_workspace_close_unsaved_desc',
    kind: 'renderer',
    group: 'workspace',
    shortcutScope: 'app',
    defaultKeybindings: [{ key: 'CmdOrCtrl+K U' }],
  },
  {
    id: 'composerToggleVoice',
    titleI18n: 'kb_cmd_composer_toggle_voice',
    descriptionI18n: 'kb_cmd_composer_toggle_voice_desc',
    kind: 'renderer',
    shortcutScope: 'app',
    // Ungrouped: voice commands carry no commandMenuGroupKey, so they sort after
    // the groups and are listed under 通用/General in the read-only dialog. The
    // default stays Klaus's existing ⌘⇧V on both platforms rather than a
    // macOS-only Ctrl+Shift+V, because changing it would silently move a key
    // users already have.
    defaultKeybindings: [{ key: 'CmdOrCtrl+Shift+V' }],
  },
  {
    id: 'startVoiceChat', titleI18n: 'kb_cmd_start_voice_chat', descriptionI18n: 'kb_cmd_start_voice_chat_desc',
    kind: 'renderer', shortcutScope: 'app', capability: 'voice',
    platformDefaultKeybindings: { macOS: [{ key: 'Ctrl+Shift+V' }], default: [] },
  },
  {
    id: 'toggleVoiceChat', titleI18n: 'kb_cmd_toggle_voice_chat', descriptionI18n: 'kb_cmd_toggle_voice_chat_desc',
    kind: 'host-only', group: 'app', shortcutScope: 'os-global', capability: 'voice', defaultKeybindings: [],
  },

  // ---------------------------------------------------------------- skills ---
  {
    id: 'openSkills',
    titleI18n: 'kb_cmd_open_skills',
    descriptionI18n: 'kb_cmd_open_skills_desc',
    kind: 'renderer',
    group: 'skills',
  },
  {
    id: 'openSlashCommands',
    titleI18n: 'kb_cmd_open_slash_commands',
    descriptionI18n: 'kb_cmd_open_slash_commands_desc',
    kind: 'renderer',
    group: 'skills',
  },
  {
    id: 'openAgents',
    titleI18n: 'kb_cmd_open_agents',
    descriptionI18n: 'kb_cmd_open_agents_desc',
    kind: 'renderer',
    group: 'skills',
  },

  // ------------------------------------------------------------- configure ---
  {
    id: 'settings',
    titleI18n: 'kb_cmd_settings',
    descriptionI18n: 'kb_cmd_settings_desc',
    kind: 'renderer',
    group: 'configure',
    defaultKeybindings: [{ key: 'CmdOrCtrl+,' }],
  },
  {
    id: 'keyboardShortcuts',
    titleI18n: 'kb_cmd_keyboard_shortcuts',
    descriptionI18n: 'kb_cmd_keyboard_shortcuts_desc',
    kind: 'renderer',
    group: 'configure',
  },
  {
    id: 'openMcp',
    titleI18n: 'kb_cmd_open_mcp',
    descriptionI18n: 'kb_cmd_open_mcp_desc',
    kind: 'renderer',
    group: 'configure',
  },
  {
    id: 'openPlugins',
    titleI18n: 'kb_cmd_open_plugins',
    descriptionI18n: 'kb_cmd_open_plugins_desc',
    kind: 'renderer',
    group: 'configure',
  },
  {
    id: 'openChannels',
    titleI18n: 'kb_cmd_open_channels',
    descriptionI18n: 'kb_cmd_open_channels_desc',
    kind: 'renderer',
    group: 'configure',
  },
  {
    id: 'openCron',
    titleI18n: 'kb_cmd_open_cron',
    descriptionI18n: 'kb_cmd_open_cron_desc',
    kind: 'renderer',
    group: 'configure',
  },
  {
    id: 'openMemory',
    titleI18n: 'kb_cmd_open_memory',
    descriptionI18n: 'kb_cmd_open_memory_desc',
    kind: 'renderer',
    group: 'configure',
  },

  // ------------------------------------------------------------------- app ---
  {
    id: 'showKeyboardShortcuts',
    titleI18n: 'kb_cmd_show_keyboard_shortcuts',
    descriptionI18n: 'kb_cmd_show_keyboard_shortcuts_desc',
    kind: 'renderer',
    group: 'app',
    shortcutScope: 'app',
    defaultKeybindings: [{ key: 'CmdOrCtrl+/' }],
  },
  {
    id: 'logOut',
    titleI18n: 'kb_cmd_log_out',
    descriptionI18n: 'kb_cmd_log_out_desc',
    kind: 'renderer',
    group: 'app',
  },
  {
    // os-global: registered with Electron globalShortcut, fires from any app.
    id: 'summonMainWindow',
    titleI18n: 'kb_cmd_summon_main_window',
    descriptionI18n: 'kb_cmd_summon_main_window_desc',
    kind: 'host-only',
    group: 'app',
    shortcutScope: 'os-global',
    defaultKeybindings: [{ key: 'CmdOrCtrl+Shift+K' }],
  },
  {
    id: 'openQuickInput',
    titleI18n: 'kb_cmd_open_quick_input',
    descriptionI18n: 'kb_cmd_open_quick_input_desc',
    kind: 'host-only',
    group: 'app',
    shortcutScope: 'os-global',
    defaultKeybindings: [{ key: 'CmdOrCtrl+Shift+Space' }],
  },
  {
    id: 'toggleDesktopPet',
    titleI18n: 'kb_cmd_toggle_desktop_pet',
    descriptionI18n: 'kb_cmd_toggle_desktop_pet_desc',
    kind: 'host-only',
    group: 'app',
    shortcutScope: 'os-global',
    platformDefaultKeybindings: { macOS: [{ key: 'Alt+Space' }], default: [{ key: 'Super+Alt+P' }] },
  },
];
