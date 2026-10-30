// Command registry consistency: the rules that keep the settings page, the
// read-only dialog, the dispatcher and the native menu from disagreeing.
//
// These are invariants of the TABLE rather than of the engine, so they live apart
// from keybindings-contract.test.ts. Each one names the failure it prevents: a
// row that cannot be executed, a duplicate id that shadows another command, a
// key two commands both claim, an i18n key with no translation, or a binding the
// application menu already owns.

import { describe, expect, test } from 'bun:test'
import {
  KeybindingRegistry,
  acceleratorsOverlap,
  canAppendBinding,
  defaultKeybindings,
  effectiveKeybindings,
  isAppScope,
  isConfigurable,
  isEquivalentCommand,
  isOsGlobal,
  findHandoffCommand,
  menuAccelerators,
  reservedFindCommand,
  sectionKeyOf,
  COMMAND_GROUP_ORDER,
  type KeybindingCommand,
  type KeybindingPlatform,
} from '../../../../contracts/keybindings'
import { FIND_COMMAND_ID, HOST_COMMAND_IDS, KLAUS_COMMANDS } from '../../../../contracts/keybindings-commands'
import { I18N } from '../../i18n/messages'

const PLATFORMS: KeybindingPlatform[] = ['macOS', 'windows', 'linux']

function registryFor(platform: KeybindingPlatform): KeybindingRegistry {
  return new KeybindingRegistry(KLAUS_COMMANDS, {
    platform,
    capabilities: new Set(['browser', 'dictation', 'terminal', 'voice', 'worktree']),
    ...(FIND_COMMAND_ID == null ? {} : { findCommandId: FIND_COMMAND_ID }),
  })
}

describe('command registry invariants', () => {
  test('every command id is unique, so no binding can be shadowed', () => {
    const ids = KLAUS_COMMANDS.map(command => command.id)
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index)
    expect(duplicates).toEqual([])
    // The registry constructor throws on a duplicate; reaching this far with all
    // three platforms proves it did not.
    for (const platform of PLATFORMS) expect(() => registryFor(platform)).not.toThrow()
  })

  test('every command declares a group from the dialog ordering, or none', () => {
    for (const command of KLAUS_COMMANDS) {
      if (command.group == null) continue
      expect(COMMAND_GROUP_ORDER).toContain(command.group)
    }
  })

  test('every group used by a command appears in the dialog section order', () => {
    const used = new Set(KLAUS_COMMANDS.map(command => sectionKeyOf(command)))
    const sections = [...COMMAND_GROUP_ORDER, 'general']
    for (const group of used) expect(sections).toContain(group)
  })

  test('every title, description and menu label has both an English and a Chinese string', () => {
    const missing: string[] = []
    for (const command of KLAUS_COMMANDS) {
      for (const key of [command.titleI18n, command.descriptionI18n, command.menuTitleI18n]) {
        if (key == null) continue
        if (I18N.en[key] == null) missing.push(`en:${key}`)
        if (I18N.zh[key] == null) missing.push(`zh:${key}`)
      }
    }
    expect(missing).toEqual([])
  })

  test('every command title and description is actually distinct copy, not a repeated key', () => {
    // A copy-paste slip here would show the same row description under several
    // commands, which reads as a bug in the settings page. One deliberate
    // exception: the numbered thread1..9 family shares a single description
    // (the rows differ only by number), so it is excluded rather than allowed
    // to mask a real duplicate elsewhere.
    const isThreadNumber = (command: KeybindingCommand) => /^thread[1-9]$/.test(command.id);
    const descriptions = KLAUS_COMMANDS
      .filter(command => !isThreadNumber(command))
      .map(command => I18N.en[command.descriptionI18n] ?? command.descriptionI18n);
    const duplicates = descriptions.filter((value, index) => descriptions.indexOf(value) !== index);
    expect(duplicates).toEqual([]);
    // Titles are unique even within the numbered family (Go to chat 1..9).
    const titles = KLAUS_COMMANDS.map(command => I18N.en[command.titleI18n] ?? command.titleI18n);
    const titleDupes = titles.filter((value, index) => titles.indexOf(value) !== index);
    expect(titleDupes).toEqual([]);
  })

  test('the two os-global commands are exactly the host-owned system hotkeys', () => {
    const globals = KLAUS_COMMANDS.filter(isOsGlobal).map(command => command.id)
    expect([...globals].sort()).toEqual([...HOST_COMMAND_IDS].sort())
    for (const id of HOST_COMMAND_IDS) {
      const command = KLAUS_COMMANDS.find(candidate => candidate.id === id)!
      expect(command.kind).toBe('host-only')
      // os-global takes one binding, so the append affordance must not appear.
      expect(canAppendBinding(command)).toBe(false)
    }
  })

  test('no renderer command is also declared host-only', () => {
    for (const command of KLAUS_COMMANDS) {
      if (command.kind === 'host-only') expect(isOsGlobal(command)).toBe(true)
      else expect(isOsGlobal(command)).toBe(false)
    }
  })
})

