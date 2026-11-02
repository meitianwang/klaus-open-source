import type { ComposerTextControl } from './contenteditable-control'
import type { SlashCommandInfo } from '../engine-events'
import type { ComposerQuery } from './composer-query'
import { sameComposerQuery } from './composer-query'
import { isSkillCommand } from './resource-reference'
import type { ComposerReferenceToken } from './reference-token'
import type { MentionEntry, SlashMenuApi } from './slash-menu'
import { syntheticContextQuery, resolveSyntheticContextQuery, type SyntheticContextQuery } from './context-menu-model'

export interface EditorDiscoveryContext {
  owner: string
  sessionId: string | null
  root?: string
}

export function routeComposerPickerKey(event: KeyboardEvent, options: {
  composing: boolean; visible: boolean
  context?: boolean
  alternateNavigation?: boolean
  navigate(direction: number): void
  select(intent: 'insert' | 'complete'): void
  escape(): void
}): boolean {
  const alternateKeys = options.alternateNavigation ?? (typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform))
  const alternate = options.context && alternateKeys && event.ctrlKey && !event.metaKey && ['n', 'p'].includes(event.key.toLowerCase())
  if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || options.composing || !options.visible
    || event.metaKey || event.ctrlKey && !alternate || event.altKey || event.shiftKey) return false
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || alternate) options.navigate(event.key === 'ArrowDown' || alternate && event.key.toLowerCase() === 'n' ? 1 : -1)
  else if (event.key === 'Enter' || event.key === 'Tab' && !options.context) options.select(event.key === 'Tab' ? 'complete' : 'insert')
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
  let synthetic: SyntheticContextQuery | null = null
  const contextKey = (value: EditorDiscoveryContext | null) => JSON.stringify(value)
  const activeQuery = (): ComposerQuery | null => {
    if (!synthetic) return control.queryAtCaret()
    const typed = control.queryAtCaret()
    if (typed && typed.start >= synthetic.start) { synthetic = null; return typed }
    const query = resolveSyntheticContextQuery(synthetic, input.value, input.selectionStart, input.selectionEnd, contextKey(options.context()))
    return query ? { ...query, prefix: '@' } : null
  }
  const current = (value: NonNullable<typeof published>) => control.revision === value.revision
    && contextKey(options.context()) === contextKey(value.context) && sameComposerQuery(value.query, activeQuery())
    && input.ownerDocument.activeElement === input
  const close = () => { mode = null; scope = null; published = null; synthetic = null; menu.hide() }
  const hide = (dismiss = false) => {
    sequence++
    if (dismiss) control.dismissQuery()
    close()
  }
  const refresh = async () => {
    const request = ++sequence, query = activeQuery(), context = options.context()
    if (!query || !context || options.prefixes && !options.prefixes.includes(query.prefix)
      || control.composing || input.ownerDocument.activeElement !== input) { close(); return }
    const value = { query, context, revision: control.revision }
    if (query.prefix === '@') {
      if (mode !== 'workspace' || published?.query.start !== query.start || contextKey(published?.context || null) !== contextKey(context)) scope = null
      mode = 'workspace'
      published = value
      menu.showMention({ query: query.query, scope, sessionId: context.sessionId, root: context.root, activation: synthetic ? 'synthetic' : 'typed' })
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
    open() {
      hide()
      input.focus()
      synthetic = syntheticContextQuery(input.value, input.selectionStart, input.selectionEnd, contextKey(options.context()))
      void refresh()
    },
    isSynthetic() { return synthetic !== null && menu.isOpen() },
    isContextOpen() { return mode === 'workspace' && menu.isOpen() },
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
      if (entry.kind === 'command' && entry.command) {
        hide()
        options.command(entry.command, value.query)
        input.focus()
        return
      }
      if (entry.kind === 'action' && entry.action) {
        hide()
        control.replaceRange(value.query.start, value.query.end, '', 'insertReplacementText')
        entry.action()
        return
      }
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
      const selectable = event.key === 'Escape' || (menu.activeIndex?.() ?? 0) >= 0
      return routeComposerPickerKey(event, { composing: control.composing, visible: selectable && mode !== null && menu.isOpen() && !!published && current(published),
        context: mode === 'workspace',
        navigate: direction => menu.navigate(direction), select: intent => menu.clickActive(intent),
        escape: () => { if (mode === 'workspace' && scope) setScope(null); else hide(true) } })
    },
  }
}
