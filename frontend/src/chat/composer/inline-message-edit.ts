import type { PendingFileEntry, SlashCommandInfo } from '../engine-events'
import { composerDocumentFromText, composerTokenDataWithinDepth, restoreComposerDocument, serializeComposerDocument, snapshotComposerDocument } from './document-model'
import { createComposerDraft, normalizeComposerDraft, type ComposerDraft } from './slash-draft'
import { migrateSkillDraft, referencesFromEditor } from './resource-reference'
import { pendingEntriesFromPrepare, restoredMessageTextCards, editCanSubmit, type RestoredMessageDraft } from './sent-message-edit'
import type { InlineTokenSnapshot } from './inline-token'

export interface MessageEditHandle { uuid: string; turnId: string }
export interface PreparedMessageEdit extends RestoredMessageDraft { messageUuid?: string }

/** Restore authored atoms independently of the ordinary composer draft. */
export function inlineMessageEditDraft(prepared: PreparedMessageEdit): ComposerDraft {
  const metadata = prepared.displayMetadata, cards = restoredMessageTextCards(prepared)
  const command = metadata?.slashCommand
  const initial = migrateSkillDraft(normalizeComposerDraft({ text: cards.text, references: metadata?.composerReferences,
    document: metadata?.composerDocument,
    ...(command?.name && cards.text.startsWith(`/${command.name}`)
      ? { slashCommand: { command, range: { start: 0, end: command.name.length + 1 } } } : {}),
  }))
  if (initial.document) return initial
  let text = initial.text
  const tokens: InlineTokenSnapshot[] = initial.references.map(reference => ({ ...reference.range, value: reference.value, data: reference }))
  if (initial.slashCommand) {
    const { command, range } = initial.slashCommand
    tokens.push({ ...range, value: initial.text.slice(range.start, range.end),
      data: { kind: 'command', name: command.displayName || command.name, command } })
  }
  const quotes = cards.selectedTextAttachments.map((card: any, index: number) => ({ ...card, index }))
    .filter((card: any) => typeof card.text === 'string' && card.text)
    .sort((a: any, b: any) => Number(b.requestOffset || 0) - Number(a.requestOffset || 0)
      || Number(b.displayOrder ?? b.index) - Number(a.displayOrder ?? a.index))
  for (const card of quotes) {
    let start = Math.max(0, Math.min(text.length, Number.isInteger(card.requestOffset) ? Number(card.requestOffset) : 0))
    const containing = tokens.find(token => token.start < start && start < token.end)
    if (containing) start = containing.end
    const data = { ...card, kind: 'selected-text', quoteId: card.quoteId || crypto.randomUUID(), file: { name: 'Quoted text', type: 'text/plain', size: card.text.length } }
    delete data.index
    const supported = composerTokenDataWithinDepth(data), inserted = supported ? '\uFFFC' : card.text
    for (const token of tokens) if (token.start >= start) { token.start += inserted.length; token.end += inserted.length }
    text = text.slice(0, start) + inserted + text.slice(start)
    if (supported) tokens.push({ start, end: start + 1, value: '\uFFFC', data })
  }
  const document = composerDocumentFromText(text, tokens), serialized = serializeComposerDocument(document)
  const selectedCommand = serialized.tokens.find(token => (token.data as { kind?: string })?.kind === 'command')
  return createComposerDraft(serialized.text, (selectedCommand?.data as { command?: SlashCommandInfo })?.command || null,
    selectedCommand ? { start: selectedCommand.start, end: selectedCommand.end } : null,
    referencesFromEditor(serialized.text, serialized.tokens), snapshotComposerDocument(document))
}

/** Existing tray items remain fixed; edited inline quotes use their current authored offsets. */
export function inlineMessageEditFiles(prepared: PreparedMessageEdit, draft: ComposerDraft,
  mediaUrl: (path: string) => string): PendingFileEntry[] {
  const cards = restoredMessageTextCards(prepared)
  const pastes = cards.pastedCards.filter((card: any) => typeof card.path === 'string' && card.path)
  const pastePaths = new Set(pastes.map((card: any) => card.path))
  const files = pendingEntriesFromPrepare(prepared.attachments, mediaUrl).filter(file => !pastePaths.has(file.uploadPath))
  for (const card of pastes) files.push({ kind: 'pasted-text', file: { name: 'pasted text', type: 'text/plain', size: card.characterCount || 0 },
    uploadPath: card.path, uploading: false, previewText: card.preview || card.previewText || '',
    ...(typeof card.text === 'string' ? { text: card.text } : {}), characterCount: card.characterCount })
  for (const card of cards.pastedCards.filter((card: any) => !card.path && typeof card.text === 'string')) files.push({
    kind: 'pasted-text', text: card.text, previewText: card.preview || card.previewText || '', uploading: false,
    file: { name: 'pasted text', type: 'text/plain', size: card.text.length } })
  const document = restoreComposerDocument(draft.document)
  const serialized = document ? serializeComposerDocument(document) : { text: draft.text, tokens: [] }
  const quotes = serialized.tokens.filter(token => (token.data as { kind?: string })?.kind === 'selected-text')
  for (const [index, token] of quotes.entries()) {
    const data = token.data as PendingFileEntry
    files.push({ ...data, file: { name: 'Quoted text', type: 'text/plain', size: data.text?.length || 0 },
      uploading: false, range: undefined, requestOffset: token.start, displayOrder: index })
  }
  return files
}