describe('default bindings', () => {
  test('no two commands default to the same key on the same platform', () => {
    for (const platform of PLATFORMS) {
      const registry = registryFor(platform)
      const claims = new Map<string, string[]>()
      for (const command of KLAUS_COMMANDS) {
        for (const accelerator of defaultKeybindings(command, platform)) {
          const owners = claims.get(accelerator) ?? []
          owners.push(command.id)
          claims.set(accelerator, owners)
        }
      }
      const collisions = [...claims].filter(([, owners]) => owners.length > 1)
        // Equivalent pairs are allowed to share a key by design.
        .filter(([accelerator, owners]) => owners.some(owner => owners.some(other => other !== owner && !isEquivalentCommand(owner, other))))
        .map(([accelerator, owners]) => ({ platform, accelerator, owners }))
      expect(collisions).toEqual([])
    }
  })

  test('every default key that overlaps another command is an equivalent pair', () => {
    // This is the ⌘K case: openCommandMenu holds ⌘K and the work panel holds the
    // ⌘K W chord. The overlap is real and intentional; what makes it safe is that
    // the two commands are declared equivalent AND the runtime gates them by
    // surface. A NEW unexplained overlap must fail here.
    const registry = registryFor('macOS')
    const overlapping: Array<[string, string, string]> = []
    for (const left of KLAUS_COMMANDS) {
      for (const right of KLAUS_COMMANDS) {
        if (left.id >= right.id) continue
        for (const leftKey of effectiveKeybindings(left.id, null, registry)) {
          for (const rightKey of effectiveKeybindings(right.id, null, registry)) {
            if (acceleratorsOverlap(leftKey, rightKey, 'macOS') && !isEquivalentCommand(left.id, right.id)) {
              overlapping.push([left.id, right.id, `${leftKey} ~ ${rightKey}`])
            }
          }
        }
      }
    }
    expect(overlapping).toEqual([])
  })

  test('no default binding claims a key reserved for native Find navigation', () => {
    for (const platform of PLATFORMS) {
      const reserved = KLAUS_COMMANDS
        .filter(command => command.id !== FIND_COMMAND_ID)
        .flatMap(command => defaultKeybindings(command, platform))
        .filter(accelerator => reservedFindCommand(accelerator, platform) != null)
      expect(reserved).toEqual([])
    }
  })

  test('content Find owns the bindable default key while chat search keeps its own shortcut', () => {
    // Content Find dispatches to the focused surface. The chat palette remains
    // independently configurable and does not claim the same default.
    for (const platform of PLATFORMS) {
      expect(reservedFindCommand('CmdOrCtrl+F', platform)).toBeNull()
      expect(findHandoffCommand('CmdOrCtrl+F', platform)).toBe('find')
      expect(defaultKeybindings(registryFor(platform).get('findInThread'), platform)).toContain('CmdOrCtrl+F')
    }
  })

  test('the ⌘W split keeps the work panel off the macOS application menu key', () => {
    // Electron resolves a menu accelerator in the main process BEFORE the renderer
    // sees the keydown, so a renderer binding on ⌘W could never fire on macOS.
    // Verified against the real menu: Electron 44's `File > close` role carries
    // CommandOrControl+W (confirmed by building that template with
    // Menu.buildFromTemplate). Windows/Linux install no application menu, so the
    // renderer owns Ctrl+W there.
    const mac = registryFor('macOS')
    const win = registryFor('windows')
    expect(defaultKeybindings(mac.get('workspaceCloseTab'), 'macOS')).toEqual([])
    expect(defaultKeybindings(win.get('workspaceCloseTab'), 'windows')).toEqual(['Ctrl+W'])
  })

  test('no default binding collides with an application-menu role accelerator', () => {
    // The macOS menu keeps Electron's built-in roles, whose accelerators are fixed
    // and resolved ahead of the renderer. A command defaulting to one of them
    // would look bound in the settings page and never fire.
    const menuOwned = new Set([
      'CommandOrControl+Q', 'CommandOrControl+W', 'CommandOrControl+Z', 'Shift+CommandOrControl+Z',
      'CommandOrControl+X', 'CommandOrControl+C', 'CommandOrControl+V', 'Cmd+Option+Shift+V',
      'CommandOrControl+A', 'CommandOrControl+R', 'Shift+CommandOrControl+R', 'Alt+Command+I',
      'CommandOrControl+0', 'CommandOrControl+Plus', 'CommandOrControl+-',
      // F/G/Shift+G are NOT here: measured by building the `editMenu` role with
      // Electron's Menu.buildFromTemplate, the macOS Edit menu carries no Find
      // items, so those accelerators reach the renderer and stay available.
      'Command+H', 'Command+Alt+H',
    ])
    const mac = registryFor('macOS')
    const collisions: string[] = []
    for (const command of KLAUS_COMMANDS) {
      // The work panel's own ⌘S is deliberately exempt: it is scoped to the work
      // panel surface by the runtime gate, and nothing in the menu claims ⌘S.
      for (const accelerator of defaultKeybindings(command, 'macOS')) {
        const normalized = accelerator.replace(/CmdOrCtrl/g, 'CommandOrControl')
        if (menuOwned.has(normalized)) collisions.push(`${command.id}=${accelerator}`)
      }
    }
    expect(collisions).toEqual([])
    expect(mac.list().length).toBeGreaterThan(0)
  })
})

