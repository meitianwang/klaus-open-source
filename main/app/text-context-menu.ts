import type { TextContextEditCommand } from '../../shared/text-context-menu'
import type { BrowserWindow, ContextMenuParams, Menu, MenuItemConstructorOptions, WebContents } from 'electron'

export interface TextContextActions {
  copyLink(url: string, title: string): Promise<void>
  search(text: string): Promise<void>
  log(error: unknown): void
}
type TextContext = Pick<ContextMenuParams, 'isEditable' | 'selectionText' | 'editFlags' | 'misspelledWord' | 'dictionarySuggestions' | 'linkURL' | 'linkText' | 'mediaType'>
type TextContents = Pick<WebContents, 'isDestroyed' | 'cut' | 'copy' | 'paste' | 'selectAll' | 'replaceMisspelling' | 'showDefinitionForSelection' | 'session'>

/** Native commands retain their originating contents even when another window gains focus. */
export function textContextMenuTemplate(params: TextContext, contents: TextContents, actions: TextContextActions,
  platform: NodeJS.Platform, chinese: boolean, current: (command?: TextContextEditCommand) => boolean | Promise<boolean> = () => !contents.isDestroyed()): MenuItemConstructorOptions[] {
  const selected = params.selectionText.length > 0
  const labels = chinese
    ? { cut: '剪切', copy: '复制', paste: '粘贴', selectAll: '全选', learn: '学习拼写', noGuesses: '无拼写建议', lookup: '查询', search: '使用 Google 搜索', link: '复制链接' }
    : { cut: 'Cut', copy: 'Copy', paste: 'Paste', selectAll: 'Select All', learn: 'Learn Spelling', noGuesses: 'No Guesses Found', lookup: 'Look Up', search: 'Search with Google', link: 'Copy Link' }
  const invoke = (action: () => unknown, command?: TextContextEditCommand) => () => {
    const apply = (allowed: boolean) => { if (allowed && !contents.isDestroyed()) return action() }
    try {
      const allowed = current(command)
      void Promise.resolve(typeof allowed === 'boolean' ? apply(allowed) : allowed.then(apply)).catch(actions.log)
    } catch (error) { actions.log(error) }
  }
  const groups: MenuItemConstructorOptions[][] = []
  if (selected && params.misspelledWord) {
    const spelling: MenuItemConstructorOptions[] = params.dictionarySuggestions.length && params.isEditable
      ? params.dictionarySuggestions.map(word => ({ id: 'text-spelling-suggestion', label: word, click: invoke(() => contents.replaceMisspelling(word), 'replaceSpelling') }))
      : params.dictionarySuggestions.length ? [] : [{ id: 'text-no-guesses', label: labels.noGuesses, enabled: false }]
    if (params.isEditable) spelling.push({ id: 'text-learn-spelling', label: labels.learn,
      click: invoke(() => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord)) })
    groups.push(spelling)
  }
  if (platform === 'darwin' && selected && !params.linkURL) {
    let preview = '', count = 0
    for (const character of params.selectionText.trim()) {
      if (count++ === 25) { preview += '…'; break }
      preview += character
    }
    preview = preview.replace(/&/g, '&&')
    groups.push([{ id: 'text-lookup', label: `${labels.lookup} “${preview}”`, click: invoke(() => contents.showDefinitionForSelection()) }])
  }
  if (selected) groups.push([{ id: 'text-search', label: labels.search, click: invoke(() => actions.search(params.selectionText)) }])
  const editing: MenuItemConstructorOptions[] = []
  if (params.isEditable) editing.push({ id: 'text-cut', label: labels.cut, accelerator: 'CmdOrCtrl+X', registerAccelerator: false,
    enabled: selected && params.editFlags.canCut, click: invoke(() => contents.cut(), 'cut') })
  if (params.isEditable || selected) editing.push({ id: 'text-copy', label: labels.copy, accelerator: 'CmdOrCtrl+C', registerAccelerator: false,
    enabled: selected && params.editFlags.canCopy, click: invoke(() => contents.copy(), 'copy') })
  if (params.isEditable) editing.push({ id: 'text-paste', label: labels.paste, accelerator: 'CmdOrCtrl+V', registerAccelerator: false,
    enabled: params.editFlags.canPaste, click: invoke(() => contents.paste(), 'paste') })
  if (platform !== 'darwin') editing.push({ id: 'text-select-all', label: labels.selectAll,
    enabled: params.editFlags.canSelectAll, click: invoke(() => contents.selectAll()) })
  groups.push(editing)
  if (params.linkURL && params.mediaType === 'none') groups.push([{ id: 'text-copy-link', label: labels.link,
    click: invoke(() => actions.copyLink(params.linkURL, params.linkText)) }])
  return groups.filter(group => group.length).flatMap((group, index) => index ? [{ type: 'separator' as const }, ...group] : group)
}

/** One listener and at most one popup belong to this app window. */
export function installTextContextMenu(window: BrowserWindow, build: (template: MenuItemConstructorOptions[]) => Menu,
  actions: TextContextActions, chinese: () => boolean, platform: NodeJS.Platform = process.platform): () => void {
  let active: Menu | null = null, attached = true, generation = 0
  const current = () => attached && !window.isDestroyed() && !window.webContents.isDestroyed()
  const close = () => { const menu = active; active = null; if (menu && !window.isDestroyed()) menu.closePopup(window) }
  const listener = (event: Electron.Event, params: ContextMenuParams) => {
    if (!current() || params.frame && params.frame !== window.webContents.mainFrame) return
    event.preventDefault()
    close()
    const capturedGeneration = ++generation
    const samePopup = () => current() && generation === capturedGeneration
    const capturedLease = window.webContents.executeJavaScript('window.__KLAUS_TEXT_CONTEXT_MENU__?.capture() ?? null')
      .catch(error => { if (samePopup()) actions.log(error); return null })
    const ownerCurrent = async (command?: TextContextEditCommand) => {
      const lease: unknown = await capturedLease
      return samePopup() && typeof lease === 'string' && await window.webContents.executeJavaScript(
        command ? `window.__KLAUS_TEXT_CONTEXT_MENU__?.prepare(${JSON.stringify(lease)}, ${JSON.stringify(command)}) === true`
          : `window.__KLAUS_TEXT_CONTEXT_MENU__?.current(${JSON.stringify(lease)}) === true`,
      ) === true && samePopup()
    }
    const template = textContextMenuTemplate(params, window.webContents, actions, platform, chinese(), ownerCurrent)
    if (!template.length) return
    const menu = build(template); active = menu
    menu.popup({ window, x: params.x, y: params.y, ...(params.frame ? { frame: params.frame } : {}),
      sourceType: params.menuSourceType, callback: () => { if (active === menu) active = null } })
  }
  const contents = window.webContents
  contents.on('context-menu', listener)
  return () => {
    if (!attached) return
    attached = false
    generation++
    if (!contents.isDestroyed()) contents.removeListener('context-menu', listener)
    close()
  }
}
