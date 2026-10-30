import type { ComposerTextControl } from './contenteditable-control'
import type { SlashCommandInfo } from '../engine-events'
import type { ComposerQuery } from './composer-query'
import { sameComposerQuery } from './composer-query'
import { isSkillCommand } from './resource-reference'
import type { ComposerReferenceToken } from './reference-token'
import type { MentionEntry, SlashMenuApi } from './slash-menu'

export interface EditorDiscoveryContext {
  owner: string
  sessionId: string | null
  root?: string
}

export function routeComposerPickerKey(event: KeyboardEvent, options: {
  composing: boolean; visible: boolean
  navigate(direction: number): void
  select(intent: 'insert' | 'complete'): void
  escape(): void
}): boolean {
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || options.composing || !options.visible
    || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') options.navigate(event.key === 'ArrowDown' ? 1 : -1)
  else if (event.key === 'Enter' || event.key === 'Tab') options.select(event.key === 'Tab' ? 'complete' : 'insert')
  else if (event.key === 'Escape') options.escape()
  else return false
  event.preventDefault()
  event.stopImmediatePropagation()
  return true
}

/** Discovery state belongs to one editor and one binding lifetime. */
export function createEditorDiscovery(options: {
  input: HTMLTextAreaElement
  control: ComposerTextControl
  menu: SlashMenuApi
  prefixes?: readonly ComposerQuery['prefix'][]
  context(): EditorDiscoveryContext | null
  load(context: EditorDiscoveryContext): Promise<SlashCommandInfo[]>
  matches(command: SlashCommandInfo, query: string): boolean
  command(command: SlashCommandInfo, query: ComposerQuery): void
  reference(entry: MentionEntry, context: EditorDiscoveryContext): Promise<Omit<ComposerReferenceToken, 'range'> | null>
  insert(reference: Omit<ComposerReferenceToken, 'range'>, query: ComposerQuery): void
  failure(error: unknown): void
}) {
  const { input, control, menu } = options
  let sequence = 0
  let mode: 'slash' | 'workspace' | null = null
  let scope: 'files' | 'folders' | null = null
  let published: { query: ComposerQuery; context: EditorDiscoveryContext; revision: number } | null = null
  const contextKey = (value: EditorDiscoveryContext | null) => JSON.stringify(value)
  const current = (value: NonNullable<typeof published>) => control.revision === value.revision
    && contextKey(options.context()) === contextKey(value.context) && sameComposerQuery(value.query, control.queryAtCaret())
    && input.ownerDocument.activeElement === input
  const close = () => { mode = null; scope = null; published = null; menu.hide() }
  const hide = (dismiss = false) => {
    sequence++
    if (dismiss) control.dismissQuery()
    close()
  }
  const refresh = async () => {
    const request = ++sequence, query = control.queryAtCaret(), context = options.context()
    if (!query || !context || options.prefixes && !options.prefixes.includes(query.prefix)
      || control.composing || input.ownerDocument.activeElement !== input) { close(); return }
    const value = { query, context, revision: control.revision }
    if (query.prefix === '@') {
      if (mode !== 'workspace' || published?.query.start !== query.start || contextKey(published?.context || null) !== contextKey(context)) scope = null
      mode = 'workspace'
      published = value
      menu.showMention({ query: query.query, scope, sessionId: context.sessionId, root: context.root })
      return
    }
    if (mode === 'workspace') close()
    if (published && !current(published)) close()
    let commands: SlashCommandInfo[]
    try { commands = await options.load(context) }
    catch (error) { if (request === sequence && current(value)) { close(); options.failure(error) }; return }
    if (request !== sequence || !current(value)) return
    const items = commands.filter(command => (query.prefix !== '$' || isSkillCommand(command)) && options.matches(command, query.query.toLowerCase()))
    if (!items.length) { close(); return }
    mode = 'slash'
    scope = null
    published = value
    menu.showSlash(items)
  }
  const setScope = (next: 'files' | 'folders' | null) => {
    const value = published
    if (!value || !current(value) || value.query.prefix !== '@') { hide(); return }
    scope = next
    control.replaceRange(value.query.start + 1, value.query.end, '', 'insertReplacementText')
    input.focus()
    void refresh()
  }
  return {
    refresh,
    hide,
    empty() { if (mode === 'workspace') hide() },
    selectCommand(command: SlashCommandInfo) {
      const value = published
      if (!value || !current(value) || value.query.prefix === '@') { hide(); return }
      hide()
      options.command(command, value.query)
      input.focus()
    },
    async selectMention(entry: MentionEntry, intent: 'insert' | 'complete' = 'insert') {
      const value = published
      if (!value || !current(value) || value.query.prefix !== '@') { hide(); return }
      if (entry.kind === 'category' && entry.category) { setScope(entry.category); return }
      if (entry.isDir && intent === 'complete') {
        const path = /[\\/]$/.test(entry.rel) ? entry.rel : `${entry.rel}/`
        control.continueQuery('@', value.query.start)
        control.replaceRange(value.query.start + 1, value.query.end, path, 'insertReplacementText')
        input.focus()
        void refresh()
        return
      }
      const request = ++sequence
      try {
        const reference = await options.reference(entry, value.context)
        if (request !== sequence || !current(value)) return
        hide()
        if (reference) options.insert(reference, value.query)
        input.focus()
      } catch (error) { if (request === sequence && current(value)) { hide(); options.failure(error) } }
    },
    keydown(event: KeyboardEvent) {
      return routeComposerPickerKey(event, { composing: control.composing, visible: mode !== null && menu.isOpen() && !!published && current(published),
        navigate: direction => menu.navigate(direction), select: intent => menu.clickActive(intent),
        escape: () => { if (mode === 'workspace' && scope) setScope(null); else hide(true) } })
    },
  }
}
