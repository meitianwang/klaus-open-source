import { createRoot } from 'react-dom/client'
import vectors from '../contracts/vectors/hooks-settings-vectors.json'
import type { HookStateRow, HooksReply } from '../frontend/src/pages/settings/hooks-model'

const w = window as any
w.currentLang = 'en'
type Scope = { projectRoot: string } | undefined
type Mutation = { method: string; key?: string; enabled?: boolean; keys?: string[]; hooks?: Record<string, unknown>; scope?: Scope }
const mutations: Mutation[] = []
const gets: Array<Scope> = []
const revealed: string[] = []
const clone = <T,>(value: T): T => structuredClone(value)
const hooks = JSON.parse(JSON.stringify(vectors.globalHooks).replace('$LONG_COMMAND', vectors.longCommand))
const globalRows = vectors.globalRows.map(value => {
  const group = hooks[value.event][value.groupIndex]
  return {
    key: `global:${vectors.globalPath}:${value.event}:${value.groupIndex}:${value.hookIndex}`,
    scope: 'global', filePath: vectors.globalPath, event: value.event,
    command: group.hooks[value.hookIndex].command, isAsync: false, ...value,
  } as HookStateRow
})
const projectKey = `project:${vectors.projectPath}:PreToolUse:0:0`
const projectRows: HookStateRow[] = [{ key: projectKey, scope: 'project', filePath: vectors.projectPath, event: 'PreToolUse', command: vectors.projectHooks.PreToolUse[0].hooks[0].command, matcher: 'Bash', isAsync: false, status: 'new' }]
const replies = new Map<string, HooksReply>([
  ['global', { ok: true, path: vectors.globalPath, hooks, rows: globalRows }],
  [vectors.projectRoot, { ok: true, path: vectors.projectPath, hooks: clone(vectors.projectHooks), rows: [...globalRows, ...projectRows] }],
  ['/fixture/projects/empty', { ok: true, path: '/fixture/projects/empty/.klaus/hooks.json', hooks: {}, rows: [...globalRows] }],
])
let failNext = false
let failReadNext = false
let pauseNext = false
let releaseMutation: (() => void) | undefined

async function mutate(request: Mutation) {
  mutations.push(clone(request))
  if (pauseNext) {
    pauseNext = false
    await new Promise<void>(resolve => { releaseMutation = resolve })
    releaseMutation = undefined
  }
  if (failNext) { failNext = false; return { ok: false, error: 'Simulated hook update failure' } }
  const reply = replies.get(request.scope?.projectRoot ?? 'global')!
  if (request.method === 'trust') for (const row of reply.rows ?? []) if (request.keys?.includes(row.key)) row.status = 'trusted'
  if (request.method === 'setEnabled') for (const row of reply.rows ?? []) if (row.key === request.key) row.status = request.enabled ? 'trusted' : 'disabled'
  if (request.method === 'set') reply.hooks = clone(request.hooks!)
  return { ok: true }
}
w.settingsApi = { klausHooks: {
  get: async (scope?: Scope) => {
    gets.push(clone(scope))
    if (failReadNext) { failReadNext = false; return { ok: false, error: 'Simulated hook read failure' } }
    return clone(replies.get(scope?.projectRoot ?? 'global')!)
  },
  trust: async (keys: string[], scope?: Scope) => mutate({ method: 'trust', keys, scope }),
  setEnabled: async (key: string, enabled: boolean, scope?: Scope) => mutate({ method: 'setEnabled', key, enabled, scope }),
  set: async (value: Record<string, unknown>, scope?: Scope) => mutate({ method: 'set', hooks: value, scope }),
} }
w.klaus = {
  projects: { list: async () => ({ roots: [vectors.projectRoot], labels: { [vectors.projectRoot]: 'Atlas' } }) },
  workspaces: { list: async () => ({ workspaces: [{ name: 'Atlas workspace', roots: [vectors.projectRoot] }, { name: 'Empty project', roots: ['/fixture/projects/empty'] }] }) },
  plugins: { market: async () => ({ plugins: [{ id: 'fixture-tools', name: 'Workflow tools', installed: true, enabled: true, contributions: { hooks: ['PreToolUse (2)', 'PostToolUse (1)'] } }, { id: 'uninstalled-tools', name: 'Not installed', installed: false, enabled: false, contributions: { hooks: ['Stop'] } }] }) },
  settings: { kv: { get: async () => null } },
}
w.artifacts = { reveal: async (path: string) => { revealed.push(path); return { ok: true } } }

w.closeSettings = () => {}
w.klausKeybindingActions = { openPlugins: () => {} }

