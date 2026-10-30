import reviewVector from '../contracts/vectors/approval-review.json'
import { createRoot } from 'react-dom/client'
import type { RuntimeConfigScope, RuntimeConfigSnapshot, RuntimeSettingKey } from '../contracts/runtime-settings'
import type { PermissionPreset, PermissionSelectApi } from '../frontend/src/chat/composer/permission-select'
import type { WorkspaceDependenciesViewState } from '../contracts/workspace-dependency-settings'
import { WORKSPACE_DEPENDENCIES_ENABLED_KEY } from '../contracts/workspace-dependency-settings'

const w = window as any
w.currentLang = 'zh'
w.klsLoading = { render: () => '<div role="status">Loading…</div>' }
const listeners = new Set<(event: { key: string }) => void>()
const requests: { key: string; value: string; scope: RuntimeConfigScope; expectedVersion: string }[] = []
const opened: RuntimeConfigScope[] = []
const links: string[] = []
const toasts: string[] = []
const revisions = new Map([['user', 1], ['/fixture/atlas', 1]])
const globalValues: Record<RuntimeSettingKey, string | null> = {
  'klaus.approvalPolicy': 'never', 'klaus.sandboxMode': 'danger-full-access', 'klaus.sandbox.networkAllowed': 'on',
  'klaus.webSearch.access': 'live', 'klaus.modelVerbosity': null, 'klaus.reasoningSummary': 'auto',
  'klaus.subagentModelCatalog': 'off',
}
const projectValues: Record<RuntimeSettingKey, string | null> = {
  'klaus.approvalPolicy': null, 'klaus.sandboxMode': null, 'klaus.sandbox.networkAllowed': null,
  'klaus.webSearch.access': null, 'klaus.modelVerbosity': null, 'klaus.reasoningSummary': null,
  'klaus.subagentModelCatalog': null,
}
const permissions = new Map<string, PermissionPreset | null>([['main', 'default'], ['side', 'auto']])
const permissionRequests: { mode: PermissionPreset; sessionId: string }[] = []
let failNext = false
let failReadNext = false
let failPermissionNext = false
let failPublicationNext = false
let heldWrite: (() => void) | undefined
let holdNext = false
let dependencyState: WorkspaceDependenciesViewState = 'ready'
let diagnoseCalls = 0
let failDiagnose = false
let diagnosticNotification: 'before' | 'after' = 'after'
let diagnosticNotifications = 0
let heldDiagnostic: (() => void) | undefined
let holdDiagnostic = false
let selectedSession = 'main'
let migrationWarnings: Array<{ code: string; message: string; keys: string[] }> = []
let mainApi: PermissionSelectApi | null
let sideApi: PermissionSelectApi | null
const copy = <T,>(value: T): T => structuredClone(value)
const sourceKey = (scope: RuntimeConfigScope) => scope.kind === 'user' ? 'user' : scope.cwd
const publish = (key: string) => { for (const listener of [...listeners]) listener({ key }) }

function readSnapshot(scope: RuntimeConfigScope): RuntimeConfigSnapshot {
  const key = sourceKey(scope)
  const values = scope.kind === 'user' ? globalValues : projectValues
  const effective = Object.fromEntries(Object.keys(globalValues).map(key => [key, values[key as RuntimeSettingKey] ?? globalValues[key as RuntimeSettingKey]])) as Record<RuntimeSettingKey, string | null>
  return copy({ scope, path: scope.kind === 'user' ? '/fixture/home/.klaus/config.toml' : `${scope.cwd}/.klaus/config.toml`, version: String(revisions.get(key)), values, effective, sources: {}, migrationWarnings })
}

w.settingsApi = {
  runtimeConfig: {
    get: async (scope: RuntimeConfigScope) => {
      if (failReadNext) { failReadNext = false; throw Error('Simulated config read failure') }
      return readSnapshot(scope)
    },
    open: async (scope: RuntimeConfigScope) => { opened.push(copy(scope)); return { ok: true } },
  },
  kv: {
    get: async (key: string) => globalValues[key as RuntimeSettingKey] ?? null,
    set: async (key: RuntimeSettingKey, value: string, scope: RuntimeConfigScope = { kind: 'user' }, expectedVersion = String(revisions.get(sourceKey(scope)))) => {
      requests.push(copy({ key, value, scope, expectedVersion }))
      if (holdNext) { holdNext = false; await new Promise<void>(resolve => { heldWrite = resolve }) }
      if (failNext) { failNext = false; throw Error('Simulated config write failure') }
      if (expectedVersion !== String(revisions.get(sourceKey(scope)))) throw Error('Config version conflict')
      const values = scope.kind === 'user' ? globalValues : projectValues
      values[key] = value || null
      revisions.set(sourceKey(scope), Number(expectedVersion) + 1)
      publish(key)
      if (failPublicationNext) { failPublicationNext = false; throw Error('Simulated live publication failure') }
      return { ok: true }
    },
  },
  workspaceDependencies: {
    get: async () => {
      const enabled = (globalValues as Record<string, string | null>)['klaus.workspaceDependencies'] !== 'off'
      return copy({ ok: true, enabled, state: enabled ? dependencyState : 'disabled', version: 'fixture-runtime', pythonVersion: '3.12.9', logPath: '/fixture/home/.klaus/workspace-runtime.log' })
    },
    diagnose: async () => {
      diagnoseCalls++
      if (holdDiagnostic) {
        holdDiagnostic = false
        await new Promise<void>(resolve => { heldDiagnostic = resolve })
      }
      if (failDiagnose) throw Error('Simulated diagnostic request failure')
      const enabled = (globalValues as Record<string, string | null>)['klaus.workspaceDependencies'] !== 'off'
      const notify = () => { publish(WORKSPACE_DEPENDENCIES_ENABLED_KEY); diagnosticNotifications++ }
      if (diagnosticNotification === 'before') notify()
      else setTimeout(notify, 80)
      return copy({ ok: true, enabled, state: enabled ? dependencyState : 'disabled', version: 'fixture-runtime', pythonVersion: '3.12.9', logPath: '/fixture/home/.klaus/workspace-runtime.log' })
    },
    reinstall: async () => copy({ ok: true, enabled: true, state: 'installing', version: 'fixture-runtime', logPath: '/fixture/home/.klaus/workspace-runtime.log' }),
  },
}
w.klaus = {
  settings: w.settingsApi,
  projects: { list: async () => ({ roots: ['/fixture/atlas'], labels: { '/fixture/atlas': 'Atlas' } }) },
  on: { appPreferencesChanged: (listener: (event: { key: string }) => void) => { listeners.add(listener); return () => listeners.delete(listener) } },
  app: { openExternal: async (url: string) => { links.push(url); return { ok: true } } },
  session: { setPermissionMode: async (mode: PermissionPreset, sessionId: string) => {
    permissionRequests.push({ mode, sessionId })
    if (failPermissionNext) { failPermissionNext = false; throw Error('Simulated permission failure') }
    permissions.set(sessionId, mode)
    return { mode, preset: mode }
  } },
}
w.showToast = (message: string) => toasts.push(message)
w.refreshComposerPreferences = () => mainApi?.setValue(permissions.get(selectedSession) ?? null)
w.refreshSidePermissionButton = () => sideApi?.setValue(permissions.get('side') ?? null)

