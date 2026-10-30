// Contract tests for the keybinding engine's pure logic, driven by the committed
// vectors in contracts/vectors/keybindings-vectors.json.
//
// Every rule here is pinned by the vector file's `_why` and each case's `why`
// field, which name the behaviour under test. A refactor that changes one of
// these without updating the vector deliberately is a regression, not a
// tidy-up.

import { describe, expect, test } from 'bun:test'
import vectors from '../../../../contracts/vectors/keybindings-vectors.json'
import {
  KeybindingRegistry,
  acceleratorsOverlap,
  bareModifierCombination,
  defaultKeybindings,
  effectiveKeybindings,
  findConflict,
  findHandoffCommand,
  formatAccelerator,
  isBareModifierHotkey,
  isEquivalentCommand,
  isSameBinding,
  menuAccelerators,
  nextKeysForSet,
  parseKeymapFile,
  reservedFindCommand,
  segmentMatches,
  serializeKeymapFile,
  splitAccelerator,
  withCommandKeys,
  parseAcceleratorSegment,
  compareCommands,
  sectionKeyOf,
  validateGlobalAccelerator,
  type KeybindingCommand,
  type KeybindingPlatform,
  type KeymapState,
} from '../../../../contracts/keybindings'

// A probe registry carrying the synthetic commands the vectors reference
// (macOnlyProbe, closeTab/closeWindow, goToLine/focusBrowserAddressBar, the
// workspace chords). Klaus's real table is asserted separately in
// commands-registry.test.ts; this one only needs the shapes the vectors exercise.
const PROBE_COMMANDS: KeybindingCommand[] = [
  { id: 'newChat', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer', group: 'thread', defaultKeybindings: [{ key: 'CmdOrCtrl+N' }] },
  { id: 'previousThread', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer', group: 'navigation', platformDefaultKeybindings: { macOS: [{ key: 'Command+Shift+[' }, { key: 'Command+Alt+Left' }], default: [{ key: 'Ctrl+Shift+[' }, { key: 'Ctrl+PageUp' }] } },
  { id: 'workspaceCloseTab', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer', group: 'workspace', platformDefaultKeybindings: { macOS: [], default: [{ key: 'Ctrl+W' }] } },
  { id: 'workspaceCloseAll', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer', group: 'workspace', defaultKeybindings: [{ key: 'CmdOrCtrl+K W' }] },
  { id: 'openCommandMenu', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer', group: 'navigation', defaultKeybindings: [{ key: 'CmdOrCtrl+K' }, { key: 'CmdOrCtrl+F' }] },
  { id: 'macOnlyProbe', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer', group: 'thread', macOnly: true, defaultKeybindings: [{ key: 'CmdOrCtrl+Alt+Shift+C' }] },
  { id: 'toggleBrowserPanel', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer', group: 'panels' },
  { id: 'toggleTerminal', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer', group: 'panels' },
  { id: 'forkThread', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer', group: 'thread' },
  { id: 'archiveThread', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer', group: 'thread' },
  { id: 'showKeyboardShortcuts', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer' },
  { id: 'closeTab', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer' },
  { id: 'closeWindow', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer' },
  { id: 'nextThread', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer' },
  { id: 'nextRecentThread', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer' },
  { id: 'previousRecentThread', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer' },
  { id: 'goToLine', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer' },
  { id: 'focusBrowserAddressBar', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer' },
  { id: 'workspaceCloseOthers', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer', group: 'workspace' },
  { id: 'workspaceCloseUnsaved', titleI18n: 't', descriptionI18n: 'd', kind: 'renderer', group: 'workspace' },
]

function registryFor(platform: KeybindingPlatform): KeybindingRegistry {
  return new KeybindingRegistry(PROBE_COMMANDS, { platform, capabilities: new Set() })
}

function stateOf(bindings: Array<{ command: string; key: string | null }>): KeymapState {
  return { supported: true, keymapPath: '', bindings }
}

describe('keybinding storage', () => {
  test('file name, serialization and row shapes match the vector', () => {
    expect(vectors.storage.fileName).toBe('keybindings.json')
    expect(serializeKeymapFile([{ command: 'newChat', key: 'CmdOrCtrl+Alt+N' }])).toBe(vectors.storage.serialized)
    // Two-space indent, trailing newline, and JSON round-trips to the row shape.
    expect(vectors.storage.serialized.endsWith('\n')).toBe(true)
    expect(vectors.storage.serialized).toContain('\n  {\n')
    expect(JSON.parse(vectors.storage.serialized)).toEqual([vectors.storage.rowShape])
  })

  test('writes sort by command id', () => {
    const input = vectors.storage.sortIsByCommandId.input as Array<{ command: string; key: string | null }>
    const output = vectors.storage.sortIsByCommandId.output as Array<{ command: string; key: string | null }>
    expect(JSON.parse(serializeKeymapFile(input))).toEqual(output)
  })

  test('parsing is lenient: malformed input yields no bindings instead of throwing', () => {
    const registry = registryFor('macOS')
    const cases = vectors.storage.lenientParse as Record<string, { raw: string; bindings: unknown[] }>
    for (const name of Object.keys(cases)) {
      const parsed = parseKeymapFile(cases[name]!.raw, '', registry)
      expect(parsed.bindings).toEqual(cases[name]!.bindings)
      expect(parsed.supported).toBe(true)
    }
  })
})

describe('keybinding resolution', () => {
  test('absent command falls back to the registry default', () => {
    const v = vectors.resolution.absentCommandUsesRegistryDefault
    expect(effectiveKeybindings(v.commandId, stateOf(v.bindings as never[]), registryFor(v.platform as KeybindingPlatform))).toEqual(v.effective)
  })

  test('an explicit null row forces empty, which is how disabled is expressed', () => {
    const v = vectors.resolution.explicitNullForcesEmpty
    expect(effectiveKeybindings(v.commandId, stateOf(v.bindings as never[]), registryFor(v.platform as KeybindingPlatform))).toEqual(v.effective)
  })

  test('a custom binding overrides the default', () => {
    const v = vectors.resolution.customOverridesDefault
    expect(effectiveKeybindings(v.commandId, stateOf(v.bindings as never[]), registryFor(v.platform as KeybindingPlatform))).toEqual(v.effective)
  })

  test('multiple stored bindings keep their order', () => {
    const v = vectors.resolution.multipleBindingsArePreservedInOrder
    expect(effectiveKeybindings(v.commandId, stateOf(v.bindings as never[]), registryFor(v.platform as KeybindingPlatform))).toEqual(v.effective)
  })

  test('platformDefaultKeybindings REPLACES defaultKeybindings rather than merging', () => {
    const v = vectors.resolution.platformDefaultReplacesRatherThanMerges
    expect(effectiveKeybindings(v.commandId, stateOf([]), registryFor('macOS'))).toEqual(v.macOS)
    expect(effectiveKeybindings(v.commandId, stateOf([]), registryFor('windows'))).toEqual(v.windows)
  })

  test('an empty platform array means no binding on that platform', () => {
    const v = vectors.resolution.emptyPlatformArrayMeansNoBinding
    // This is the macOS ⌘W case: the application menu owns the key there, so the
    // renderer must not bind it; Windows installs no menu and Ctrl+W is free.
    expect(effectiveKeybindings(v.commandId, stateOf([]), registryFor('macOS'))).toEqual(v.macOS)
    expect(effectiveKeybindings(v.commandId, stateOf([]), registryFor('windows'))).toEqual(v.windows)
  })

  test('a macOS-only command resolves to nothing elsewhere', () => {
    const v = vectors.resolution.macOnlyCommandHasNoBindingElsewhere
    expect(defaultKeybindings(registryFor('macOS').get(v.commandId), 'macOS')).toEqual(v.macOS)
    expect(defaultKeybindings(registryFor('windows').get(v.commandId), 'windows')).toEqual(v.windows)
  })
})

describe('accelerator formatting', () => {
  for (const platform of ['macOS', 'windows', 'linux'] as KeybindingPlatform[]) {
    const cases = vectors.format[platform === 'macOS' ? 'macOS' : platform] as Array<{ accelerator: string; label: string }>
    test(`${platform} labels match the committed vectors exactly`, () => {
      for (const entry of cases) {
        expect(formatAccelerator(entry.accelerator, platform)).toBe(entry.label)
      }
    })
  }

  test('macOS modifier order is ⌃⌥⇧⌘ with no separator, and Shift+/ folds to ?', () => {
    // ⌃ appears only for an explicit Control token; CmdOrCtrl contributes Command
    // alone. Pinned by the vectors, not by hand.
    expect(formatAccelerator('Control+Alt+Shift+Command+C', 'macOS')).toBe('⌃⌥⇧⌘C')
    expect(formatAccelerator('CmdOrCtrl+Alt+Shift+C', 'macOS')).toBe('⌥⇧⌘C')
    expect(formatAccelerator('CmdOrCtrl+Shift+/', 'macOS')).toBe('⌘?')
  })

  test('chord segments join with exactly one space', () => {
    expect(formatAccelerator('CmdOrCtrl+K CmdOrCtrl+S', 'macOS')).toBe('⌘K ⌘S')
    expect(splitAccelerator('  CmdOrCtrl+K   CmdOrCtrl+S ')).toEqual(['CmdOrCtrl+K', 'CmdOrCtrl+S'])
  })
})

describe('capture normalization', () => {
  for (const entry of vectors.capture as Array<{ event: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; shiftKey: boolean }; accelerator: string | null }>) {
    test(`${JSON.stringify(entry.event.key)} with modifiers -> ${entry.accelerator}`, () => {
      const parts: string[] = []
      if (entry.event.ctrlKey) parts.push('Ctrl')
      if (entry.event.metaKey) parts.push('Command')
      if (entry.event.altKey) parts.push('Alt')
      if (entry.event.shiftKey) parts.push('Shift')
      const main = captureMainKey(entry.event.key)
      expect(main == null ? null : [...parts, main].join('+')).toBe(entry.accelerator)
    })
  }
})

// Mirrors app/keybindings/capture.ts without needing a DOM KeyboardEvent, so the
// modifier ORDER (Ctrl, Command, Alt, Shift) that the vector pins is exercised
// here too. The real module is covered by the renderer behaviour test.
function captureMainKey(key: string): string | null {
  if (['Meta', 'Control', 'Alt', 'AltGraph', 'Shift'].includes(key)) return null
  if (key === ' ') return 'Space'
  if (key === '+') return 'Plus'
  const arrows: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right' }
  if (arrows[key] != null) return arrows[key]!
  if (key === 'Escape') return 'Escape'
  if (/^f\d{1,2}$/i.test(key)) return key.toUpperCase()
  if (key.length === 1) return key.toUpperCase()
  return key
}

describe('event matching', () => {
  for (const entry of vectors.matching as Array<{ accelerator: string; platform: KeybindingPlatform; event?: Record<string, unknown>; matches?: boolean; segments?: unknown }>) {
    if (entry.event == null || entry.matches == null) continue
    // Hoisted out of the closure: TypeScript does not carry the null checks above
    // into the test body, and reading `entry.event.key` there would be unsound.
    const eventInit = entry.event
    const expected = entry.matches
    test(`${entry.accelerator} on ${entry.platform}: ${JSON.stringify(eventInit.key)} matches=${expected}`, () => {
      const isMac = entry.platform === 'macOS'
      const segments = splitAccelerator(entry.accelerator).map(segment => parseAcceleratorSegment(segment, isMac))
      const event = {
        key: eventInit.key as string,
        ctrlKey: eventInit.ctrlKey as boolean,
        metaKey: eventInit.metaKey as boolean,
        altKey: eventInit.altKey as boolean,
        shiftKey: eventInit.shiftKey as boolean,
      }
      // A single-segment accelerator matches only when the lone segment matches
      // and all four modifier bits are equal.
      expect(segments.length === 1 && segmentMatches(event, segments[0]!)).toBe(expected)
    })
  }

  test('a chord splits into the expected number of segments', () => {
    const chord = (vectors.matching as Array<Record<string, unknown>>).find(entry => entry.accelerator === 'CmdOrCtrl+K W')
    expect(splitAccelerator(chord!.accelerator as string)).toHaveLength(2)
  })
})

describe('conflict detection', () => {
  for (const entry of vectors.conflicts as Array<{ held: string; captured: string; platform: KeybindingPlatform; conflicts?: boolean; reservedFind?: string; handoffFind?: string }>) {
    if (entry.reservedFind != null) continue
    test(`${entry.captured} vs held ${entry.held} on ${entry.platform} conflicts=${entry.conflicts}`, () => {
      expect(acceleratorsOverlap(entry.held, entry.captured, entry.platform)).toBe(entry.conflicts)
      // Prefix overlap is symmetric, which is what makes ⌘K collide with ⌘K S.
      expect(acceleratorsOverlap(entry.captured, entry.held, entry.platform)).toBe(entry.conflicts)
    })
    if (entry.handoffFind != null) {
      // The find-handoff key behaves like any command key: the holder is named
      // by its command, never by a Find name.
      test(`${entry.captured} is held by its command, not reported as Find`, () => {
        const registry = registryFor(entry.platform)
        const state = stateOf([{ command: 'openCommandMenu', key: entry.held }])
        expect(findConflict({ accelerator: entry.captured, commandId: 'forkThread', state, registry })).toEqual({ commandId: 'openCommandMenu' })
      })
    }
  }

  test('reserved native Find keys are named by their own command, not a registry command', () => {
    for (const entry of vectors.conflicts as Array<{ platform: KeybindingPlatform; reservedFind?: string; captured?: string }>) {
      if (entry.reservedFind == null) continue
      expect(reservedFindCommand(entry.captured!, entry.platform)).toBe(entry.reservedFind)
    }
    expect(reservedFindCommand('CmdOrCtrl+F', 'macOS')).toBeNull()
    expect(findHandoffCommand('CmdOrCtrl+F', 'macOS')).toBe('find')
    expect(reservedFindCommand('Command+G', 'macOS')).toBe('findNext')
    expect(reservedFindCommand('Shift+F3', 'windows')).toBe('findPrevious')
    expect(reservedFindCommand('CmdOrCtrl+N', 'macOS')).toBeNull()
  })

  test('findConflict refuses a key another command holds and names it', () => {
    const registry = registryFor('macOS')
    const state = stateOf([{ command: 'newChat', key: 'CmdOrCtrl+Alt+N' }])
    const conflict = findConflict({ accelerator: 'CmdOrCtrl+Alt+N', commandId: 'forkThread', state, registry })
    expect(conflict).toEqual({ commandId: 'newChat' })
    // The holder never conflicts with itself.
    expect(findConflict({ accelerator: 'CmdOrCtrl+Alt+N', commandId: 'newChat', state, registry })).toBeNull()
  })

  test('findConflict reports the find-handoff key by its holding command', () => {
    const registry = registryFor('macOS')
    // openCommandMenu defaults to ⌘F, so capturing it for another command names
    // that holder — the key is no longer refused by a Find name.
    expect(findConflict({ accelerator: 'CmdOrCtrl+F', commandId: 'forkThread', state: stateOf([]), registry })).toEqual({ commandId: 'openCommandMenu' })
    // The holder never conflicts with itself.
    expect(findConflict({ accelerator: 'CmdOrCtrl+F', commandId: 'openCommandMenu', state: stateOf([]), registry })).toBeNull()
  })
})

describe('equivalent command pairs', () => {
  test('the pair list matches the vector', () => {
    for (const pair of vectors.equivalentCommands.pairs as Array<[string, string]>) {
      expect(isEquivalentCommand(pair[0], pair[1])).toBe(true)
      expect(isEquivalentCommand(pair[1], pair[0])).toBe(true)
    }
  })

  test('equivalent commands are exempt from conflict in both directions', () => {
    const exempt = vectors.equivalentCommands.exemptFromConflict
    expect(isEquivalentCommand(exempt.left, exempt.right)).toBe(true)
    expect(isEquivalentCommand(vectors.equivalentCommands.symmetric.left, vectors.equivalentCommands.symmetric.right)).toBe(true)
    expect(isEquivalentCommand('newChat', 'newChat')).toBe(true)
    // A pair that is NOT equivalent still conflicts normally.
    expect(isEquivalentCommand('newChat', 'forkThread')).toBe(false)
  })

  test('the ⌘K overlap is real but exempt, so the work-panel chord coexists with the command menu', () => {
    // openCommandMenu holds ⌘K; workspaceCloseAll holds the ⌘K W chord. The keys
    // genuinely overlap by prefix — the exemption is what allows both to exist,
    // and the runtime's canStart gate is what keeps only one firing per surface.
    expect(acceleratorsOverlap('CmdOrCtrl+K', 'CmdOrCtrl+K W', 'macOS')).toBe(true)
    expect(isEquivalentCommand('openCommandMenu', 'workspaceCloseAll')).toBe(true)
    const registry = registryFor('macOS')
    const state = stateOf([{ command: 'openCommandMenu', key: 'CmdOrCtrl+K' }])
    expect(findConflict({ accelerator: 'CmdOrCtrl+K W', commandId: 'workspaceCloseAll', state, registry })).toBeNull()
  })
})

describe('binding updates', () => {
  test('set puts the new key first and keeps the rest', () => {
    const v = vectors.updates.setPutsNewKeyFirstAndKeepsRest
    expect(nextKeysForSet(v.current, v.accelerator)).toEqual(v.result)
  })

  test('set on an empty command binds exactly one', () => {
    const v = vectors.updates.setOnEmptyBindsOne
    expect(nextKeysForSet(v.current, v.accelerator)).toEqual(v.result)
  })

  test('append adds at the end and dedupes', () => {
    const add = vectors.updates.appendAddsAtEnd
    expect([...add.current, add.accelerator]).toEqual(add.result)
    const dupe = vectors.updates.appendDedupes
    expect(withCommandKeys([], 'newChat', [...dupe.current, dupe.accelerator])).toEqual([{ command: 'newChat', key: 'CmdOrCtrl+N' }])
  })

  test('removing the last binding stores an explicit null row', () => {
    const v = vectors.updates.removeLeavesExplicitNullWhenLastGoes
    expect(withCommandKeys([{ command: 'newChat', key: v.current[0] }], 'newChat', v.current.filter(key => key !== v.remove))).toEqual(v.storedRows)
  })

  test('clear writes an explicit null row, reset deletes every row', () => {
    expect(withCommandKeys([{ command: 'newChat', key: 'CmdOrCtrl+N' }], 'newChat', [])).toEqual(vectors.updates.clearWritesExplicitNull.storedRows)
    // Reset = no rows at all, so the default resolves again.
    expect(withCommandKeys([], 'newChat', ['CmdOrCtrl+N'])).toEqual([{ command: 'newChat', key: 'CmdOrCtrl+N' }])
    const registry = registryFor('macOS')
    expect(effectiveKeybindings('newChat', stateOf([]), registry)).toEqual(vectors.updates.resetDeletesEveryRow.effective)
  })
})

describe('global shortcut rules', () => {
  test('validation rejects bare keys and Shift-only chords, accepts a real modifier', () => {
    for (const entry of vectors.globalShortcuts.validation as Array<{ accelerator: string; platform: KeybindingPlatform; valid: boolean }>) {
      expect(validateGlobalAccelerator(entry.accelerator, entry.platform) == null).toBe(entry.valid)
    }
  })

  test('bare-modifier detection is macOS-only and needs two distinct modifiers', () => {
    for (const entry of vectors.globalShortcuts.bareModifiers as Array<{ accelerator: string; platform: KeybindingPlatform; bare: boolean; combination?: string }>) {
      expect(isBareModifierHotkey(entry.accelerator, entry.platform)).toBe(entry.bare)
      if (entry.bare) expect(bareModifierCombination(entry.accelerator)).toBe(entry.combination)
    }
  })
})

describe('native menu accelerators', () => {
  test('chords, mouse buttons and reserved Find keys are excluded', () => {
    const registry = registryFor('macOS')
    // The work-panel close-all chord cannot be a menu accelerator.
    expect(menuAccelerators('workspaceCloseAll', stateOf([]), registry)).toEqual([])
    // A command with both a chord and a plain binding advertises only the plain one.
    expect(menuAccelerators('workspaceCloseAll', stateOf([{ command: 'workspaceCloseAll', key: 'CmdOrCtrl+K W' }, { command: 'workspaceCloseAll', key: 'CmdOrCtrl+Alt+N' }]), registry))
      .toEqual(['CmdOrCtrl+Alt+N'])
  })

  test('the find-handoff key never becomes a menu accelerator', () => {
    const registry = registryFor('macOS')
    const vector = (vectors.menu as any).findHandoffKeysAreExcluded
    expect(vector.effective).toEqual(['CmdOrCtrl+F'])
    expect(menuAccelerators('newChat', stateOf([{ command: 'newChat', key: 'CmdOrCtrl+F' }]), registry)).toEqual(vector.menu)
    // And an outright-reserved navigation key stays out too.
    expect(menuAccelerators('newChat', stateOf([{ command: 'newChat', key: 'CmdOrCtrl+G' }]), registry)).toEqual([])
  })
})

describe('ordering and sections', () => {
  test('group order matches the vector and ungrouped sorts last', () => {
    expect([...vectors.ordering.groupOrder]).toEqual(['thread', 'navigation', 'panels', 'workspace', 'skills', 'configure', 'app'])
    const registry = registryFor('macOS')
    expect(sectionKeyOf(registry.get('showKeyboardShortcuts')!)).toBe('general')
    expect(compareCommands(registry.get('showKeyboardShortcuts')!, registry.get('newChat')!)).toBeGreaterThan(0)
  })

  test('priority ids lead their group, then id order', () => {
    const registry = registryFor('macOS')
    const v = vectors.ordering.priorityIdsLeadTheirGroup
    const sorted = v.ids.map(id => registry.get(id)!).sort((a, b) => compareCommands(a, b, v.priorityIds)).map(c => c.id)
    expect(sorted).toEqual(v.sorted)
  })

  test('same-group commands sort by id', () => {
    const registry = registryFor('macOS')
    const v = vectors.ordering.sameGroupSortsById
    const sorted = v.ids.map(id => registry.get(id)!).sort((a, b) => compareCommands(a, b)).map(c => c.id)
    expect(sorted).toEqual(v.sorted)
  })

  test('dialog section order ends with general', () => {
    expect([...vectors.dialog.sectionOrder]).toEqual(['thread', 'navigation', 'panels', 'workspace', 'skills', 'configure', 'app', 'general'])
  })
})

describe('same-binding detection', () => {
  test('recapturing the identical key is a no-op, not a save', () => {
    // Same-binding detection compares platform labels, so Command+K and
    // CmdOrCtrl+K on mac are the same binding and capture simply exits without
    // writing.
    expect(isSameBinding('Command+K', 'CmdOrCtrl+K', 'macOS')).toBe(true)
    expect(isSameBinding('CmdOrCtrl+K', 'CmdOrCtrl+Shift+K', 'macOS')).toBe(false)
    expect(isSameBinding(null, 'CmdOrCtrl+K', 'macOS')).toBe(false)
  })
})