describe('menu accelerators', () => {
  test('a chord default never becomes a menu accelerator', () => {
    const registry = registryFor('macOS')
    // workspaceCloseAll defaults to the ⌘K W chord; an Electron menu item cannot
    // express a sequence, so it must not advertise one.
    expect(defaultKeybindings(registry.get('workspaceCloseAll'), 'macOS')).toEqual(['CmdOrCtrl+K W'])
    expect(menuAccelerators('workspaceCloseAll', null, registry)).toEqual([])
  })

  test('every command with a menu label yields a usable accelerator on macOS', () => {
    const registry = registryFor('macOS')
    for (const command of KLAUS_COMMANDS) {
      if (command.menuTitleI18n == null) continue
      const accelerators = menuAccelerators(command.id, null, registry)
      // A menu item with no accelerator is allowed (it just shows no key hint),
      // but a label with a chord-only binding would be a silent dead hint.
      for (const accelerator of accelerators) {
        expect(accelerator.includes(' ')).toBe(false)
        expect(reservedFindCommand(accelerator, 'macOS')).toBeNull()
      }
    }
  })
})

describe('scope declarations', () => {
  test('app-scoped commands are surface-gated and none is os-global', () => {
    for (const command of KLAUS_COMMANDS) {
      if (isAppScope(command)) expect(isOsGlobal(command)).toBe(false)
    }
    // The work panel's keys are app-scoped: they only apply while that surface is
    // up, which the runtime enforces through its canStart gate.
    for (const id of ['workspaceSave', 'workspaceCloseTab', 'workspaceCloseOthers', 'workspaceCloseAll', 'workspaceCloseUnsaved']) {
      const command = KLAUS_COMMANDS.find(candidate => candidate.id === id)
      expect(command).toBeTruthy()
      expect(isAppScope(command!)).toBe(true)
    }
  })

  test('every command is configurable and therefore editable in the settings page', () => {
    // No command is marked non-configurable yet; if a read-only row is added
    // it must be added deliberately, with a reason, and this test
    // is where that decision gets recorded.
    const locked = KLAUS_COMMANDS.filter(command => !isConfigurable(command)).map(command => command.id)
    expect(locked).toEqual([])
  })

  test('Find navigation keys remain reserved for the active content surface', () => {
    expect(FIND_COMMAND_ID).toBeNull()
    const registry = registryFor('macOS')
    expect(registry.findCommandId).toBeNull()
    // Find-next/previous stay outright reservations: no command may take them.
    expect(reservedFindCommand('Command+G', 'macOS')).toBe('findNext')
    expect(reservedFindCommand('Shift+F3', 'windows')).toBe('findPrevious')
    // ⌘F is a handoff instead: it binds, lists and conflict-checks like any
    // command key, and only an active in-surface find bar takes it over.
    expect(reservedFindCommand('CmdOrCtrl+F', 'macOS')).toBeNull()
    expect(findHandoffCommand('CmdOrCtrl+F', 'macOS')).toBe('find')
  })
})

