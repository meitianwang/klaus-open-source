import type { SlashCommandInfo } from '../engine-events'
import type { InlineTokenSnapshot } from './inline-token'
import { normalizeComposerReferences, syncComposerReferences, type ComposerReferenceToken } from './reference-token'
import { createComposerDraft, type ComposerDraft } from './slash-draft'
import { resourceReferenceValue, type ResourceReferenceKind } from '../../../../shared/composer-reference-scan'

export function isSkillCommand(command: SlashCommandInfo): boolean {
  const source = String(command.source || '').toLowerCase()
  return command.kind === 'skill' || source.includes('skill') || source === 'bundled' || source === 'installed'
}

export function skillReference(command: SlashCommandInfo, label = command.displayName || command.name): Omit<ComposerReferenceToken, 'range'> {
  const path = typeof command.path === 'string' ? command.path : undefined
  return { ...resourceReference('skill', label, command.name),
    value: resourceReferenceValue('skill', label, command.name, path),
    ...(path ? { skillPath: path } : {}), ...(command.definitionPreview === true ? { skillPreview: true } : {}), source: 'configured' }
}

export function resourceReference(kind: ResourceReferenceKind, name: string, id = name): Omit<ComposerReferenceToken, 'range'> {
  return { kind, name, id, value: resourceReferenceValue(kind, name, id), ...(kind === 'plugin' ? { source: 'plugin' as const } : {}) }
}

/** Older drafts used a single executable selection for a skill mention. */
export function migrateSkillDraft(draft: ComposerDraft): ComposerDraft {
  const selected = draft.slashCommand
  if (!selected || !isSkillCommand(selected.command)) return draft
  const reference = skillReference(selected.command)
  const text = draft.text.slice(0, selected.range.start) + reference.value + draft.text.slice(selected.range.end)
  return createComposerDraft(text, null, null, [...syncComposerReferences(draft.text, text, draft.references),
    { ...reference, range: { start: selected.range.start, end: selected.range.start + reference.value.length } }])
}

/** Surviving editor nodes own their identities and positions after native edits. */
export function referencesFromEditor(value: string, tokens: readonly InlineTokenSnapshot[]): ComposerReferenceToken[] {
  return normalizeComposerReferences(value, tokens.flatMap(token => {
    if (!token.data || typeof token.data !== 'object') return []
    return [{ ...token.data, range: { start: token.start, end: token.end } }]
  }))
}

/** Identity context reaches the model; display metadata alone is renderer-only. */
export function resourceReferenceContext(references: readonly ComposerReferenceToken[]): string {
  const resources = references.filter(reference => ['skill', 'plugin', 'mcp', 'file', 'folder'].includes(reference.kind))
    .map(reference => ({ kind: reference.kind, name: reference.kind === 'skill' ? reference.id || reference.name : reference.name,
      ...(reference.id ? { id: reference.id } : {}), ...(reference.skillPath || reference.path || reference.rel ? { path: reference.skillPath || reference.path || reference.rel } : {}) }))
  const unique = [...new Map(resources.map(resource => [JSON.stringify([resource.kind, resource.id || resource.name, resource.path]), resource])).values()]
  if (!unique.length) return ''
  return ['<referenced-resources>',
    'The user selected these inline references. Interpret them with the surrounding message; selection is not a standalone command.',
    'When the request calls for a skill, resolve its exact name with the skill tool. Some user-selectable skills are hidden from that tool; read the referenced definition path instead. If an older reference has no path, locate SKILL.md under the configured skill roots. A failed tool lookup alone does not mean the selected skill is unavailable.',
    'Plugins and MCP references identify tool sources; use their available capabilities when relevant to the request.',
    'File and folder references identify exact filesystem targets. Resolve relative paths from the conversation workspace, and read or inspect those targets when needed for the request.',
    'If a referenced resource cannot be resolved, explain its unavailability instead of silently ignoring the reference.',
    JSON.stringify(unique), '</referenced-resources>'].join('\n')
}