const results: string[] = []
const settle = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms))
async function until(check: () => unknown, label: string, timeout = 7000) {
  const start = Date.now()
  while (!check()) { if (Date.now() - start > timeout) throw Error(`Timed out: ${label}`); await settle() }
}
function assert(value: unknown, label: string): asserts value { if (!value) throw Error(label); results.push(label) }
const find = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector)
  if (!element) throw Error(`Missing ${selector}`)
  return element
}
const by = (attribute: string, value: string) => `[${attribute}="${CSS.escape(value)}"]`
const row = (key: string) => find<HTMLElement>(by('data-hook-row', key))
const toggle = (key: string) => find<HTMLInputElement>(by('data-hook-enabled', key))
async function native(request: { key?: string; shift?: boolean; capture?: string; width?: number; height?: number }) {
  await new Promise<void>((resolve, reject) => { w.hooksNativeDone = resolve; w.hooksNativeFail = reject; w.hooksNativeRequest = request })
  await settle(80)
}
async function open(id = 'global') {
  const button = find<HTMLButtonElement>(by('data-hook-source', id))
  button.focus()
  button.click()
  await until(() => document.querySelector<HTMLDialogElement>('[data-hooks-dialog]')?.open, `open source ${id}`)
  await settle()
  return button
}
async function close() {
  find<HTMLButtonElement>('[data-hooks-close]').click()
  await until(() => !document.querySelector('[data-hooks-dialog]'), 'close source')
}
function input(raw: string) {
  const editor = find<HTMLTextAreaElement>('#hooks-json-editor')
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, raw)
  editor.dispatchEvent(new Event('input', { bubbles: true }))
}
const trustedKey = globalRows.find(value => value.event === 'PreToolUse')!.key
const newKey = globalRows.find(value => value.event === 'PostToolUse' && value.status === 'new')!.key
const disabledKey = globalRows.find(value => value.event === 'SessionStart')!.key
const changedKey = globalRows.find(value => value.event === 'Stop')!.key