describe('every command can actually run', () => {
  // A command that appears in the settings page but has no handler is the worst
  // failure mode here: the user binds a key, presses it, and nothing happens.
  // The settings dialog lists only commands with a handler; this pins the same
  // invariant from the other side — the table and the wiring
  // must agree, so adding a command without wiring it fails the suite.
  // HANDLED mirrors app/keybindings/commands.ts, the fallback map.
  const HANDLED: Record<string, string> = {
    findInThread: 'fallback', closeContentFind: 'fallback', newProject: 'fallback', navigateBack: 'fallback', navigateForward: 'fallback',
    previousTab: 'fallback', nextTab: 'fallback', newBrowserTab: 'fallback',
    focusBrowserAddressBar: 'fallback', reloadBrowserPage: 'fallback',
    newChat: 'fallback', openFolder: 'fallback', renameThread: 'fallback',
    archiveThread: 'fallback', toggleThreadPin: 'fallback', forkThread: 'fallback',
    previousThread: 'fallback', nextThread: 'fallback', nextThreadNeedingAttention: 'fallback',
    openCommandMenu: 'fallback',
    searchFiles: 'fallback', toggleSidebar: 'fallback', toggleWorkPanel: 'fallback',
    toggleTerminal: 'fallback', toggleFilesPanel: 'fallback', toggleChangesPanel: 'fallback',
    toggleOverviewPanel: 'fallback', toggleBrowserPanel: 'fallback', settings: 'fallback',
    keyboardShortcuts: 'fallback', openSkills: 'fallback', openSlashCommands: 'fallback',
    openAgents: 'fallback', openMcp: 'fallback', openPlugins: 'fallback',
    openChannels: 'fallback', openCron: 'fallback', openMemory: 'fallback',
    logOut: 'fallback',
    showKeyboardShortcuts: 'dialog host',
    // Registered by the surface that owns the action, also as a fallback handler.
    workspaceSave: 'workspace panel', workspaceCloseTab: 'workspace panel',
    workspaceCloseOthers: 'workspace panel', workspaceCloseAll: 'workspace panel',
    workspaceCloseUnsaved: 'workspace panel', composerToggleVoice: 'voice', startVoiceChat: 'voice chat',
    // Host-owned: the main process registers these with Electron globalShortcut.
    summonMainWindow: 'host', openQuickInput: 'host', toggleDesktopPet: 'host', toggleVoiceChat: 'host',
  };

  test('the handled list covers every registry command, with no typo either way', () => {
    const ids = KLAUS_COMMANDS.map(command => command.id)
    const handled = Object.keys(HANDLED)
    // thread1..9 are wired by index in the fallback map, so they are the only
    // registry ids legitimately absent from the explicit list above.
    const numbered = ids.filter(id => /^thread[1-9]$/.test(id))
    expect(numbered).toHaveLength(9)
    // A registry command with no handler would be a dead row in the settings page.
    expect(ids.filter(id => !handled.includes(id) && !numbered.includes(id)).sort()).toEqual([])
    // A handler naming an unknown command is a typo that silently binds nothing.
    expect(handled.filter(id => !ids.includes(id)).sort()).toEqual([])
  })

  test('no host-owned command is also wired into the renderer fallback map', () => {
    // os-global commands register with globalShortcut in the main process; if the
    // renderer also had a handler, one keypress could fire the action twice.
    for (const id of HOST_COMMAND_IDS) {
      expect(HANDLED[id]).toBe('host')
      expect(KLAUS_COMMANDS.find(command => command.id === id)!.kind).toBe('host-only')
    }
    for (const [id, where] of Object.entries(HANDLED)) {
      if (where === 'fallback') expect(HOST_COMMAND_IDS).not.toContain(id)
    }
  })
})

describe('registry views', () => {
  test('the visible list on every platform includes the commands the UI offers', () => {
    for (const platform of PLATFORMS) {
      const registry = registryFor(platform)
      const visible = registry.visible().map(command => command.id)
      for (const id of ['newChat', 'openFolder', 'toggleSidebar', 'settings', 'showKeyboardShortcuts', 'openCommandMenu']) {
        expect(visible).toContain(id)
      }
      // The two system hotkeys are host-owned, so they are visible in the list but
      // never dispatched in-window.
      for (const id of HOST_COMMAND_IDS) expect(visible).toContain(id)
    }
  })

  test('a command gated on a missing capability disappears rather than showing a dead row', () => {
    const bare = new KeybindingRegistry(KLAUS_COMMANDS, { platform: 'macOS', capabilities: new Set() })
    const visible = bare.visible().map(command => command.id)
    // toggleTerminal is gated on the terminal capability.
    expect(visible).not.toContain('toggleTerminal')
    // With the capability present it returns.
    expect(registryFor('macOS').visible().map(command => command.id)).toContain('toggleTerminal')
  })

  test('bindings still resolve for a command hidden by a missing capability', () => {
    // Hiding a row must not silently drop a user's stored binding: the value
    // stays in the file and returns when the capability does.
    const bare = new KeybindingRegistry(KLAUS_COMMANDS, { platform: 'macOS', capabilities: new Set() })
    const state = { supported: true, keymapPath: '', bindings: [{ command: 'toggleTerminal', key: 'Control+Shift+T' }] }
    expect(effectiveKeybindings('toggleTerminal', state, bare)).toEqual(['Control+Shift+T'])
  })
})
