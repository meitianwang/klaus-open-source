// Composer plus-menu skill rows: merge host installed + builtin + project
// skill rows into the deduplicated, sorted list the submenu renders.
// Kept pure so the merge semantics (project rows overriding same-name global
// rows, disabled/hidden rows dropped) are unit-testable without the DOM.
import { unpackBuiltinSkillsReply, type BuiltinSkillsReply } from '../../pages/skills/builtin-reply'
import { localizeSkillName } from '../../pages/skills/localize'

export interface ComposerSkillRow {
  name: string
  displayName: string
  description: string
  source: string
  path?: string
}

interface SkillLike {
  name?: unknown
  dirName?: unknown
  description?: unknown
  source?: unknown
  enabled?: unknown
  userEnabled?: unknown
  userInvocable?: unknown
  path?: unknown
}

interface ProjectCommandLike {
  name?: unknown
  displayName?: unknown
  description?: unknown
  source?: unknown
  kind?: unknown
  scope?: unknown
  path?: unknown
}

/** Same grouping rule as chat.ts commandGroupKey: the skills group is decided
 *  by the first matching branch, so plugin/mcp markers cannot override it. */
function isProjectSkillCommand(command: ProjectCommandLike | null | undefined): boolean {
  if (!command) return false
  const source = String(command.source || '').toLowerCase()
  return command.kind === 'skill' || source.includes('skill') || source === 'bundled' || source === 'installed'
}

export function selectComposerSkillRows(input: {
  installed: unknown
  builtin: unknown
  projectCommands: unknown
  loadFailedMessage: string
}): ComposerSkillRow[] {
  const { installed, builtin, projectCommands, loadFailedMessage } = input
  if (!Array.isArray(installed) || !Array.isArray(projectCommands)) throw new Error(loadFailedMessage)
  const builtinReply: BuiltinSkillsReply = unpackBuiltinSkillsReply(builtin)
  const byName = new Map<string, ComposerSkillRow>()
  for (const skill of [...builtinReply.items, ...(installed as SkillLike[])]) {
    const row = skill as SkillLike
    const name = String(row?.dirName || row?.name || '').trim()
    if (!name || byName.has(name)) continue
    if (row?.userInvocable === false) continue
    if (row?.enabled === false || row?.userEnabled === false) continue
    byName.set(name, {
      name,
      // The submenu row and the inserted chip show the same localized product
      // name the skills page shows; a slug without a table entry keeps its
      // frontmatter name, exactly like the page fallback.
      displayName: localizeSkillName({ dirName: name, name: String(row?.name || name) }),
      description: String(row?.description || ''),
      source: String(row?.source || 'skills'),
      ...(typeof row.path === 'string' ? { path: row.path } : {}),
    })
  }
  // Scoped discovery has already resolved shadowing and knows each definition's
  // exact path, including extra project roots and bundled assets.
  for (const command of projectCommands as ProjectCommandLike[]) {
    if (!isProjectSkillCommand(command)) continue
    const name = String(command.name || '').trim()
    if (!name) continue
    byName.set(name, {
      name,
      displayName: localizeSkillName({ dirName: name, name: String(command.displayName || name) }),
      description: String(command.description || ''),
      source: 'skills',
      ...(typeof command.path === 'string' ? { path: command.path } : {}),
    })
  }
  return [...byName.values()].sort((a, b) =>
    a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }))
}
