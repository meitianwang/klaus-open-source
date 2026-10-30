import type { Menu, MenuItem, MenuItemConstructorOptions, WebContents } from 'electron'
import { join } from 'node:path'
import { createOwnedEditMenu, ownedEditMenuTemplate } from '../main/app/owned-edit-menu'
import { nativeMenuLabels } from '../main/app/native-menu-labels'
import { assert, assertEqual, assertDeepEqual, Harness } from './harness'
const h = new Harness()

function item(options: Record<string, unknown>): MenuItem {
  const submenu = Array.isArray(options.submenu) ? menu(options.submenu.map(value => item(value as Record<string, unknown>))) : undefined
  return { ...options, submenu } as unknown as MenuItem
}
function menu(items: MenuItem[]): Menu {
  return { items, getMenuItemById(id: string): MenuItem | null {
    for (const entry of items) { if (entry.id === id) return entry; const child = entry.submenu?.getMenuItemById(id); if (child) return child }
    return null
  } } as Menu
}
function contents() {
  const calls: string[] = []
  return { calls, value: { isDestroyed: () => false, undo: () => calls.push('undo'), redo: () => calls.push('redo') } as unknown as WebContents }
}
const native = () => item({ role: 'editmenu', label: 'Localized Edit', type: 'submenu', submenu: [
  { role: 'undo', label: 'Localized Undo', accelerator: 'CommandOrControl+Z', menu: {}, commandId: 1, click() {} },
  { role: 'redo', label: 'Localized Redo', accelerator: 'Shift+CommandOrControl+Z' },
  { type: 'separator' }, { role: 'cut', label: 'Cut', accelerator: 'CommandOrControl+X', registerAccelerator: false },
  { role: 'copy', label: 'Copy' }, { role: 'paste', label: 'Paste' },
  { label: 'Find', futureOption: 'retained', submenu: [{ selector: 'performFindPanelAction:', label: 'Find Next', tag: 3 }] },
  { label: 'Spelling', submenu: [{ role: 'togglespellchecker', type: 'checkbox', checked: true }] },
  { label: 'Speech', submenu: [{ role: 'startspeaking' }, { role: 'stopspeaking' }] },
] })

h.test('native edit roles and nested system features follow the selected language', () => {
  const original = item({ role: 'editmenu', label: 'Edit', submenu: [
    { role: 'pasteandmatchstyle', label: 'Paste and Match Style', accelerator: 'Cmd+Option+Shift+V' },
    { label: 'Substitutions', submenu: [{ role: 'showsubstitutions', label: 'Show Substitutions' }, { role: 'togglesmartquotes', label: 'Smart Quotes' }] },
    { label: 'Speech', submenu: [{ role: 'startspeaking', label: 'Start Speaking' }, { role: 'stopspeaking', label: 'Stop Speaking' }] },
  ] })
  const translated = ownedEditMenuTemplate(original, nativeMenuLabels(true))
  const children = translated.submenu as MenuItemConstructorOptions[]
  assertEqual(translated.label, '编辑', 'localized heading')
  assertEqual(children[0]!.accelerator, 'CmdOrCtrl+Shift+V', 'visible match-style shortcut')
  assertEqual(children[0]!.role, 'pasteandmatchstyle', 'native paste behavior remains owned by the system')
  assertEqual(children[1]!.label, '替换', 'substitution submenu')
  assertEqual(children[2]!.label, '语音', 'speech submenu')
  assertEqual((children[2]!.submenu as MenuItemConstructorOptions[])[0]!.label, '开始朗读', 'nested action')
  const english = ownedEditMenuTemplate(original, nativeMenuLabels(false))
  assertEqual(english.label, 'Edit', 'switching back restores English')
})

h.test('native Edit derivation retains every other role submenu and future native option', () => {
  const original = native(), result = ownedEditMenuTemplate(original)
  const children = result.submenu as MenuItemConstructorOptions[]
  assertEqual(children.length, original.submenu!.items.length, 'no native item was removed')
  assertEqual(children[0]!.label, 'Localized Undo', 'native localized label')
  assertEqual(children[0]!.accelerator, 'CommandOrControl+Z', 'native undo accelerator')
  assertEqual(children[1]!.accelerator, 'Shift+CommandOrControl+Z', 'native redo accelerator')
  assertEqual(children[0]!.role, undefined, 'custom undo is not consumed by a native role')
  assertEqual(children[0]!.id, 'klaus-edit-undo', 'stable undo menu action')
  assert(!('menu' in children[0]!) && !('commandId' in children[0]!) && !('click' in children[0]!), 'instance-owned state is not cloned')
  assertEqual(children[3]!.role, 'cut', 'native cut retains its role')
  assertEqual(children[3]!.registerAccelerator, false, 'native accelerator registration policy')
  assertEqual((children[6] as unknown as Record<string, unknown>).futureOption, 'retained', 'future native metadata')
  assertEqual((children[6]!.submenu as MenuItemConstructorOptions[])[0]!.label, 'Find Next', 'Find submenu retained')
  assertEqual(((children[6]!.submenu as Record<string, unknown>[])[0]!).selector, 'performFindPanelAction:', 'native selector retained')
  assertEqual((children[7]!.submenu as MenuItemConstructorOptions[])[0]!.checked, true, 'Spelling state retained')
  assertDeepEqual((children[8]!.submenu as MenuItemConstructorOptions[]).map(value => value.role), ['startspeaking', 'stopspeaking'], 'Speech roles retained')
})

h.test('actual menu click targets only the supplied main renderer and keeps other contents native', () => {
  const main = contents(), other = contents(), routed: string[] = [], fallback: string[] = []
  let builds = 0
  const build = (template: MenuItemConstructorOptions[]) => ++builds === 1 ? menu([native()]) : menu(template.map(value => item(value as unknown as Record<string, unknown>)))
  const edited = createOwnedEditMenu(build, main.value, { execute: async command => { routed.push(command); return false } }, command => fallback.push(command))
  const undo = edited.submenu!.getMenuItemById('klaus-edit-undo')!, redo = edited.submenu!.getMenuItemById('klaus-edit-redo')!
  undo.click({}, undefined, main.value)
  redo.click({}, undefined, main.value)
  assertDeepEqual(routed, ['undo', 'redo'], 'one command per actual main menu click')
  assertEqual(main.calls.length, 0, 'owned false does not retarget to stale native history')
  undo.click({}, undefined, other.value)
  redo.click({}, undefined, other.value)
  assertDeepEqual(other.calls, ['undo', 'redo'], 'browser and terminal contents keep native editing')
  assertEqual(routed.length, 2, 'external contents never evaluate the renderer dispatcher')
  undo.click({}, undefined, undefined)
  assertDeepEqual(fallback, ['undo'], 'native first responder fallback without web contents')
  const closed = { isDestroyed: () => true, undo() { throw Error('closed native target') } } as unknown as WebContents
  undo.click({}, undefined, closed)
  assertEqual(routed.length, 2, 'destroyed target never dispatches')
})
void (async () => { process.exit(await h.finish(join(__dirname, 'owned-edit-menu-result.json'), 'owned-edit-menu')) })()
