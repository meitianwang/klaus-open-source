import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { SLASH_COMMAND_NAME_RE, classifySlashCommand, isHiddenBuiltinSlashCommand, sortSlashCommands } from './helpers'

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), 'utf8')
}

describe('slash commands page contract', () => {
  const page = source('./SlashCommandsPage.tsx')
  const index = source('./index.tsx')
  const styles = source('./slash-commands.module.css')
  const chat = source('../../chat/chat.ts')

  test('project commands start a draft in their owning project', () => {
    expect(page).toContain("w().klausComposer.startNewChat({ workdir: projectRoot })")
    expect(page).toContain("draftInComposer(commandForInsert(name), '', isProject ? activeRoot : '', isWorkspace ? scope.id : '')")
    expect(page).toContain("draftInComposer(command, seed, isProject ? activeRoot : '', isWorkspace ? activeWorkspace?.id ?? '' : '')")
    expect(chat).toContain('startNewChat(options: { workdir?: string | null; workspaceId?: string | null } = {})')
    expect(chat).toContain('newChat(options)')
  })

  test('workspace tabs list every member folder and route writes to the primary root', () => {
    expect(page).toContain('data-qc-scope-ws=')
    expect(page).toContain("w().klaus.commands?.list?.(workspaceId ? { workspaceId } : projectRoot ? { projectRoot } : undefined)")
    expect(page).toContain('{ workspaceId: sv.slice(WORKSPACE_SCOPE_PREFIX.length) }')
    expect(page).toContain('w().klausComposer.startNewChat({ workdir: null, workspaceId })')
  })

  test('page entry refreshes data and scope changes never expose stale rows', () => {
    expect(index).toContain('onShow: () =>')
    expect(index).toContain('SLASH_COMMANDS_RELOAD_EVENT')
    expect(page).toContain('window.addEventListener(SLASH_COMMANDS_RELOAD_EVENT, onReload)')
    expect(page).toContain('loadedScope: effective')
    expect(page).toContain('sameScope(data.loadedScope, scope)')
    expect(page).toContain('setScope(dataRef.current.loadedScope)')
  })

  test('only locally manageable projects are offered as command scopes', () => {
    expect(page).toContain("!root.startsWith('ssh://')")
    expect(page).toContain('root.split(/[\\\\/]/)')
  })

  test('the full visual row opens details while action buttons remain independent', () => {
    expect(page.match(/closest\(`\.\$\{styles\['qc-row-actions'\]\}`\)/g)?.length).toBe(2)
    expect(page.match(/<button type="button" className=\{styles\['qc-row-open'\]\} aria-label=\{`\/\$\{name\}`\}>/g)?.length).toBe(2)
    expect(styles).toContain('.qc-row-open {')
    expect(styles).toContain('font: inherit;')
    expect(styles).toContain(':global(#slash-commands-results .qc-row)')
  })

  test('scope tabs and the editor expose complete keyboard and dialog semantics', () => {
    expect(page).toContain('role="tablist"')
    expect(page).toContain('role="tab" aria-selected=')
    expect(page).toContain("['ArrowLeft', 'ArrowRight', 'Home', 'End']")
    expect(page).toContain('tabs[nextIndex]?.click()')
    expect(page).toContain('pendingScopeFocusRef.current = tabs[nextIndex]?.dataset.qcScopeWs')
    expect(page).toContain(": tabs[nextIndex]?.dataset.qcScopeRoot || 'global'")
    expect(page).toContain('target?.focus()')
    expect(page).toContain('role="dialog"')
    expect(page).toContain('aria-modal="true"')
    expect(page).toContain("event.key !== 'Tab'")
    expect(page).toContain("option.setAttribute('role', 'option')")
    expect(page).toContain("const navigationKeys = ['ArrowDown', 'ArrowUp', 'Home', 'End']")
    expect(page).toContain("dialog?.querySelector('.kls-select.open')")
    expect(page).toContain('const usefulPreviousFocus = previousFocus')
    expect(page).toContain('previousFocus !== document.body')
    expect(page).toContain('selectApi?.destroy?.()')
    expect(page).toContain('htmlFor="qc-editor-name"')
    expect(page).toContain("aria-invalid={nameError ? 'true' : 'false'}")
  })

  test('save and delete mutations synchronously reject duplicate entry and cannot dismiss mid-save', () => {
    expect(page).toContain('if (savingRef.current) return')
    expect(page).toContain('savingRef.current = true')
    expect(page).toContain('if (!savingRef.current) onClose()')
    expect(page).toContain('if (deletingRef.current) return')
    expect(page).toContain('deletingRef.current = true')
    expect(page).toContain("aria-busy={deletingName === name ? 'true' : 'false'}")
  })

  test('manual context actions remain discoverable in desktop command surfaces', () => {
    expect(isHiddenBuiltinSlashCommand({ name: 'compact', type: 'local' })).toBe(false)
    expect(isHiddenBuiltinSlashCommand({ name: 'COMPACT' })).toBe(false)
    expect(isHiddenBuiltinSlashCommand({ name: 'init', type: 'local' })).toBe(false)
    expect(isHiddenBuiltinSlashCommand({ name: 'review', source: 'commands' })).toBe(false)
    expect(isHiddenBuiltinSlashCommand(null)).toBe(false)
    // The composer menu and the page both consume the engine list through this gate.
    const discovery = chat.slice(chat.indexOf('async function loadScopedSlashCommands('), chat.indexOf('async function', chat.indexOf('async function loadScopedSlashCommands(') + 1))
    expect(discovery).toContain("(sessionId || root || command?.scope !== 'project') && !isHiddenBuiltinSlashCommand(command)")
    expect(chat).toContain("import { isHiddenBuiltinSlashCommand } from '../pages/slash-commands/helpers'")
    expect(page).toContain('&& !isHiddenBuiltinSlashCommand(command)')
  })

  test('command classification, ordering and names remain deterministic', () => {
    expect(classifySlashCommand({ name: 'compact', source: 'builtin' })).toBe('builtin')
    expect(classifySlashCommand({ name: 'plugin:run', source: 'plugin' })).toBe('plugins')
    expect(classifySlashCommand({ name: 'server:prompt', source: 'mcp' })).toBe('mcp')
    expect(sortSlashCommands([{ name: 'zeta' }, { name: 'alpha' }]).map(command => command.name)).toEqual(['alpha', 'zeta'])
    expect(SLASH_COMMAND_NAME_RE.test('release-notes_2')).toBe(true)
    expect(SLASH_COMMAND_NAME_RE.test('../escape')).toBe(false)
    expect(SLASH_COMMAND_NAME_RE.test(`a${'b'.repeat(64)}`)).toBe(false)
  })
})