const checks: string[] = []
const settle = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms))
const assert = (value: unknown, label: string) => { if (!value) throw Error(label); checks.push(label) }
const find = <T extends HTMLElement>(selector: string): T => {
  const node = document.querySelector<T>(selector)
  if (!node) throw Error(`Missing ${selector}`)
  return node
}
async function until(check: () => unknown, label: string) {
  const started = Date.now()
  while (!check()) { if (Date.now() - started > 8000) throw Error(`Timed out: ${label}`); await settle() }
}
async function native(request: { click?: { x: number; y: number }; key?: string; shift?: boolean; capture?: string; width?: number; height?: number }) {
  await new Promise<void>((resolve, reject) => { w.runtimeNativeDone = resolve; w.runtimeNativeFail = reject; w.runtimeNativeRequest = request })
  await settle(45)
}
async function click(node: HTMLElement | string) {
  const element = typeof node === 'string' ? find(node) : node
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0 || rect.top < 0 || rect.bottom > innerHeight) throw Error(`Target outside viewport: ${element.outerHTML.slice(0,150)}`)
  await native({ click: { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) } })
}
async function choose(id: string, value: string) {
  await click(`#${id}`)
  await until(() => document.querySelector('[role="listbox"]'), `open ${id}`)
  await click(`[role="listbox"] [data-value="${CSS.escape(value)}"]`)
  await until(() => !find<HTMLButtonElement>(`#${id}`).disabled, `saved ${id}`)
}
const permissionPanel = (root = 'permission-select') => find<HTMLElement>(`#${root} .permission-select-panel:not([hidden])`)
async function openPermission(root = 'permission-select') {
  await click(`#${root} .kls-select-trigger`)
  await until(() => document.querySelector(`#${root} .permission-select-panel:not([hidden])`), `open ${root}`)
}
const onButton = (text: string) => {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent?.trim() === text && button.getBoundingClientRect().height > 0)
  if (!button) throw Error(`Missing button ${text}`)
  return button
}

