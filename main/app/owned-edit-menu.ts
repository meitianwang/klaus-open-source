import type { Menu, MenuItem, MenuItemConstructorOptions, WebContents } from 'electron'
import type { ComposerEditCommands, EditCommand } from './composer-edit-commands'
import type { NativeMenuLabels } from './native-menu-labels'

/** Derive the complete native menu; only history commands lose their native role. */
export function ownedEditMenuTemplate(item: MenuItem, labels?: NativeMenuLabels): MenuItemConstructorOptions {
  const options: Record<string, unknown> = {}
  const instanceFields = new Set(['menu', 'commandId', 'click', 'submenu', 'userAccelerator', 'groupId'])
  for (const key of Object.keys(item)) if (!instanceFields.has(key)) options[key] = (item as unknown as Record<string, unknown>)[key]
  if (item.submenu) options.submenu = item.submenu.items.map(child => ownedEditMenuTemplate(child, labels))
  const role = String(item.role ?? '').toLowerCase()
  if (labels?.roles[role]) options.label = labels.roles[role]
  if (labels && !role && item.submenu) {
    const roles = item.submenu.items.map(child => String(child.role ?? '').toLowerCase())
    if (roles.includes('showsubstitutions')) options.label = labels.submenus.substitutions
    if (roles.includes('startspeaking')) options.label = labels.submenus.speech
  }
  if (role === 'pasteandmatchstyle') options.accelerator = 'CmdOrCtrl+Shift+V'
  if (role === 'undo' || role === 'redo') {
    delete options.role
    options.id = `klaus-edit-${role}`
  }
  return options as MenuItemConstructorOptions
}

/** Keep evaluation on the main renderer; other contents keep only their native command. */
export function dispatchOwnedMenuEdit(command: EditCommand, target: WebContents | undefined, main: WebContents, commands: Pick<ComposerEditCommands, 'execute'>, nativeFallback: (command: EditCommand) => void): void {
  if (!target) { nativeFallback(command); return }
  if (target.isDestroyed()) return
  if (target === main) { void commands.execute(command); return }
  if (command === 'undo') target.undo()
  else target.redo()
}

/** Use public native menu construction and writable click callbacks, without moving attached items. */
export function createOwnedEditMenu(
  build: (template: MenuItemConstructorOptions[]) => Menu,
  main: WebContents,
  commands: Pick<ComposerEditCommands, 'execute'>,
  nativeFallback: (command: EditCommand) => void,
  labels?: NativeMenuLabels,
): MenuItem {
  const native = build([{ role: 'editMenu' }]).items[0]!
  const template = ownedEditMenuTemplate(native, labels)
  if (labels) {
    const children = template.submenu as MenuItemConstructorOptions[]
    const selectAll = children.findIndex(child => String(child.role).toLowerCase() === 'selectall')
    if (selectAll > 0 && children[selectAll - 1]?.type !== 'separator') children.splice(selectAll, 0, { type: 'separator' })
    children.push({ role: 'pasteAndMatchStyle', label: labels.roles.pasteandmatchstyle, accelerator: 'Cmd+Option+Shift+V', visible: false, acceleratorWorksWhenHidden: true })
  }
  const item = build([template]).items[0]!
  for (const command of ['undo', 'redo'] as const) {
    const action = item.submenu?.getMenuItemById(`klaus-edit-${command}`)
    if (!action) throw new Error(`Native Edit menu is missing ${command}`)
    action.click = (_event: unknown, _window: unknown, target: WebContents | undefined) => dispatchOwnedMenuEdit(command, target, main, commands, nativeFallback)
  }
  return item
}
