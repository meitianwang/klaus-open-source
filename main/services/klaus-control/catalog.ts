import { DESKTOP_PET_CHANNELS } from '../../../contracts/desktop-pet';

// The fixed product action catalog. New channels need an exposed action or an explicit exclusion.
export interface ControlOperation { action: string; channel: string; args: string; confirm: boolean; currentSession: boolean }
export interface ControlSurface { key: string; about: string; reads: ControlOperation[]; writes: ControlOperation[]; manualHeading: string; panel?: string[]; elsewhere?: string }
export const CONTROL_SURFACES: ControlSurface[] = [
  {
    "key": "docs",
    "about": "The Klaus user manual: what each feature is, how it works internally, and the FAQ. Start here for any 'how does X work / why did X happen' question about the app itself.",
    "reads": [
      {
        "action": "outline",
        "channel": "@docs.outline",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "section",
        "channel": "@docs.section",
        "args": "{ name: string } — a heading from the outline (prefix/substring match)",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "search",
        "channel": "@docs.search",
        "args": "{ query: string }",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [],
    "manualHeading": "让 Klaus 操作 Klaus",
    "elsewhere": "nowhere in the window — there is no in-app manual reader. This surface IS the manual: the text is shipped as an app resource, and the same file is published on the web at `/klaus-manual.md`. Quote the section rather than sending the user looking for a help page."
  },
  {
    "key": "app",
    "about": "The application itself: build edition and public service address, version and runtime capabilities, launch-at-login (the switch is on Settings → Preferences), opening external http/https/mailto URLs, a screenshot of the Klaus window, and restarting. The version, the bundled changelog and manual update controls live on Settings → About.",
    "reads": [
      {
        "action": "distribution",
        "channel": "app:distribution",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "capabilities",
        "channel": "runtime:capabilities",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "extensions",
        "channel": "runtime:extensions",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "loginItem",
        "channel": "app:loginItem:get",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "openExternal",
        "channel": "app:openExternal",
        "args": "{ url: string } — http, https or mailto only",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "setLoginItem",
        "channel": "app:loginItem:set",
        "args": "{ enabled: boolean }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "screenshot",
        "channel": "feedback:capture-screenshot",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "restart",
        "channel": "system:restart-app",
        "args": "",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "应用与更新",
    "panel": [
      "settings",
      "preferences"
    ]
  },
  {
    "key": "quickInput",
    "about": "Two of the system-wide hotkeys and the Quick Input card: summon Klaus from inside another app, or hand it a task without leaving what you are doing. A third OS-global hotkey, Show or hide Mini (`toggleDesktopPet`; default Alt+Space on macOS, Super+Alt+P elsewhere), is not settable here: the user changes it in Settings → Mini & Pets or Settings → Keyboard shortcuts.",
    "reads": [
      {
        "action": "shortcuts",
        "channel": "@quickInput.shortcuts",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "card",
        "channel": "@quickInput.card",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "setShortcut",
        "channel": "@quickInput.setShortcut",
        "args": "{ which: 'main' | 'quickInput', accelerator: string } — a chord in Electron spelling (`CommandOrControl+Shift+K`, `Alt+Space`), or `off` to disable it, or `default` to go back to the built-in one. Read `shortcuts` first: this takes the chord away from every other app on the machine, so replacing the wrong one of the two leaves the user unable to reach what they were using",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "showCard",
        "channel": "@quickInput.showCard",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "hideCard",
        "channel": "@quickInput.hideCard",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "快速输入与全局热键",
    "elsewhere": "Settings → Keyboard shortcuts lists both chords in the editable shortcut list (`summonMainWindow`, `openQuickInput`), and the card itself floats over the desktop with no window chrome. Use `setShortcut` when the user asks you to change one; `nav.open` { view: 'settings', tab: 'keyboard' } shows them the editor instead."
  },
  {
    "key": "nav",
    "about": "Move the window to a page or a settings tab, so the user ends up looking at what was just discussed.",
    "reads": [
      {
        "action": "targets",
        "channel": "@nav.targets",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "open",
        "channel": "@nav.open",
        "args": "{ view: string, tab?: string } — view is one of the ids from nav.targets; tab only applies to view 'settings'",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "让 Klaus 操作 Klaus",
    "elsewhere": "nowhere of its own — this surface is the act of opening a panel, which by hand is the sidebar, the settings list and the panel tabs."
  },
  {
    "key": "updater",
    "about": "Automatic updates: current state, checking, installing. The app checks a few seconds after launch and then every 15 minutes, and downloads a found update on its own; a status pill in the title bar and a Restart to update button at the bottom of the sidebar then appear, and `install` restarts into it. Self-built and development builds report updates as unsupported.",
    "reads": [
      {
        "action": "status",
        "channel": "updater:status",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "check",
        "channel": "updater:check",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "install",
        "channel": "updater:install",
        "args": "",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "应用与更新",
    "panel": [
      "settings",
      "about"
    ]
  },
  {
    "key": "session",
    "about": "Conversations: listing, history, archiving, forking, export, per-conversation model, thinking level, Codex Fast mode and independent collaboration mode, and per-conversation working directories. The permission mode is also per conversation (a change becomes the default for new chats); this surface can only read it — the user changes it in the composer's permission dropdown.",
    "reads": [
      {
        "action": "list",
        "channel": "session:list",
        "args": "{ limit?: integer 1..50 } — same result as list_threads; all pinned tasks plus recent unpinned tasks",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "history",
        "channel": "session:history",
        "args": "{ sessionId: string, cursor?: string, turnLimit?: integer 1..10, includeOutputs?: boolean, maxOutputCharsPerItem?: integer 0..20000 } — same paginated result as read_thread; defaults to the latest turn",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "historyPage",
        "channel": "session:history-page",
        "args": "{ sessionId: string, cursor?: string, limit?: integer 1..100, itemsView?: 'full'|'summary'|'notLoaded', sortDirection?: 'asc'|'desc' } — one page of saved turns plus their turn shells",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "historyItems",
        "channel": "session:history-items",
        "args": "{ sessionId: string, turnId: string, cursor?: string, beforeItemId?: string, limit?: integer 1..100, sortDirection?: 'asc'|'desc' } — one page of one turn's messages",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "fileChanges",
        "channel": "session:file-changes",
        "args": "{ sessionId?: string }",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "listArchived",
        "channel": "session:list-archived",
        "args": "{ limit?: integer 1..50, cursor?: string, hostId?: string } — same result as list_archived_threads",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "workdir",
        "channel": "session:get-workdir",
        "args": "{ sessionId?: string }",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "resolvedWorkdir",
        "channel": "session:get-resolved-workdir",
        "args": "{ sessionId?: string }",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "mainModel",
        "channel": "session:get-main-model",
        "args": "{ sessionId?: string }",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "mainModelOptions",
        "channel": "session:get-main-model-options",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "customMainModelOptions",
        "channel": "session:get-custom-main-model-options",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "thinkingLevel",
        "channel": "session:get-thinking-level",
        "args": "{ sessionId?: string }",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "ultraMode",
        "channel": "session:get-ultra-mode",
        "args": "{ sessionId?: string } — Local proactive delegation mode, independent of reasoning",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "fastMode",
        "channel": "session:get-fast-mode",
        "args": "{ sessionId?: string } — Native Fast mode and selected-model availability",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "collaborationMode",
        "channel": "session:get-collaboration-mode",
        "args": "{ sessionId?: string } — authoritative Default or Plan mode, independent of the permission preset",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "permissionMode",
        "channel": "session:get-permission-mode",
        "args": "{ sessionId?: string } — returns `mode` ('default'|'auto'|'acceptEdits'|'bypassPermissions'|null), `preset` ('default'|'auto'|'bypassPermissions'|null), and the exact `policy`; null means no preset matches the configured policy; `effectiveMode` may also be 'read-only' during native sandbox preparation; without sessionId, reads the default new chats inherit",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "new",
        "channel": "session:new",
        "args": "{ workdir?: string, workspaceId?: string, projectRoot?: string }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "rename",
        "channel": "session:rename",
        "args": "{ sessionId: string, title: string }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "archive",
        "channel": "session:archive",
        "args": "{ sessionId: string, displayTitle?: string (the name the archived entry keeps; defaults to the title the sidebar shows) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "unarchive",
        "channel": "session:unarchive",
        "args": "{ sessionId: string }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "delete",
        "channel": "session:delete",
        "args": "{ sessionId: string, wipeWorkspace?: boolean (also delete that conversation's workspace folder) }",
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "export",
        "channel": "session:export",
        "args": "{ sessionId: string } — opens a save dialog for the user to choose where the text export goes",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "fork",
        "channel": "session:fork",
        "args": "{ sessionId: string, beforeMessageUuid?: string (branch from just before that message instead of copying the whole conversation) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "setWorkdir",
        "channel": "session:set-workdir",
        "args": "{ sessionId?: string, dir: string } — an absolute directory path",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "clearWorkdir",
        "channel": "session:clear-workdir",
        "args": "{ sessionId?: string }",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "setWorkspace",
        "channel": "session:set-workspace",
        "args": "{ sessionId?: string, workspaceId?: string (omit to unbind) }",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "setMainModel",
        "channel": "session:set-main-model",
        "args": "{ mode: string (an id from mainModelOptions, or 'auto'), source?: 'custom'|'codex'|'cursor'|'subscription'|'qoder'|'qwenwork'|'qoderwork'|'workbuddy'|'antigravity'|'trae'|'kiro'|'kimi'|'bailian'|'minimax'|'zhipu'|'ark', sessionId?: string } — changes the model and source of one conversation atomically and updates the default for future conversations; omit sessionId to change only that default",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "setThinkingLevel",
        "channel": "session:set-thinking-level",
        "args": "{ level: string (an effort declared by the current model), sessionId?: string, ultraMode?: false } — Select only a declared native effort and leave Ultra atomically. Standard reasoning values are off/low/medium/high/xhigh/max. TRAE CN preserves its service-declared values such as light in exact model members. Local Ultra uses setUltraMode and retains the saved native level. Cursor reasoning levels select an available concrete model variant while retaining its other parameters. A session id changes only that conversation; omit it to change the default for future conversations",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "setUltraMode",
        "channel": "session:set-ultra-mode",
        "args": "{ enabled: boolean, sessionId?: string } — Enable proactive delegation with model-resolved request effort while retaining the saved native choice. A session id changes only that conversation; omit it to change the default for future conversations",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "setFastMode",
        "channel": "session:set-fast-mode",
        "args": "{ enabled: boolean, sessionId?: string } — available for Codex and supported Cursor selections; Cursor selects an existing Fast variant while retaining reasoning. Changes one conversation and the default for future chats; usage follows the provider's pricing",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "setCollaborationMode",
        "channel": "session:set-collaboration-mode",
        "args": "{ sessionId?: string, mode: 'default'|'plan', expectedRevision?: number } — changes next-turn collaboration without expanding permissions",
        "confirm": false,
        "currentSession": true
      }
    ],
    "manualHeading": "会话操作",
    "panel": [
      "settings",
      "archivedSessions"
    ]
  },
  {
    "key": "engine",
    "about": "The agent engine's view of this conversation: context/token usage, compaction, the slash commands and workspace file index it resolved.",
    "reads": [
      {
        "action": "contextStats",
        "channel": "engine:contextStats",
        "args": "{ sessionId?: string }",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "slashCommands",
        "channel": "engine:slashCommands",
        "args": "{ sessionId?: string, root?: string (a project directory to list against, for the commands page's own view) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "fileSearch",
        "channel": "engine:workspaceFileSearch",
        "args": "{ query: string, limit?: number, sessionId?: string }",
        "confirm": false,
        "currentSession": true
      }
    ],
    "writes": [
      {
        "action": "compact",
        "channel": "engine:compactSession",
        "args": "{ sessionId?: string, customInstructions?: string (what the summary should keep) } — refused while that conversation has a turn running",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "refreshCommands",
        "channel": "engine:refreshCommands",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "上下文与自动压缩",
    "elsewhere": "the pie chip at the right end of the composer's context row; hovering it opens the context-usage detail, which is where compaction is started by hand (the `/compact` slash command does the same). The slash commands it resolved are the Slash commands page, and the file index is what `@` in the composer searches."
  },
  {
    "key": "goal",
    "about": "The persistent objective and accounting of one conversation. User controls edit, pause, resume and clear; model goal tools own their permitted completion and blocker transitions.",
    "reads": [
      {
        "action": "get",
        "channel": "goal:get",
        "args": "{ sessionId?: string }",
        "confirm": false,
        "currentSession": true
      }
    ],
    "writes": [],
    "manualHeading": "目标与侧任务",
    "elsewhere": "a row pinned directly above the composer while a goal is set — the objective, the budget spent so far, and edit / pause / clear buttons. It is switched on as Goal mode from the composer's + menu."
  },
  {
    "key": "sideTask",
    "about": "Side tasks: temporary threads that inherit a conversation's completed context, project, working directory, model and thinking level. Inherited messages are hidden from their own transcript. They can move between left and right panes, do not appear in the sidebar, and live until explicitly closed or the application exits.",
    "reads": [
      {
        "action": "list",
        "channel": "side-task:list",
        "args": "{ parentSessionId: string } — required; the conversation whose side tasks to list",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "create",
        "channel": "side-task:create",
        "args": "{ parentSessionId: string } — required; the PARENT conversation, which must be an ordinary active chat. There is no opening prompt here: the visible transcript starts empty while the completed parent context stays available to the model",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "close",
        "channel": "side-task:close",
        "args": "{ sessionId: string } — the SIDE TASK's own session id from `list`, not the parent's",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "目标与侧任务",
    "elsewhere": "a tab in the right-hand panel, one per live side task, alongside Overview, Files, Changes, pages and terminals. A side task can be discarded or converted into a regular conversation from its tab."
  },
  {
    "key": "tasks",
    "about": "The conversation's plan checklist: the task items the agent created this turn, each with subject, status (pending / in_progress / completed), owner and blockers. Sub-agents are a different list — see agents.backgroundSummaries.",
    "reads": [
      {
        "action": "list",
        "channel": "tasks:list",
        "args": "{ sessionId?: string }",
        "confirm": false,
        "currentSession": true
      }
    ],
    "writes": [],
    "manualHeading": "目标与侧任务",
    "elsewhere": "the Plan section at the top of the right-hand panel's Overview tab; it is empty until the agent creates tasks."
  },
  {
    "key": "agents",
    "about": "Sub-agent definitions and their run history. `list` returns the engine's built-in agents plus the user's own; user definitions are markdown files (~/.klaus/agents/<id>.md) — there is no project scope here, and built-in names cannot be reused. `backgroundSummaries` is the live sub-agent roster shown in the Overview tab's Subagents section.",
    "reads": [
      {
        "action": "list",
        "channel": "agents:definitions:list",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "read",
        "channel": "agents:definitions:read",
        "args": "{ id: string } — the file name without .md",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "history",
        "channel": "agents:history",
        "args": "{ sessionId?: string, agentId: string }",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "backgroundSummaries",
        "channel": "agents:background-summaries",
        "args": "{ sessionId?: string }",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "teammateMessages",
        "channel": "agents:teammate-messages",
        "args": "{ sessionId?: string, taskId: string }",
        "confirm": false,
        "currentSession": true
      }
    ],
    "writes": [
      {
        "action": "save",
        "channel": "agents:definitions:save",
        "args": "{ content: string (markdown with a `name:` front-matter field), id?: string (defaults to a slug of that name) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "delete",
        "channel": "agents:definitions:delete",
        "args": "{ id: string } — moves the file to the trash",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "扩展怎么被加载",
    "panel": [
      "agents",
      ""
    ]
  },
  {
    "key": "command",
    "about": "Slash commands (custom prompts the user can invoke with /name).",
    "reads": [
      {
        "action": "list",
        "channel": "commands:list",
        "args": "{ projectRoot?: string (adds that project's .klaus/commands), workspaceId?: string (adds every member folder's) } — global commands are always listed",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "save",
        "channel": "commands:save",
        "args": "{ name: string, body: string (the prompt text), description?: string, argumentHint?: string, scope?: 'global'|'project', projectRoot?: string (required for project scope unless workspaceId names a workspace, whose primary folder is used), workspaceId?: string, originalName?: string (the name it had before, to rename in place instead of leaving a copy) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "delete",
        "channel": "commands:delete",
        "args": "{ name: string, scope?: 'global'|'project', projectRoot?: string }",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "扩展怎么被加载",
    "panel": [
      "slash-commands",
      ""
    ]
  },
  {
    "key": "skill",
    "about": "Skills: instruction packs the engine auto-loads when a task matches. Market browsing, install/uninstall/update, enable/disable (a disabled skill keeps its files). Installing, editing, toggling or removing a skill reaches open conversations and the `/` menu without a new chat or restart; a SKILL.md edited on disk is picked up within about ten seconds.",
    "reads": [
      {
        "action": "installed",
        "channel": "skills:list",
        "args": "{ projectRoot?: string (lists that project's .klaus/skills instead of the global ones), workspaceId?: string (every member folder's) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "market",
        "channel": "skills:market",
        "args": "{ query?: string, limit?: number, cursor?: string }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "builtin",
        "channel": "skills:builtin",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "readFile",
        "channel": "skills:read-file",
        "args": "{ filePath: string } — must resolve inside a skills directory",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "install",
        "channel": "skills:install",
        "args": "{ name: string, version?: string, installMissing?: boolean (go ahead even when the skill's required commands are missing; otherwise the install stops and reports them) } — the market's dirName; installs into ~/.klaus/skills/<name>",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "installFromSource",
        "channel": "skills:install-from-source",
        "args": "{ spec: string (direct http(s) .zip url), name?: string, force?: boolean }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "toggle",
        "channel": "skills:toggle",
        "args": "{ name: string, enabled: boolean }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "update",
        "channel": "skills:update",
        "args": "{ slug: string, version?: string (defaults to the newest) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "openEditor",
        "channel": "skills:open-window",
        "args": "{ name: string, projectRoot?: string } — opens that skill's file in an editor window",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "uninstall",
        "channel": "skills:uninstall",
        "args": "{ name: string, projectRoot?: string }",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "技能",
    "panel": [
      "skills",
      ""
    ]
  },
  {
    "key": "plugin",
    "about": "Plugins: packaged bundles that can contribute skills, slash commands, sub-agents, hooks and MCP servers. The engine owns the installed-plugin ledger. Enable/disable is app-wide, there is no project scope, and install, enable and disable need no restart. Built-in plugins (such as Browser) can be disabled but not uninstalled.",
    "reads": [
      {
        "action": "installed",
        "channel": "plugins:list",
        "args": "{ sessionId?: string } — the session id decides whose RUNTIME state (loaded / failed) is reported alongside each row",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "market",
        "channel": "plugins:market",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "runtime",
        "channel": "plugins:runtime",
        "args": "{ sessionId?: string }",
        "confirm": false,
        "currentSession": true
      }
    ],
    "writes": [
      {
        "action": "install",
        "channel": "plugins:install",
        "args": "{ id: string } — the marketplace entry id from `market` (`<name>@<marketplace>`)",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "update",
        "channel": "plugins:update",
        "args": "{ id: string, version: string, installedVersion?: string } — the available release from market",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "toggle",
        "channel": "plugins:toggle",
        "args": "{ id: string, enabled: boolean }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "refresh",
        "channel": "plugins:refresh",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "addMarketplace",
        "channel": "plugins:marketplace:add",
        "args": "{ source: string } — a git url, an `owner/repo` shorthand, or an absolute local directory path",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "uninstall",
        "channel": "plugins:uninstall",
        "args": "{ id: string }",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "插件",
    "panel": [
      "plugins",
      ""
    ]
  },
  {
    "key": "mcp",
    "about": "MCP servers (global scope): the external tool servers the engine can call. Status, connect/reconnect, per-tool enable. Project-scoped servers need no trust decision — they connect directly.",
    "reads": [
      {
        "action": "list",
        "channel": "mcp:list",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "status",
        "channel": "mcp:status",
        "args": "no arguments — the live runtime of the conversation currently shown in the main window (or, with none open, the declarations of the active project)",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "sessionStatus",
        "channel": "mcp:session:status",
        "args": "{ cwd?: string, sessionId?: string, workspaceId?: string } — declared servers across the user, project and local scopes for that directory, conversation or workspace; with none given only user-scope servers are listed",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "builtinList",
        "channel": "mcp:builtin:list",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "diagnose",
        "channel": "mcp:diagnose:bundle",
        "args": "{ name: string, lastError?: string (the error text to fold into the report) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "uvCheck",
        "channel": "mcp:uv:check",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "needsAuth",
        "channel": "mcp:klaus:needs-auth",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "create",
        "channel": "mcp:create",
        "args": "{ name: string, ...server fields } — the server definition sits at the top level beside name (`command`/`args`/`env` for stdio, or `type`/`url`/`headers`), not under a `config` key",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "update",
        "channel": "mcp:update",
        "args": "{ name: string, config: object }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "toggle",
        "channel": "mcp:toggle",
        "args": "{ name: string, enabled: boolean }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "reconnect",
        "channel": "mcp:reconnect",
        "args": "no arguments — reloads EVERY ready server of the conversation currently shown in the main window, not one by name",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "setToolEnabled",
        "channel": "mcp:setToolEnabled",
        "args": "{ name: string, toolName: string, enabled: boolean }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "installBuiltin",
        "channel": "mcp:builtin:install",
        "args": "{ id: string }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "import",
        "channel": "mcp:import",
        "args": "{ json: string } — the text of an `{ \"mcpServers\": { ... } }` block (a bare server map is accepted too)",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "authenticate",
        "channel": "mcp:klaus:authenticate",
        "args": "{ name: string } — completes a parked OAuth authorization for the conversation currently shown (opens the provider's page in the browser)",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "remove",
        "channel": "mcp:remove",
        "args": "{ name: string }",
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "revokeAuth",
        "channel": "mcp:revokeAuth",
        "args": "{ name: string }",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "MCP 与连接器",
    "panel": [
      "mcp",
      ""
    ]
  },
  {
    "key": "mcpProject",
    "about": "Project-scoped MCP servers, stored in the project's `.klaus/mcp.json` (shared with anyone using the repository). `cwd` must be a registered project root. After a change, idle open conversations in that directory reload their MCP servers; one in the middle of a turn picks the change up later.",
    "reads": [
      {
        "action": "list",
        "channel": "mcp:project:list",
        "args": "{ cwd: string, workspaceId?: string } — without cwd the answer is an empty list; with workspaceId, every member folder's servers",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "create",
        "channel": "mcp:project:create",
        "args": "{ cwd: string (or workspaceId, which writes its primary folder), name: string, config: object }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "update",
        "channel": "mcp:project:update",
        "args": "{ cwd: string, name: string, config: object }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "toggle",
        "channel": "mcp:project:toggle",
        "args": "{ cwd: string, name: string, enabled: boolean }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "remove",
        "channel": "mcp:project:remove",
        "args": "{ cwd: string, name: string }",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "MCP 与连接器",
    "panel": [
      "mcp",
      ""
    ]
  },
  {
    "key": "mcpLocal",
    "about": "Local-scope MCP servers: private to this user and one project directory, kept in the engine's own config (`projects.<dir>.mcpServers`) rather than in the repository. Each config needs `command` (stdio) or `url` (http/sse); `cwd` must be a registered project root.",
    "reads": [
      {
        "action": "list",
        "channel": "mcp:local:list",
        "args": "{ cwd: string } — required; without it the answer is an empty list",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "create",
        "channel": "mcp:local:create",
        "args": "{ cwd: string, name: string, config: object }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "update",
        "channel": "mcp:local:update",
        "args": "{ cwd: string, name: string, config: object }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "toggle",
        "channel": "mcp:local:toggle",
        "args": "{ cwd: string, name: string, enabled: boolean }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "remove",
        "channel": "mcp:local:remove",
        "args": "{ cwd: string, name: string }",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "MCP 与连接器",
    "panel": [
      "mcp",
      ""
    ]
  },
  {
    "key": "connector",
    "about": "System connectors: macOS data and apps (Messages, Safari, Photos, App UI…). Most need a system permission granted first, and macOS caches permission decisions per process, so a freshly granted one needs an app restart.",
    "reads": [
      {
        "action": "list",
        "channel": "connectors:list",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "status",
        "channel": "connectors:status",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "preflight",
        "channel": "connectors:preflight",
        "args": "{ id: string }",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "toggle",
        "channel": "connectors:toggle",
        "args": "{ id: string, enabled: boolean }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "setToolEnabled",
        "channel": "connectors:setToolEnabled",
        "args": "{ id: string, toolName: string, enabled: boolean }",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "MCP 与连接器",
    "panel": [
      "mcp",
      ""
    ]
  },
  {
    "key": "browser",
    "about": "The agent browser (Klaus driving web pages): state, navigation, screenshots, and its settings including the Chrome extension bridge. Browser is a built-in plugin: its on/off switch and Chrome pairing live on the Browser card of the Plugins page, and the default Bing web search runs on it. The `browser-use:*` page actions work only on the browser panel of the conversation currently shown; for this task's own pages use the browser tools. Site permission requests (location, notifications, camera…) from built-in browser pages are answered by the user in an in-app Browser permission dialog, and `@` in the composer can reference a specific open tab.",
    "reads": [
      {
        "action": "state",
        "channel": "browser-use:state",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "tabs",
        "channel": "browser-use:tabs",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "mentionTabs",
        "channel": "browser-use:mention-tabs",
        "args": "{ query?: string } — the tabs the composer's `@` Tabs picker offers: built-in browser tabs plus, when the Chrome bridge is on, connected Chrome tabs",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "config",
        "channel": "settings:browser-use:get",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "chromeDiagnostics",
        "channel": "settings:browser-use:chrome-diagnostics",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "show",
        "channel": "browser-use:show",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "hide",
        "channel": "browser-use:hide",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "navigate",
        "channel": "browser-use:navigate",
        "args": "{ url: string }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "back",
        "channel": "browser-use:back",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "forward",
        "channel": "browser-use:forward",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "reload",
        "channel": "browser-use:reload",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "stop",
        "channel": "browser-use:stop",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "screenshot",
        "channel": "browser-use:screenshot",
        "args": "{ format?: 'jpeg'|'png' (default jpeg), quality?: integer 0..100 }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "setEnabled",
        "channel": "settings:browser-use:set-enabled",
        "args": "{ enabled: boolean } — enables or disables the built-in Browser plugin",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "setChromeEnabled",
        "channel": "settings:browser-use:set-chrome-enabled",
        "args": "{ enabled: boolean }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "setPreferences",
        "channel": "settings:browser-use:set-preferences",
        "args": "{ showFullUrl?: boolean, annotationScreenshots?: 'always'|'necessary', webUrlTarget?: 'in-app'|'system-default'|'chrome', localUrlTarget?: 'in-app'|'system-default'|'chrome', promptForDownloads?: boolean, downloadDirectory?: string|null }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "setOriginPolicy",
        "channel": "settings:browser-use:set-origin-policy",
        "args": "{ pattern?: string, resource: 'browsing'|'downloads'|'uploads'|'siteTools'|'debug', setting: 'allow'|'ask'|'deny'|'inherit' } — omit pattern for the default; inherit is only valid for a website rule",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "removeOriginPolicy",
        "channel": "settings:browser-use:remove-origin-policy",
        "args": "{ pattern: string }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "setSitePermission",
        "channel": "settings:browser-use:set-site-permission",
        "args": "{ origin: string, permission: 'geolocation'|'notifications'|'audioCapture'|'videoCapture'|'clipboard-read'|'fullscreen'|'screen-wake-lock', setting: 'granted'|'denied'|'prompt' }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "setApprovalMode",
        "channel": "settings:browser-use:set-approval-mode",
        "args": "{ mode: 'alwaysAsk'|'neverAsk' } — any other value is stored as 'alwaysAsk'",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "setScreenshotMode",
        "channel": "settings:browser-use:set-screenshot-mode",
        "args": "{ mode: 'alwaysInclude'|'manualOnly'|'never' } — any other value is stored as 'alwaysInclude'",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "addOrigin",
        "channel": "settings:browser-use:add-origin",
        "args": "{ origin: string, kind?: 'allowed'|'denied' (default allowed; a denied origin cannot be navigated to) } — a URL or host is reduced to its origin",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "removeOrigin",
        "channel": "settings:browser-use:remove-origin",
        "args": "{ origin: string, kind?: 'allowed'|'denied' }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "chromeSetup",
        "channel": "settings:browser-use:chrome-setup",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "chromeInstallNativeHost",
        "channel": "settings:browser-use:chrome-install-native-host",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "chromeOpenExtensionManager",
        "channel": "settings:browser-use:chrome-open-extension-manager",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "chromeOpenWebstore",
        "channel": "settings:browser-use:chrome-open-webstore",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "chromeOpenWindow",
        "channel": "settings:browser-use:chrome-open-window",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "chromeDeployExtension",
        "channel": "settings:browser-use:chrome-deploy-extension",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "chromeRevealExtension",
        "channel": "settings:browser-use:chrome-reveal-extension",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "chromePolicyInstallExtension",
        "channel": "settings:browser-use:chrome-policy-install",
        "args": "",
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "chromePolicyUninstallExtension",
        "channel": "settings:browser-use:chrome-policy-uninstall",
        "args": "",
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "clearData",
        "channel": "settings:browser-use:clear-data",
        "args": "{ kind?: 'all'|'cookies'|'cache' } — defaults to 'all' (cache, cookies and site storage, plus remembered site-permission answers); this is the browsing data of the built-in browser, logins included",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "浏览器操控",
    "panel": [
      "plugins",
      ""
    ]
  },
  {
    "key": "computerUse",
    "about": "Computer use and demonstration recording. The connector card controls enablement; Settings > Computer Use lists saved always-allowed apps with removal. Other local apps can be used after approval; blocked apps remain blocked. Saved approvals skip the per-app question. Needs system Accessibility and Screen Recording grants. Recording starts from Record a skill on the Skills page.",
    "reads": [
      {
        "action": "config",
        "channel": "settings:computer-use:get",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "recordStatus",
        "channel": "computer-use:record:status",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "setEnabled",
        "channel": "settings:computer-use:set-enabled",
        "args": "{ enabled: boolean }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "addAllowedApp",
        "channel": "settings:computer-use:add-allowed-app",
        "args": "{ app: string (an app name, or a `bundle:<id>` / `name:<name>` entry for an exact match) } — remembers an app approval",
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "removeAllowedApp",
        "channel": "settings:computer-use:remove-allowed-app",
        "args": "{ app: string } — removes the exact saved app approval",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "recordStop",
        "channel": "computer-use:record:stop",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "recordDiscard",
        "channel": "computer-use:record:discard",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "电脑操控",
    "panel": [
      "mcp",
      ""
    ]
  },
  {
    "key": "hook",
    "about": "Hooks: shell commands the engine runs at lifecycle points (before a tool call, after a turn…). Global hooks live in ~/.klaus/hooks.json; a registered project can carry its own set in <project>/.klaus/hooks.json. A declaration runs only after the user trusts it (rows report new / changed / trusted / disabled; editing a trusted hook voids its trust). A change made through this surface marks open conversations stale so they rebuild before their next turn; a hooks.json edited on disk is read only by new conversations. Plugin hooks come from the plugin ledger and are not edited here.",
    "reads": [
      {
        "action": "get",
        "channel": "settings:hooks:get",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "getProject",
        "channel": "klaus:hooks:get",
        "args": "{ projectRoot?: string (a registered project root), workspaceId?: string (every member folder) } — rows include each declaration's trust key and state",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "set",
        "channel": "settings:hooks:set",
        "args": "{ hooks: object }",
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "setProject",
        "channel": "klaus:hooks:set",
        "args": "{ projectRoot: string (a registered project root; or workspaceId, which writes its primary folder), hooks: object }",
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "trust",
        "channel": "settings:hooks:trust",
        "args": "{ keys: string[] (row keys from get / getProject), projectRoot?: string, workspaceId?: string } — trusts and enables those declarations in their current form",
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "setEnabled",
        "channel": "settings:hooks:enabled",
        "args": "{ key: string, enabled: boolean, projectRoot?: string, workspaceId?: string }",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "钩子（Hooks）",
    "panel": [
      "settings",
      "hooks"
    ]
  },
  {
    "key": "permission",
    "about": "Pre-authorization rules that decide which tool calls run without asking. The agent cannot answer a live permission prompt or change the conversation's permission preset through this surface.",
    "reads": [
      {
        "action": "rules",
        "channel": "permission:rules:list",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "addRule",
        "channel": "permission:rules:add",
        "args": "{ toolName: string, ruleContent?: string (argument prefix), behavior: 'allow'|'deny'|'ask', source?: 'userSettings' }",
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "deleteRule",
        "channel": "permission:rules:delete",
        "args": "{ toolName: string, ruleContent?: string, behavior: 'allow'|'deny'|'ask', source?: 'userSettings' }",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "权限是怎么判的",
    "panel": [
      "settings",
      "permissions"
    ]
  },
  {
    "key": "memory",
    "about": "Long-term memory Markdown files: MEMORY.md is the index, and a file's name prefix is its category (user_ about you, feedback_ preferences, project_ current work, reference_ references). Readable scope is ~/.klaus/agent-memory plus each project's ~/.klaus/projects/<slug>/memory directory — a project conversation's memory and the paths a dream lists in filesTouched usually live in the latter.",
    "reads": [
      {
        "action": "readFile",
        "channel": "memory:read-file",
        "args": "{ relPath: string } or { filePath: string } — resolved against ~/.klaus (e.g. 'agent-memory/MEMORY.md' or 'projects/<slug>/memory/user_profile.md'), or an absolute path such as one from dream.detail filesTouched; it must land inside one of the memory directories. Large files come back truncated",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "openWindow",
        "channel": "memory:open-window",
        "args": "{ filePath: string } — required; an absolute path inside ~/.klaus/agent-memory or a ~/.klaus/projects/<slug>/memory directory; opens it in a preview window. There is no \"open the index\" default",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "reveal",
        "channel": "memory:reveal",
        "args": "no arguments — opens the ~/.klaus data folder (the parent of every memory directory) in the file manager",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "记忆是怎么长出来的",
    "panel": [
      "memory",
      ""
    ]
  },
  {
    "key": "dream",
    "about": "Dreaming: the background pass that weaves recent conversations into long-term memory. Auto-dream is OFF by default; once enabled it needs both gates open (>=5 new sessions AND 24h since the last dream).",
    "reads": [
      {
        "action": "list",
        "channel": "dream:list",
        "args": "{ limit?: number (1-100, default 20), before?: number, from?: number, to?: number } — the three filters are epoch-ms bounds on the start time",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "current",
        "channel": "dream:current",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "detail",
        "channel": "dream:detail",
        "args": "{ taskId: string }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "config",
        "channel": "dream:config-get",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "triggerNow",
        "channel": "dream:trigger-now",
        "args": "— no payload. Ignores the >=5-sessions / 24h thresholds, but still needs auto-dream ON (dream.setConfig `enabled: true`), else it answers ok:false with error 'gate-closed'. The other refusals: 'no-context' (no session has finished a turn since this app started — it will not dream over an empty conversation), 'already-running', 'lock-held' (another Klaus process holds the consolidation lock)",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "setConfig",
        "channel": "dream:config-set",
        "args": "{ enabled?: boolean (auto-dream), minHours?: number (default 24), minSessions?: number (default 5), skillEvolutionEnabled?: boolean (also refine skills while dreaming; default off) } — omitted keys keep their current value. The separate per-turn auto-record switch is preference autoMemory",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "记忆与梦",
    "panel": [
      "settings",
      "engineMemory"
    ]
  },
  {
    "key": "cron",
    "about": "Scheduled tasks: cron-expression jobs that run unattended. Each run follows the task's saved permission preset; tasks created without one keep the previous unrestricted default. A run is capped at 5 minutes unless the task sets its own timeoutSeconds (at most 24 hours). Run history and the scheduler lines in ~/.klaus/electron-host.log (JSON lines with kind 'cron') are how a missed run is diagnosed.",
    "reads": [
      {
        "action": "list",
        "channel": "settings:cron:list",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "status",
        "channel": "settings:cron:status",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "runs",
        "channel": "settings:cron:runs:list",
        "args": "{ taskId?: string, limit?: number (1-1000, default 200), offset?: number, status?: 'running'|'success'|'failed' } — 'failed' also includes successful runs that recorded an error",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "keepAwake",
        "channel": "settings:cron:keep-awake:get",
        "args": "no arguments — answers { enabled } for the app-wide 'Prevent sleep while running' preference (Settings → Preferences → App, not shown on Windows); it holds an idle-sleep lock while any local conversation or scheduled run is working",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "upsert",
        "channel": "settings:cron:upsert",
        "args": "{ id: string (mint one to create; reuse it to edit), name: string, description?: string, schedule: string (cron expression), prompt: string, timezone?: string, enabled?: boolean (default FALSE — send true or the task never runs), model?: string (source:modelId frozen into the task; omit for the app default), thinking?: string, workdir?: string (project directory the run works in; omit for a plain conversation; mutually exclusive with workspaceId), workspaceId?: string (workspace whose project directories the run may use; mutually exclusive with workdir), permissionPreset?: 'default' | 'auto' | 'bypassPermissions' (per-run conversation permission; omitted keeps the previous unrestricted scheduled-task default), notificationPolicy?: 'failed_runs_only' (default) | 'all_runs', timeoutSeconds?: number (per-run timeout in seconds; values above 86400 are capped, default 300), deleteAfterRun?: boolean (a one-shot: after its run the task is DISABLED, not deleted — the card and its run history stay), channelBinding?: object (create-only; shaped { channelId, targetId, chatType 'direct'|'group', accountId?, threadId? } — delivers each run's reply to that chat, and a failed run delivers the failure notice instead) } — a full replace: every omitted field is reset, so on an edit resend the existing values from `list`",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "runNow",
        "channel": "settings:cron:run:now",
        "args": "{ id: string }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "setKeepAwake",
        "channel": "settings:cron:keep-awake:set",
        "args": "{ enabled: boolean } — writes the app-wide 'Prevent sleep while running' preference (Settings → Preferences → App); the remote-control plugged-in keep-awake switch is separate and user-only",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "pruneRuns",
        "channel": "settings:cron:runs:prune",
        "args": "{ taskId?: string, before?: number (epoch ms; defaults to now, i.e. every finished run) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "delete",
        "channel": "settings:cron:delete",
        "args": "{ id: string }",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "定时任务",
    "panel": [
      "cron",
      ""
    ]
  },
  {
    "key": "channel",
    "about": "Messaging channels: external IM accounts (Feishu, DingTalk, WeChat, WeCom, QQ, Telegram, Discord, WhatsApp) whose conversations arrive in Klaus. Login flows that need a QR scan are not drivable from here.",
    "reads": [
      {
        "action": "list",
        "channel": "channels:list",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "connect",
        "channel": "channels:connect",
        "args": "{ id: 'feishu'|'dingtalk'|'wechat'|'wecom'|'qq'|'telegram'|'discord'|'whatsapp', config: object } — saves config and (re)starts the channel. Required string fields: feishu app_id+app_secret, dingtalk client_id+client_secret, wecom bot_id+secret, qq app_id+client_secret, telegram/discord bot_token; wechat/whatsapp need none here but only work after the in-app QR login",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "disconnect",
        "channel": "channels:disconnect",
        "args": "{ id: string }",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "频道（Channels）",
    "panel": [
      "channels",
      ""
    ]
  },
  {
    "key": "channelDiscord",
    "about": "Discord channel policy: who may DM the bot, which guild channels it answers in, pending access requests.",
    "reads": [
      {
        "action": "access",
        "channel": "channels:discord:access",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "setDmPolicy",
        "channel": "channels:discord:setDmPolicy",
        "args": "{ dmPolicy: 'pairing'|'allowlist'|'disabled' }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "addAllowFrom",
        "channel": "channels:discord:addAllowFrom",
        "args": "{ senderId: string } — a Discord user id, not a pairing code",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "removeAllowFrom",
        "channel": "channels:discord:removeAllowFrom",
        "args": "{ senderId: string }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "approvePending",
        "channel": "channels:discord:approvePending",
        "args": "{ code: string } — the pairing code from `access.pending`, not the sender id",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "denyPending",
        "channel": "channels:discord:denyPending",
        "args": "{ code: string }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "upsertGroup",
        "channel": "channels:discord:upsertGroup",
        "args": "{ channelId: string, requireMention?: boolean, allowFrom?: string[] } — a full replace, not a merge",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "removeGroup",
        "channel": "channels:discord:removeGroup",
        "args": "{ channelId: string }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "updateDelivery",
        "channel": "channels:discord:updateDelivery",
        "args": "{ mentionPatterns?: string (newline-separated), ackReaction?: string, replyToMode?: 'off'|'first'|'all', textChunkLimit?: number (1-2000), chunkMode?: 'length'|'newline' } — every key is rewritten on each call, so send the whole shape",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "频道消息怎么进来",
    "panel": [
      "channels",
      ""
    ]
  },
  {
    "key": "project",
    "about": "Projects: a working directory registered in the sidebar so its conversations operate on real files.",
    "reads": [
      {
        "action": "list",
        "channel": "projects:list",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "add",
        "channel": "projects:add",
        "args": "{ path: string (an absolute local directory, or an ssh://user@host/path workdir from ssh.makeWorkdir), label?: string }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "setActive",
        "channel": "projects:set-active",
        "args": "{ path?: string (omit to clear the active project) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "remove",
        "channel": "projects:remove",
        "args": "{ path: string } — unregisters the sidebar row only; the folder and its conversations stay",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "侧栏",
    "elsewhere": "the project rows in the sidebar, each with a ⋯ menu; the project picker at the top of a new conversation is what registers one."
  },
  {
    "key": "workspace",
    "about": "Files in the conversation's working directory: every root of a multi-folder workspace, or the remote directory of an SSH project (list, search, rename, delete and write then act on the remote host; open/reveal are local only). Directory reads load children on demand; searches return bounded filename and path matches within the same roots. Exclude globs (Settings → Preferences → Workspace, empty by default) apply on top of built-in skips such as .git, node_modules, dist, build and target.",
    "reads": [
      {
        "action": "list",
        "channel": "workspace:list",
        "args": "{ sessionId?: string, filePath?: string } — omit filePath for workspace roots; pass a directory path to load its children",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "search",
        "channel": "workspace:search",
        "args": "{ sessionId?: string, query: string } — case-insensitive filename, path and in-order-letters matches, best first, with a truncated flag when scan limits are reached",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "excludes",
        "channel": "workspace:get-excludes",
        "args": "no arguments — answers { patterns } (the user's globs only; built-in skips are not listed)",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "open",
        "channel": "workspace:open",
        "args": "{ sessionId?: string, filePath: string } — an absolute path inside the conversation's roots; opens it in the OS default app (refused for an SSH project)",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "write",
        "channel": "workspace:write",
        "args": "{ sessionId?: string, filePath: string, content: string, expectedMtimeMs?: number, force?: boolean } — overwrites an EXISTING text file (UTF-8, at most 5 MB); binary, image/audio/video/PDF and missing files are refused. Pass the mtimeMs you last read as expectedMtimeMs: if the file changed since, nothing is written and the answer is { conflict: true, content, mtimeMs }; force: true overwrites anyway",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "rename",
        "channel": "workspace:rename",
        "args": "{ sessionId?: string, filePath: string, newName: string } — newName is a bare file name, not a path",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "reveal",
        "channel": "workspace:reveal",
        "args": "{ sessionId?: string, filePath: string }",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "setExcludes",
        "channel": "workspace:set-excludes",
        "args": "{ patterns: string[] } — replaces the whole list (globs such as '**/coverage/**'; an empty array clears it); applies to the Files tree and search in every conversation",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "delete",
        "channel": "workspace:delete",
        "args": "{ sessionId?: string, filePath: string } — moves it to the trash (on an SSH project it is removed on the remote host; there is no trash there). A workspace root cannot be deleted",
        "confirm": true,
        "currentSession": true
      }
    ],
    "manualHeading": "工作区、Git 与改动",
    "elsewhere": "the Files tab in the right-hand panel (⇧⌘E / Ctrl+Shift+E), which browses the same roots and edits text files in place with a 3-second autosave and a keep-mine / use-disk choice on conflict. It is a panel tab, not a page — `nav.open` has no id for it."
  },
  {
    "key": "workspaceSet",
    "about": "Saved multi-root workspace definitions.",
    "reads": [
      {
        "action": "list",
        "channel": "workspaces:list",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "save",
        "channel": "workspaces:save",
        "args": "{ id?: string (omit to create a new one), name?: string (defaults to the first folder's name), roots: string[] (absolute paths; the first is the primary directory) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "delete",
        "channel": "workspaces:delete",
        "args": "{ id: string, deleteSessions?: boolean } — removes the saved definition; its conversations are kept and unlinked unless deleteSessions: true, which also deletes them",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "工作区、Git 与改动",
    "elsewhere": "the workspace editor, a modal reached from the project picker: a name plus several ticked folders, the first tick being the primary directory."
  },
  {
    "key": "worktree",
    "about": "Parallel git worktrees: a project conversation running in its own checkout under ~/.klaus/worktrees on a new klaus/wt-<timestamp> branch. Klaus has no merge action; merging that branch back is ordinary git work the user (or a command, with permission) does after committing (see the diff surface).",
    "reads": [
      {
        "action": "status",
        "channel": "worktree:status",
        "args": "{ path: string } — the managed worktree directory, from session.resolvedWorkdir; answers { state: 'available', branch, dirty, repoRoot } or { state: 'gone' } once the directory was removed",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "create",
        "channel": "worktree:create-from-workdir",
        "args": "{ workdir: string, baseRef?: string (a branch/tag/commit to branch off; defaults to HEAD), includeUncommitted?: boolean (copy the checkout's uncommitted and untracked changes into the new worktree; only honoured when starting from HEAD) } — workdir is a local git project directory with at least one commit; answers { path, branch, repoRoot }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "reveal",
        "channel": "worktree:reveal",
        "args": "{ path: string } — a managed worktree directory; opens it in the file manager",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "remove",
        "channel": "worktree:remove",
        "args": "{ path: string } — removes the directory with --force, keeps the branch and its commits; refused with 'worktree-in-use' while a conversation still works in it",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "并行工作树",
    "elsewhere": "the worktree badge on a conversation in the sidebar, plus the reveal entry in that conversation's ⋯ menu. A new worktree is started from the new-conversation 'Run in' row (switch the mode to Worktree, optionally carrying the N uncommitted changes); it is offered only for a single-folder git project with a current branch."
  },
  {
    "key": "git",
    "about": "Git basics the client owns: branch list, checkout, path-limited commit, init. Every action needs `workdir`, an absolute local directory inside the repository (use session.resolvedWorkdir); SSH workdirs are refused.",
    "reads": [
      {
        "action": "branches",
        "channel": "git:branches",
        "args": "{ workdir: string } — answers { current, branches (most recent first), gitRoot }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "uncommitted",
        "channel": "git:uncommitted",
        "args": "{ workdir: string, branch?: string } — change count plus the files a checkout of `branch` would refuse to carry (tracked edits that also differ on the target, untracked files already in its tree)",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "checkout",
        "channel": "git:checkout",
        "args": "{ workdir: string, branch: string, create?: boolean (start a new branch instead of switching to an existing one) } — check `uncommitted` first: git refuses a switch that would overwrite local edits",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "commitPaths",
        "channel": "git:commit-paths",
        "args": "{ workdir: string, paths: string[] (repository-relative or absolute), message: string } — commits ONLY the named paths; the rest of the working tree stays uncommitted. Refused mid merge/rebase",
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "init",
        "channel": "git:init",
        "args": "{ workdir: string } — initializes a repository on branch main and immediately commits EVERYTHING in the folder as 'Initial commit'; answers alreadyRepo: true when the folder is already inside one. Say so before running it",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "工作区、Git 与改动",
    "elsewhere": "the branch button above the composer. It appears only for a single-folder project inside a git repository with a current branch (a multi-folder workspace has no single current branch, so it shows no branch at all); it lists the branches and switches between them, committing the files a switch would overwrite when the user asks it to."
  },
  {
    "key": "diff",
    "about": "The Changes view: repository comparisons, recorded last-turn patches, and committing current changes in the selected checkout. Scopes: 'branch' (default — the working tree against the merge-base with the remote default branch, or with baseBranch), 'uncommitted', 'unstaged', 'staged', 'commit' (one commit, commitSha or HEAD) and 'last-turn' (what the latest turn edited, across repositories). It shows the repository's real state, including the user's own edits. A conversation spanning several repositories lists them in `repositories`; pass repositoryRoot to pick one. SSH projects have no Changes view, and a repository mid merge/rebase reports transient and cannot be committed.",
    "reads": [
      {
        "action": "summary",
        "channel": "diff:summary",
        "args": "{ sessionId?: string, source?: 'branch' | 'uncommitted' | 'unstaged' | 'staged' | 'commit' | 'last-turn' (default 'branch'), repositoryRoot?: string (one of `repositories`; default the first), baseBranch?: string (branch scope only; default the remote default branch), commitSha?: string (commit scope; default HEAD) } — answers files with line stats, repositories, defaultBaseBranch, baseBranches, recent commits and canCommit",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "hunks",
        "channel": "diff:hunks",
        "args": "{ sessionId: string (required — not filled in automatically), filePath: string, source?: string, repositoryRoot?: string (required for last-turn), baseBranch?: string, commitSha?: string, previousPath?: string (a renamed file's old path), turnId?: string, entryId?: string (when last-turn recorded several patches for one file), expectedBaseRevision?: string, expectedHeadRevision?: string } — use the same source/repositoryRoot/baseBranch as the summary it came from",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "commitMessage",
        "channel": "diff:generateCommitMessage",
        "args": "{ sessionId?: string, repositoryRoot?: string } — drafts a message from the uncommitted diff and recent commit style; it only returns text and commits nothing",
        "confirm": false,
        "currentSession": true
      }
    ],
    "writes": [
      {
        "action": "applyReviewAction",
        "channel": "diff:apply-review-action",
        "args": "{ sessionId: string, action: 'stage' | 'unstage' | 'revert', source: 'branch' | 'uncommitted' | 'unstaged' | 'staged', repositoryRoot?: string, baseBranch?: string, filePath?: string, previousPath?: string, hunkIndex?: number, expectedSnapshotId: string } — modifies only the selected displayed snapshot; omit filePath for all comparison files; historical scopes are read-only and hunk actions require text patches",
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "open",
        "channel": "diff:open",
        "args": "{ sessionId: string, filePath: string, repositoryRoot?: string, source?: string }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "reveal",
        "channel": "diff:reveal",
        "args": "{ sessionId: string, filePath: string, repositoryRoot?: string, source?: string }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "commit",
        "channel": "diff:commit",
        "args": "{ sessionId: string (or workdir: string), repositoryRoot?: string, message: string } — stages EVERYTHING in that repository (`git add -A`), including the user's own edits; for a named subset use git.commitPaths. Review diff.summary { source: 'uncommitted' } first",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "工作区、Git 与改动",
    "elsewhere": "the Changes tab in the right-hand panel: the changed files with their hunks and the commit box. It is a panel tab, not a page — `nav.open` has no id for it."
  },
  {
    "key": "model",
    "about": "Settings → Model Sources manages sign-ins, endpoints and model catalogs, including the custom API-key entries managed here. Settings → Model Tiers holds the advisor and shared high/medium/low mapping; Settings → Multimodal Models holds the global image, video, speech and music picks. Tiers are independent of a chat's main model: a tier set to null follows the calling chat's main model, and a configured tier whose model is unavailable falls back to that main model for the call. Saves apply from the next call; running requests keep their captured config. The conversation main model, native thinking level, independent Ultra mode and supported-source Fast mode are per chat: use session.setMainModel / setThinkingLevel / setUltraMode / setFastMode. Image, video, speech, music, advisor and auxiliary task picks live on imageSelection, videoSelection, audioSelection, musicSelection, advisor and featureModels.",
    "reads": [
      {
        "action": "list",
        "channel": "settings:models:list",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "tiers",
        "channel": "settings:models:tiers:get",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "tierOptions",
        "channel": "settings:models:tiers:options",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "upsert",
        "channel": "settings:models:upsert",
        "args": "{ id: string (the entry's key; reuse it to edit — the write replaces the whole entry, so resend every field from model.list), name: string, provider: 'anthropic'|'openai' (OpenAI Compatible)|'kimi-api'|'deepseek'|'gemini'|'bedrock'|'vertex', baseUrl?: string, apiKey?: string (a new entry needs one; omit on edit to keep the stored key), model: string, openaiApi?: 'chat'|'responses' (openai provider only), authScheme?: 'bearer' (anthropic provider only, for gateways that validate only the Authorization bearer carrier; omit for the native x-api-key header), maxContextTokens?: number (default 200000), thinking?: string, reasoningEffort?: 'none'|'std'|'xhigh'|'max' (declared reasoning tiers), supportsThinking?: boolean (declares extended thinking), supportsVision?: boolean (declares image input), isDefault?: boolean, costInput?: number, costOutput?: number, costCacheRead?: number, costCacheWrite?: number }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "setTier",
        "channel": "settings:models:tiers:set",
        "args": "{ tier: 'high'|'medium'|'low', target: { source: string, modelId: string } | null (follow this conversation's main model), expectedRevision: number (from model.tiers) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "delete",
        "channel": "settings:models:delete",
        "args": "{ id: string }",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "模型",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "imageGen",
    "about": "The custom image-generation endpoint for generate_image, stored once globally. The backend that actually runs is the global image selection (imageSelection); this row backs only its 'custom' choice, and saving it never changes the selection. Reference images work when the endpoint supports editing. For source workbuddy or qwenwork, this action instead reads or writes one native image model preference shared by generation and editing, validated against that account catalog; native preferences never contain endpoint credentials. An empty row returns a setup notice when the custom selection is in force.",
    "reads": [
      {
        "action": "config",
        "channel": "settings:image-gen:get",
        "args": "{ source?: string } — workbuddy or qwenwork returns the shared native image model preference plus capabilities without endpoint credentials; otherwise returns the global custom endpoint row",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "setConfig",
        "channel": "settings:image-gen:set",
        "args": "{ source?: string, provider?: 'openai-compatible'|'doubao-ark'|'google' (inferred as openai-compatible when omitted), baseUrl?: string, apiKey?: string, model?: string } — source workbuddy or qwenwork updates only supplied native model preferences; other sources replace the whole custom row: an omitted field is erased, including apiKey. The stored key is redacted from agent reads, so changing only the model would drop it; ask the user to edit the key in settings instead. An all-empty payload clears the row.",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "图片、视频与语音生成",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "imageSelection",
    "about": "The global image backend for generate_image in every chat (Settings → Multimodal Models → image model): a signed-in subscription's own image API (Codex, Cursor, Qoder, QwenWork, QoderWork, WorkBuddy) or the global custom endpoint (imageGen). Independent of the chat's language source. Qoder and QoderWork are text-to-image only. QwenWork and WorkBuddy support declared native editing models and reference images. The set handler rejects a choice whose sign-in or custom API key is missing; a selected source that later fails returns an error with no fallback to another backend.",
    "reads": [
      {
        "action": "selection",
        "channel": "settings:image-selection:get",
        "args": "{} — returns selection, current {source, modelId}, concrete model options and per-source availability",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "setSelection",
        "channel": "settings:image-selection:set",
        "args": "{ selection: 'codex'|'cursor'|'qoder'|'qwenwork'|'qoderwork'|'workbuddy'|'antigravity'|'trae'|'custom', model?: string } — the optional concrete image model is validated and saved atomically with the source; generation and editing use that same model, and editing requires that model to support references",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "图片、视频与语音生成",
    "panel": [
      "settings",
      "multimodal"
    ]
  },
  {
    "key": "videoSelection",
    "about": "The single global video backend for generate_video in every chat (Settings → Multimodal Models → video model): WorkBuddy and QwenWork native video services, MiniMax M Plan's own task protocol (spending the same subscription its text turns use; needs an Explore or Build tier) or the global custom OpenAI-compatible endpoint (videoGen). There are no per-source video endpoints. Independent of the language source and of the image backend. The set handler rejects MiniMax without a stored plan key and custom without a stored API key; a selected backend that later fails returns an error with no fallback.",
    "reads": [
      {
        "action": "selection",
        "channel": "settings:video-selection:get",
        "args": "{} — returns selection, current {source, modelId}, concrete model options and per-source availability",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "setSelection",
        "channel": "settings:video-selection:set",
        "args": "{ selection: 'minimax'|'workbuddy'|'qwenwork'|'trae'|'custom', model?: string } — an optional concrete model is validated and saved atomically with the source",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "图片、视频与语音生成",
    "panel": [
      "settings",
      "multimodal"
    ]
  },
  {
    "key": "videoGen",
    "about": "The one global custom video endpoint: base URL, API key and model for the OpenAI-compatible /videos route that the `custom` video selection runs. Video endpoints are no longer per model source. For source workbuddy, qwenwork or minimax, model reads and writes use a separate source-specific model preference. Native account choices are validated against their account catalog. MiniMax uses its stored subscription credential and never reads the custom endpoint's model, base URL or key. An unconfigured row returns a setup notice when the custom selection is in force.",
    "reads": [
      {
        "action": "config",
        "channel": "settings:video-gen:get",
        "args": "{ source?: string } — WorkBuddy or QwenWork returns account-owned model preferences and available capabilities without endpoint credentials; otherwise returns the global custom endpoint row",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "setConfig",
        "channel": "settings:video-gen:set",
        "args": "{ source?: string, baseUrl?: string, apiKey?: string, model?: string } — source workbuddy, qwenwork or minimax updates only the supplied source-specific model preference; other sources replace the whole custom row: an omitted field is erased, including apiKey (redacted from agent reads, so leave key edits to the user in settings).",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "图片、视频与语音生成",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "audioSelection",
    "about": "The global speech backend for generate_audio in every chat: none disables speech; Cursor, MiniMax, Bailian and WorkBuddy synthesize spoken text. Custom speech endpoints are retired and saved custom selections resolve to none. Music has an independent musicSelection and generate_music tool. Changing either selection never changes the other. Unavailable sources return errors without fallback.",
    "reads": [
      {
        "action": "selection",
        "channel": "settings:audio-selection:get",
        "args": "{} — returns selection, current {source, modelId}, concrete model options and per-source availability",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "setSelection",
        "channel": "settings:audio-selection:set",
        "args": "{ selection: 'none'|'cursor'|'minimax'|'bailian'|'workbuddy', model?: string } — an optional concrete model is validated and saved atomically with the source",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "图片、视频与语音生成",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "audioGen",
    "about": "Speech model preferences and the retained legacy endpoint configuration. Custom speech endpoints are retired: their saved rows cannot activate a generation route. The MiniMax and Bailian selections use independent source-specific model preferences and stored subscription credentials. Their shared default voice still comes from the legacy row; its model, base URL and key do not affect subscription calls.",
    "reads": [
      {
        "action": "config",
        "channel": "settings:audio-gen:get",
        "args": "{ source?: string } — workbuddy returns native speech capabilities; other sources return the global custom endpoint row",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "setConfig",
        "channel": "settings:audio-gen:set",
        "args": "{ source?: string, provider?: 'openai-compatible'|'dashscope'|'minimax'|'zhipu' (stored as openai-compatible when omitted or unknown), baseUrl?: string, apiKey?: string, model?: string, voice?: string } — source minimax or bailian updates only its source-specific model preference; workbuddy has no model or voice settings. Other sources replace the whole custom row: an omitted field is erased, including apiKey (redacted from agent reads, so leave key edits to the user in settings). The shared voice preference for MiniMax and Bailian remains in the custom row.",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "图片、视频与语音生成",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "musicSelection",
    "about": "The independent global backend for generate_music. none disables music; qwenwork generates music from a prompt and optional lyrics. Speech configuration is unchanged.",
    "reads": [
      {
        "action": "selection",
        "channel": "settings:music-selection:get",
        "args": "{} — returns selection, current {source, modelId}, concrete model options and per-source availability",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "setSelection",
        "channel": "settings:music-selection:set",
        "args": "{ selection: 'none'|'qwenwork', model?: string } — an optional concrete model is validated and saved atomically with the source",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "图片、视频与语音生成",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "musicGen",
    "about": "Native music model preference for the connected QwenWork account, independent of speech and custom endpoints. No API key or endpoint is stored here.",
    "reads": [
      {
        "action": "config",
        "channel": "settings:music-gen:get",
        "args": "{ source: 'qwenwork' } — returns model and native capabilities",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "setConfig",
        "channel": "settings:music-gen:set",
        "args": "{ source: 'qwenwork', model?: string } — updates the native music model preference",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "图片、视频与语音生成",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "outputStyle",
    "about": "Output styles: the answer persona/format the engine applies, app-wide (Settings → Preferences → Session → reply style). Built-in styles plus user styles from ~/.klaus/output-styles; a change reaches open conversations on their next turn.",
    "reads": [
      {
        "action": "list",
        "channel": "settings:output-styles:list",
        "args": "no arguments — answers { current, defaultStyle, styles: [{ id, name, description, source, active }] }",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "set",
        "channel": "settings:output-styles:set",
        "args": "{ style: string } — an `id` from `list` ('default' resets); the key is `style`, and a missing or empty one silently selects 'default'",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "回答风格",
    "panel": [
      "settings",
      "preferences"
    ]
  },
  {
    "key": "voice",
    "about": "Voice input: correction dictionary, transcript history and microphone permission. Refinement and language detection run automatically. The voiceLearning preference controls personalized phrasing; dictionary correction learning remains active when personalization is off. Live capture is driven by the mic button.",
    "reads": [
      {
        "action": "config",
        "channel": "voice:config:get",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "hotwords",
        "channel": "voice:hotwords:list",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "history",
        "channel": "voice:history:list",
        "args": "{ limit?: number (1-500, default 100) } — newest first",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "micPermission",
        "channel": "voice:mic-permission",
        "args": "no arguments — reports microphone access; on macOS, when it was never asked, this call itself raises the system permission prompt, so only use it when the user is trying to set up voice input",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "addHotword",
        "channel": "voice:hotwords:add",
        "args": "{ text: string, id?: string } — add a term of 1-100 UTF-16 units, or edit an existing id without changing its source",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "deleteHotword",
        "channel": "voice:hotwords:delete",
        "args": "{ id: string }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "learn",
        "channel": "voice:learn",
        "args": "{ rawText: string, insertedText?: string, finalText: string }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "clearHistory",
        "channel": "voice:history:clear",
        "args": "",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "语音输入",
    "panel": [
      "settings",
      "voiceInput"
    ]
  },
  {
    "key": "account",
    "about": "The Klaus account and guest entry: sign-in state, legacy account plan record, profile, plus the provider usage read. The app needs no sign-in, and no model source requires the Klaus account (model access never depends on a Klaus plan); the account is used only for friends, team collaboration, cross-device chats, phone pairing and feedback. Signing out affects only those features and leaves provider credentials and custom API keys in place. `usage` reports the allowance of the model source of the current chat (remaining amount, reset times, plan; Claude lists each stored account and marks the one in use). `wipeLocal` is intentionally NOT reachable from here.",
    "reads": [
      {
        "action": "status",
        "channel": "klausAuth:status",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "subscription",
        "channel": "klausAuth:subscription",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "clientConfig",
        "channel": "klausAuth:clientConfig",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "usage",
        "channel": "usage:subscriptions",
        "args": "{ sessionId?: string } — defaults to this conversation; reports that chat's model source",
        "confirm": false,
        "currentSession": true
      }
    ],
    "writes": [
      {
        "action": "login",
        "channel": "klausAuth:login",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "cancelLogin",
        "channel": "klausAuth:cancelLogin",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "enterGuest",
        "channel": "klausAuth:guestEnter",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "updateProfile",
        "channel": "klausAuth:updateProfile",
        "args": "{ displayName: string }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "logout",
        "channel": "klausAuth:logout",
        "args": "",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "账号与登录",
    "panel": [
      "settings",
      "profile"
    ]
  },
  {
    "key": "claudeAuth",
    "about": "Claude Code subscription sign-in (provider auth, separate from the Klaus account). The source keeps a queue of several Claude accounts. When the account in use is rate-limited or out of allowance, the engine moves it to the tail and retries the same request on the next one, erroring only after every account has been tried; authentication failures first try token renewal and then rotate if another account is available. A single account or a queue whose logins all fail needs a new sign-in. Per-account allowance is in account.usage.",
    "reads": [
      {
        "action": "status",
        "channel": "auth:status",
        "args": "no arguments — answers { loggedIn, account, subscriptionType, accounts: [{ id, email, displayName, isCurrent }] }; the head of the queue is the account in use",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "login",
        "channel": "auth:login",
        "args": "no arguments — browser OAuth; appends an account to the queue, or refreshes the stored one when the same account signs in again",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "importLocal",
        "channel": "auth:import-local",
        "args": "no arguments — adopts this computer's existing Claude login; appends or refreshes the same way as login",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "logout",
        "channel": "auth:logout",
        "args": "{ accountId?: string (an id from status.accounts) } — removes that one account; omitting accountId signs out EVERY stored Claude account",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "模型来源",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "codexAuth",
    "about": "ChatGPT/Codex subscription sign-in: browser device-code login or adopting this computer's Codex login. A signed-in Codex subscription also backs the Codex image backend (imageSelection), the Codex web-search source and message prediction. Codex fast mode is a per-chat toggle set through session.setFastMode.",
    "reads": [
      {
        "action": "status",
        "channel": "codex-auth:status",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "models",
        "channel": "codex-auth:models",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "start",
        "channel": "codex-auth:start",
        "args": "no arguments — opens the verification page in the browser and answers { deviceCode, userCode, verificationUri, expiresIn, interval }; show the user the userCode, then poll with deviceCode",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "poll",
        "channel": "codex-auth:poll",
        "args": "{ deviceCode: string (from codexAuth.start) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "importLocal",
        "channel": "codex-auth:import-local",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "logout",
        "channel": "codex-auth:logout",
        "args": "",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "模型来源",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "cursorAuth",
    "about": "Cursor account models and plan allowance. Sign in through the browser or reuse this computer's login as separate actions. Model menus group base models with catalog-driven parameters, while saved selections retain exact variant identities. Disconnect clears this app's credential without signing out of Cursor.",
    "reads": [
      {
        "action": "status",
        "channel": "cursor-auth:status",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "models",
        "channel": "cursor-auth:models",
        "args": "{ forceRefresh?: boolean }",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "start",
        "channel": "cursor-auth:start",
        "args": "no arguments — opens browser authorization and returns { flowId, authUrl, expiresAt, interval }; poll with flowId",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "poll",
        "channel": "cursor-auth:poll",
        "args": "{ flowId: string (from cursorAuth.start) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "cancel",
        "channel": "cursor-auth:cancel",
        "args": "{ flowId: string (from cursorAuth.start) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "importLocal",
        "channel": "cursor-auth:import-local",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "logout",
        "channel": "cursor-auth:logout",
        "args": "",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "模型来源",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "qoderAuth",
    "about": "Qoder subscription sign-in: browser login (start/poll) or adopting the signed-in official client on this computer. A signed-in Qoder subscription also backs the Qoder image backend (text-to-image only) and the Qoder web-search source.",
    "reads": [
      {
        "action": "status",
        "channel": "qoder-auth:status",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "models",
        "channel": "qoder-auth:models",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "start",
        "channel": "qoder-auth:start",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "poll",
        "channel": "qoder-auth:poll",
        "args": "{ flowId: string (from qoderAuth.start) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "importLocal",
        "channel": "qoder-auth:import-local",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "logout",
        "channel": "qoder-auth:logout",
        "args": "",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "模型来源",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "qwenworkAuth",
    "about": "QwenWork subscription sign-in: browser login (start/poll) or adopting the signed-in official client on this computer. A signed-in QwenWork subscription also backs the QwenWork image backend (text-to-image only).",
    "reads": [
      {
        "action": "status",
        "channel": "qwenwork-auth:status",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "models",
        "channel": "qwenwork-auth:models",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "start",
        "channel": "qwenwork-auth:start",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "poll",
        "channel": "qwenwork-auth:poll",
        "args": "{ flowId: string (from qwenworkAuth.start) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "importLocal",
        "channel": "qwenwork-auth:import-local",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "logout",
        "channel": "qwenwork-auth:logout",
        "args": "",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "模型来源",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "qoderworkAuth",
    "about": "QoderWork subscription sign-in: browser login (start/poll) or adopting the signed-in official client on this computer. A signed-in QoderWork subscription also backs the QoderWork image backend (text-to-image only) and the QoderWork web-search source.",
    "reads": [
      {
        "action": "status",
        "channel": "qoderwork-auth:status",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "models",
        "channel": "qoderwork-auth:models",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "start",
        "channel": "qoderwork-auth:start",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "poll",
        "channel": "qoderwork-auth:poll",
        "args": "{ flowId: string (from qoderworkAuth.start) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "importLocal",
        "channel": "qoderwork-auth:import-local",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "logout",
        "channel": "qoderwork-auth:logout",
        "args": "",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "模型来源",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "kiroAuth",
    "about": "Sign in to Kiro through browser authorization or reuse the local Kiro account for cloud models and native web search. Signing out removes only the Klaus connection.",
    "reads": [
      { "action": "status", "channel": "kiro-auth:status", "args": "", "confirm": false, "currentSession": false },
      { "action": "models", "channel": "kiro-auth:models", "args": "", "confirm": false, "currentSession": false }
    ],
    "writes": [
      { "action": "start", "channel": "kiro-auth:start", "args": "", "confirm": false, "currentSession": false },
      { "action": "poll", "channel": "kiro-auth:poll", "args": "{ flowId: string (from kiroAuth.start) }", "confirm": false, "currentSession": false },
      { "action": "cancel", "channel": "kiro-auth:cancel", "args": "{ flowId: string (from kiroAuth.start) }", "confirm": false, "currentSession": false },
      { "action": "importLocal", "channel": "kiro-auth:import-local", "args": "", "confirm": false, "currentSession": false },
      { "action": "logout", "channel": "kiro-auth:logout", "args": "", "confirm": true, "currentSession": false }
    ],
    "manualHeading": "模型来源",
    "panel": ["settings", "models"]
  },
  {
    "key": "traeAuth",
    "about": "Sign in to TRAE CN through browser authorization or reuse the local account for cloud models, image and video generation, native search and dictation. Allowances use the same account. Signing out removes only the Klaus connection.",
    "reads": [
      { "action": "status", "channel": "trae-auth:status", "args": "", "confirm": false, "currentSession": false },
      { "action": "models", "channel": "trae-auth:models", "args": "", "confirm": false, "currentSession": false }
    ],
    "writes": [
      { "action": "start", "channel": "trae-auth:start", "args": "", "confirm": false, "currentSession": false },
      { "action": "poll", "channel": "trae-auth:poll", "args": "{ flowId: string (from traeAuth.start) }", "confirm": false, "currentSession": false },
      { "action": "cancel", "channel": "trae-auth:cancel", "args": "{ flowId: string (from traeAuth.start) }", "confirm": false, "currentSession": false },
      { "action": "importLocal", "channel": "trae-auth:import-local", "args": "", "confirm": false, "currentSession": false },
      { "action": "logout", "channel": "trae-auth:logout", "args": "", "confirm": true, "currentSession": false }
    ],
    "manualHeading": "模型来源",
    "panel": ["settings", "models"]
  },
  {
    "key": "antigravityAuth",
    "about": "Sign in to Antigravity through browser authorization or reuse the local account for cloud models, image generation, search and dictation. Quotas use the same account. Signing out removes only the Klaus credential.",
    "reads": [
      { "action": "status", "channel": "antigravity-auth:status", "args": "", "confirm": false, "currentSession": false },
      { "action": "models", "channel": "antigravity-auth:models", "args": "", "confirm": false, "currentSession": false }
    ],
    "writes": [
      { "action": "start", "channel": "antigravity-auth:start", "args": "", "confirm": false, "currentSession": false },
      { "action": "poll", "channel": "antigravity-auth:poll", "args": "{ flowId: string (from antigravityAuth.start) }", "confirm": false, "currentSession": false },
      { "action": "cancel", "channel": "antigravity-auth:cancel", "args": "{ flowId: string (from antigravityAuth.start) }", "confirm": false, "currentSession": false },
      { "action": "importLocal", "channel": "antigravity-auth:import-local", "args": "", "confirm": false, "currentSession": false },
      { "action": "logout", "channel": "antigravity-auth:logout", "args": "", "confirm": true, "currentSession": false }
    ],
    "manualHeading": "模型来源",
    "panel": ["settings", "models"]
  },
  {
    "key": "workbuddyAuth",
    "about": "WorkBuddy subscription sign-in: browser login (start/poll) or adopting the signed-in official client on this computer. An adopted login that expires is recovered only by importing it again.",
    "reads": [
      {
        "action": "status",
        "channel": "workbuddy-auth:status",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "models",
        "channel": "workbuddy-auth:models",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "start",
        "channel": "workbuddy-auth:start",
        "args": "{ region?: 'cn' | 'intl' }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "poll",
        "channel": "workbuddy-auth:poll",
        "args": "{ flowId: string (from workbuddyAuth.start) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "importLocal",
        "channel": "workbuddy-auth:import-local",
        "args": "{ region?: 'cn' | 'intl' }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "logout",
        "channel": "workbuddy-auth:logout",
        "args": "",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "模型来源",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "kimiAuth",
    "about": "Kimi membership sign-in: browser login (start/poll) or a Kimi Code console API key (setApiKey). The served model list follows the membership tier.",
    "reads": [
      {
        "action": "status",
        "channel": "kimi-auth:status",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "models",
        "channel": "kimi-auth:models",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "setApiKey",
        "channel": "kimi-auth:set-api-key",
        "args": "{ apiKey: string (a Kimi Code console key), apiBase?: string }",
        // This replaces the credential every Kimi conversation spends, so it is
        // gated the way the logout beside it is rather than offered as a casual
        // write.
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "start",
        "channel": "kimi-auth:start",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "poll",
        "channel": "kimi-auth:poll",
        "args": "{ flowId: string (from kimiAuth.start) }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "logout",
        "channel": "kimi-auth:logout",
        "args": "",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "模型来源",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "bailianAuth",
    "about": "Aliyun Bailian Token Plan sign-in: a pasted plan key (no browser login) for the China or international site. The plan key also backs the Bailian speech backend (audioSelection) and the Bailian web-search source. A separate optional Bailian console sign-in (consoleLogin) only unlocks the plan allowance figures in usage.",
    "reads": [
      {
        "action": "status",
        "channel": "bailian-auth:status",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "models",
        "channel": "bailian-auth:models",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "consoleStatus",
        "channel": "bailian-auth:console-status",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "setApiKey",
        "channel": "bailian-auth:set-api-key",
        "args": "{ apiKey: string (a Token Plan sk-sp- key), region?: 'cn' | 'intl' } — omitting region keeps the site of the stored key",
        // This replaces the credential every Bailian conversation spends, so it is
        // gated the way the logout beside it is rather than offered casually.
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "logout",
        "channel": "bailian-auth:logout",
        "args": "",
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "consoleLogin",
        "channel": "bailian-auth:console-login",
        "args": "no arguments — opens the Bailian console sign-in in the browser; poll consoleStatus until it lands",
        // Opens the Bailian console sign-in in the browser and stores the
        // session token that unlocks allowance reads; a login, not a spend,
        // so it is not confirm-gated.
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "consoleLogout",
        "channel": "bailian-auth:console-logout",
        "args": "",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "模型来源",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "minimaxAuth",
    "about": "MiniMax M Plan sign-in. A subscription that spends one shared allowance across text, image, audio and video, authenticated only by a console key (sk-cp-). The video model needs an Explore or Build tier.",
    "reads": [
      {
        "action": "status",
        "channel": "minimax-auth:status",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "models",
        "channel": "minimax-auth:models",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "setApiKey",
        "channel": "minimax-auth:set-api-key",
        "args": "{ apiKey: string (an M Plan sk-cp- subscription key), region?: 'cn' | 'global' } — omit region to have the engine detect the site from the key; a pay-as-you-go open-platform key is refused (that key belongs in audioGen's minimax provider instead)",
        // This replaces the credential every MiniMax conversation spends, including
        // the video route, so it is gated the way the logout beside it is rather
        // than offered casually.
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "logout",
        "channel": "minimax-auth:logout",
        "args": "",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "模型来源",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "zhipuAuth",
    "about": "Zhipu GLM Coding Plan sign-in: a pasted plan key for the China (bigmodel.cn) or international (z.ai) site; keys do not cross sites. The plan includes no speech allowance, so it is not a speech backend; an open-platform key can still be used through audioGen's zhipu provider.",
    "reads": [
      {
        "action": "status",
        "channel": "zhipu-auth:status",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "models",
        "channel": "zhipu-auth:models",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "setApiKey",
        "channel": "zhipu-auth:set-api-key",
        // The plan publishes no key grammar, so this names no required prefix.
        "args": "{ apiKey: string (a Coding Plan API key), region?: 'cn' | 'intl' } — omitting region keeps the site of the stored key",
        // This replaces the credential every Zhipu conversation spends, so it is
        // gated the way the logout beside it is rather than offered casually.
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "logout",
        "channel": "zhipu-auth:logout",
        "args": "",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "模型来源",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "arkAuth",
    "about": "Volcengine Ark Coding Plan sign-in: a pasted plan key (single region). A separate optional Volcengine console sign-in (consoleLogin) only unlocks the plan allowance figures in usage.",
    "reads": [
      {
        "action": "status",
        "channel": "ark-auth:status",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "models",
        "channel": "ark-auth:models",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "consoleStatus",
        "channel": "ark-auth:console-status",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "setApiKey",
        "channel": "ark-auth:set-api-key",
        // The plan publishes no key grammar, so this names no required prefix.
        "args": "{ apiKey: string (a Coding Plan API key), region?: 'cn-beijing' }",
        // This replaces the credential every Ark conversation spends, so it is
        // gated the way the logout beside it is rather than offered casually.
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "logout",
        "channel": "ark-auth:logout",
        "args": "",
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "consoleLogin",
        "channel": "ark-auth:console-login",
        "args": "",
        // Opens the Volcengine console sign-in in the browser and stores the
        // session that unlocks allowance reads; a login, not a spend, so it is
        // gated like the bailian console login beside it.
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "consoleLogout",
        "channel": "ark-auth:console-logout",
        "args": "",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "模型来源",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "mobileBridge",
    "about": "Remote control (Settings → Remote Control) for computers signed in to the same Klaus account. The 'Allow remote control of this device' switch decides whether this computer accepts phone connections and requires a signed-in account; the device list renames or removes registered computers. The same page has 'keep this computer awake while plugged in' for remote access, which only the user can change here.",
    "reads": [
      {
        "action": "get",
        "channel": "settings:mobile-bridge:get",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "devices",
        "channel": "settings:mobile-bridge:devices",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "set",
        "channel": "settings:mobile-bridge:set",
        "args": "{ enabled: boolean }",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "removeDevice",
        "channel": "settings:mobile-bridge:remove-device",
        "args": "{ deviceId: string } — from `devices`; deletes the server-side device record (the removed computer is signed out of remote access)",
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "renameDevice",
        "channel": "settings:mobile-bridge:rename-device",
        "args": "{ deviceId: string, name: string (at most 120 characters) }",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "设备与访问管理",
    "panel": [
      "settings",
      "mobile"
    ]
  },
  {
    "key": "systemPermission",
    "about": "macOS privacy permissions (TCC): Full Disk Access, Photos, Accessibility, Automation, Screen Recording, Notifications and Location (the Settings page is macOS-only). Status is probed live, so Accessibility and Screen Recording can only tell 'granted' from 'not granted'. The in-place grant prompt (Photos, Automation, Notifications) is the user's own button on that page; `open` only opens the matching System Settings pane. macOS caches a decision for a running process, so a permission granted in System Settings takes effect only after Klaus restarts.",
    "reads": [
      {
        "action": "check",
        "channel": "system:permissions:check",
        "args": "no arguments — read-only probe, never prompts; answers one status per permission",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "open",
        "channel": "system:permissions:open",
        "args": "{ type: 'fullDiskAccess'|'screenRecording'|'accessibility'|'automation'|'notification'|'location'|'photosLibrary' }",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "系统授权",
    "panel": [
      "settings",
      "systemAuth"
    ]
  },
  {
    "key": "externalImport",
    "about": "Importing from other agent clients detected on this machine (claude-code, qoder, codex). Importable item types are SESSIONS, SKILLS, MCP_SERVER_CONFIG and PROJECTS; CONFIG, HOOKS, COMMANDS, SUBAGENTS, AGENTS_MD and PLUGINS are accepted by the wire but always fail with 'no supported conversion'. Import copies; the source client is untouched, and an unchanged session file is skipped on re-import.",
    "reads": [
      {
        "action": "detect",
        "channel": "external-agent-import:detect",
        "args": "{ includeHome?: boolean (default true: user-level items and recent sessions), workspaceRoots?: string[] (extra project folders to scan) } — answers ready-made import items ({ providerId, itemType, cwd?, details }); pass the chosen ones to `import` unchanged",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "status",
        "channel": "external-agent-import:status",
        "args": "",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "import",
        "channel": "external-agent-import:import",
        "args": "{ items: [{ providerId: 'claude-code'|'qoder'|'codex', itemType: 'SESSIONS'|'SKILLS'|'MCP_SERVER_CONFIG'|'PROJECTS', cwd?: string (a project root returned by detect or already registered; omit for the user-level scope), details?: { sessions?: [{ path }] (SESSIONS: up to 200 transcript paths from detect), projectRoots?: string[] (PROJECTS) } }] } — at most 1000 items; answers { ok, imported, errors, skipped, projectRoots }",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "从其他客户端导入",
    "panel": [
      "settings",
      "externalImport"
    ]
  },
  {
    "key": "artifact",
    "about": "Artifacts the agent produced (pages, images, documents) and the preview that shows them. Reachable paths: the conversation's working directory (every root of a multi-folder workspace; an SSH project reads the remote file), the upload cache, its inline-visualization directory, and any file this conversation itself wrote even outside those roots; anything else answers 'path outside preview scope'. Inline visualizations need none of this — their page travels with the message.",
    "reads": [
      {
        "action": "read",
        "channel": "artifacts:read",
        "args": "{ sessionId?: string, filePath: string } — an absolute path; files over 1 MB come back truncated, binary files are flagged",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "fileUrl",
        "channel": "artifacts:file-url",
        "args": "{ sessionId?: string, filePath: string } — mints the scoped klaus-media:// capability URL the preview pane loads (HTML pages get a directory-bounded preview URL)",
        "confirm": false,
        "currentSession": true
      }
    ],
    "writes": [
      {
        "action": "openWindow",
        "channel": "artifacts:open-window",
        "args": "{ sessionId?: string, filePath: string, displayName?: string (the window title) }",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "openWorkspace",
        "channel": "artifacts:open-workspace",
        "args": "{ sessionId?: string } — opens that conversation's primary working directory in the file manager",
        "confirm": false,
        "currentSession": true
      },
      {
        "action": "reveal",
        "channel": "artifacts:reveal",
        "args": "{ filePath: string } — an absolute local path; shows it in the file manager",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "会话产物",
    "elsewhere": "the Artifacts section of the Overview panel (every file this conversation changed or produced, with source/preview toggle, open-in-window and reveal), the separate preview window `openWindow` opens, and file cards in the transcript. Browsing the whole folder is the Files tab."
  },
  {
    "key": "spec",
    "about": "Historical planning documents retained for inspection and export.",
    "reads": [
      {
        "action": "readDoc",
        "channel": "spec:read-doc",
        "args": "{ path: string } — an absolute .md file directly inside ~/.klaus/plans or <project>/.klaus/specs",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "openDoc",
        "channel": "spec:open-doc",
        "args": "{ path: string } — same shape as readDoc; opens the file in the operating system's default app for Markdown",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "计划模式",
    "elsewhere": "historical document review cards in saved conversations; current proposals use revisioned plan artifacts and the Plan panel."
  },
  {
    "key": "ssh",
    "about": "Remote hosts: the hosts from the user's SSH config and remote working directories. A registered ssh:// project's conversations run commands on the host, and its Files tab reads and edits the remote files; it has no Changes view. Password or passphrase prompts are answered only by the user in the app.",
    "reads": [
      {
        "action": "hosts",
        "channel": "ssh:list-hosts",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "dirs",
        "channel": "ssh:list-dirs",
        "args": "{ target: string, path?: string ('~' (default) or an absolute remote path) } — lists that directory's subdirectories",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "test",
        "channel": "ssh:test",
        "args": "{ target: string } — 'user@host', 'host:port' or an 'ssh://user@host/path' workdir string",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "makeWorkdir",
        "channel": "ssh:make-workdir",
        "args": "{ target: string, path: string (absolute remote path) } — touches nothing remote; only builds { workdir: 'ssh://…', label }, which project.add then registers",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "远程主机（SSH）",
    "elsewhere": "the Connect SSH modal in the project picker: host, then a remote directory, which is then registered as a project like a local folder."
  },
  {
    "key": "advisor",
    "about": "The advisor (顾问) is an optional model the main agent can consult through its advisor tool before substantial work, when stuck, and before finishing. The tool sends the current effective conversation context and a question to the selected source, consuming that source's quota, and returns advice without executing tools. Stored once globally: all chats share the pick independently of their main model. There is no model-rank requirement and it uses none of the high/medium/low tiers. In the UI it lives in Settings → Model Tiers: pick a source, then a model of that source, then enable; enabled without a model counts as off. Changes apply on the next turn; disabling preserves the pick. An unavailable advisor reports an error instead of falling back to another model.",
    "reads": [
      {
        "action": "get",
        "channel": "settings:advisor:get",
        "args": "no arguments — reads the global pick; answers { enabled, model, providerSupported, active, activeScope, readiness, status, error? }. active describes configuration activation, not a successful provider request; readiness remains unchecked until the engine resolves the target.",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "set",
        "channel": "settings:advisor:set",
        "args": "{ enabled?: boolean (omitted keeps the current flag), model?: string } — model is an explicit source:modelId selection, e.g. 'codex:<modelId>', where source is one of subscription|custom|codex|cursor|qoder|qwenwork|qoderwork|workbuddy|antigravity|trae|kiro|kimi|bailian|minimax|zhipu|ark; an empty string clears the pick. Omitting model preserves the saved pick, including when disabling. Enabling without a saved or supplied model is accepted and stays inert, exactly like a disabled advisor, until a model is chosen. Changes apply on the next turn.",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "顾问",
    "panel": [
      "settings",
      "modelTiers"
    ]
  },
  {
    "key": "featureModels",
    "about": "The auxiliary task models (辅助任务模型): one global pick each for chat title generation, composer message predictions, memory and dream maintenance, and the text refinement of dictation. Every slot defaults to an empty pick meaning the task follows the calling chat's main model; a slot can instead name an explicit source:modelId, possibly from another source than the chat's. title/prediction/memory are engine-bound: they publish to sessions as feature targets, and a configured target whose source or model became unavailable degrades silently to the chat's main model instead of failing the maintenance path. voiceRefinement never enters engine configuration; the host reads it when a dictation refinement starts, and a failed refinement keeps the recognizer text. In the UI title generation lives in Settings → Preferences → Conversation, message predictions in Settings → Preferences → Editor, speech refinement in Settings → Voice, and the memory slot in Settings → Dream. Engine-bound changes apply from the next call of running chats; the speech pick applies at the next dictation.",
    "reads": [
      {
        "action": "get",
        "channel": "settings:feature-models:get",
        "args": "no arguments — answers { ok, settings: { title, prediction, memory, voiceRefinement } }; each value is '' (follow the calling chat's main model, the default) or an explicit 'source:modelId' pick",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "set",
        "channel": "settings:feature-models:set",
        "args": "{ title?: string, prediction?: string, memory?: string, voiceRefinement?: string } — a partial patch; each supplied value is '' (follow the chat's main model) or 'source:modelId' where source is one of subscription|custom|codex|cursor|qoder|qwenwork|qoderwork|workbuddy|antigravity|trae|kiro|kimi|bailian|minimax|zhipu|ark and modelId names a model of that source. An invalid reference rejects the whole patch with feature_model_invalid. Changes to title/prediction/memory republish running sessions and apply from the next call; voiceRefinement applies at the next dictation refinement without a republish.",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "辅助任务模型",
    "panel": [
      "settings",
      "models"
    ]
  },
  {
    "key": "feedback",
    "about": "Sending feedback or a feature suggestion to the Klaus team. Externally visible, so both actions require confirmation.",
    "reads": [],
    "writes": [
      {
        "action": "submit",
        "channel": "feedback:submit",
        "args": "{ sessionId: string (the conversation the problem happened in; required), description: string } — attaches that conversation's id, working directory, transcript path, git state and app/system info; the report is saved under ~/.klaus/feedback first and only sent when the user is signed in",
        "confirm": true,
        "currentSession": false
      },
      {
        "action": "submitSuggestion",
        "channel": "feedback:suggestion-submit",
        "args": "{ description: string } — the suggestion text (saved under ~/.klaus/suggestions, sent only when signed in). File attachments are not available from here: they must first be picked in the app's own file picker",
        "confirm": true,
        "currentSession": false
      }
    ],
    "manualHeading": "反馈与建议",
    "elsewhere": "a bug report is the report entry in a conversation's ⋯ menu. A feature suggestion has no entry point in the window at all, so `submitSuggestion` here is the only way the user has to send one — offer it rather than telling them to look for a menu."
  },
  {
    "key": "runtime",
    "about": "Native Windows sandbox preparation used by runtime configuration. Preparation and readiness do not enable or change the configured sandbox level.",
    "reads": [{
      "action": "windowsSandboxReadiness",
      "channel": "settings:runtime:windows-sandbox-readiness",
      "args": "",
      "confirm": false,
      "currentSession": false
    }],
    "writes": [{
      "action": "startWindowsSandboxSetup",
      "channel": "settings:runtime:windows-sandbox-setup-start",
      "args": "{ mode: 'elevated'|'unelevated', cwd?: string|null } — prepare or refresh native isolation; enabling it is a separate configuration write",
      "confirm": false,
      "currentSession": false
    }],
    "manualHeading": "偏好设置",
    "panel": ["settings", "preferences"]
  },
  {
    "key": "preference",
    "about": "The user's own settings BY NAME instead of by storage row: appearance, language, notifications, follow-up mode, message predictions, web access, auto-record memory, voice, and the engine values with no settings page (maxToolConcurrency, budgetUsd, checkpoints, threadTools). Other Preferences-page rows live on their own surfaces: launch at login (app.setLoginItem), prevent sleep while running (cron.setKeepAwake), reply style (outputStyle.set), file-tree excludes (workspace.setExcludes). `list` is the catalog — every name, what it accepts, what it is right now, what it does when nobody has set it, and where the user sees it. Use this rather than `setting` for anything it covers: it checks the value before writing, and a value the store cannot parse is not stored at all — the row is dropped and the setting silently falls back to its default, which the user reads as 'nothing happened'.",
    "reads": [
      {
        "action": "list",
        "channel": "@preference.list",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "get",
        "channel": "@preference.get",
        "args": "{ name: string } — a name from `list`, never a storage key",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "set",
        "channel": "@preference.set",
        "args": "{ name: string, value: string } — both from `list`; an empty value on a number or a list clears it back to the default",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "偏好设置",
    "panel": [
      "settings",
      "preferences"
    ]
  },
  {
    "key": "setting",
    "about": "The raw settings store, addressed by storage row and NOT validated. `preference` covers the settings users actually ask about and checks what it writes — go there first; come here for a row it does not carry (an engine config row such as klaus.taskBudgetTokens; klaus.providerTrace 'on'/'off', the 'Developer debug log' switch on Settings → About; or something this machine stored that no panel shows). `list` shows what this machine has actually stored, and reading a value first tells you its shape.",
    "reads": [
      {
        "action": "list",
        "channel": "@setting.list",
        "args": "",
        "confirm": false,
        "currentSession": false
      },
      {
        "action": "get",
        "channel": "settings:kv:get",
        "args": "{ key: string }",
        "confirm": false,
        "currentSession": false
      }
    ],
    "writes": [
      {
        "action": "set",
        "channel": "settings:kv:set",
        "args": "{ key: string, value: any }",
        "confirm": false,
        "currentSession": false
      }
    ],
    "manualHeading": "数据都存在哪",
    "panel": [
      "settings",
      "preferences"
    ]
  }
];
export const CONTROL_EXCLUSIONS: Record<string, string> = {
  "session:view-retain": "renderer-owned transcript lifetime token; agents cannot impersonate a mounted view",
  "session:view-release": "renderer-owned transcript lifetime release for its exact owner token",
  "settings:computer-use:app-details": "owner settings list resolves artwork only for saved app approvals",
  "settings:computer-use:list-apps": "owner settings picker enumerates local apps for the saved approval list",
  "settings:computer-history:get": "owner settings tab reads the local observation timeline status",
  "settings:computer-history:set-enabled": "owner settings tab toggles local environment observation",
  "settings:computer-history:pause": "owner settings tab pauses local observation",
  "settings:computer-history:resume": "owner settings tab resumes local observation",
  "settings:computer-history:update-observation": "owner settings tab edits the observation policy list",
  "settings:computer-history:remove-observation-entry": "owner settings tab removes one observation policy entry",
  "settings:computer-history:clear-history": "owner settings tab clears the local timeline",
  "settings:computer-history:entries": "owner settings tab pages the local timeline for review",
  "app:content-find": "focused owner renderer's native text-search session",
  "app:native-menu-state": "focused owner renderer's native menu projection",
  "prototype:list": "owner design-panel switcher; agents use scoped prototype tools",
  "prototype:open": "owner design-panel navigation; agents use scoped prototype tools",
  "prototype:open-result": "owner design-panel presentation acknowledgement",
  "prototype:panel-close": "owner design-panel lifecycle",
  "prototype:panel-hide": "owner design-panel visibility",
  "prototype:panel-set-bounds": "owner design-panel geometry",
  "prototype:panel-show": "owner design-panel visibility",
  "prototype:runtime-action": "owner design-editor runtime transport; agents use scoped prototype tools",
  "settings:workspace-dependencies:get": "owner shared-runtime configuration; agents use load_workspace_dependencies",
  "settings:workspace-dependencies:diagnose": "owner shared-runtime repair diagnostics; agents use load_workspace_dependencies",
  "settings:workspace-dependencies:reinstall": "owner repair removes shared runtime versions and cached installations",
  "storage:usage": "owner profile-wide storage accounting",
  "storage:refresh": "owner profile-wide storage accounting refresh",
  "storage:review": "owner review issues a cleanup receipt across conversations",
  "storage:cleanup": "owner cleanup consumes its reviewed storage selection",
  "voice:chat:audio": "owner live-call microphone audio transport",
  "voice:chat:control": "owner live-call control transport",
  "voice:chat:end": "owner live-call lifecycle",
  "voice:chat:levels": "owner microphone level transport",
  "voice:chat:negotiate": "owner live-call negotiation",
  "voice:chat:present": "owner live-call presentation",
  "voice:chat:reserve": "owner microphone reservation",
  "voice:chat:state": "owner live-call state projection",
  "voice:hotwords:toggle": "legacy per-word enable toggle kept for stored entries; the dictation dictionary surface adds, edits and deletes words instead",
  "voice:memories:delete": "legacy voice-memory row deletion kept for stored rows; personalization superseded the memory list surface",
  "voice:memories:list": "legacy voice-memory rows kept for stored data; personalization superseded the memory list surface",
  "voice:overlay:control": "dedicated voice-overlay lifecycle transport",
  "voice:overlay:drag": "dedicated voice-overlay geometry transport",
  "voice:overlay:interaction": "dedicated voice-overlay interaction transport",
  "voice:overlay:state": "dedicated voice-overlay state projection",
  "worktree:list": "owner global worktree retention inventory and settings",
  "worktree:configure": "owner global worktree retention settings can schedule cleanup",
  "worktree:storage-delete": "owner snapshot-backed maintenance can archive owning conversations",
  'artifacts:authorize-preview': 'Owner file-viewer selection grants a canonical single-file read capability. Model tools may read already scoped artifacts through artifact.read and artifact.fileUrl, but cannot grant themselves access to another file.',
  'profile:activity': 'Owner profile dashboard projection of aggregate activity across conversation history; current-chat provider allowance remains available through account.usage.',
  'composer:prediction': 'Owner composer suggestion transport tied to the visible session, turn and renderer; agents use the existing conversation tools.',
  'composer:prediction:source': 'Owner composer discovery of the active suggestion turn and source; an agent cannot acquire the renderer-bound suggestion lifecycle.',
  'composer:prediction:availability': 'The composer suggestion UI reads the editor preference, engine capability and, for a covered subscription account, that account\'s own suggestion readiness; this creates no model-control capability.',
  'composer:prediction:cancel': 'Owner composer lifecycle cancellation for its renderer-bound suggestion request.',
  ...Object.fromEntries([
    ...DESKTOP_PET_CHANNELS,
    'desktop-pet:pick-attachments', 'desktop-pet:screenshot-sources', 'desktop-pet:attach-screenshot',
    'desktop-pet:remove-attachment', 'desktop-pet:submit-message',
    'desktop-pet:import-attachment', 'desktop-pet:conversation-state', 'desktop-pet:select-conversation',
    'desktop-pet:refresh-conversation', 'desktop-pet:stop-conversation', 'desktop-pet:react-message',
    'desktop-pet:composer-draft', 'desktop-pet:save-composer-draft',
    'desktop-pet:realtime-options', 'desktop-pet:realtime-state', 'desktop-pet:negotiate-realtime', 'desktop-pet:end-realtime',
    'desktop-pet:realtime-control', 'desktop-pet:realtime-audio',
    'desktop-pet:attach-foreground', 'desktop-pet:appshot-settings', 'desktop-pet:update-appshot-settings',
    'desktop-pet:ack-main-capture', 'desktop-pet:set-main-conversation',
  ].map(channel => [channel, 'Owned companion UI transport: panel input, microphone capture, parked request answers, attachment grants and catalog state belong to the companion window; agents use their existing scoped tools and cannot acquire these owner capabilities.'])),
  "power:snapshot": "renderer-only lifecycle context for the task and remote-access power policy",
  "power:request:set": "renderer-only task and remote-access observations; agents cannot impersonate active UI lifecycle owners",
  "settings:power:set": "owner settings transport; task sleep prevention is available through cron.setKeepAwake, while remote-access policy remains owner UI",
  "site-references:open-targets": "renderer-only opening menu target discovery and remembered user preference",
  "end-resources:targets": "renderer-only discovery of the applications that can open a turn-end resource the user is looking at",
  "end-resources:open": "renderer-only explicit click opening a scoped turn-end file or local site in an application the operating system lists for it",
  "end-resources:reveal": "renderer-only explicit click revealing a scoped turn-end file in the system file manager",
  "end-resources:download-copy": "renderer-only explicit click copying a scoped turn-end file into Downloads under a free name",
  "end-resources:existing": "renderer-only check of which scoped turn-end files still exist before their cards render",
  "end-resources:page-meta": "renderer-only read of a scoped page's own title and icon for its turn-end card",
  "site-references:open": "renderer-only explicit website click and opening preference; agents use the scoped browser surface",
  "settings:web-fetch-sources:get": "the web settings page reports that page fetching uses the built-in reader",
  "settings:web-search-sources:get": "the web settings page's own login-state read for the subscription search sources; each source's status is already reachable through its auth surface",
  "settings:runtime-config:get": "owner settings projection of scoped configuration and its file revision; agents use their existing file and preference tools",
  "settings:runtime-config:open": "owner settings action opening the selected configuration file in the editor; agents use their existing file tools",
  "friends:send-message": "owner composer direct delivery; agents send only through the dedicated friend messaging tool and its task scope checks",
  "friends:runtime": "owner UI task inbox and local resource grants; agents may not inspect other friend task conversations",
  "friends:set-receiver": "owner UI choice of the computer receiving external tasks",
  "friends:apps": "owner application picker; a task's Computer Use tools expose only its approved applications",
  "friends:approve": "owner-only task resource authorization, never an approval an agent can issue for itself",
  "friends:reject": "owner UI decision to reject a task request",
  "friends:ignore": "owner UI decision to quietly set a pending task request aside without any status reply to the friend",
  "friends:cancel": "owner UI revocation of a task's running authority",
  "friends:save-template": "owner-only persistent permission grant for this friend and receiving computer",
  "friends:revoke-template": "owner UI revocation of remembered resource authority",
  "friends:set-default-grant": "owner UI baseline permission grant new friendships start from",
  "friends:retry-reply": "owner UI retry of the approved result back to its original request",
  "friends:retry-send": "owner UI retry of one failed transmission with its original message identity",
  "friends:prepare-local-assist": "owner UI preparation of an independent local chat without starting inference or expanding the friend task grant",
  "friends:resolve-access-request": "owner-only answer to a running friend task's parked directory request; an agent can ask, never approve",
  "friends:pending-access-requests": "owner UI read of the directory requests still waiting for an answer on this computer",
  "friends:request-reply": "owner UI request that Klaus reply to a friend task that closed without a result (reusing the task's original grant), or that Klaus handle a request waiting in one of the owner's own conversations as an owner turn there",
  "browser-use:permission-answer": "the owner-drawn page-permission dialog's answer transport; the user's decision on a page permission is never an answer an agent submits",
  "friends:my-card": "owner's own scannable add-me card; it carries no capability over any friendship",
  "friends:save-qr-card": "owner UI save of their own QR image through the system file dialog",
  "friends:share-qr-card": "owner UI copy of their own invite card text to the clipboard",
  "app:camera-lease": "owner UI camera lease held only while the friends scan dialog is open",
  "app:camera-lease-release": "owner UI release of that camera lease",
  "friends:list": "renderer friend-management state; agents discover accepted friends through the named list_friends tool",
  "friends:lookup": "owner UI lookup by exact registered email before sending a friendship request",
  "friends:request": "owner UI decision to establish a cross-account relationship; task delegation uses send_message_to_friend",
  "friends:respond": "owner UI decision to accept or reject a friendship request, not authority delegated to an agent",
  "friends:set-authorization": "recipient-owned authorization decision; an agent cannot grant another account access on the owner's behalf",
  "friends:remove": "owner UI decision to end a friendship and revoke its shared relationship",
  "friends:set-remark": "owner's private local note about one friend; it never leaves this computer and grants nothing",
  "keymap:state": "the keyboard-shortcuts settings page's own read of keybindings.json; app-scope bindings are the user's UI preference and the two system hotkeys stay reachable through quickInput.setShortcut",
  "keymap:set": "the keyboard-shortcuts settings page's own write; same reasoning as keymap:state",
  "keymap:reset": "'reset all to defaults' is a destructive UI action the user takes on the settings page, not something an agent should do on their behalf",
  "keymap:capture-begin": "UI-session transport: brackets one recording so the host can release global hotkeys while the user presses the new key; carries no capability of its own",
  "keymap:capture-end": "UI-session transport: the matching release of keymap:capture-begin",
  "settings:mobile-bridge:restart": "internal transport recovery; the product surface is only the availability switch and device management",
  "settings:mobile-bridge:rotate-token": "legacy transport credential maintenance; pairing tokens are intentionally hidden from the product surface",
  "projects:resolve-root": "workspace path resolution is the sidebar's own transport",
  "projects:reorder": "the sidebar's own drag-reorder transport: it persists the user's hand-arranged Projects order. An agent has no business rearranging the user's sidebar, and the underlying project facts stay reachable through the project surface's list/add/remove, so this is excluded beside resolve-root rather than exposed",
  "artifacts:widget-url": "renderer-only minting of a checked, session-owned Widget revision for its sandboxed iframe; the agent creates revisions through the named show_widget host tool rather than invoking the renderer transport",
  "artifacts:save-copy": "renderer-only Save-As transport: the preview's own copy button re-checks the file against the artifact scope and then hands the destination to the user's native save dialog, so the placement is the user's decision and no agent capability rides on it; reading the bytes stays reachable as artifacts.read",
  "run-preview:open": "renderer-only manual reveal of a page already created by the named run_preview host tool; not a second way for an agent to open arbitrary Browser tabs",
  "run-preview:retry": "renderer-only retry for an existing run_preview call in its originating chat",
  "engine:workspaceFileSearchSessionStart": "renderer-only picker transport: the @-menu opens a persistent file-search session to avoid re-walking the tree per keystroke; an agent uses the one-shot engine.fileSearch read instead",
  "engine:workspaceFileSearchSessionQuery": "renderer-only picker transport: re-ranks a session's held snapshot for one keystroke; no agent capability beyond engine.fileSearch",
  "engine:workspaceFileSearchSessionStop": "renderer-only picker transport: closes a file-search session when the @-menu closes",
  "run-preview:state": "renderer-only status reconciliation for an existing run_preview call, not a new agent capability",
  "media:read-image": "renderer-only image transport for a picture the agent already produced: it returns the bytes of one already-granted image so the transcript frame can render, copy or save it. Every call re-validates its grant, and the capability behind it is already reachable as artifacts.read / artifacts.fileUrl, so this is not a second door",
  "media:save-image": "renderer-only native save dialog for one already-granted image, written to the path the user picks with mode 0600; the user chooses the destination, so it is not an agent write capability",
  "media:copy-image": "renderer-only clipboard copy of one already-granted image; the same bytes the frame already holds",
  "media:reveal-image": "renderer-only reveal-in-Finder for the local file behind an already-granted image, guarded by the same re-validation",
  "goal:set": "Goal editing, resume and explicit objective submission are authenticated user controls; models use their own restricted goal tools and cannot acquire user provenance through app control.",
  "goal:clear": "Revoking a goal is the user's decision; automatic completion cleanup is generation-bound UI transport.",
  "goal:prepare-objective": "Owner composer attachment preparation, scoped to one draft on the engine host.",
  "goal:read-objective": "Owner objective-editor reference hydration; models read goal context through their own goal tools.",
  "goal:discard-prepared-objective": "Owner draft cleanup cannot be invoked by a model.",
  "session:get-spec-mode": "Compatibility access to authoritative collaboration state for existing renderer call sites.",
  "session:set-spec-mode": "Compatibility renderer transport; current model capability is setCollaborationMode.",
  "plan:get": "Renderer artifact hydration; model planning state is already part of its engine context.",
  "plan:read-document": "Owner plan-editor materialization for a reviewed artifact and revision.",
  "plan:save-document": "Owner plan-editor changes must remain the user's reviewed content.",
  "plan:accept": "Implementation acceptance is the user's decision and cannot be granted by the model.",
  "plan:feedback": "Plan feedback is authenticated user input.",
  "plan:cancel": "Cancelling an implementation request is the user's decision.",
  "planning-input:pending": "Renderer-only recovery of structured planning questions.",
  "planning-input:answer": "Structured question answers are the user's decision and remain bound to their tool call.",
  "spec:save-doc": "native save dialog for a user-selected Markdown export",
  "permission:respond": "approval is the user's decision",
  "approval-review:approve": "Only the authenticated user can authorize a denied action for another automatic review; models cannot issue this authorization.",
  "permission:pending": "renderer-only recovery of the user's unresolved approval cards",
  "elicit:pending": "renderer-only recovery of the user's unanswered elicitation cards",
  "elicit:respond": "approval is the user's decision",
  "question:pending": "renderer-only recovery of the user's unanswered asynchronous questions",
  "question:answer": "the answer to an asynchronous question is the user's decision",
  "system:permissions:request": "the settings page's explicit consent request: it presents the macOS system dialog and the answer is the user's decision, so an agent must not trigger it on their behalf (the passive read stays available as system:permissions:check)",
  "memory-snapshot:respond": "approval is the user's decision",
  "session:set-permission-mode": "the approval policy of a conversation is the user's decision",
  "session:set-pinned": "sidebar organization is the user's decision",
  "chat:send": "turn transport",
  "chat:interrupt": "turn transport",
  "chat:continue": "turn transport",
  "chat:follow-up": "turn transport",
  "chat:side-question": "turn transport",
  "chat:side-question:cancel": "turn transport",
  "chat:queue-snapshot": "turn transport",
  "chat:queued-follow-ups": "turn transport",
  "chat:edit-queued": "turn transport",
  "chat:remove-queued": "turn transport",
  "chat:reorder-queued": "turn transport",
  "chat:client-queue-snapshot": "turn transport",
  "chat:client-queue-add": "turn transport",
  "chat:client-queue-remove": "turn transport",
  "chat:client-queue-restore": "turn transport",
  "chat:client-queue-reorder": "turn transport",
  "chat:client-queue-resume": "turn transport",
  "chat:client-queue-deliver": "turn transport",
  "chat:client-queue-clear": "turn transport",
  "chat:rewind-from": "turn transport",
  "chat:edit-message": "turn transport; truncates the conversation and re-runs the edited message, leaving files alone",
  // The read that refills the composer for the edit above: one sent user message's text and
  // attachment paths. It mutates nothing and carries no capability of its own, so it is
  // excluded exactly like the send it feeds.
  "chat:edit-prepare": "turn transport; read-only refill for chat:edit-message",
  "chat:upload": "turn transport",
  "chat:upload-path": "turn transport",
  "chat:pasted-text-create": "turn transport; stores a large composer paste as a host-owned text file and returns its reference",
  "chat:pasted-text-read": "turn transport; reads a stored paste back for restoring it into the composer",
  "chat:pasted-text-remove": "turn transport; deletes a stored paste a draft no longer references",
  "chat:pasted-text-release": "turn transport; drops ledger ownership once a draft is submitted, keeping the file for the sent message",
  "klausAuth:wipeLocal": "irreversible local data wipe",
  "terminal:start": "raw pty; use the shell tool",
  "terminal:write": "raw pty; use the shell tool",
  "terminal:resize": "raw pty; use the shell tool",
  "terminal:kill": "raw pty; use the shell tool",
  "session:pick-workdir": "native picker",
  "session:pick-workdirs": "native picker",
  "feedback:pick-attachments": "native picker",
  "clipboard:read-file-paths": "the clipboard belongs to whoever is typing",
  "clipboard:read-text": "the clipboard belongs to whoever is typing",
  "clipboard:write-text": "the clipboard belongs to whoever is typing",
  "ssh:askpass-answer": "credential prompt reply",
  "channels:wechat:qrStart": "QR pairing loop",
  "channels:wechat:qrPoll": "QR pairing loop",
  "channels:whatsapp:start": "QR pairing loop",
  "channels:whatsapp:poll": "QR pairing loop",
  "mcp:device:start": "device-code poll loop",
  "mcp:device:wait": "device-code poll loop",
  "mcp:device:cancel": "device-code poll loop",
  "mcp:device:client-id": "device-code poll loop",
  "voice:session:start": "live microphone leg",
  "voice:session:audio": "live microphone leg",
  "voice:session:stop": "live microphone leg",
  "voice:session:cancel": "live microphone leg",
  "skills:upload": "inline byte buffer",
  "voice:transcribe": "inline byte buffer",
  "klausAuth:uploadAvatar": "inline byte buffer",
  "window:setTitleBarColors": "window chrome",
  "klausAuth:loginWindow": "window chrome",
  "quick-input:submit": "turn transport: the card's text starts a conversation",
  "quick-input:hide": "the card's own view state; quickInput.hideCard is the exposed door",
  "quick-input:language": "the card reading its own label language",
  "browser-use:set-bounds": "window chrome",
  "computer-use-pip:get-state": "window presentation state",
  "computer-use-pip:set-host-layout": "window presentation geometry",
  "computer-use-pip:set-visibility": "user-owned preview visibility",
  "browser-use:set-conversation": "window chrome",
  "browser-use:view-available": "window chrome",
  "browser-use:view-input": "window chrome",
  "app:setApprovalBadge": "renderer view state",
  "composer:edit-focus": "renderer view state",
  "side-task:touch": "renderer view state",
  "agents:load-tasks": "renderer view state",
  "agents:save-tasks": "renderer view state",
  "session:background-processes": "Overview projection; the model already owns bash_output and write_stdin",
  "session:background-process-output": "process workspace output cursor; the model already owns bash_output and write_stdin",
  "session:stop-background-process": "process workspace control; the model already owns kill_shell",
  "mcp:trust:decide": "removed feature; the stub changes nothing",
  "mcp:trust:reset": "removed feature; the stub changes nothing",
  "agents:snapshot": "renderer task-state reconciliation; the model reads agents:history and background summaries",
  "dream:stop": "always answers ok:false; the engine exposes no abort",
  "canvas:load": "the preview page's own file read; the model has file tools",
  "canvas:state-write": "the preview page persisting user view state",
  "canvas:action": "the preview page's own host actions",
  "canvas:send-to-chat": "turn transport: it writes the user's composer, like quick-input:submit",
  "canvas:open": "canvas_check opens a clean canvas; no second door",
  "canvas:open-result": "renderer acknowledgement for the canvas_check presentation request",
  "canvas:list": "renderer view state; the canvas dir is on disk for the model to read",
  "canvas:panel-show": "right-panel child-webview lifecycle; canvas_check opens it",
  "canvas:panel-set-bounds": "right-panel child-webview geometry",
  "canvas:panel-hide": "right-panel child-webview lifecycle",
  "canvas:panel-close": "right-panel child-webview lifecycle",
  "digram:list": "panel document switcher; the agent uses digram_open/digram_get",
  "digram:get": "panel read; the agent uses the digram_get tool",
  "digram:apply-edit": "panel drag-edit write; the agent uses digram_edit",
  "digram:icons": "panel icon-path resolution for rendering; the agent uses digram_icons_search",
  "digram:history": "panel history UI; the agent uses digram_history",
  "digram:revert": "panel revert UI; the agent uses digram_revert",
  "digram:export": "panel export button; the agent uses the digram_export tool",
  "digram:render-result": "the renderer answering a headless render-request; internal transport",
  "model3d:list": "panel document switcher; the agent uses model3d_scene",
  "model3d:get": "panel document read; the agent uses model3d_serialize",
  "model3d:mesh": "panel geometry buffer fetch; the agent uses model3d_mesh",
  "model3d:apply": "panel drag write-back; the agent uses the model3d_* mutating tools",
  "model3d:render-result": "the renderer answering a delegated render request; internal transport",
  "collaboration:request": "the team-collaboration page's own transport to the shared service (projects/issues/discussions/members/invitations/files/executions); no agent tool exposes that surface",
  "collaboration:watch": "the team-collaboration page subscribing to the account/project event stream; internal transport",
  "collaboration:local-binding": "read-only resolution of this device's local folder binding for a project; the page's own storage",
  "collaboration:set-local-binding": "the user's device-local folder binding; it never leaves this machine and the page owns the picker that produces it",
  "collaboration:pick-local-folder": "opens a native folder picker; the user must choose the folder",
  "collaboration:draft-project": "the project form's own drafting call into a scratch read-only session",
  "collaboration:draft-issue": "the issue form's own drafting call into a scratch read-only session",
  "collaboration:cancel-draft": "cancels the page's own in-flight drafting request",
  "collaboration:execute": "runs a project Agent definition on the member's own machine; the request is the user's, made from the issue or discussion they are looking at",
  "collaboration:local-agents": "lists the local Agent definitions this account registered; the page's own picker source",
  "collaboration:download-file": "native save dialog for an attachment the user chose to download",
  "collaboration:preview-file": "inline image preview of an attachment the user opened",
  "featureGates:snapshot": "the renderer's read of server-resolved feature gates (which shipped features this account may see); eligibility is the server's decision, and an agent changing its own gates is not a capability"
};
export const NAV_VIEWS: [string, string][] = [
  [
    "chat",
    "the conversation itself (closes any full-screen page)"
  ],
  [
    "settings",
    "the settings window; pass `tab` to land on one"
  ],
  [
    "cron",
    "Scheduled Tasks"
  ],
  [
    "skills",
    "Skills"
  ],
  [
    "plugins",
    "Plugins"
  ],
  [
    "mcp",
    "MCP & connectors"
  ],
  [
    "memory",
    "Memory & dreams"
  ],
  [
    "agents",
    "Sub-agents"
  ],
  [
    "channels",
    "Messaging channels"
  ],
  [
    "friends",
    "Friends: friend list and requests, sent tasks, and each friend's incoming tasks"
  ],
  [
    "team-collaboration",
    "Shared engineering projects, issues and project discussions (only when that feature is enabled for the account)"
  ],
  [
    "slash-commands",
    "Slash commands"
  ]
];
export const NAV_SETTINGS_TABS: string[] = [
  "pets",
  "profile",
  "friends",
  "preferences",
  "keyboard",
  "voiceInput",
  "externalImport",
  "archivedSessions",
  "models",
  "modelTiers",
  "multimodal",
  "engineWeb",
  "permissions",
  "hooks",
  "engineMemory",
  "mobile",
  "computerUse",
  "systemAuth",
  "about"
];
