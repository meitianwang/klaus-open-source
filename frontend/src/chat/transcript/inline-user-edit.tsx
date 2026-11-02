import { useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { useT } from '../../i18n'
import { composerKeyWasHandled, installContenteditableTextControl, type ComposerTextControl } from '../composer/contenteditable-control'
import { composerDraftFromControl } from '../composer/document-draft'
import { createEditorDiscovery } from '../composer/editor-discovery'
import { InlineMessageEdits, inlineMessageEditCanSubmit, type InlineMessageEditRuntime, type MessageEditHandle } from '../composer/inline-message-edit'
import { mountSlashMenu, type SlashMenuActions, type MentionEntry } from '../composer/slash-menu'
import { normalizeComposerReferences, replaceComposerReferenceRange, syncComposerReferences, type ComposerReferenceToken } from '../composer/reference-token'
import { isSkillCommand, referencesFromEditor, skillReference } from '../composer/resource-reference'
import type { SlashCommandInfo } from '../engine-events'
import type { InlineTokenSnapshot } from '../composer/inline-token'
import { renderComposerReferencePillHtml } from '../composer/reference-pill'
import './inline-user-edit.css'

export interface InlineUserEditRuntime extends InlineMessageEditRuntime {
  commands(sessionId: string): Promise<SlashCommandInfo[]>
  matches(command: SlashCommandInfo, query: string): boolean
  menuActions(callbacks: Pick<SlashMenuActions, 'onSelectCommand' | 'onSelectMention' | 'onMentionMenuEmpty'>): SlashMenuActions
  reference(entry: MentionEntry, sessionId: string): Promise<Omit<ComposerReferenceToken, 'range'> | null>
}
let runtime: InlineUserEditRuntime
export function configureInlineUserEditing(value: InlineUserEditRuntime): void { runtime = value }
export const inlineUserEdits = new InlineMessageEdits(() => runtime)
export function openInlineUserEdit(sessionId: string, handle: MessageEditHandle): void { void inlineUserEdits.begin(sessionId, handle) }
export function useInlineUserEdit(sessionId: string, handle: MessageEditHandle) {
  const key = inlineUserEdits.key(sessionId, handle)
  const state = useSyncExternalStore(inlineUserEdits.subscribe, () => inlineUserEdits.snapshot(key), () => undefined)
  return { key, state }
}

/** This editor belongs to one submitted message, independent of either composer. */
export function InlineUserEditor({ editKey }: { editKey: string }) {
  const state = useSyncExternalStore(inlineUserEdits.subscribe, () => inlineUserEdits.snapshot(editKey), () => undefined)
  const t = useT(), root = useRef<HTMLDivElement>(null), wrapper = useRef<HTMLFormElement>(null), menuRoot = useRef<HTMLDivElement>(null)
  const control = useRef<ComposerTextControl | null>(null)
  const discoveryRef = useRef<ReturnType<typeof createEditorDiscovery> | null>(null)
  const prepared = state?.prepared
  useLayoutEffect(() => {
    if (!prepared || !state?.draft || !root.current || !wrapper.current || !menuRoot.current) return
    const input = root.current as unknown as HTMLTextAreaElement
    let tokens: InlineTokenSnapshot[] = [], references: ComposerReferenceToken[] = []
    const editor = installContenteditableTextControl(root.current, value => tokens.map(token => {
      const element = document.createElement('span'), data = token.data as { kind?: string; name?: string; command?: SlashCommandInfo; previewText?: string; text?: string }
      if (!data || typeof data !== 'object') element.textContent = token.value
      else if (data.kind === 'selected-text') { element.className = 'kls-inline-quote'; element.textContent = data.previewText || data.text || '' }
      else if (data.kind === 'command') { element.className = 'composer-reference-token'; element.textContent = data.name || data.command?.displayName || data.command?.name || token.value }
      else element.innerHTML = renderComposerReferencePillHtml(data as ComposerReferenceToken)
      return { ...token, value: value.slice(token.start, token.end), element }
    }), { restoreTokens: (value, next) => { tokens = next; references = referencesFromEditor(value, next) } })
    if (!editor) return
    control.current = editor
    if (!state.draft.document || !editor.restoreDocument(state.draft.document)) editor.restoreText(state.draft.text)
    const insert = (reference: Omit<ComposerReferenceToken, 'range'>, query: { start: number; end: number }) => {
      if (inlineUserEdits.snapshot(editKey)?.status !== 'editing') return
      const before = input.value, inserted = replaceComposerReferenceRange(before, query.start, query.end, '', reference)
      references = normalizeComposerReferences(inserted.text, [...syncComposerReferences(before, inserted.text, references), inserted.reference])
      const existing = tokens.filter(token => (token.data as { kind?: string })?.kind === 'selected-text')
      tokens = [...existing, ...references.map(item => ({ ...item.range, value: item.value, data: item }))]
      editor.replaceRange(query.start, query.end, inserted.text.slice(query.start, inserted.text.length - before.length + query.end), 'insertText')
      input.focus(); input.setSelectionRange(inserted.caret, inserted.caret)
    }
    let discovery: ReturnType<typeof createEditorDiscovery> | null = null
    const menuActions = runtime.menuActions({
      onSelectCommand: command => discovery?.selectCommand(command), onSelectMention: (entry, intent) => { void discovery?.selectMention(entry, intent) },
      onMentionMenuEmpty: () => discovery?.empty(),
    })
    menuActions.contextCommands = async () => (await runtime.commands(state.sessionId)).filter(isSkillCommand)
    menuActions.contextCatalogScope = 'inline-skills'
    menuActions.onRequestClose = () => discovery?.hide(true)
    const menu = mountSlashMenu(menuRoot.current, menuActions, { wrapper: wrapper.current, input: root.current })
    if (menu) discovery = createEditorDiscovery({ input, control: editor, menu, prefixes: ['@', '$'],
      context: () => root.current?.isConnected && inlineUserEdits.snapshot(editKey)?.status === 'editing'
        ? { owner: editKey, sessionId: state.sessionId } : null,
      load: () => runtime.commands(state.sessionId), matches: runtime.matches,
      command: (command, query) => insert(skillReference(command), query), reference: entry => runtime.reference(entry, state.sessionId), insert,
      failure: error => (window as any).showToast?.(runtime.failure(error)),
    })
    discoveryRef.current = discovery
    const changed = () => { inlineUserEdits.update(editKey, composerDraftFromControl(editor)); void discovery?.refresh() }
    const selected = () => { void discovery?.refresh() }
    const blur = () => discovery?.hide()
    const blockFiles = (event: DragEvent | ClipboardEvent) => {
      const data = 'clipboardData' in event ? event.clipboardData : event.dataTransfer
      if (!data?.files.length && !Array.from(data?.types || []).some(type => /files?/i.test(type))) return
      event.preventDefault(); event.stopPropagation()
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.keyCode === 229 || editor.composing || discovery?.keydown(event)) return
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); inlineUserEdits.cancel(editKey) }
    }
    const submitKeydown = (event: KeyboardEvent) => {
      if (composerKeyWasHandled(event) || event.isComposing || event.keyCode === 229 || editor.composing) return
      if (event.key === 'Enter' && !event.shiftKey && !event.altKey) {
        event.preventDefault(); event.stopImmediatePropagation(); void inlineUserEdits.submit(editKey)
      }
    }
    input.addEventListener('input', changed); input.addEventListener('select', selected); input.addEventListener('focus', selected)
    input.addEventListener('blur', blur); input.addEventListener('keydown', keydown, true)
    input.addEventListener('keydown', submitKeydown)
    const form = wrapper.current
    for (const type of ['dragenter', 'dragover', 'drop']) form.addEventListener(type, blockFiles as EventListener, true)
    form.addEventListener('paste', blockFiles as EventListener, true)
    input.focus(); input.setSelectionRange(input.value.length, input.value.length)
    return () => { discovery?.hide(); menu?.destroy?.(); input.removeEventListener('input', changed); input.removeEventListener('select', selected)
      input.removeEventListener('focus', selected); input.removeEventListener('blur', blur); input.removeEventListener('keydown', keydown, true)
      input.removeEventListener('keydown', submitKeydown)
      for (const type of ['dragenter', 'dragover', 'drop']) form.removeEventListener(type, blockFiles as EventListener, true)
      form.removeEventListener('paste', blockFiles as EventListener, true)
      editor.destroy?.(); control.current = null; discoveryRef.current = null }
  }, [editKey, prepared])
  useLayoutEffect(() => {
    control.current?.setEditable?.(state?.status !== 'submitting')
    if (state?.status !== 'editing') discoveryRef.current?.hide()
    root.current?.setAttribute('aria-disabled', String(state?.status === 'submitting'))
  }, [state?.status])
  if (!state) return null
  const pending = state.status === 'submitting'
  return <form ref={wrapper} className="inline-user-edit" onSubmit={event => { event.preventDefault(); void inlineUserEdits.submit(editKey) }}>
    {state.prepared && <div ref={root} className="inline-user-edit-input" aria-label={t('msg_edit')} />}
    <div ref={menuRoot} className="slash-menu hidden" />
    {state.error && <div className="inline-user-edit-error" role="alert">{state.error}</div>}
    <div className="inline-user-edit-actions">
      <button type="button" disabled={pending} onClick={() => inlineUserEdits.cancel(editKey)}>{t('msg_edit_cancel')}</button>
      <button type="submit" disabled={!inlineMessageEditCanSubmit(state)} aria-busy={pending}>{t('send')}</button>
    </div>
  </form>
}
