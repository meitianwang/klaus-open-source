import type { ComposerTextControl } from './contenteditable-control'
import type { SlashCommandInfo } from '../engine-events'
import { createComposerDraft } from './slash-draft'
import { referencesFromEditor } from './resource-reference'

/** One authored snapshot supplies history, submission and editing metadata. */
export function composerDraftFromControl(control: ComposerTextControl) {
  const serialized = control.serializeSubmission()
  const command = serialized.tokens.find(token => (token.data as { kind?: string })?.kind === 'command')
  return createComposerDraft(serialized.text, (command?.data as { command?: SlashCommandInfo })?.command || null,
    command ? { start: command.start, end: command.end } : null,
    referencesFromEditor(serialized.text, serialized.tokens), control.snapshotDocument())
}
