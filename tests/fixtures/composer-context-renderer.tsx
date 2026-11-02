import '../../frontend/css/styles.css'
import { installContenteditableTextControl } from '../../frontend/src/chat/composer/contenteditable-control'
import { createEditorDiscovery } from '../../frontend/src/chat/composer/editor-discovery'
import { mountSlashMenu, type MentionEntry } from '../../frontend/src/chat/composer/slash-menu'
import { normalizeComposerReferences, replaceComposerReferenceRange, syncComposerReferences, type ComposerReferenceToken } from '../../frontend/src/chat/composer/reference-token'
import { referencesFromEditor, resourceReference, skillReference } from '../../frontend/src/chat/composer/resource-reference'
import { workspaceReference } from '../../frontend/src/chat/composer/workspace-reference'
import { renderComposerReferencePillHtml } from '../../frontend/src/chat/composer/reference-pill'
import { queryClient } from '../../frontend/src/app/query-client'

const globals = window as any
globals.currentLang = 'en'
globals.PLUGIN_NAME_EN_OVERRIDES = {}
globals.PLUGIN_NAME_ZH_OVERRIDES = {}
globals.PLUGIN_NAME_TOKEN_ZH = {}
globals.SKILL_TEXT_I18N = {}
const fixtureFriendId = '11111111-1111-4111-8111-111111111111'
globals.klaus = {
  plugins: { list: async () => [{ id: 'review-tools', name: 'Review tools', installed: true, enabled: true }] },
  session: { list: async () => [{ id: 'chat-fixture', title: 'Review menus' }] },
  settings: { mobileBridge: { devices: async () => ({ ok: true, devices: [{ id: 'device-fixture', name: 'Fixture computer', platform: 'darwin', status: 'online' }] }) } },
  friends: { list: async () => ({ friends: [{ id: fixtureFriendId, status: 'accepted', displayName: 'Fixture friend', online: true }] }) },
  agents: { definitions: { list: async () => ({ agents: [{ agentType: 'reviewer', filename: 'Reviewer', whenToUse: 'Review changes' }] }) } },
  browserUse: { mentionTabs: async () => ({ ok: true, tabs: [], errors: [] }) },
  on: { browserUseState: () => () => {}, klausAuthUpdated: () => () => {} },
}
queryClient.clear()
document.body.innerHTML = `<main><h1>Context picker</h1><section id="main-surface" class="surface"><div id="main-card" class="card"><div id="main-input" contenteditable="true" role="textbox" aria-multiline="true"></div><button id="main-plus" type="button" aria-label="Add context">+</button><button id="main-after" type="button">Next control</button></div></section><section id="side-surface" class="surface"><div id="side-card" class="card"><div id="side-input" contenteditable="true" role="textbox" aria-multiline="true"></div><button id="side-plus" type="button" aria-label="Add context">+</button><button id="side-after" type="button">Next control</button></div></section></main>`
const commands = [...Array.from({ length: 14 }, (_, index) => ({ name: `skill-${index}`, displayName: `Skill ${index}`, description: `Review item ${index}`, kind: 'skill', type: 'prompt', source: 'skills' })),
  { name: 'note', displayName: 'Write a note', description: 'Prepare a note', kind: 'command', type: 'prompt', source: 'user' }]