export interface InlineMessageEditState {
  key: string
  sessionId: string
  handle: MessageEditHandle
  status: 'preparing' | 'editing' | 'submitting'
  prepared?: PreparedMessageEdit
  draft?: ComposerDraft
  error?: string
}
export interface InlineMessageEditRuntime {
  prepare(sessionId: string, handle: MessageEditHandle): Promise<PreparedMessageEdit>
  submit(state: InlineMessageEditState & { prepared: PreparedMessageEdit; draft: ComposerDraft }): Promise<void>
  failure(error: unknown): string
}

export function inlineMessageEditCanSubmit(state?: InlineMessageEditState): state is InlineMessageEditState & {
  prepared: PreparedMessageEdit; draft: ComposerDraft
} {
  return state?.status === 'editing' && !!state.prepared && !!state.draft
    && editCanSubmit(state.draft.text, inlineMessageEditFiles(state.prepared, state.draft, () => '').length)
}

/** Per-message state survives transcript remounts without touching new-message drafts. */
export class InlineMessageEdits {
  private entries = new Map<string, InlineMessageEditState>()
  private listeners = new Set<() => void>()
  constructor(private runtime: () => InlineMessageEditRuntime) {}
  key(sessionId: string, handle: MessageEditHandle): string { return JSON.stringify([sessionId, handle.turnId || handle.uuid]) }
  snapshot(key: string): InlineMessageEditState | undefined { return this.entries.get(key) }
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener) }
  private publish(key: string, state?: InlineMessageEditState) {
    if (state) this.entries.set(key, state); else this.entries.delete(key)
    for (const listener of this.listeners) listener()
  }
  async begin(sessionId: string, handle: MessageEditHandle): Promise<void> {
    const key = this.key(sessionId, handle)
    if (this.entries.has(key)) return
    if (this.entries.size >= 100) {
      const oldest = [...this.entries].find(([, value]) => value.status !== 'submitting')
      if (!oldest) return
      this.entries.delete(oldest[0])
    }
    const state: InlineMessageEditState = { key, sessionId, handle: { ...handle }, status: 'preparing' }
    this.publish(key, state)
    const runtime = this.runtime()
    try {
      const prepared = await runtime.prepare(sessionId, handle)
      if (this.entries.get(key) !== state) return
      this.publish(key, { ...state, handle: { ...handle, uuid: prepared.messageUuid || handle.uuid }, status: 'editing', prepared, draft: inlineMessageEditDraft(prepared) })
    } catch (error) {
      if (this.entries.get(key) !== state) return
      this.publish(key, { ...state, status: 'editing', error: runtime.failure(error) })
    }
  }
  update(key: string, draft: ComposerDraft): void {
    const state = this.entries.get(key)
    if (state?.status === 'editing' && state.prepared) this.publish(key, { ...state, draft, error: undefined })
  }
  cancel(key: string): boolean {
    if (this.entries.get(key)?.status === 'submitting') return false
    this.publish(key)
    return true
  }
  forgetSession(sessionId: string): void {
    for (const [key, state] of this.entries) if (state.sessionId === sessionId) this.publish(key)
  }
  async submit(key: string): Promise<void> {
    const state = this.entries.get(key)
    if (!inlineMessageEditCanSubmit(state)) return
    const submitting = { ...state, status: 'submitting' as const, prepared: state.prepared, draft: state.draft, error: undefined }
    this.publish(key, submitting)
    const runtime = this.runtime()
    try {
      await runtime.submit(submitting)
      if (this.entries.get(key) === submitting) this.publish(key)
    } catch (error) {
      if (this.entries.get(key) === submitting) this.publish(key, { ...submitting, status: 'editing', error: runtime.failure(error) })
    }
  }
}
