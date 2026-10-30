import { normalizeComposerDraft, type ComposerDraft } from './slash-draft'
import { syncComposerReferences } from './reference-token'
import { EditorState } from 'prosemirror-state'
import { restoreComposerDocument, serializeComposerDocument, snapshotComposerDocument } from './document-model'
import { projectComposerDocument } from './document-projection'
import { referencesFromEditor } from './resource-reference'
import type { SlashCommandInfo } from '../engine-events'

/** Consume only an unchanged structured prefix, retaining newly authored formatting. */
function remainingDocumentDraft(submitted: ComposerDraft, current: ComposerDraft): ComposerDraft | null {
  const before = restoreComposerDocument(submitted.document), after = restoreComposerDocument(current.document)
  if (!before || !after) return null
  const prefix = projectComposerDocument(before), complete = projectComposerDocument(after)
  if (!prefix.text || !complete.text.startsWith(prefix.text)) return null
  const end = complete.documentPosition(prefix.text.length)
  const state = EditorState.create({ doc: after })
  if (!state.tr.delete(end, after.content.size).doc.eq(before)) return null
  let remainder = state.tr.delete(0, end).doc
  const remainingProjection = projectComposerDocument(remainder)
  const trim = remainingProjection.text.length - remainingProjection.text.trimStart().length
  if (trim) remainder = EditorState.create({ doc: remainder }).tr.delete(0, remainingProjection.documentPosition(trim)).doc
  const serialized = serializeComposerDocument(remainder)
  const command = serialized.tokens.find(token => (token.data as { kind?: string })?.kind === 'command')
  return normalizeComposerDraft({ text: serialized.text, document: snapshotComposerDocument(remainder),
    references: referencesFromEditor(serialized.text, serialized.tokens),
    slashCommand: command ? { command: (command.data as { command: SlashCommandInfo }).command,
      range: { start: command.start, end: command.end } } : null })
}

export interface SubmissionDraft<File> {
  draft: ComposerDraft
  files: readonly File[]
}

function quoteIdentity(file: unknown): string | null {
  if (!file || typeof file !== 'object') return null
  const quote = file as { kind?: string; quoteId?: string; text?: string; specAnnotation?: unknown }
  return quote.kind === 'selected-text' && typeof quote.quoteId === 'string' && quote.quoteId
    ? JSON.stringify([quote.quoteId, quote.text, quote.specAnnotation]) : null
}

function remainingSubmissionDraft<File>(before: SubmissionDraft<File>, current: SubmissionDraft<File>): SubmissionDraft<File> | null {
  const submitted = normalizeComposerDraft(before.draft)
  let draft = current.draft
  const documentRemainder = remainingDocumentDraft(submitted, draft)
  if (documentRemainder) draft = documentRemainder
  // An appended character must not keep the whole sent message in the composer.
  // A replacement or an edit within the submitted text remains a separate draft.
  if (!submitted.document && !draft.document && submitted.text && draft.text.startsWith(submitted.text)) {
    const prefix = normalizeComposerDraft({ ...draft, text: submitted.text })
    if (JSON.stringify(prefix) === JSON.stringify(submitted)) {
      // Draft restoration removes leading whitespace, so offsets must describe
      // the same remaining text that the composer will actually render.
      const text = draft.text.slice(submitted.text.length).trimStart()
      const removedPrefixLength = draft.text.length - text.length
      const selection = draft.slashCommand
      draft = normalizeComposerDraft({
        text,
        slashCommand: selection && selection.range.start >= removedPrefixLength ? {
          command: selection.command,
          range: { start: selection.range.start - removedPrefixLength, end: selection.range.end - removedPrefixLength },
        } : null,
        references: syncComposerReferences(draft.text, text, draft.references),
      })
    }
  }
  const sentFiles = new Set(before.files)
  const sentQuotes = new Set(before.files.map(quoteIdentity).filter((identity): identity is string => identity !== null))
  const files = current.files.filter(file => {
    const quote = quoteIdentity(file)
    return !sentFiles.has(file) && (!quote || !sentQuotes.has(quote))
  })
  return draft !== current.draft || files.length !== current.files.length ? { draft, files } : null
}

// Session creation can reject before there is a turn or transcript to own an
// error. Keep the draft intact until creation succeeds, then consume submitted
// text and attachments independently while retaining newly authored content.
export async function prepareComposerSubmission<File, Payload>(options: {
  snapshot: SubmissionDraft<File>
  ensureSession(): Promise<string | null>
  buildPayload(sessionId: string): Payload
  readDraft(sessionId: string): SubmissionDraft<File>
  consumeDraft(sessionId: string, remaining: SubmissionDraft<File>): void
  onUnavailable(error: unknown): void
  releaseBusy(): void
}): Promise<{ sessionId: string; payload: Payload } | null> {
  try {
    const sessionId = await options.ensureSession()
    if (!sessionId) throw new Error('Session creation returned no session')
    const payload = options.buildPayload(sessionId)
    const remaining = remainingSubmissionDraft(options.snapshot, options.readDraft(sessionId))
    if (remaining) options.consumeDraft(sessionId, remaining)
    return { sessionId, payload }
  } catch (error) {
    try {
      options.onUnavailable(error)
    } finally {
      options.releaseBusy()
    }
    return null
  }
}