async function run() {
  const { HooksSettingsTab } = await import('../frontend/src/pages/settings/hooks-tab')
  createRoot(find('#fixture-root')).render(<HooksSettingsTab />)
  await until(() => document.querySelector('[data-hook-source="global"]') && !find<HTMLButtonElement>('[data-hooks-refresh]').disabled, 'loaded sources')
  assert(document.querySelectorAll(by('data-hook-source', `project:${vectors.projectRoot}`)).length === 1, 'Projects listed in multiple collections produce one source')
  assert(document.querySelectorAll('[data-hook-source^="project:"]').length === 2, 'Project sources include workspace roots')
  assert(!!document.querySelector('[data-hook-source="plugin:fixture-tools"]') && !document.body.textContent?.includes('Not installed'), 'Installed plugin contributions are discoverable')
  assert(!document.querySelector('#hooks-json-editor'), 'Overview keeps configuration syntax out of the initial view')
  await native({ capture: 'hooks-overview' })
  const opener = await open()
  const dialog = find<HTMLDialogElement>('[data-hooks-dialog]')
  assert(dialog.hasAttribute('aria-labelledby') && dialog.hasAttribute('aria-describedby'), 'Source dialog has an accessible title and description')
  assert(document.querySelectorAll('[data-hook-row]').length === globalRows.length, 'Global source displays every owned hook exactly once')
  assert(JSON.stringify(Array.from(document.querySelectorAll('[data-hook-event]')).map(element => element.getAttribute('data-hook-event'))) === JSON.stringify(vectors.expectedGlobalEventOrder), 'Configured hooks are grouped in stable event order')
  assert(toggle(trustedKey).checked && !toggle(trustedKey).disabled, 'Approved hooks expose an enabled switch')
  assert(!toggle(disabledKey).checked && !toggle(disabledKey).disabled, 'Disabled hooks can be enabled without another review')
  assert(!toggle(newKey).checked && toggle(newKey).disabled && !!row(newKey).querySelector('[data-hook-trust]'), 'New hooks require review before enabling')
  assert(!toggle(changedKey).checked && toggle(changedKey).disabled && !!row(changedKey).querySelector('[data-hook-trust]'), 'Changed hooks require a fresh review')
  await native({ capture: 'hooks-modal' })
  find<HTMLButtonElement>(by('data-hook-expand', newKey)).click()
  await until(() => row(newKey).textContent?.includes(vectors.longCommand), 'expanded command')
  assert(row(newKey).textContent?.includes('30s') && row(newKey).textContent?.includes('Write|Edit'), 'Expanded details expose the full command and execution options')
  const detail = find<HTMLElement>('#' + CSS.escape(find(by('data-hook-expand', newKey)).getAttribute('aria-controls')!))
  assert(detail.scrollWidth <= detail.clientWidth + 1, 'Long details wrap within the dialog')
  await native({ capture: 'hooks-expanded' })
  find<HTMLButtonElement>(by('data-hook-reveal', newKey)).click()
  await until(() => revealed.length, 'reveal hook configuration')
  assert(revealed[0] === vectors.globalPath, 'Reveal targets the hook source configuration')
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex="0"]')).filter(element => !!element.getClientRects().length)
  focusable.at(-1)!.focus()
  await native({ key: 'Tab' })
  assert(dialog.contains(document.activeElement), 'Tab remains in the modal dialog')
  focusable[0]!.focus()
  await native({ key: 'Tab', shift: true })
  assert(dialog.contains(document.activeElement), 'Shift Tab remains in the modal dialog')
  await native({ key: 'Escape' })
  await until(() => !document.querySelector('[data-hooks-dialog]'), 'Escape closes dialog')
  assert(document.activeElement === opener, 'Closing restores focus to the source row')

  await open()
  pauseNext = true
  toggle(trustedKey).click()
  await until(() => releaseMutation, 'pending toggle')
  await until(() => toggle(trustedKey).disabled, 'pending controls disabled')
  assert(toggle(trustedKey).checked, 'Pending mutation retains the last confirmed enabled state')
  assert(find<HTMLButtonElement>('[data-hooks-close]').disabled && find<HTMLButtonElement>('[data-hooks-refresh]').disabled, 'Pending mutation prevents closure and refresh races')
  releaseMutation!()
  await until(() => !toggle(trustedKey).checked && !toggle(trustedKey).disabled, 'confirmed toggle')
  assert(JSON.stringify(mutations.at(-1)) === JSON.stringify({ method: 'setEnabled', key: trustedKey, enabled: false, scope: undefined }), 'Global switch sends the exact key and global scope')
  failNext = true
  toggle(trustedKey).click()
  await until(() => dialogText().includes('Simulated hook update failure'), 'mutation failure visible')
  assert(!toggle(trustedKey).checked && !toggle(trustedKey).disabled, 'Failed mutation preserves the last saved state and allows retry')
  const beforeTrust = mutations.length
  find<HTMLButtonElement>(by('data-hook-trust', newKey)).click()
  await until(() => !toggle(newKey).disabled && toggle(newKey).checked, 'approved hook enabled')
  assert(mutations.length === beforeTrust + 1 && mutations.at(-1)?.method === 'trust' && mutations.at(-1)?.keys?.[0] === newKey && mutations.at(-1)?.scope === undefined, 'Review sends approval without an implicit toggle mutation')
  await close()
  await open(`project:${vectors.projectRoot}`)
  assert(!document.querySelector(by('data-hook-row', trustedKey)) && document.querySelectorAll('[data-hook-row]').length === 2, 'Project source excludes global rows returned by the host')
  find<HTMLButtonElement>(by('data-hook-trust', projectKey)).click()
  await until(() => toggle(projectKey).checked, 'project trust')
  assert(JSON.stringify(mutations.at(-1)?.scope) === JSON.stringify({ projectRoot: vectors.projectRoot }), 'Project review preserves the exact project root')
  toggle(projectKey).click()
  await until(() => !toggle(projectKey).checked && !toggle(projectKey).disabled, 'project disable')
  assert(mutations.at(-1)?.key === projectKey && mutations.at(-1)?.enabled === false && mutations.at(-1)?.scope?.projectRoot === vectors.projectRoot, 'Project switch preserves key and scope')
  find<HTMLButtonElement>('[data-hooks-editor-toggle]').click()
  await until(() => document.querySelector('#hooks-json-editor'), 'configuration editor')
  input('[]')
  await settle()
  const beforeInvalid = mutations.length
  find<HTMLButtonElement>('#hooks-save-btn').click()
  await until(() => document.querySelector('[data-hooks-dialog] [role="alert"]'), 'invalid editor value')
  assert(mutations.length === beforeInvalid, 'Invalid editor data never reaches the host')
  const savedHooks = { PreToolUse: [{ hooks: [{ type: 'command', command: 'node ./scripts/updated-guard.mjs' }] }] }
  input(JSON.stringify({ hooks: savedHooks }, null, 2))
  await settle()
  find<HTMLButtonElement>('#hooks-save-btn').click()
  await until(() => mutations.at(-1)?.method === 'set' && find<HTMLButtonElement>('#hooks-save-btn').disabled && !find<HTMLTextAreaElement>('#hooks-json-editor').disabled, 'save editor')
  assert(JSON.stringify(mutations.at(-1)?.hooks) === JSON.stringify(savedHooks) && mutations.at(-1)?.scope?.projectRoot === vectors.projectRoot, 'Editor unwraps the hooks object and saves only to its project')
  input('{"Stop": []}')
  await settle()
  find<HTMLButtonElement>('[data-hooks-close]').click()
  await until(() => document.querySelector<HTMLDialogElement>('[data-hooks-discard-dialog]')?.open, 'unsaved close confirmation')
  const confirmation = find<HTMLDialogElement>('[data-hooks-discard-dialog]')
  assert(confirmation.open && find<HTMLDialogElement>('[data-hooks-dialog]').open, 'Discard confirmation owns the top modal layer while retaining the draft')
  find<HTMLButtonElement>('[data-hooks-discard]').focus()
  await native({ key: 'Tab' })
  assert(confirmation.contains(document.activeElement), 'Tab stays in the discard confirmation and cannot activate source controls')
  await native({ key: 'Escape' })
  await until(() => !document.querySelector('[data-hooks-discard-dialog]') && !find<HTMLButtonElement>('[data-hooks-close]').disabled, 'resume editing')
  assert(!!document.querySelector('[data-hooks-dialog]') && find<HTMLTextAreaElement>('#hooks-json-editor').value.includes('Stop'), 'Declining close keeps the unsaved draft')
  find<HTMLButtonElement>('[data-hooks-close]').click()
  await until(() => document.querySelector<HTMLDialogElement>('[data-hooks-discard-dialog]')?.open, 'discard confirmation')
  find<HTMLButtonElement>('[data-hooks-discard]').click()
  await until(() => !document.querySelector('[data-hooks-dialog]'), 'discard draft')
  assert(!document.querySelector('[data-hooks-discard-dialog]'), 'Discarding an unsaved draft requires an explicit confirmation')

  await open('plugin:fixture-tools')
  assert(dialogText().includes('PreToolUse') && !document.querySelector('[data-hook-enabled]') && !document.querySelector('[data-hooks-editor-toggle]'), 'Plugin hooks expose event information without editable configuration controls')
  await close()
  failReadNext = true
  find<HTMLButtonElement>('[data-hooks-refresh]').click()
  await settle()
  await until(() => !find<HTMLButtonElement>('[data-hooks-refresh]').disabled, 'refresh completes')
  await open()
  assert(dialogText().includes('Simulated hook read failure'), 'Read errors remain visible beside the cached configuration')
  const beforeFailedReadActions = mutations.length
  const lockedControls = [...document.querySelectorAll<HTMLButtonElement>('[data-hook-enabled], [data-hook-trust], #hooks-trust-all')]
  assert(lockedControls.some(control => control.hasAttribute('data-hook-enabled')) && lockedControls.every(control => control.disabled), 'Cached hook rows retain no enabled mutation controls after a read failure')
  lockedControls.forEach(control => control.click())
  find<HTMLButtonElement>('[data-hooks-editor-toggle]').click()
  await settle()
  assert(find<HTMLTextAreaElement>('#hooks-json-editor').disabled && find<HTMLButtonElement>('#hooks-save-btn').disabled, 'Cached configuration can be inspected but cannot be edited or saved after a read failure')
  const editorActions = [...find('#hooks-save-btn').parentElement!.querySelectorAll<HTMLButtonElement>('button')]
  assert(editorActions.every(control => control.disabled), 'Cached configuration formatting and save actions remain disabled')
  editorActions.forEach(control => control.click())
  await settle()
  assert(mutations.length === beforeFailedReadActions, 'Attempted cached configuration changes issue no host mutation')
  await close()
  find<HTMLButtonElement>('[data-hooks-refresh]').click()
  await settle()
  await until(() => !find<HTMLButtonElement>('[data-hooks-refresh]').disabled, 'retry reload')
  await open()
  w.currentLang = 'zh'
  document.documentElement.lang = 'zh'
  window.dispatchEvent(new CustomEvent('klaus:lang-change', { detail: { lang: 'zh' } }))
  await until(() => find('#hooks-source-title').textContent === '用户配置', 'Chinese dialog labels')
  assert(!dialogText().includes('hooks_event_') && dialogText().includes('钩子'), 'Chinese event descriptions and controls resolve translation keys')
  await native({ capture: 'hooks-chinese' })
  document.documentElement.dataset.theme = 'dark'
  await native({ capture: 'hooks-dark' })
  assert(getComputedStyle(find('[data-hooks-dialog]')).backgroundColor !== 'rgb(255, 255, 255)', 'Dialog follows the dark theme')
  await native({ width: 760, capture: 'hooks-narrow' })
  const narrow = find('[data-hooks-dialog]').getBoundingClientRect()
  assert(narrow.left >= 0 && narrow.right <= innerWidth + 1, 'Dialog stays inside a narrow viewport')
  assert(document.documentElement.scrollWidth <= innerWidth + 1, 'Narrow settings layout has no document overflow')
  w.hooksSettingsResults = { passed: results.length, results, mutations, reads: gets.length, revealed }
}
function dialogText() { return document.querySelector('[data-hooks-dialog]')?.textContent ?? '' }
w.hooksSettingsReady = run().catch(error => { w.hooksSettingsError = String(error?.stack ?? error); w.hooksSettingsResults = { passed: results.length, results, mutations }; throw error })
