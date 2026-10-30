// Settings 侧栏的平台裁剪：macOS 才有的项在别的平台整条消失，随之空掉的分组
// 标题也不能留。macOS 是唯一存在逐 App 隐私授权（TCC）的平台，Windows 上没有
// 任何可以事先授予的对象，所以入口不该出现。
import { describe, expect, test } from 'bun:test'
import { NAV_ENTRIES, visibleNavEntries } from './settings-nav-entries'

const stabs = (isMac: boolean) =>
  visibleNavEntries(isMac).filter(entry => entry.kind === 'tab').map(entry => entry.stab)

const groups = (isMac: boolean) =>
  visibleNavEntries(isMac).filter(entry => entry.kind === 'group').map(entry => entry.i18n)

describe('settings nav keyboard entry', () => {
  const keyboardEntry = NAV_ENTRIES.find(entry => entry.stab === 'keyboard')

  test('the keyboard shortcuts tab exists on every platform', () => {
    // Codex gates its entry with `case 'keyboard-shortcuts': return !0` — always
    // visible, never loading, no capability requirement. A platform-gated entry
    // would leave Windows/Linux users with no way to see or change their keys.
    expect(keyboardEntry).toBeDefined()
    expect(keyboardEntry!.kind).toBe('tab')
    expect(keyboardEntry!.macOnly).toBeUndefined()
    for (const isMac of [true, false]) expect(stabs(isMac)).toContain('keyboard')
  })

  test('it sits in the General group, after preferences and before voice input', () => {
    // Codex lists it in its Personal group between the appearance rows and the
    // usage rows; Klaus's equivalent of "personal" is General, and the ordering
    // matters because the nav is the only entry point to the editor.
    const general = stabs(true)
    expect(general.indexOf('keyboard')).toBe(general.indexOf('preferences') + 1)
    expect(general.indexOf('keyboard')).toBeLessThan(general.indexOf('voiceInput'))
    const entryIndex = NAV_ENTRIES.indexOf(keyboardEntry!)
    expect(NAV_ENTRIES[entryIndex - 1]!.i18n).toBe('preferences')
    // Still inside the General group, not starting a new one.
    const groupBefore = NAV_ENTRIES.slice(0, entryIndex).filter(entry => entry.kind === 'group').pop()
    expect(groupBefore!.i18n).toBe('settings_group_general')
  })

  test('the nav label uses the same copy as the page title and the dialog title', () => {
    // Three surfaces name this feature; a drift between them reads as a bug.
    expect(keyboardEntry!.i18n).toBe('keyboard_shortcuts_settings')
  })

  test('it has an icon, as every other Klaus settings tab does', () => {
    // Klaus renders `entry.icon!` unconditionally (settings-nav.tsx), so a tab
    // without one throws at render, so the icon is required.
    expect(keyboardEntry!.icon).toBe('settings-nav-keyboard')
  })
})

describe('settings nav about entry', () => {
  const aboutEntry = NAV_ENTRIES.find(entry => entry.stab === 'about')

  test('the about tab exists on every platform', () => {
    // Version, changelog and manual update control are not macOS-only: the
    // About menu row is, so the settings entry must not inherit that gate.
    expect(aboutEntry).toBeDefined()
    expect(aboutEntry!.macOnly).toBeUndefined()
    for (const isMac of [true, false]) expect(stabs(isMac)).toContain('about')
  })

  test('it closes the System group, after system auth on macOS', () => {
    const mac = stabs(true)
    expect(mac[mac.length - 1]).toBe('about')
    expect(mac.indexOf('about')).toBe(mac.indexOf('systemAuth') + 1)
    // Off macOS the group survives on about alone, so the header is not orphaned.
    const other = stabs(false)
    expect(other[other.length - 1]).toBe('about')
    expect(groups(false)).toContain('settings_group_system')
  })

  test('it has an icon and a label key, as every other settings tab does', () => {
    expect(aboutEntry!.icon).toBe('settings-nav-about')
    expect(aboutEntry!.i18n).toBe('about_settings')
  })
})

describe('settings nav platform trimming', () => {
  test('keeps the system auth entry and its group on macOS', () => {
    expect(stabs(true)).toContain('systemAuth')
    expect(groups(true)).toContain('settings_group_system')
    expect(visibleNavEntries(true)).toEqual(NAV_ENTRIES)
  })

  test('drops the system auth entry off macOS', () => {
    expect(stabs(false)).not.toContain('systemAuth')
  })

  test('the System group survives off macOS on the about entry alone', () => {
    // Before about joined the group, trimming system auth emptied it and the
    // header had to go too. About is every platform's entry, so the header
    // stays everywhere now.
    expect(groups(false)).toContain('settings_group_system')
  })

  test('changes nothing else off macOS', () => {
    expect(stabs(false)).toEqual(stabs(true).filter(stab => stab !== 'systemAuth'))
  })

  test('never leaves a group header without a tab under it', () => {
    for (const isMac of [true, false]) {
      const entries = visibleNavEntries(isMac)
      entries.forEach((entry, index) => {
        if (entry.kind !== 'group') return
        expect(entries[index + 1]?.kind).toBe('tab')
      })
    }
  })
})

describe('settings nav storage entry', () => {
  const storageEntry = NAV_ENTRIES.find(entry => entry.stab === 'storage')

  test('the storage tab exists on every platform', () => {
    expect(storageEntry).toBeDefined()
    expect(storageEntry!.kind).toBe('tab')
    expect(storageEntry!.macOnly).toBeUndefined()
    for (const isMac of [true, false]) expect(stabs(isMac)).toContain('storage')
  })

  test('it sits in the General group after voice input', () => {
    const general = stabs(true)
    expect(general.indexOf('storage')).toBe(general.indexOf('voiceInput') + 1)
    const entryIndex = NAV_ENTRIES.indexOf(storageEntry!)
    const groupBefore = NAV_ENTRIES.slice(0, entryIndex).filter(entry => entry.kind === 'group').pop()
    expect(groupBefore!.i18n).toBe('settings_group_general')
  })

  test('it has an icon, as every other Klaus settings tab does', () => {
    expect(storageEntry!.icon).toBe('settings-nav-storage')
  })
})
