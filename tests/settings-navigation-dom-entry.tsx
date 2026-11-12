import { useState, type ReactNode } from 'react'
import { flushSync } from 'react-dom'
import { mountSettingsTab, PrefNumberRow, PrefTextRow } from '../frontend/src/pages/settings/kv'
import { DEFAULT_PET_SETTINGS } from '../contracts/desktop-pet'
import '../frontend/src/icons'
import '../frontend/src/app/ui-select'

const w = window as any
const sleep = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms))
const delayed = async <T,>(value: T, ms = 100): Promise<T> => { await sleep(ms); return structuredClone(value) }
const checks: string[] = [], toasts: string[] = [], writes: Array<{ key: string; value: string }> = []
const stored = new Map<string, string>([['voice.input.source', 'system'], ['display_name', 'Fixture profile'], ['profile_handle:guest', 'fixture.guest']])
const authListeners = new Set<(event: any) => void>()
const powerListeners = new Set<(value: any) => void>()
let currentUser: any = null, currentTab = '', failNext = false, failReads = false, writeDelay = 20
let remount: (() => void) | undefined
let workspaceExcludes: string[] = []
let failSearchAvailability = false
const power = { revision: 1, platform: 'darwin', preferences: { preventSleepWhileRunning: false, keepRemoteControlAwakeWhilePluggedIn: false } }
const runtime = (scope: any) => ({ scope, version: '1', path: '/fixture/settings.json', values: {}, effective: { 'klaus.approvalPolicy': 'on-request', 'klaus.sandboxMode': scope.kind === 'user' ? 'workspace-write' : 'read-only', 'klaus.sandbox.networkAllowed': 'on' }, sources: {} })
const friendRuntime = () => ({ signedIn: true, currentDeviceId: 'device-A', receiver: { selectedDeviceId: 'device-A', devices: [{ id: 'device-A', name: 'My device', platform: 'darwin', online: true, supportsFriendsMessaging: true, isCurrent: true }] }, tasks: [], templates: [], outgoing: [], defaultGrant: { deviceId: 'device-A', mode: 'manual', computerUse: false, apps: [], directories: [], remember: false, policy: 'approve' }, friendFilesRoot: '/fixture/files', executionTargets: { projects: [], workspaces: [] } })
const settings: any = {
  kv: {
    get: async (key: string) => { const value = stored.get(key); await sleep(100); if (failReads) throw Error('Fixture refresh failed'); return value },
    set: async (key: string, value: string) => {
      writes.push({ key, value }); const failed = failNext; failNext = false
      await sleep(writeDelay)
      if (failed) return { ok: false, error: 'Fixture save failed' }
      stored.set(key, value); remount?.(); return { ok: true }
    },
  },
  outputStyles: { list: () => delayed({ defaultStyle: 'default', current: 'default', styles: [{ id: 'default', isDefault: true }, { id: 'Learning' }] }), set: async () => ({ ok: true }) },
  webSearchSources: { get: async () => { await sleep(100); if (failSearchAvailability) throw Error('Fixture source availability failed'); return { availability: { codex: true, cursor: false } } } }, webFetchSources: { get: () => delayed({ availability: {} }) },
  permissions: { list: () => delayed({ ok: true, allow: [{ toolName: 'Read', source: 'userSettings' }], deny: [], ask: [] }) },
  runtimeConfig: { get: (scope: any) => delayed(runtime(scope)) },
  mobileBridge: { get: () => delayed({ ok: true, settings: { enabled: true, accountLinked: true } }), devices: () => delayed({ ok: true, devices: [] }) },
  klausHooks: { get: () => delayed({ ok: true, hooks: {} }) },
  klausSandbox: { normalizeRootList: (value: string) => value.trim() },
  keymap: { captureEnd: async () => {} },
  models: { getTiers: () => delayed({ ok: true, mapping: { high: null, medium: null, low: null } }), tierOptions: () => delayed({ ok: true, sources: [] }) },
}
const mediaSelections = new Map(['image', 'video', 'audio', 'music'].map(kind => [kind, kind === 'music' ? 'none' : 'custom']))
const mediaModels = new Map(['image', 'video', 'audio', 'music'].map(kind => [kind, new Map([['custom', 'custom-two'], ['qwenwork', kind === 'music' ? 'music-one' : 'native-two'], ['minimax', 'native-two'], ['none', '']])]))
const mediaWrites: Array<{ kind: string; source: string; model?: string }> = []
let mediaWriteDelay = 20, mediaReadDelay = 100, mediaFailNext = false, mediaFailReads = false
function mediaCatalog(kind: string) {
  const native = kind === 'audio' ? 'minimax' : 'qwenwork'
  const sources = kind === 'music' ? ['none', native] : ['custom', native]
  const currentBySource = Object.fromEntries(sources.map(source => [source, { source, modelId: mediaModels.get(kind)!.get(source)! }]))
  const selection = mediaSelections.get(kind)!
  const options = sources.flatMap(source => source === 'none' ? [{ source, modelId: '', label: 'Disabled', available: true }]
    : kind === 'music' ? [{ source, modelId: 'music-one', label: 'Music One', available: true }]
    : (source === 'custom' ? [['custom-one', 'Custom One'], ['custom-two', 'Custom Two']] : [['native-one', 'Native One'], ['native-two', 'Native Two']]).map(([modelId, label]) => ({ source, modelId, label, available: true })))
  return { ok: true, selection, current: currentBySource[selection], currentBySource, options, availability: Object.fromEntries(sources.map(source => [source, true])) }
}
for (const kind of ['image', 'video', 'audio', 'music']) {
  settings[`${kind}Selection`] = {
    get: async () => { const value = mediaCatalog(kind); await sleep(mediaReadDelay); if (mediaFailReads) throw Error('Fixture media refresh failed'); return structuredClone(value) },
    set: async (value: string, model?: string) => {
      mediaWrites.push({ kind, source: value, model })
      const failed = mediaFailNext; mediaFailNext = false
      await sleep(mediaWriteDelay)
      if (failed) return { ok: false, error: 'Fixture media save failed' }
      mediaSelections.set(kind, value)
      if (model !== undefined) mediaModels.get(kind)!.set(value, model)
      remount?.(); await sleep(80); return { ok: true }
    },
  }
  settings[`${kind}Gen`] = { get: () => delayed({ model: 'm1', capabilities: { [kind]: { available: true, models: [{ id: 'm1', label: 'Model 1' }, { id: 'm2', label: 'Model 2' }], defaultModel: 'm1' }, imageEdit: { available: true, models: [{ id: 'm1', label: 'Model 1' }], defaultModel: 'm1' } } }), set: async (patch: any) => ({ ok: true, config: patch }) }
}
settings.advisor = { get: () => delayed({ enabled: false, model: '' }), set: async (value: any) => ({ ok: true, settings: value }) }
w.currentLang = 'en'
const captureToast = (message: string) => toasts.push(message)
w.showToast = captureToast
w.klsLoading = { render: () => '<div class="fixture-loader" role="status">Loading settings</div>' }
w.settingsApi = settings
w.sessionDisplayTitle = () => 'Archived fixture'
w.KlausRendererProductContracts = { createArchivedLifecycleController: () => ({ isPending: () => false }) }
w.KlausFollowUp = { normalizeMode: (value: string) => value === 'steer' ? 'steer' : 'queue' }
const account = { status: () => delayed({ loggedIn: false }) }
w.klaus = {
  settings, auth: account, codexAuth: account, qoderAuth: account, qoderworkAuth: account, workbuddyAuth: account, qwenworkAuth: account,
  projects: { list: () => delayed({ roots: ['/fixture/project'], labels: {} }) }, workspaces: { list: () => delayed({ workspaces: [] }) }, plugins: { market: () => delayed([]) },
  powerSave: { snapshot: () => delayed(power), subscribe: (listener: any) => { powerListeners.add(listener); return () => powerListeners.delete(listener) } },
  app: { loginItem: { get: () => delayed({ enabled: false }) } }, workspace: { getExcludes: () => delayed({ patterns: workspaceExcludes }), setExcludes: async (patterns: string[]) => { workspaceExcludes = patterns; return { ok: true } } }, composerPredictions: { availability: () => delayed({ available: true }) },
  systemPermissions: { check: () => delayed({ supported: true, permissions: { fullDiskAccess: 'denied' } }) },
  updater: { status: () => delayed({ supported: true, currentVersion: '0.5.2', state: 'idle' }) },
  desktopPet: { getState: () => delayed({ revision: 1, settings: { ...DEFAULT_PET_SETTINGS, language: 'en' }, catalog: [], tasks: [], layout: { pet: { x: 0, y: 0, width: 112, height: 112 }, viewport: { width: 1280, height: 960 }, placement: 'bottom-end' }, visible: false, menuOpen: false, stashedEdge: null }), onState: () => () => {} },
  session: { listArchived: () => delayed([{ id: 'archived-1', workdir: '/fixture/project', updatedAt: 123 }]) },
  klausAuth: { status: () => delayed({ loggedIn: !!currentUser, user: currentUser }) },
  profile: { activity: () => delayed({ days: [], totalTokens: 42, peakDailyTokens: 0, longestTaskMs: 0, longestStreakDays: 0, currentStreakDays: 0 }) },
  friends: { runtime: () => delayed(friendRuntime()), apps: () => delayed({ available: true, apps: [], taskCommands: true }), onRuntimeChanged: () => () => {} },
  voice: { config: () => delayed({ ok: true, source: stored.get('voice.input.source'), systemAsr: true, availability: {} }), hotwords: { list: () => delayed([]) }, memories: { list: () => delayed([]) } },
  on: { appPreferencesChanged: () => () => {}, updaterStatus: () => () => {}, klausAuthUpdated: (listener: any) => { authListeners.add(listener); return () => authListeners.delete(listener) } },
}
function assert(value: unknown, label: string): asserts value { if (!value) throw Error(`${currentTab}: ${label}`); checks.push(`${currentTab}: ${label}`) }
function find<T extends HTMLElement>(selector: string): T { const value = document.querySelector<T>(selector); if (!value) throw Error(`${currentTab}: Missing ${selector}`); return value }
async function until(check: () => unknown) { const end = Date.now() + 5000; while (!check()) { if (Date.now() > end) throw Error(`${currentTab}: Timed out\n${document.body.innerText}`); await sleep() } }
async function run() {
  const [prefs, engine, misc, capabilities, hooks, about, pets, archived, profile, friends, native, tiers, voice, subscription] = await Promise.all([
    import('../frontend/src/pages/settings/prefs-tabs'), import('../frontend/src/pages/settings/engine-tabs'), import('../frontend/src/pages/settings/misc-tabs'), import('../frontend/src/pages/settings/capability-tabs'), import('../frontend/src/pages/settings/hooks-tab'), import('../frontend/src/pages/settings/about-tab'), import('../frontend/src/pages/settings/pets-tab'), import('../frontend/src/pages/settings/archived-tab'), import('../frontend/src/pages/profile/ProfilePage'), import('../frontend/src/pages/settings/friends-tab'), import('../frontend/src/pages/settings/native-media-models'), import('../frontend/src/pages/settings/global-model-tiers'), import('../frontend/src/pages/settings/voice-tab'), import('../frontend/src/pages/settings/subscription-card'),
  ])
  const runtimeView = await import('../frontend/src/pages/settings/runtime-tab')
  w.showToast = captureToast
  const pages: Array<{ name: string; node: ReactNode; selector: string }> = [
    { name: 'preferences', node: <prefs.PreferencesTab />, selector: '#pref-predictions' },
    { name: 'web', node: <engine.EngineWebTab />, selector: '#klaus-ws-enabled' },
    { name: 'memory', node: <engine.DreamSettingsTab />, selector: '#klaus-feat-automemory' },
    { name: 'permissions', node: <prefs.PermissionRulesTab />, selector: '#perm-rules-lists code' },
    { name: 'system', node: <misc.SystemAuthTab />, selector: '#sys-auth-list [data-sep="1"]' },
    { name: 'runtime', node: <runtimeView.RuntimeSettingsTab />, selector: '#runtime-approval' },
    { name: 'mobile', node: <capabilities.MobileBridgeSettingsTab />, selector: '#mobile-bridge-enabled' },
    { name: 'hooks', node: <hooks.HooksSettingsTab />, selector: '[data-hook-source="global"]' },
    { name: 'about', node: <about.AboutTab />, selector: '#about-open-changelog' },
    { name: 'pets', node: <pets.PetsSettingsTab />, selector: '.pet-settings-button' },
    { name: 'archived', node: <archived.ArchivedSessionsTab />, selector: '[data-session-id="archived-1"]' },
    { name: 'profile', node: <profile.ProfilePage embedded />, selector: 'dd' },
    { name: 'friends', node: <friends.FriendsSettingsTab />, selector: '#friends-local-assist:not(:disabled)' },
    { name: 'native-media', node: <native.NativeMediaModels kind="image" source="qwenwork" reloadSeq={0} />, selector: '#native-image-model .kls-select-trigger' },
    { name: 'model-defaults', node: <tiers.GlobalModelTiers configureSource={() => {}} />, selector: '#advisor-enabled' },
    { name: 'voice', node: <voice.VoiceInputSettingsTab />, selector: '#voice-personalization-toggle' },
  ]
  const host = () => find<HTMLElement>('#fixture-root')
  const mount = (page: typeof pages[number]) => { currentTab = page.name; remount = () => mountSettingsTab(host(), page.node); remount() }
  const frames: Array<{ tab: string; ready: boolean }> = []
  const ready = (page: typeof pages[number]) => {
    const node = document.querySelector(page.selector)
    return !!node && (page.name !== 'profile' || node.textContent === '42')
  }
  let monitored: typeof pages[number] | undefined, sampling = true
  const sample = () => { if (monitored) frames.push({ tab: monitored.name, ready: ready(monitored) }); if (sampling) requestAnimationFrame(sample) }
  requestAnimationFrame(sample)
  setTimeout(() => { for (const listener of powerListeners) listener(power) }, 25)
  for (const page of pages) {
    mount(page); await until(() => ready(page)); await sleep(350)
    monitored = page; mount(page)
    assert(ready(page), 'warm remount paints resolved content synchronously')
    await sleep(250); monitored = undefined
  }
  for (const page of pages) { monitored = page; mount(page); await sleep(30) }
  monitored = undefined
  assert(frames.length > 50 && frames.every(frame => frame.ready), 'all sampled warm navigation frames retain their resolved content')

  const voicePage = pages.find(page => page.name === 'voice')!
  mount(voicePage); await sleep(250)
  await until(() => !!document.querySelector('#voice-source-select .kls-select-trigger'))
  assert(!document.querySelector('[data-source-tabs="voice-input"]'), 'voice preferences host a single source selector, not tabbed sources')
  assert(!!document.querySelector('#voice-personalization-toggle') && !!document.querySelector('#voice-dictionary-list'), 'voice preferences retain personalization and the correction dictionary')
  const capabilityPage = pages.find(page => page.name === 'model-defaults')!
  mount(capabilityPage); await sleep(250)
  assert(!document.querySelector('#voice-source-select'), 'capability settings no longer contain the speech recognition source selector')
  mount(voicePage); await until(() => !!document.querySelector('#voice-source-select .kls-select-trigger'))
  const voiceValue = () => (find('#voice-source-select') as any).__klsSelect.getValue()
  const voiceDisabled = () => find('#voice-source-select .kls-select-trigger').getAttribute('aria-disabled') === 'true'
  const chooseVoice = (source: string) => {
    find<HTMLButtonElement>('#voice-source-select .kls-select-trigger').click()
    find<HTMLButtonElement>(`#voice-source-select [data-value="${source}"]`).click()
  }
  await until(() => !voiceDisabled())
  assert(!document.querySelector('[data-capability-voice-source] [id*="auth-login"], [data-capability-voice-source] [id*="auth-logout"]'), 'voice capability reuses credentials without embedding account cards')
  chooseVoice('custom')
  await until(() => stored.get('voice.input.source') === 'custom' && !voiceDisabled())
  assert(toasts.length === 0, 'switching a voice source saves without a success toast')
  writeDelay = 300
  chooseVoice('system'); mount(voicePage)
  assert(voiceValue() === 'system' && voiceDisabled(), 'voice optimistic value and save lock survive a preference-driven remount')
  await until(() => stored.get('voice.input.source') === 'system' && !voiceDisabled())
  failNext = true
  chooseVoice('custom'); await sleep(20); mount(voicePage)
  await until(() => toasts.includes('Fixture save failed') && voiceValue() === 'system' && !voiceDisabled())
  assert(stored.get('voice.input.source') === 'system', 'failed voice source saves restore the confirmed choice across remounts')
  writeDelay = 20
  chooseVoice('qwenwork'); await until(() => stored.get('voice.input.source') === 'qwenwork' && !voiceDisabled())
  mount(voicePage); await until(() => !!document.querySelector('#voice-dictionary-list') && document.body.innerText.includes('QwenWork'))
  assert(!!document.querySelector('#voice-source-select'), 'the source selector remains available on the voice input page after changing providers')

  mount(pages[0]!); writeDelay = 300
  find<HTMLInputElement>('#pref-predictions').click()
  await sleep(180)
  assert(!find<HTMLInputElement>('#pref-predictions').checked, 'slow mount reads cannot overwrite a newer optimistic edit')
  await until(() => stored.get('composer_predictions_enabled') === 'off'); await sleep(250); writeDelay = 20
  failReads = true; mount(pages[0]!); await until(() => document.querySelector('[role="alert"]'))
  assert(!!document.querySelector('#pref-predictions'), 'background errors preserve controls and expose a retry')
  failReads = false; find<HTMLButtonElement>('[role="alert"] button').click(); await until(() => !document.querySelector('[role="alert"]'))

  writeDelay = 250; failNext = true
  const failedSaveToasts = toasts.filter(message => message === 'Fixture save failed').length
  find<HTMLInputElement>('#pref-predictions').click(); await sleep(20); mount(pages[0]!)
  await until(() => toasts.filter(message => message === 'Fixture save failed').length > failedSaveToasts && !find<HTMLInputElement>('#pref-predictions').checked && stored.get('composer_predictions_enabled') === 'off')
  assert(!find<HTMLInputElement>('#pref-predictions').checked, 'a failed save settling after remount rolls back the active view')
  writeDelay = 20

  stored.set('klaus.additionalWritableRoots', '/fixture/new-root')
  workspaceExcludes = ['new-pattern']
  mount(pages[0]!)
  await until(() => find<HTMLTextAreaElement>('#ws-excludes').value === 'new-pattern')
  assert(find<HTMLTextAreaElement>('#ws-excludes').value === 'new-pattern', 'workspace exclusions refresh their visible cached textarea')

  const searchPage = pages.find(page => page.name === 'model-defaults')!
  const webPage = pages.find(page => page.name === 'web')!
  mount(webPage); await sleep(250)
  assert(!document.querySelector('#klaus-ws-source, [data-source-tabs="websearch-sources"], #klaus-ws-brave-key'), 'Network has no search source controls or credential tabs')
  assert(!!document.querySelector('#klaus-ws-enabled') && !!document.querySelector('#klaus-ws-blocked') && !!document.querySelector('#klaus-wf-note') && !!document.querySelector('#klaus-wf-blocked'), 'Network retains search limits, enablement and built-in page fetching')
  mount(searchPage); await sleep(250)
  const chooseSearch = (source: string) => {
    find<HTMLButtonElement>('#klaus-ws-source .kls-select-trigger').click()
    find<HTMLButtonElement>(`#klaus-ws-source [data-value="${source}"]`).click()
  }
  const searchValue = () => (find('#klaus-ws-source') as any).__klsSelect.getValue()
  const searchIdle = () => document.querySelector('[data-function-search-source]')?.getAttribute('aria-busy') === 'false'
  find<HTMLButtonElement>('#klaus-ws-source .kls-select-trigger').click()
  assert([searchValue(), ...Array.from(document.querySelectorAll('#klaus-ws-source [data-value]')).map(item => item.getAttribute('data-value'))].sort().join(',') === ['builtin', 'subscription', 'codex', 'cursor', 'qoder', 'qoderwork', 'qwenwork', 'workbuddy', 'antigravity', 'kimi', 'bailian', 'minimax', 'zhipu'].sort().join(','), 'search lists every verified subscription plus a legacy stored source, independent of credentials')
  find<HTMLButtonElement>('#klaus-ws-source .kls-select-trigger').click()
  writeDelay = 300
  chooseSearch('codex'); await sleep(30)
  assert(searchValue() === 'codex', 'a delayed search save paints its choice immediately')
  assert(find('#klaus-ws-source .kls-select-trigger').getAttribute('aria-disabled') === 'false', 'search stays usable while saving')
  mount(searchPage)
  assert(searchValue() === 'codex', 'a warm remount retains a pending search choice synchronously')
  chooseSearch('kimi')
  await until(() => stored.get('klaus.webSearch.source') === 'kimi' && searchIdle()); await sleep(150)
  assert(searchValue() === 'kimi', 'queued search changes survive host remounts and stale reads')
  const searchWrites = writes.filter(row => row.key === 'klaus.webSearch.source').map(row => row.value)
  assert(searchWrites.slice(-2).join(',') === 'codex,kimi', 'rapid search source writes are serialized')
  failNext = true
  chooseSearch('codex'); await sleep(30); mount(searchPage)
  await until(() => searchIdle() && document.querySelector('[data-function-search-source] [role="alert"]'))
  assert(searchValue() === 'kimi', 'a failed search save restores the last confirmed choice after remount')
  find<HTMLButtonElement>('[data-function-search-source] [role="alert"] button').click()
  await until(() => !document.querySelector('[data-function-search-source] [role="alert"]'))
  writeDelay = 20
  chooseSearch('cursor')
  await until(() => stored.get('klaus.webSearch.source') === 'cursor' && searchIdle())
  assert(!!document.querySelector('[data-search-connection-required]'), 'an unconnected subscription saves and then asks for its credentials')
  assert(!!document.querySelector('[data-search-connection-required] button'), 'the credential hint offers the source configuration entry')
  chooseSearch('codex')
  await until(() => stored.get('klaus.webSearch.source') === 'codex' && searchIdle())
  assert(!document.querySelector('[data-search-connection-required]'), 'a connected subscription clears the credential hint')
  mount(searchPage); failReads = true
  await until(() => document.querySelector('[data-function-search-source] [role="alert"]'))
  assert(searchValue() === 'codex', 'a failed background search read retains its resolved choice')
  failReads = false
  find<HTMLButtonElement>('[data-function-search-source] [role="alert"] button').click()
  await until(() => !document.querySelector('[data-function-search-source] [role="alert"]'))
  failSearchAvailability = true
  window.dispatchEvent(new Event('klaus:models-changed'))
  await until(() => document.querySelector('[data-function-search-source] [role="alert"]'))
  assert(searchValue() === 'codex', 'availability failures retain the selected subscription and expose a retry')
  failSearchAvailability = false
  find<HTMLButtonElement>('[data-function-search-source] [role="alert"] button').click()
  await until(() => !document.querySelector('[data-function-search-source] [role="alert"]'))
  assert(searchValue() === 'codex', 'retry refreshes subscription availability without changing the effective choice')

  mount(pages.find(page => page.name === 'model-defaults')!); await sleep(250)
  find<HTMLButtonElement>('#tier-image-select .kls-select-trigger').click()
  find<HTMLButtonElement>('#tier-image-select [data-value="qwenwork"]').click()
  await until(() => mediaSelections.get('image') === 'qwenwork')
  assert(find('#tier-image-select').textContent?.includes('QwenWork'), 'global media selection paints the new source when the host remounts before replying')
  await sleep(300)
  assert(!find<HTMLButtonElement>('#tier-image-select .kls-select-trigger').disabled, 'the remounted media selection unlocks after its pending save completes')

  const mediaPage = pages.find(page => page.name === 'model-defaults')!
  const selectMedia = (source: string) => {
    find<HTMLButtonElement>('#tier-image-select .kls-select-trigger').click()
    find<HTMLButtonElement>(`#tier-image-select [data-value="${source}"]`).click()
  }
  const modelValue = () => (find('#tier-image-select-model') as any).__klsSelect.getValue()
  const mediaIdle = () => document.querySelector('[data-effective-media-model="image"]')?.getAttribute('aria-busy') === 'false'
  selectMedia('custom'); await until(() => mediaSelections.get('image') === 'custom' && mediaIdle()); await sleep(150)
  const mediaFrames: Array<{ phase: string; source: string; model: string; sourceText: string; modelText: string; disabled: boolean }> = []
  let mediaSampling = true, mediaPhase = 'remembered'
  const sampleMedia = () => {
    if (mediaSampling && currentTab === 'model-defaults') {
      const source = document.querySelector<any>('#tier-image-select'), model = document.querySelector<any>('#tier-image-select-model')
      mediaFrames.push({ phase: mediaPhase, source: source?.__klsSelect?.getValue() ?? '', model: model?.__klsSelect?.getValue() ?? '',
        sourceText: source?.querySelector('.kls-select-trigger')?.textContent.trim() ?? '', modelText: model?.querySelector('.kls-select-trigger')?.textContent.trim() ?? '',
        disabled: [source, model].some(node => !node || node.querySelector('.kls-select-trigger')?.getAttribute('aria-disabled') !== 'false') })
    }
    if (mediaSampling) requestAnimationFrame(sampleMedia)
  }
  requestAnimationFrame(sampleMedia)
  mediaWriteDelay = 300
  selectMedia('qwenwork'); await sleep(40)
  assert(modelValue() === 'native-two', 'switching modes immediately shows the remembered model rather than its first option')
  mount(mediaPage)
  assert(modelValue() === 'native-two', 'a pending source/model pair is fully bound before the remount can paint')
  assert(find<HTMLButtonElement>('#tier-image-select-model .kls-select-trigger').getAttribute('aria-disabled') === 'false', 'ready model choices remain usable while saving the source')
  await sleep(100)
  mediaPhase = 'queued-model'
  find<HTMLButtonElement>('#tier-image-select-model .kls-select-trigger').click()
  find<HTMLButtonElement>('#tier-image-select-model [data-value="native-one"]').click()
  await sleep(20)
  assert(modelValue() === 'native-one', 'a model picked during a source save is shown immediately')
  await until(() => mediaModels.get('image')!.get('qwenwork') === 'native-one' && mediaIdle())
  assert(mediaWrites.slice(-2).map(row => row.model).join() === 'native-two,native-one', 'rapid source and model choices are saved in order')
  mediaPhase = 'failed-save'; mediaFailNext = true
  selectMedia('custom'); await sleep(20); mount(mediaPage)
  await until(() => mediaIdle() && document.querySelector('[data-effective-media-model="image"] [role="alert"]'))
  assert((find('#tier-image-select') as any).__klsSelect.getValue() === 'qwenwork' && modelValue() === 'native-one', 'a failed save after remount restores the complete confirmed source/model pair')
  mediaPhase = 'failed-refresh'; mediaFailReads = true; mediaWriteDelay = 20
  selectMedia('custom')
  await until(() => mediaSelections.get('image') === 'custom' && mediaIdle() && document.querySelector('[data-effective-media-model="image"] [role="alert"]'))
  assert(modelValue() === 'custom-two', 'a post-save refresh failure cannot clear the resolved model')
  mediaFailReads = false
  find<HTMLButtonElement>('[data-effective-media-model="image"] [role="alert"] button').click()
  await until(() => !document.querySelector('[data-effective-media-model="image"] [role="alert"]'))
  mediaPhase = 'late-read'; mediaReadDelay = 600
  mount(mediaPage); selectMedia('qwenwork')
  await until(() => mediaSelections.get('image') === 'qwenwork' && mediaIdle()); await sleep(700)
  assert(modelValue() === 'native-one', 'late pre-save reads cannot replace the remembered model after switching')
  mediaPhase = 'navigate-pending'; mediaReadDelay = 100; mediaWriteDelay = 300
  selectMedia('custom'); mount(pages[0]!); await sleep(40); mount(mediaPage)
  assert(modelValue() === 'custom-two', 'returning during a save retains a complete pending pair')
  await until(() => mediaSelections.get('image') === 'custom' && mediaIdle())
  mediaSampling = false; mediaWriteDelay = 20
  assert(mediaFrames.length > 20 && mediaFrames.every(frame => frame.sourceText && frame.modelText && !frame.disabled), 'every sampled switch frame retains nonempty enabled controls')
  assert(mediaFrames.every(frame => frame.source === 'custom' ? frame.model.startsWith('custom-') : frame.source === 'qwenwork' && frame.model.startsWith('native-')), 'every sampled switch frame contains a coherent source/model pair')
  assert(mediaFrames.filter(frame => frame.phase === 'remembered' && frame.source === 'qwenwork').every(frame => frame.model === 'native-two'), 'no switch frame guesses the first model')
  w.mediaSwitchFrames = mediaFrames

  currentTab = 'generation-accounts'; remount = undefined
  w.klaus.codexAuth = { status: () => delayed({ loggedIn: true }) }
  let selectAccount: (value: string) => void = () => {}
  function Accounts() {
    const [source, setSource] = useState('codex'); selectAccount = setSource
    return <subscription.SubscriptionCardBody key={source} mode={source} reloadSeq={0} reload={() => {}} />
  }
  mountSettingsTab(host(), <Accounts />)
  await until(() => document.querySelector('#codex-auth-logout-btn'))
  flushSync(() => selectAccount('qoder'))
  assert(!document.querySelector('#qoder-auth-logout-btn'), 'a newly selected account source never borrows the previous source login state')
  await until(() => document.querySelector('#qoder-auth-login-btn'))
  flushSync(() => selectAccount('codex'))
  assert(!!document.querySelector('#codex-auth-logout-btn'), 'returning to a known media account paints its own cached login state')

  currentTab = 'workbuddy-account'
  const workbuddyCalls: Array<{ action: string; region?: string }> = []
  const workbuddyConfirmations: string[] = []
  let workbuddyConnected = false, workbuddyImportSuccess = false, workbuddyConfirm = true
  const previousDialog = w.klausDialog
  w.klausDialog = { confirm: async (value: string | { message: string }) => {
    workbuddyConfirmations.push(typeof value === 'string' ? value : value.message)
    const confirmed = workbuddyConfirm
    await sleep(80); return confirmed
  } }
  w.klaus.workbuddyAuth = {
    status: () => delayed({ loggedIn: workbuddyConnected, account: 'Fixture WorkBuddy', region: 'intl' }),
    start: async (region: string) => { workbuddyCalls.push({ action: 'login', region }); await sleep(100); return { ok: false, error: 'Fixture browser login declined.' } },
    importLocal: async (region: string) => {
      workbuddyCalls.push({ action: 'import', region }); await sleep(80)
      if (workbuddyImportSuccess) { workbuddyConnected = true; return { ok: true } }
      return { ok: false, error: 'Fixture local login unavailable.' }
    },
    logout: async () => { workbuddyCalls.push({ action: 'logout' }); workbuddyConnected = false; return { ok: true } },
  }
  function WorkBuddyAccount() {
    const [revision, setRevision] = useState(0)
    return <subscription.SubscriptionCardBody mode="workbuddy" reloadSeq={revision} reload={() => setRevision(value => value + 1)} activateModelOnLogin={false} />
  }
  mountSettingsTab(host(), <WorkBuddyAccount />)
  const workbuddyButtons = () => [...document.querySelectorAll<HTMLButtonElement>('[id^="workbuddy-auth-login-"][id$="-btn"], [id^="workbuddy-auth-import-"][id$="-btn"]')]
  await until(() => workbuddyButtons().length === 4)
  assert(!document.querySelector('#workbuddy-auth-region-select'), 'signed-out WorkBuddy offers four explicit actions without an edition selector')
  assert(workbuddyButtons().every(button => button.textContent?.trim() && !button.disabled), 'all edition actions are named and initially usable')
  for (const action of ['login', 'import']) for (const region of ['cn', 'intl']) {
    find<HTMLButtonElement>(`#workbuddy-auth-${action}-${region}-btn`).click()
    await sleep(20)
    assert(workbuddyButtons().every(button => button.disabled), 'every edition action is disabled during login, import and confirmation')
    for (const button of workbuddyButtons()) button.click()
    await until(() => workbuddyButtons().length === 4 && workbuddyButtons().every(button => !button.disabled))
  }
  assert(JSON.stringify(workbuddyCalls) === JSON.stringify([{ action: 'login', region: 'cn' }, { action: 'login', region: 'intl' }, { action: 'import', region: 'cn' }, { action: 'import', region: 'intl' }]), 'each explicit action reaches only its clicked edition and busy clicks start no extra operation')
  assert(workbuddyConfirmations[0]?.includes('China') && workbuddyConfirmations[1]?.includes('International'), 'local reuse confirms the exact clicked edition')
  workbuddyConfirm = false
  find<HTMLButtonElement>('#workbuddy-auth-import-cn-btn').click()
  await sleep(20)
  await until(() => workbuddyButtons().length === 4 && workbuddyButtons().every(button => !button.disabled))
  assert(workbuddyCalls.length === 4, 'canceling reuse restores all actions without importing credentials')
  workbuddyConfirm = true; workbuddyImportSuccess = true
  find<HTMLButtonElement>('#workbuddy-auth-import-intl-btn').click()
  await until(() => document.querySelector('#workbuddy-auth-logout-btn'))
  assert(workbuddyCalls.at(-1)?.region === 'intl', 'the successful reuse keeps the edition from its own button')
  assert(document.querySelectorAll('button').length === 1 && !document.querySelector('.kls-select'), 'connected WorkBuddy shows only logout without edition or import controls')
  await until(() => host().textContent?.includes('Fixture WorkBuddy') && host().textContent?.includes('International'))
  assert(host().textContent?.includes('Fixture WorkBuddy') && host().textContent?.includes('International'), 'the connected card retains its account and edition badge')
  mountSettingsTab(host(), <WorkBuddyAccount />)
  assert(!!document.querySelector('#workbuddy-auth-logout-btn') && workbuddyButtons().length === 0, 'a warm connected remount never flashes login or import actions')
  find<HTMLButtonElement>('#workbuddy-auth-logout-btn').click()
  await until(() => workbuddyButtons().length === 4)
  assert(workbuddyCalls.at(-1)?.action === 'logout', 'logout restores the four signed-out edition actions')
  w.klausDialog = previousDialog

  currentTab = 'blur'; remount = undefined
  const commits: string[] = []
  let updateText: (value: string) => void = () => {}
  function Fields() {
    const [value, setValue] = useState('saved'); updateText = setValue
    return <><PrefTextRow id="fixture-text" label="Text" desc="Text" value={value} onCommit={next => { commits.push(next); setValue(next) }} /><PrefNumberRow id="fixture-number" label="Number" desc="Number" value="4" attrs={{ min: 1 }} onCommit={next => commits.push(next)} /></>
  }
  mountSettingsTab(host(), <Fields />)
  const input = find<HTMLInputElement>('#fixture-text'); input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  const number = find<HTMLInputElement>('#fixture-number'); number.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  assert(commits.length === 0, 'leaving unchanged text and numeric fields does not write preferences')
  flushSync(() => updateText('external'))
  assert(input.value === 'external', 'background preference updates refresh untouched fields')
  input.value = 'draft'; flushSync(() => updateText('new external'))
  assert(input.value === 'draft', 'background preference updates preserve an in-progress draft')
  input.value = 'edited'; input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
  assert(commits.join() === 'edited', `edited text still commits on blur (${commits.join()})`)

  currentTab = 'account-boundary'
  mount(pages.find(page => page.name === 'profile')!); await sleep(350)
  assert(document.body.innerText.includes('@fixture.guest'), 'guest profile is loaded before account switch')
  mount(pages.find(page => page.name === 'web')!)
  currentUser = { id: 'account-B' }; for (const listener of authListeners) listener({ user: currentUser })
  mount(pages.find(page => page.name === 'profile')!)
  assert(!document.body.innerText.includes('@fixture.guest'), 'switching accounts while profile is hidden invalidates its old identity immediately')
  await sleep(350)
  sampling = false
  w.settingsNavigationResults = { passed: checks.length, checks, frameCount: frames.length, missingFrames: frames.filter(frame => !frame.ready), pages: pages.map(page => page.name), writes, toasts, mediaWrites, mediaSwitchFrames: w.mediaSwitchFrames, workbuddyCalls, workbuddyConfirmations }
}
w.settingsNavigationReady = run().catch(error => { w.settingsNavigationError = error?.stack || String(error); throw error })