const files = [{ name: 'menu.ts', rel: 'src/menu.ts', isDir: false }, { name: 'My Folder', rel: 'My Folder', isDir: true }]
function mount(owner: string) {
  const input = document.getElementById(`${owner}-input`)! as unknown as HTMLTextAreaElement
  const trigger = document.getElementById(`${owner}-plus`)!
  const container = document.createElement('div')
  container.id = `${owner}-context-menu`; container.className = 'hidden'; document.body.append(container)
  let references: ComposerReferenceToken[] = [], attachments = 0, submits = 0, commandSelections = 0, revision = 1
  const control = installContenteditableTextControl(input as unknown as HTMLElement, value => normalizeComposerReferences(value, references).map(reference => {
    const element = document.createElement('span'); element.innerHTML = renderComposerReferencePillHtml(reference)
    return { ...reference.range, value: reference.value, element, data: reference }
  }), { restoreTokens: (value, tokens) => { references = referencesFromEditor(value, tokens) } })!
  let discovery: ReturnType<typeof createEditorDiscovery>
  const insert = (reference: Omit<ComposerReferenceToken, 'range'>, range: { start: number; end: number }) => {
    const before = input.value, result = replaceComposerReferenceRange(before, range.start, range.end, '', reference)
    references = normalizeComposerReferences(result.text, [...syncComposerReferences(before, result.text, references), result.reference])
    control.replaceRange(range.start, range.end, result.text.slice(range.start, result.text.length - before.length + range.end), 'insertText')
    input.focus(); input.setSelectionRange(result.caret, result.caret)
  }
  const menu = mountSlashMenu(container, {
    commandIconSvg: () => '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="5" fill="currentColor"/></svg>',
    slashCommandDescription: command => command.description || '', slashCommandDisplayName: command => command.displayName || command.name,
    slashCommandGroupLabel: key => key, commandGroupKey: command => command.kind === 'skill' ? 'skills' : 'shortcuts',
    folderIconSvg: () => '▱', fileIconSvg: () => '▤', pluginIconSvg: () => '◇', deviceIconHtml: () => '▣', categoryIconHtml: () => '▤', conversationIconHtml: () => '○',
    openFileSearchSession: () => ({ search: async () => files, close: async () => {} } as any),
    contextCommands: async () => commands, contextMcp: async () => [{ name: 'Fixture tools' }],
    contextActions: () => [{ name: 'Add photos and files', path: 'context-action:attach-files', rel: '', kind: 'action', isDir: false, action: () => { attachments++ } }],
    onMentionMenuEmpty: () => discovery?.empty(), onRequestClose: () => discovery?.hide(true),
    onSelectCommand: command => discovery?.selectCommand(command), onSelectMention: (entry, intent) => { void discovery?.selectMention(entry, intent) },
  }, { wrapper: document.getElementById(`${owner}-surface`)!, input: document.getElementById(`${owner}-card`)!, trigger })!
  discovery = createEditorDiscovery({ input, control, menu, context: () => ({ owner: `${owner}:${revision}`, sessionId: owner, root: '/fixture-project' }),
    load: async () => commands, matches: (command, query) => command.name.includes(query),
    command: (command, range) => { commandSelections++; if (command.kind === 'skill') insert(skillReference(command), range); else control.replaceRange(range.start, range.end, `/${command.name} `, 'insertText') },
    reference: async (entry: MentionEntry) => entry.kind === 'mcp' || entry.kind === 'plugin' ? resourceReference(entry.kind, entry.name, entry.path)
      : entry.kind === 'agent' ? { kind: 'agent', name: entry.name, value: `@agent-${entry.path}`, source: 'configured' }
        : workspaceReference({ ...entry, path: `/fixture-project/${entry.rel}` }), insert, failure: error => { throw error },
  })
  input.addEventListener('input', () => { void discovery.refresh() })
  input.addEventListener('select', () => { void discovery.refresh() })
  input.addEventListener('blur', () => discovery.hide())
  input.addEventListener('keydown', event => {
    if (discovery.keydown(event)) return
    if (event.key === 'Enter' && !event.shiftKey) { submits++; event.preventDefault() }
  }, true)
  trigger.addEventListener('mousedown', event => event.preventDefault())
  trigger.addEventListener('click', () => discovery.isSynthetic() ? discovery.hide() : discovery.open())
  document.addEventListener('pointerdown', event => {
    if (!container.contains(event.target as Node) && !input.contains(event.target as Node) && !trigger.contains(event.target as Node)) discovery.hide(true)
  }, true)
  return {
    setText(value: string) { discovery.hide(); references = []; control.restoreText(value); input.focus(); input.setSelectionRange(value.length, value.length) },
    nextOwner() { revision++; void discovery.refresh() },
    snapshot() {
      const box = document.getElementById(`${owner}-card`)!.getBoundingClientRect(), panel = container.getBoundingClientRect(), style = getComputedStyle(container)
      const rows = Array.from(container.querySelectorAll<HTMLButtonElement>('[role=option]'))
      const row = rows[0], rowStyle = row ? getComputedStyle(row) : null
      return { value: input.value, references, attachments, submits, commandSelections, open: menu.isOpen(), focus: document.activeElement?.id,
        expanded: trigger.getAttribute('aria-expanded'), headings: Array.from(container.querySelectorAll('[data-mention-heading]')).map(element => element.textContent),
        rows: rows.map(element => ({ name: element.textContent, key: element.dataset.contextKey, active: element.getAttribute('aria-selected') === 'true' })),
        panel: { width: panel.width, left: panel.left, top: panel.top, bottom: panel.bottom, radius: style.borderRadius, shadow: style.boxShadow, padding: style.padding },
        anchor: { width: box.width, left: box.left, top: box.top, bottom: box.bottom },
        row: rowStyle ? { radius: rowStyle.borderRadius, height: row.getBoundingClientRect().height, minHeight: rowStyle.minHeight, fontSize: rowStyle.fontSize, lineHeight: rowStyle.lineHeight } : null,
      }
    },
  }
}
globals.contextFixture = { main: mount('main'), side: mount('side'), ready: true }