async function run() {
  const [{ RuntimeSettingsTab }, { mountPermissionSelect }, { I18N }] = await Promise.all([
    import('../frontend/src/pages/settings/runtime-tab'), import('../frontend/src/chat/composer/permission-select'), import('../frontend/src/i18n'),
  ])
  // Production UI helpers register globals during import. Keep unrelated
  // permission notifications captured while diagnostics exercise the real toast.
  w.showToast = (message: string) => toasts.push(message)
  w.tt = (key: string) => I18N[w.currentLang as 'zh' | 'en'][key] ?? key
  const settingsView = document.createElement('section')
  settingsView.id = 'settings-view'
  settingsView.className = 'active'
  settingsView.style.cssText = 'position:fixed;inset:0;z-index:100;display:grid;grid-template-columns:240px 1fr;background:var(--bg)'
  settingsView.innerHTML = '<aside class="settings-sidebar"></aside><div class="settings-main" style="overflow:auto;padding:32px"><div id="settings-content"></div></div>'
  document.body.appendChild(settingsView)
  const [{ mountSettingsSidebar }, { loadSettingsTab }, { mountSettingsTab, unmountSettingsTab }] = await Promise.all([
    import('../frontend/src/pages/settings/settings-nav'), import('../frontend/src/pages/settings/shell'), import('../frontend/src/pages/settings/kv'),
  ])
  w.loadPreferencesTab = (container: HTMLElement) => mountSettingsTab(container, <RuntimeSettingsTab embedded />)
  mountSettingsSidebar()
  await until(() => settingsView.querySelector('[data-stab="preferences"]'), 'settings navigation loaded')
  assert(!settingsView.querySelector('[data-stab="runtime"], [data-stab="sandbox"]'), 'Configuration is merged into preferences without a separate runtime entry')
  loadSettingsTab('sandbox')
  await until(() => settingsView.querySelector('#runtime-sandbox'), 'retired sandbox location opens current configuration')
  assert(w.currentSettingsTab === 'preferences' && settingsView.querySelector('[data-stab="preferences"][aria-current="page"]'), 'Retained sandbox locations select preferences')
  assert(settingsView.querySelectorAll('[data-setting]').length === 4 && !settingsView.querySelector('#klaus-sandbox, #runtime-search'), 'The configuration section keeps its remaining groups without retired controls')
  await native({ capture: 'settings-single-configuration-entry-zh' })
  unmountSettingsTab()
  settingsView.remove()
  const root = createRoot(find('#fixture-root'))
  const mount = () => root.render(<RuntimeSettingsTab />)
  mount()
  mainApi = mountPermissionSelect(find('#permission-select'), () => selectedSession)
  sideApi = mountPermissionSelect(find('#side-permission-select'), () => 'side')
  await until(() => document.querySelector('#permission-select .kls-select-trigger')?.textContent === '权限暂不可用'
    && document.querySelector('#side-permission-select .kls-select-trigger')?.textContent === '权限暂不可用', 'initial permission reads keep their unavailable state')
  for (const id of ['permission-select', 'side-permission-select']) {
    const selector = find(`#${id}`)
    assert(selector.querySelectorAll('[role="menuitemradio"]').length === 3
      && selector.querySelectorAll('[role="menuitemradio"]:disabled').length === 3
      && !selector.querySelector('[aria-checked="true"]')
      && !selector.querySelector('[data-preset="custom"]'), 'Initial permission reads keep three unselected presets disabled')
  }
  mainApi?.setValue('default')
  sideApi?.setValue('auto')
  await until(() => document.querySelector('#runtime-approval'), 'runtime settings loaded')
  assert(document.querySelectorAll('[data-setting]').length === 4 && !document.querySelector('#runtime-search'), 'Four grouped settings rows remain after removing web search')
  assert(find('#runtime-approval').textContent?.includes('从不请求审批'), 'Saved approval value appears on the trigger')
  assert(find('#runtime-sandbox').textContent?.includes('完整访问权限'), 'Saved full-access sandbox value appears')
  assert(find('#runtime-verbosity').textContent?.includes('模型默认'), 'Absent verbosity preserves model default')
  await native({ capture: 'settings-full-access-zh' })
  migrationWarnings = [{ code: 'legacySandboxConfigMigrated', message: 'Existing sandbox configuration was migrated.', keys: ['sandbox'] }]
  publish('klaus.sandboxMode')
  await until(() => document.querySelector('[data-config-migration-notice]'), 'configuration migration notice appears')
  assert(document.querySelector('[data-config-migration-notice]')?.textContent?.includes('权限范围') && !find<HTMLButtonElement>('#runtime-sandbox').disabled, 'A completed migration is explained without blocking configuration changes')
  migrationWarnings = []
  publish('klaus.sandboxMode')
  await until(() => !document.querySelector('[data-config-migration-notice]'), 'settled configuration clears the completed migration notice')

  const domains: Record<string, string[]> = {
    approval: ['on-request', 'never'], sandbox: ['read-only', 'workspace-write', 'danger-full-access'],
    verbosity: ['', 'low', 'medium', 'high'], summary: ['auto', 'concise', 'detailed', 'none'],
  }
  for (const [name, values] of Object.entries(domains)) {
    await click(`#runtime-${name}`)
    const actual = Array.from(document.querySelectorAll<HTMLElement>('[role="listbox"] [role="option"]')).map(node => node.dataset.value)
    assert(JSON.stringify(actual) === JSON.stringify(values), `${name} exposes its complete value domain`)
    assert(document.querySelectorAll('[role="listbox"] [aria-selected="true"]').length === 1, `${name} marks exactly one selected value`)
    await native({ key: 'Escape' })
    assert(document.activeElement === find(`#runtime-${name}`), `${name} Escape restores trigger focus`)
  }
  await choose('runtime-approval', 'on-request')
  await choose('runtime-sandbox', 'workspace-write')
  assert(!!document.querySelector('#runtime-network'), 'Workspace-write exposes the network control')
  await click('label:has(#runtime-network)')
  await until(() => !find<HTMLInputElement>('#runtime-network').disabled, 'network write finished')
  assert(globalValues['klaus.sandbox.networkAllowed'] === 'off', 'Network intent persists independently')
  await choose('runtime-verbosity', 'high')
  await choose('runtime-summary', 'detailed')
  assert(requests.every((request, index) => request.expectedVersion === String(index + 1)), 'Every setting write carries the latest revision')
  await native({ capture: 'settings-workspace-zh' })

  await click('#runtime-summary')
  await native({ key: 'Home' })
  await native({ key: 'End' })
  assert((document.activeElement as HTMLElement)?.dataset.value === 'none', 'Home/End navigate the settings menu')
  await native({ key: 'Enter' })
  await until(() => globalValues['klaus.reasoningSummary'] === 'none', 'keyboard summary selection')
  assert(document.activeElement === find('#runtime-summary'), 'Keyboard selection returns focus to the field')

  find<HTMLButtonElement>('#runtime-verbosity').focus()
  await native({ key: 'Down' })
  await native({ key: 'Tab' })
  assert(!document.querySelector('[role="listbox"]') && document.activeElement === find('#runtime-summary'), 'Tab closes the settings menu and advances to the next field')
  await native({ key: 'Down' })
  await native({ key: 'Tab', shift: true })
  assert(!document.querySelector('[role="listbox"]') && document.activeElement === find('#runtime-verbosity'), 'Shift Tab closes the settings menu and returns to the previous field')

  failNext = true
  await choose('runtime-verbosity', 'low')
  assert(find('[role="alert"]').textContent?.includes('Simulated config write failure'), 'Failed settings saves show their error')
  assert(find('#runtime-verbosity').textContent?.includes('高') && globalValues['klaus.modelVerbosity'] === 'high', 'Failed saves retain the actual stored selection')
  await click(onButton('重试'))
  await until(() => document.querySelector('#runtime-verbosity') && !document.querySelector('[role="alert"]'), 'retry fresh configuration')
  failPublicationNext = true
  await choose('runtime-summary', 'concise')
  assert(globalValues['klaus.reasoningSummary'] === 'concise' && find('#runtime-summary').textContent?.includes('简洁') && find('[role="alert"]').textContent?.includes('Simulated live publication failure'), 'A persisted setting remains visible when live publication fails, without repeating the write')
  await click(onButton('重试'))
  await until(() => document.querySelector('#runtime-summary') && !document.querySelector('[role="alert"]'), 'publication failure refresh')

  holdNext = true
  const beforeHold = requests.length
  await click('#runtime-summary')
  await click('[role="listbox"] [data-value="detailed"]')
  await until(() => heldWrite, 'held write started')
  assert(find<HTMLButtonElement>('#runtime-scope').disabled && find<HTMLButtonElement>('#runtime-summary').disabled, 'Pending writes fence scope changes and competing revisions')
  assert(requests.length === beforeHold + 1, 'One native selection creates one pending write')
  heldWrite!(); heldWrite = undefined
  await until(() => !find<HTMLButtonElement>('#runtime-summary').disabled, 'held write completed')

  await choose('runtime-scope', '/fixture/atlas')
  await until(() => find('#runtime-scope').textContent?.includes('Atlas') && document.querySelector('#runtime-approval'), 'project scope loaded')
  const globalSummary = globalValues['klaus.reasoningSummary']
  await choose('runtime-summary', 'concise')
  assert(projectValues['klaus.reasoningSummary'] === 'concise' && globalValues['klaus.reasoningSummary'] === globalSummary, 'Project settings remain scoped and inherit other fields')
  await click(onButton('打开 config.toml'))
  assert(opened.at(-1)?.kind === 'project', 'Open config uses the selected project scope')
  root.render(<div />); await settle(); mount()
  await until(() => document.querySelector('#runtime-summary'), 'settings remounted')
  assert(find('#runtime-scope').textContent?.includes('Atlas') && find('#runtime-summary').textContent?.includes('简洁'), 'Reopening keeps the scope and stored selection')

  await openPermission()
  const panel = permissionPanel()
  assert(panel.textContent?.includes('应如何批准 Klaus 操作？') && panel.textContent?.includes('了解更多'), 'Permission menu contains its explanatory header and help action')
  assert(panel.querySelectorAll('[role="menuitemradio"]').length === 3, 'The normal permission menu has all three presets')
  await native({ capture: 'permission-request-zh' })
  await click(panel.querySelector<HTMLElement>('[data-preset="auto"]')!)
  await until(() => permissions.get('main') === 'auto', 'automatic review persisted')
  assert(permissionRequests.at(-1)?.sessionId === 'main' && permissions.get('side') === 'auto', 'Main permission selection names its own conversation')

  find<HTMLButtonElement>('#permission-select .kls-select-trigger').focus()
  await native({ key: 'Down' })
  await native({ key: 'Tab' })
  assert(!document.querySelector('#permission-select .permission-select-panel:not([hidden])') && document.activeElement === find('#side-permission-select .kls-select-trigger'), 'Tab closes the permission menu and advances past its trigger')

  await openPermission()
  await click(permissionPanel().querySelector<HTMLElement>('[data-preset="bypassPermissions"]')!)
  await until(() => document.querySelector('[role="dialog"]'), 'full access confirmation')
  await native({ key: 'Escape' })
  assert(permissions.get('main') === 'auto' && permissionPanel().querySelector('[data-preset="auto"]')?.getAttribute('aria-checked') === 'true', 'Cancelling full access retains the previous preset and open menu')
  await click(permissionPanel().querySelector<HTMLElement>('[data-preset="bypassPermissions"]')!)
  await click(onButton('确认'))
  await until(() => permissions.get('main') === 'bypassPermissions', 'full access confirmed')
  assert(find('#permission-select .kls-select-trigger').textContent === '完全访问', 'The closed full-access trigger uses its compact label')
  await openPermission()
  const fullRow = permissionPanel().querySelector<HTMLElement>('[data-preset="bypassPermissions"]')!
  assert(fullRow.getAttribute('aria-checked') === 'true' && getComputedStyle(fullRow).color === 'rgb(246, 83, 0)', 'Full access carries the selected check and orange warning ink')
  await native({ capture: 'permission-full-access-zh' })
  await click(permissionPanel().querySelector<HTMLElement>('.permission-select-help')!)
  assert(links.at(-1)?.includes('/docs/desktop/plan-and-permission'), 'Learn more opens the permission documentation')

  await openPermission()
  failPermissionNext = true
  await click(permissionPanel().querySelector<HTMLElement>('[data-preset="default"]')!)
  await until(() => permissionPanel().querySelector('[role="alert"]'), 'permission failure displayed')
  assert(permissions.get('main') === 'bypassPermissions' && fullRow.isConnected, 'Failed permission writes keep the authoritative selection')
  await native({ key: 'Escape' })
  find<HTMLButtonElement>('#permission-select .kls-select-trigger').focus()
  await native({ key: 'Down' })
  await native({ key: 'Home' })
  assert((document.activeElement as HTMLElement).dataset.preset === 'default', 'Native keyboard navigation reaches the first permission preset')
  await native({ key: 'Enter' })
  await until(() => permissions.get('main') === 'default', 'keyboard permission persisted')

  const beforeUnmatchedPolicy = permissionRequests.length
  permissions.set('main', null); mainApi?.setValue(null)
  await until(() => find('#permission-select .kls-select-trigger').textContent === '权限模式', 'unmatched policy uses a neutral trigger')
  await openPermission()
  assert(permissionPanel().querySelectorAll('[role="menuitemradio"]').length === 3
    && permissionPanel().querySelectorAll('[aria-checked="true"]').length === 0
    && !permissionPanel().querySelector('[data-preset="custom"]'), 'An unmatched policy has three presets with no selected or custom row')
  assert(permissionRequests.length === beforeUnmatchedPolicy && permissions.get('main') === null, 'Rendering an unmatched policy does not write a replacement preset')
  await native({ key: 'Escape' })
  permissions.set('side', null); sideApi?.setValue(null)
  await until(() => find('#side-permission-select .kls-select-trigger').textContent === '权限模式', 'unmatched side policy uses a neutral trigger')
  await openPermission('side-permission-select')
  assert(permissionPanel('side-permission-select').querySelectorAll('[role="menuitemradio"]').length === 3
    && !permissionPanel('side-permission-select').querySelector('[aria-checked="true"]')
    && permissionRequests.length === beforeUnmatchedPolicy, 'The side composer also preserves an unmatched policy without selecting or writing a preset')
  await click(permissionPanel('side-permission-select').querySelector<HTMLElement>('[data-preset="default"]')!)
  await until(() => permissions.get('side') === 'default', 'side preset saved')
  assert(permissions.get('main') === null && permissionRequests.at(-1)?.sessionId === 'side', 'Side permission selection leaves the unmatched main policy intact')

  mainApi?.setUnavailable()
  await openPermission()
  assert(permissionPanel().querySelectorAll('[role="menuitemradio"]').length === 3
    && permissionPanel().querySelectorAll('[role="menuitemradio"]:not(:disabled)').length === 0
    && !permissionPanel().querySelector('[data-preset="custom"]')
    && permissionPanel().textContent?.includes('无法读取权限设置')
    && permissionPanel().textContent?.includes('重试'), 'Unavailable permission reads keep three disabled presets without a custom row and expose retry')
  await click(permissionPanel().querySelector<HTMLElement>('.permission-select-error button')!)
  await until(() => !document.querySelector('#permission-select .permission-select-error'), 'permission read retried')
  await native({ key: 'Escape' })

  permissions.set('main', 'default'); mainApi?.setValue('default')
  await openPermission()
  await click(permissionPanel().querySelector<HTMLElement>('[data-preset="bypassPermissions"]')!)
  const beforeStaleConfirmation = permissionRequests.length
  selectedSession = 'replacement'
  permissions.set('replacement', null)
  mainApi?.setValue(null)
  await click(onButton('确认'))
  assert(permissionRequests.length === beforeStaleConfirmation && permissions.get('replacement') === null, 'A stale full-access confirmation cannot grant permissions to another conversation')
  selectedSession = 'main'; permissions.set('main', null); mainApi?.setValue(null)

  await native({ width: 480, height: 850 })
  await openPermission()
  const narrow = permissionPanel().getBoundingClientRect()
  assert(narrow.left >= 7 && narrow.right <= innerWidth - 7 && narrow.bottom <= innerHeight - 7, 'Permission menu remains within a narrow viewport')
  assert(document.documentElement.scrollWidth <= innerWidth, 'Narrow settings do not create horizontal page overflow')
  await native({ capture: 'settings-permission-narrow-zh' })
  await native({ key: 'Escape' })
  w.currentLang = 'en'; window.dispatchEvent(new Event('klaus:lang-change')); mainApi?.refresh(); sideApi?.refresh()
  await until(() => find('#runtime-summary').textContent?.includes('Concise'), 'English settings labels refreshed')
  await openPermission()
  assert(permissionPanel().textContent?.includes('Approve for me'), 'Both surfaces refresh their localized copy')
  await native({ capture: 'settings-permission-narrow-en' })
  await native({ key: 'Escape' })
  failReadNext = true
  publish('klaus.reasoningSummary')
  await until(() => document.querySelector('[role="alert"]')?.textContent?.includes('Simulated config read failure'), 'load failure displayed')
  assert(find('#runtime-summary').textContent?.includes('Concise') && find<HTMLButtonElement>('#runtime-summary').disabled, 'Failed background reads retain the last configuration and disable writes until recovery')
  await click(onButton('Retry'))
  await until(() => document.querySelector('#runtime-summary') && !find<HTMLButtonElement>('#runtime-summary').disabled && !document.querySelector('[role="alert"]'), 'failed read retry')
  globalValues['klaus.sandboxMode'] = 'read-only'
  publish('klaus.sandboxMode')
  await until(() => document.querySelector('#runtime-sandbox')?.textContent === w.tt('runtime_sandbox_read-only'), 'read-only configuration loaded')
  assert(!document.querySelector('#runtime-network') && !document.querySelector('#klaus-sandbox'), 'Read-only configuration does not expose retired isolation or network controls')
  await choose('runtime-sandbox', 'danger-full-access')
  const sandboxWrite = requests.at(-1)
  assert(sandboxWrite?.key === 'klaus.sandboxMode' && readSnapshot(sandboxWrite.scope).effective['klaus.sandboxMode'] === 'danger-full-access', 'The configuration selector writes the authoritative filesystem policy in its selected scope')
  const [{ ApprovalReviewCard, ApprovalReviewToolDetails, ApprovalReviewNotice, openApprovalReviewDenials }, { approvalReview }, { replaceApprovalReviewHistory }, { mountSlashMenu }] = await Promise.all([
    import('../frontend/src/chat/transcript/approval-review'), import('../contracts/approval-review'), import('../frontend/src/chat/approval-review-state'), import('../frontend/src/chat/composer/slash-menu'),
  ])
  await native({ width: 1000, height: 850 })
  const hydrateApprovalReviewDenials = (sessionId: string, events: Record<string, unknown>[]) => replaceApprovalReviewHistory(sessionId, events.flatMap(event => {
    const review = approvalReview(event)
    return review ? [{event,review}] : []
  }))
  const reviewSession = 'review-main', sideReviewSession = 'review-side'
  let currentReviewSession = reviewSession
  const rawReviews = Array.from({ length: 12 }, (_, index) => ({ ...reviewVector.denied, id: `review-${index}`, targetItemId: `tool-${index}`, startedAtMs: 10000 - index,
    pluginId: 'fixture-plugin', scriptPath: 'scripts/action.sh', reviewReason: 'authorization_changed' }))
  const approvals: Array<{ sessionId: string; event: Record<string, unknown> }> = []
  let settleApproval: { resolve(): void; reject(error: Error): void } | undefined
  w.klaus.approvalReview = {
    approve: async (sessionId: string, event: Record<string, unknown>) => {
      approvals.push({ sessionId, event: copy(event) })
      await new Promise<void>((resolve, reject) => { settleApproval = { resolve, reject } })
      return {}
    },
  }
  hydrateApprovalReviewDenials(reviewSession, rawReviews)
  hydrateApprovalReviewDenials(sideReviewSession, [{ ...rawReviews[0], id: 'side-review' }])
  const reviewCaptureStructure: Record<string, unknown>[] = []
  const denied = approvalReview(rawReviews[0])!
  root.render(<div>
    <ApprovalReviewCard review={denied} />
    <ApprovalReviewCard review={{ ...denied, reviewId: 'review-running', status: 'inProgress', rationale: undefined }} />
    <ApprovalReviewToolDetails sessionId={reviewSession} reviews={[denied]} declined />
    <ApprovalReviewNotice kind="strictReviewRequired" /><ApprovalReviewNotice kind="tooManyDenials" />
  </div>)
  await until(() => document.querySelector('[data-review-approve]'), 'inline review authorization visible')
  assert(find('[data-review-id="review-0"]').getAttribute('data-target-item-id') === 'tool-0', 'Review lifecycle retains the exact tool, review and turn identities')
  assert(document.body.textContent?.includes('Records approval for this action and allows one retry. It does not run it.'), 'Inline approval states that authorization records one retry without running the action')
  await click('[data-review-id="review-0"] > summary')
  assert(find<HTMLDetailsElement>('[data-review-id="review-0"]').open && document.body.textContent?.includes('Requires explicit authorization because this action is considered high risk'), 'Denied review expands to its explicit high-risk authorization explanation')
  await settle(160)
  assert(getComputedStyle(find('[data-review-id="review-0"] > summary'), '::after').transform !== 'none', 'The expanded review chevron follows the disclosure state')
  const menuContainer = document.createElement('div')
  menuContainer.className = 'slash-menu kls-select-panel hidden'
  document.body.appendChild(menuContainer)
  const wrapper = document.createElement('div'); wrapper.id = 'input-wrapper'
  const anchor = document.createElement('div'); anchor.id = 'input-area'; anchor.style.cssText = 'position:fixed;bottom:40px;left:24px;width:420px;height:60px'
  wrapper.appendChild(anchor); document.body.appendChild(wrapper)
  const recordReviewCapture = (name: string) => reviewCaptureStructure.push({name,devicePixelRatio,viewport:{width:innerWidth,height:innerHeight},
    menuBounds:menuContainer.getBoundingClientRect().toJSON(),menuChoiceCount:menuContainer.querySelectorAll('[data-review-choice]').length,
    composerAnchorBounds:anchor.getBoundingClientRect().toJSON(),composerAnchorChildCount:anchor.childElementCount,composerAnchorText:anchor.textContent})
  const menu = mountSlashMenu(menuContainer, {
    commandIconSvg: () => '', slashCommandDescription: () => '', slashCommandGroupLabel: () => '', commandGroupKey: () => 'shortcuts', folderIconSvg: () => '', fileIconSvg: () => '', pluginIconSvg: () => '', deviceIconHtml: () => '', categoryIconHtml: () => '', conversationIconHtml: () => '', openFileSearchSession: () => null, onMentionMenuEmpty() {}, onSelectCommand() {}, onSelectMention() {},
  })!
  const showReview = (sessionId = reviewSession) => { currentReviewSession = sessionId; menu.showApprovalReview(sessionId, () => currentReviewSession, () => menu.hide()) }
  showReview()
  await until(() => document.querySelectorAll('[data-review-choice]').length === 10, 'ten recent denial choices')
  assert(document.querySelectorAll('[data-review-choice]').length === 10 && !document.querySelector('[role="dialog"]'), 'The denial picker is a slash submenu showing ten recent requests')
  recordReviewCapture('approval-review-submenu-en')
  await native({ capture: 'approval-review-submenu-en' })
  await click('[data-review-choice="review-0"]')
  await until(() => document.body.textContent?.includes('Recording approval…'), 'approval acknowledgment pending')
  assert(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-review-choice]')).every(row => row.disabled) && find<HTMLButtonElement>('[data-review-approve]').disabled, 'Pending authorization disables the shared submenu and inline actions')
  assert(JSON.stringify(approvals[0]?.event) === JSON.stringify(rawReviews[0]), 'The authorization submits the full original event without a prompt or rewritten action')
  settleApproval!.reject(Error('Simulated approval admission failure'))
  await until(() => !find<HTMLButtonElement>('[data-review-choice="review-0"]').disabled, 'failed admission releases pending state')
  assert(!menuContainer.classList.contains('hidden') && toasts.at(-1) === 'Could not record auto-review approval', 'Failed authorization keeps the menu and request available with the sourced failure message')
  await click('[data-review-choice="review-0"]')
  await until(() => approvals.length === 2, 'second approval attempt sent')
  settleApproval!.resolve()
  await until(() => menuContainer.classList.contains('hidden'), 'successful acknowledgment closes submenu')
  assert(!document.querySelector('[data-review-approve="review-0"]') && toasts.at(-1) === 'Approval recorded', 'Successful acknowledgment consumes the action in every surface and records approval')
  showReview()
  await until(() => document.querySelector('[data-review-choice="review-10"]'), 'next older denial visible')
  assert(!document.querySelector('[data-review-choice="review-0"]') && document.querySelectorAll('[data-review-choice]').length === 10, 'Consumed actions stay hidden while the newest ten unconsumed denials remain available')
  menu.hide(); showReview(sideReviewSession)
  await until(() => document.querySelector('[data-review-choice="side-review"]'), 'side review submenu visible')
  await click('[data-review-choice="side-review"]')
  await until(() => approvals.length === 3, 'side approval sent')
  assert(approvals.at(-1)?.sessionId === sideReviewSession, 'Side-chat authorization targets its captured conversation independently')
  currentReviewSession = reviewSession
  settleApproval!.resolve()
  await until(() => !document.querySelector('[data-review-choice="side-review"]'), 'side result settled')
  assert(!menuContainer.classList.contains('hidden'), 'A late acknowledgment cannot close another conversation’s active menu')
  menu.hide()
  w.currentLang = 'zh'; window.dispatchEvent(new Event('klaus:lang-change'))
  await until(() => document.body.textContent?.includes('被拒原因'), 'Chinese review translation refreshed')
  assert(document.body.textContent?.includes('此请求需要额外的安全检查') && document.querySelector('[data-review-notice="tooManyDenials"] button')?.getAttribute('data-klaus-tip')?.includes('自动审核已停止本轮操作'), 'Strict-review and interruption notices retain their localized explanations')
  await native({ width: 480, height: 850 })
  anchor.style.width = '400px'; showReview()
  await until(() => document.querySelector('[data-review-choice="review-1"]'), 'narrow review menu')
  const reviewBounds = menuContainer.getBoundingClientRect()
  assert(reviewBounds.left >= 8 && reviewBounds.right <= innerWidth - 8, 'The review submenu stays within a narrow viewport')
  recordReviewCapture('approval-review-submenu-zh-narrow')
  await native({ capture: 'approval-review-submenu-zh-narrow' })
  menu.hide()
  const older = approvalReview(rawReviews[11])!
  root.render(<div><ApprovalReviewToolDetails sessionId={reviewSession} reviews={[older]} declined /><ApprovalReviewToolDetails sessionId={reviewSession} reviews={[approvalReview(rawReviews[9])!]} declined readOnly /></div>)
  await until(() => document.querySelector('[data-review-approve="review-11"]'), 'older inline authorization visible')
  assert(document.querySelectorAll('[data-review-approve]').length === 1, 'An older inline denial remains available beyond the picker window while read-only details stay informational')
  await click('[data-review-approve="review-11"]')
  await until(() => approvals.length === 4, 'older inline approval sent')
  assert(JSON.stringify(approvals.at(-1)?.event) === JSON.stringify(rawReviews[11]), 'Inline authorization submits its full older event through the shared facade')
  settleApproval!.resolve()
  await until(() => !document.querySelector('[data-review-approve="review-11"]'), 'inline approval consumed after acknowledgment')
  const sideAnchor = document.createElement('textarea'); sideAnchor.style.cssText = 'position:fixed;bottom:40px;left:24px;width:400px;height:60px'
  document.body.appendChild(sideAnchor)
  openApprovalReviewDenials(reviewSession, () => reviewSession, sideAnchor)
  await until(() => document.querySelector('[data-review-choice="review-1"]'), 'side popup opens')
  sideAnchor.focus(); await native({ key: 'Down' })
  assert(document.activeElement?.getAttribute('data-review-choice') === 'review-1', 'The side picker starts keyboard navigation at its newest unconsumed denial')
  await native({ key: 'Up' })
  assert(document.activeElement?.getAttribute('data-review-choice') === 'review-10', 'The side picker wraps keyboard navigation through the visible choices')
  await native({ width: 640, height: 850 })
  const sideBounds = find('[data-approval-review-menu]').parentElement!.getBoundingClientRect()
  assert(sideBounds.left >= 8 && sideBounds.right <= innerWidth - 8, 'The side picker repositions when its viewport changes')
  await native({ key: 'Escape' })
  await until(() => !document.querySelector('[data-approval-review-menu]'), 'side picker escape closes')
  openApprovalReviewDenials(reviewSession, () => reviewSession, sideAnchor)
  await until(() => document.querySelector('[data-review-choice="review-1"]'), 'side picker reopens')
  sideAnchor.focus(); await native({ key: 'Enter' })
  await until(() => approvals.length === 5, 'side picker enter selects first denial')
  assert(approvals.at(-1)?.event.id === 'review-1', 'Enter in the side composer authorizes the selected denial without submitting chat text')
  settleApproval!.resolve()
  await until(() => !document.querySelector('[data-approval-review-menu]'), 'side picker acknowledgment closes')
  sideAnchor.remove(); wrapper.remove(); menuContainer.remove()

  mount()
  await until(() => document.querySelector('[data-workspace-dependencies]'), 'workspace dependencies section loaded')
  const depCard = find<HTMLElement>('[data-workspace-dependencies]')
  depCard.scrollIntoView({ block: 'center' })
  await settle()
  assert(depCard.previousElementSibling?.textContent === '工作空间依赖项', 'The workspace dependencies section keeps its heading above the card')
  assert(!!document.querySelector('#runtime-dependencies-toggle'), 'The dependency toggle row is present')
  const diagnoseButton = find<HTMLButtonElement>('[data-dependency="diagnose"] button')
  const reinstallButton = find<HTMLButtonElement>('[data-dependency="reinstall"] button')
  assert(diagnoseButton.textContent?.includes('诊断') && reinstallButton.textContent?.includes('重新安装'), 'Dependency actions expose their localized labels')
  const clearDiagnosticToasts = () => document.querySelectorAll('#settings-toast-viewport .toast-root').forEach(node => node.remove())
  const diagnosticToast = (tone: string) => document.querySelector<HTMLElement>(`#settings-toast-viewport .toast-root[data-tone="${tone}"] .toast-message`)
  holdDiagnostic = true
  await click(diagnoseButton)
  await until(() => heldDiagnostic, 'diagnostic request is pending')
  assert(diagnoseButton.disabled && diagnoseButton.getAttribute('aria-busy') === 'true' && diagnoseButton.textContent?.includes('正在诊断'),
    'Diagnostics expose the pending request and disable duplicate activation')
  assert(diagnoseCalls === 1 && !diagnosticToast('success'), 'A pending diagnostic request cannot report success early')
  heldDiagnostic!(); heldDiagnostic = undefined
  await until(() => diagnosticToast('success'), 'healthy diagnostic toast appears')
  await until(() => diagnosticNotifications === 1, 'late diagnostic status notification arrives')
  await settle(300)
  assert(diagnosticToast('success')?.textContent === w.tt('runtime_dependencies_diagnose_ready'),
    'A healthy diagnostic result stays in a toast after a late status refresh')
  assert(!diagnoseButton.disabled && diagnoseButton.getAttribute('aria-busy') === 'false', 'Diagnostics release the busy state after completion')
  assert(!depCard.parentElement?.querySelector('[role="status"]'), 'Diagnostic completion uses the toast surface without an inline result row')
  const toastBounds = diagnosticToast('success')!.getBoundingClientRect()
  assert(toastBounds.width > 0 && toastBounds.height > 0 && toastBounds.top >= 0 && toastBounds.bottom <= innerHeight,
    'Diagnostic feedback is visible inside the viewport while the dependency card is scrolled into view')
  await native({ capture: 'dependency-diagnose-healthy-zh' })
  clearDiagnosticToasts()
  dependencyState = 'missing'
  diagnosticNotification = 'before'
  await click(diagnoseButton)
  await until(() => diagnosticToast('warning'), 'missing bundle diagnostic toast appears')
  assert(diagnosticToast('warning')?.textContent === w.tt('runtime_dependencies_diagnose_problem') && diagnosticNotifications === 2,
    'A missing bundle shows a repair warning even when the status notification precedes the response')
  publish(WORKSPACE_DEPENDENCIES_ENABLED_KEY)
  await settle(300)
  assert(!!diagnosticToast('warning'), 'A repeated preference notification cannot erase the repair warning')
  await native({ capture: 'dependency-diagnose-missing-zh' })
  clearDiagnosticToasts()
  dependencyState = 'failed'
  await click(diagnoseButton)
  await until(() => diagnosticToast('warning'), 'failed bundle probe warning appears')
  assert(diagnosticToast('warning')?.textContent === w.tt('runtime_dependencies_diagnose_problem'),
    'An executed probe that finds a broken bundle reports a repair warning')
  clearDiagnosticToasts()
  failDiagnose = true
  await click(diagnoseButton)
  await until(() => diagnosticToast('danger'), 'diagnostic request failure toast appears')
  assert(diagnosticToast('danger')?.textContent === w.tt('runtime_dependencies_diagnose_failed') && !diagnoseButton.disabled,
    'A failed diagnostic request shows an error toast and allows retry')
  await native({ capture: 'dependency-diagnose-error-zh' })
  clearDiagnosticToasts()
  failDiagnose = false
  dependencyState = 'ready'
  w.currentLang = 'en'; window.dispatchEvent(new Event('klaus:lang-change'))
  await until(() => diagnoseButton.textContent?.includes('Diagnose'), 'English diagnostics label refreshes')
  await click(diagnoseButton)
  await until(() => diagnosticToast('success'), 'English diagnostic success toast appears')
  assert(diagnosticToast('success')?.textContent === 'Klaus dependencies look healthy', 'A retried diagnostic request reports its healthy result in the current language')
  clearDiagnosticToasts()
  const { showToast } = await import('../frontend/src/app/ui-shared')
  const removeNeutral = showToast('Neutral fixture message')
  const neutralToast = find<HTMLElement>('#settings-toast-viewport .toast-root')
  assert(!neutralToast.hasAttribute('data-tone'), 'Existing toast callers do not acquire a diagnostic tone')
  removeNeutral?.()
  clearDiagnosticToasts()
  w.currentLang = 'zh'; window.dispatchEvent(new Event('klaus:lang-change'))
  await until(() => diagnoseButton.textContent?.includes('诊断'), 'Chinese dependency labels refreshed')
  depCard.scrollIntoView({ block: 'center' }); await settle()
  await click('label:has(#runtime-dependencies-toggle)')
  await until(() => find<HTMLButtonElement>('[data-dependency="diagnose"] button').disabled, 'disabling dependencies fences the dependency actions')
  assert((globalValues as Record<string, string | null>)['klaus.workspaceDependencies'] === 'off', 'The dependency preference persists through the shared settings write')
  await click('label:has(#runtime-dependencies-toggle)')
  await until(() => !find<HTMLButtonElement>('[data-dependency="diagnose"] button').disabled, 're-enabling restores the dependency actions')
  const modelToggle = () => find<HTMLInputElement>('#runtime-subagent-model-catalog')
  const scrollToModelToggle = async () => {
    find<HTMLElement>('[data-subagent-model-policy]').scrollIntoView({ block: 'center' })
    await settle()
  }
  await scrollToModelToggle()
  assert(!modelToggle().checked && document.body.textContent?.includes('关闭时按高、中、低档位委派'), 'Subagent catalog selection defaults off and explains tier delegation')
  const toggleWrites = requests.length
  await click('label:has(#runtime-subagent-model-catalog)')
  await until(() => !modelToggle().disabled && modelToggle().checked, 'catalog model selection enabled')
  assert(requests.length === toggleWrites + 1 && requests.at(-1)?.key === 'klaus.subagentModelCatalog'
    && requests.at(-1)?.scope.kind === 'project' && projectValues['klaus.subagentModelCatalog'] === 'on'
    && globalValues['klaus.subagentModelCatalog'] === 'off', 'The catalog switch saves once in the selected scope without changing the user default')
  root.render(<div />); await settle(); mount()
  await until(() => document.querySelector('#runtime-subagent-model-catalog'), 'model selection settings remounted')
  await scrollToModelToggle()
  assert(modelToggle().checked && find('#runtime-scope').textContent?.includes('Atlas'), 'Reopening restores the saved catalog policy and its scope')
  await native({ capture: 'subagent-model-catalog-on-zh' })
  w.currentLang = 'en'; window.dispatchEvent(new Event('klaus:lang-change'))
  await until(() => document.body.textContent?.includes('Choose subagent models from the catalog'), 'English model selection copy refreshed')
  await scrollToModelToggle()
  assert(document.body.textContent?.includes('Off: delegate using high, medium, or low tiers.'), 'English copy explains both model selection policies')
  failNext = true
  await click('label:has(#runtime-subagent-model-catalog)')
  await until(() => document.querySelector('[role="alert"]'), 'failed catalog policy save displayed')
  assert(modelToggle().checked && projectValues['klaus.subagentModelCatalog'] === 'on', 'Failed catalog policy writes preserve the authoritative selection')
  const retryModelPolicy = onButton('Retry')
  retryModelPolicy.scrollIntoView({ block: 'center' }); await settle()
  await click(retryModelPolicy)
  await until(() => !modelToggle().disabled && !document.querySelector('[role="alert"]'), 'catalog policy save recovered')
  await scrollToModelToggle()
  await click('label:has(#runtime-subagent-model-catalog)')
  await until(() => !modelToggle().checked && !modelToggle().disabled, 'tier model selection restored')
  assert(projectValues['klaus.subagentModelCatalog'] === 'off', 'Disabling catalog selection persists the tier-only policy')
  w.currentLang = 'zh'; window.dispatchEvent(new Event('klaus:lang-change'))
  await until(() => document.body.textContent?.includes('从模型目录选择子智能体模型'), 'Chinese model selection copy refreshed')
  await scrollToModelToggle()
  await native({ capture: 'subagent-model-catalog-off-zh' })
  const currentReinstallButton = find<HTMLButtonElement>('[data-dependency="reinstall"] button')
  currentReinstallButton.scrollIntoView({ block: 'center' }); await settle()
  await click(currentReinstallButton)
  await until(() => find<HTMLButtonElement>('[data-dependency="reinstall"] button').textContent?.includes('正在安装'), 'reinstall shows its installing state')
  assert(find<HTMLButtonElement>('[data-dependency="diagnose"] button').disabled, 'An installing workspace fences diagnose')
  return { passed: checks.length, checks, settingsWrites: requests.length, permissionWrites: permissionRequests.length, opened, links, toasts, approvalWrites: approvals.length, reviewCaptureStructure }

}

w.runtimeSettingsReady = run().then(results => { w.runtimeSettingsResults = results; return true }).catch(error => {
  w.runtimeSettingsError = error?.stack ?? String(error)
  w.runtimeSettingsResults = { passed: checks.length, checks }
  throw error
})
