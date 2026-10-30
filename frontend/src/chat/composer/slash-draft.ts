import type { FriendComposeContext } from './friend-compose'
import type { SlashCommandInfo } from '../engine-events'
import { normalizeComposerReferences, type ComposerReferenceToken } from './reference-token'
import { restoreComposerDocument, snapshotComposerDocument, composerDocumentText, type ComposerDocumentSnapshot } from './document-model'

export interface ComposerSlashSelection {
  command: SlashCommandInfo
  range: { start: number; end: number }
}

export interface ComposerDraft {
  text: string
  slashCommand: ComposerSlashSelection | null
  references: ComposerReferenceToken[]
  document?: ComposerDocumentSnapshot
  friendCompose?: FriendComposeContext
}

function validSelection(text: string, value: unknown): ComposerSlashSelection | null {
  if (!value || typeof value !== 'object') return null
  const selection = value as Partial<ComposerSlashSelection>
  const command = selection.command
  const range = selection.range
  const name = typeof command?.name === 'string' ? command.name.trim() : ''
  if (!name || !range || !Number.isInteger(range.start) || !Number.isInteger(range.end)) return null
  if (range.start < 0 || range.end < range.start || range.end > text.length) return null
  if (text.slice(range.start, range.end) !== `/${name}`) return null
  return {
    command: { ...command, name },
    range: { start: range.start, end: range.end },
  }
}

/**
 * Normalize persisted composer data. Legacy string drafts intentionally have no
 * selected slash command: text that merely looks like `/name` is not evidence
 * that the user chose a menu item.
 */
export function normalizeComposerDraft(value: unknown): ComposerDraft {
  if (typeof value === 'string') return { text: value, slashCommand: null, references: normalizeComposerReferences(value, null) }
  if (!value || typeof value !== 'object') return { text: '', slashCommand: null, references: [] }
  const candidate = value as Partial<ComposerDraft>
  const text = typeof candidate.text === 'string' ? candidate.text : ''
  const document = restoreComposerDocument(candidate.document)
  return {
    text,
    slashCommand: validSelection(text, candidate.slashCommand),
    references: normalizeComposerReferences(text, candidate.references),
    ...(document ? { document: snapshotComposerDocument(document) } : {}),
    ...(candidate.friendCompose && ['request', 'notice'].includes(candidate.friendCompose.intent) ? { friendCompose: {
      intent: candidate.friendCompose.intent,
      ...(typeof candidate.friendCompose.recipientId === 'string' ? { recipientId: candidate.friendCompose.recipientId } : {}),
      ...(typeof candidate.friendCompose.quotedMessageId === 'string' ? { quotedMessageId: candidate.friendCompose.quotedMessageId } : {}),
      ...(typeof candidate.friendCompose.questionId === 'string' ? { questionId: candidate.friendCompose.questionId } : {}),
      ...(typeof candidate.friendCompose.replyToMessageId === 'string' ? { replyToMessageId: candidate.friendCompose.replyToMessageId } : {}),
      ...(typeof candidate.friendCompose.supplementToRequestId === 'string' ? { supplementToRequestId: candidate.friendCompose.supplementToRequestId } : {}),
      ...(typeof candidate.friendCompose.answersRequestId === 'string' ? { answersRequestId: candidate.friendCompose.answersRequestId } : {}),
    } } : {}),
  }
}

export function createComposerDraft(
  text: string,
  command: SlashCommandInfo | null = null,
  range: { start: number; end: number } | null = null,
  references: ComposerReferenceToken[] = [],
  document?: ComposerDocumentSnapshot,
): ComposerDraft {
  return normalizeComposerDraft({
    text: String(text || ''),
    slashCommand: command && range ? { command, range } : null,
    references,
    document,
  })
}

export function selectedSlashCommandFromDraft(value: unknown): ComposerSlashSelection | null {
  return normalizeComposerDraft(value).slashCommand
}

export function hasComposerDraftContent(draft: ComposerDraft): boolean {
  const document = restoreComposerDocument(draft.document)
  return draft.text.length > 0 || !!(document && composerDocumentText(document).length)
}
