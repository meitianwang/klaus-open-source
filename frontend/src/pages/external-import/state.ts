// External Agent Import 状态与纯逻辑（迁自 js/external-import.js）：
// 三个入口（设置页 tab / 首启 onboarding 覆层 / 项目级导入弹窗）共享同一份
// 检测结果与选择集，模块级 state + pub/sub，组件经 useSyncExternalStore 订阅。
import { t } from '../../i18n'

const w = () => window as any
const SOURCE_IDS = ['claude-code', 'qoder', 'codex']

export const EXTERNAL_IMPORT_ONBOARDING_DISMISSED_KEY = 'external_agent_import.onboarding_dismissed'

export interface ExternalImportItem {
  providerId?: string
  providerName?: string
  itemType?: string
  cwd?: string
  description?: string
  details?: {
    sessions?: Array<{ title?: string; cwd?: string; path?: string }>
    projectRoots?: string[]
  }
}

export interface ExternalImportDetect {
  items: ExternalImportItem[]
  providers?: Array<{ id: string; name?: string; accent?: string; itemCount?: number }>
}

export interface ExternalImportProvider {
  id: string
  name: string
  accent: string
  itemCount: number
  nativeChatsSupported: boolean
}

export interface ExternalImportState {
  step: 'provider' | 'items'
  detect: ExternalImportDetect | null
  selectedProviderIds: Set<string>
  selectedItemIds: Set<string>
  pending: boolean
  complete: boolean
  error: string
  /** Non-fatal import notice (e.g. children skipped for unreadable links). */
  notice: string
}

export let externalImportState: ExternalImportState = {
  step: 'provider',
  detect: null,
  selectedProviderIds: new Set(),
  selectedItemIds: new Set(),
  pending: false,
  complete: false,
  error: '',
  notice: '',
}

// ---- pub/sub ----
const listeners = new Set<() => void>()
let version = 0
export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}
export function getVersion(): number { return version }
export function emit(): void {
  version++
  for (const fn of listeners) fn()
}

export function initExternalImportState(detect: any): void {
  const items: ExternalImportItem[] = Array.isArray(detect?.items) ? detect.items : []
  const providers = externalImportProviders({ ...detect, items })
  externalImportState = {
    step: 'provider',
    detect: { ...detect, items },
    selectedProviderIds: new Set(providers.filter(provider => provider.itemCount > 0).map(provider => provider.id)),
    selectedItemIds: new Set(items.filter(item => SOURCE_IDS.includes(item.providerId || 'claude-code') && item.itemType === 'SESSIONS').map(item => externalImportItemId(item))),
    pending: false,
    complete: false,
    error: '',
    notice: '',
  }
  emit()
}

export function externalImportItemId(item: ExternalImportItem | undefined): string {
  return [
    item?.providerId || 'claude-code',
    item?.itemType || 'unknown',
    item?.cwd || '',
    item?.description || '',
  ].join('|')
}

export function externalImportProviders(detect: any = externalImportState.detect): ExternalImportProvider[] {
  const items: ExternalImportItem[] = Array.isArray(detect?.items) ? detect.items : []
  const declared = Array.isArray(detect?.providers) ? detect.providers : []
  const byId = new Map<string, ExternalImportProvider>()
  const declaredIds = new Set<string>()
  declared.forEach((provider: any) => {
    if (!provider?.id || !SOURCE_IDS.includes(provider.id)) return
    declaredIds.add(provider.id)
    byId.set(provider.id, {
      id: provider.id,
      name: provider.name || externalImportProviderName(provider.id),
      accent: provider.accent || externalImportProviderAccent(provider.id),
      itemCount: Number(provider.itemCount) || 0,
      nativeChatsSupported: provider.id === 'claude-code' || provider.id === 'codex',
    })
  })
  items.forEach(item => {
    const id = item?.providerId || 'claude-code'
    if (!SOURCE_IDS.includes(id)) return
    const existing = byId.get(id)
    if (existing) {
      if (!declaredIds.has(id)) existing.itemCount += 1
      return
    }
    byId.set(id, {
      id,
      name: item?.providerName || externalImportProviderName(id),
      accent: externalImportProviderAccent(id),
      itemCount: 1,
      nativeChatsSupported: id === 'claude-code' || id === 'codex',
    })
  })
  for (const id of SOURCE_IDS) if (!byId.has(id)) byId.set(id, {
    id, name: externalImportProviderName(id), accent: externalImportProviderAccent(id),
    itemCount: 0, nativeChatsSupported: id === 'claude-code' || id === 'codex',
  })
  return SOURCE_IDS.map(id => byId.get(id)!)
}

export function externalImportHasDetectedItems(): boolean {
  return (externalImportState.detect?.items || []).some(item => SOURCE_IDS.includes(item.providerId || 'claude-code'))
}

export function externalImportProviderName(id: string): string {
  return ({
    'claude-code': 'Claude Code',
    qoder: 'Qoder',
    codex: 'Codex',
  } as Record<string, string>)[id] || id
}

export function externalImportProviderAccent(id: string): string {
  return ({
    'claude-code': '#da6a44',
    qoder: '#7c5cff',
    codex: '#111111',
  } as Record<string, string>)[id] || 'var(--accent)'
}

export function externalImportProviderLogoSrc(id: string): string {
  return ({
    'claude-code': 'import-claude-logo.png',
    qoder: 'import-qoder-logo.png',
    codex: 'codex-logo.png',
  } as Record<string, string>)[id] || ''
}

export function externalImportVisibleItems(): ExternalImportItem[] {
  const items = Array.isArray(externalImportState.detect?.items) ? externalImportState.detect!.items : []
  const selectedProviders = externalImportState.selectedProviderIds || new Set()
  return items.filter(item => SOURCE_IDS.includes(item?.providerId || 'claude-code') && selectedProviders.has(item?.providerId || 'claude-code'))
}

export interface ExternalImportGroupEntry {
  item: ExternalImportItem
  id: string
}

export interface ExternalImportSummary {
  items: ExternalImportItem[]
  tools: ExternalImportGroupEntry[]
  projects: ExternalImportGroupEntry[]
  chats: ExternalImportGroupEntry[]
  projectCount: number
  chatCount: number
  toolsCount: number
  hasItems: boolean
}

export function externalImportSummary(): ExternalImportSummary {
  const items = externalImportVisibleItems()
  const tools: ExternalImportGroupEntry[] = []
  const projects: ExternalImportGroupEntry[] = []
  const chats: ExternalImportGroupEntry[] = []
  const projectRoots = new Set<string>()
  let chatCount = 0
  items.forEach((item) => {
    const withId = { item, id: externalImportItemId(item) }
    if (item.itemType === 'SESSIONS') {
      chats.push(withId)
      const sessions = Array.isArray(item.details?.sessions) ? item.details!.sessions! : []
      chatCount += sessions.length
      sessions.forEach(session => { if (session?.cwd) projectRoots.add(session.cwd) })
    } else if (item.itemType === 'PROJECTS') {
      projects.push(withId)
      const roots = Array.isArray(item.details?.projectRoots) ? item.details!.projectRoots! : []
      roots.forEach(root => projectRoots.add(root))
    } else {
      tools.push(withId)
      if (item.cwd) projectRoots.add(item.cwd)
    }
  })
  return {
    items,
    tools,
    projects,
    chats,
    projectCount: projectRoots.size,
    chatCount,
    toolsCount: tools.length,
    hasItems: tools.length > 0 || projects.length > 0 || chats.length > 0,
  }
}

export function externalImportGroupState(groupItems: ExternalImportGroupEntry[]): 'off' | 'on' | 'mixed' {
  if (!groupItems.length) return 'off'
  const selected = groupItems.filter(({ id }) => externalImportState.selectedItemIds.has(id)).length
  if (selected === 0) return 'off'
  if (selected === groupItems.length) return 'on'
  return 'mixed'
}

export function externalImportSelectedItems(): ExternalImportItem[] {
  const items = externalImportVisibleItems()
  return items.filter(item => externalImportState.selectedItemIds.has(externalImportItemId(item)))
}

export function externalImportTooltipText(groupItems: ExternalImportGroupEntry[]): string {
  const labels: Array<string | undefined> = []
  groupItems.forEach(({ item }) => {
    if (item.itemType === 'SESSIONS') {
      const sessions = Array.isArray(item.details?.sessions) ? item.details!.sessions! : []
      sessions.slice(0, 5).forEach(session => labels.push(session.title || session.cwd || session.path))
      if (sessions.length > 5) labels.push(t('external_import_more_count').replace('{count}', String(sessions.length - 5)))
      return
    }
    if (item.itemType === 'PROJECTS') {
      const roots = Array.isArray(item.details?.projectRoots) ? item.details!.projectRoots! : []
      labels.push(...roots.slice(0, 5))
      if (roots.length > 5) labels.push(t('external_import_more_count').replace('{count}', String(roots.length - 5)))
      return
    }
    labels.push(externalImportItemLabel(item))
  })
  return labels.filter(Boolean).join(', ')
}

function itemTypeLabelMap(): Record<string, string> {
  return {
    CONFIG: t('external_import_item_config'),
    SKILLS: t('external_import_item_skills'),
    AGENTS_MD: t('external_import_item_instructions'),
    PLUGINS: t('external_import_item_plugins'),
    MCP_SERVER_CONFIG: t('external_import_item_mcp'),
    SUBAGENTS: t('external_import_item_agents'),
    HOOKS: t('external_import_item_hooks'),
    COMMANDS: t('external_import_item_commands'),
    PROJECTS: t('external_import_item_projects'),
    SESSIONS: t('external_import_item_sessions'),
  }
}

export function externalImportItemLabel(item: ExternalImportItem): string {
  const typeLabel = itemTypeLabelMap()[item.itemType || ''] || item.itemType || ''
  const provider = item.providerName || externalImportProviderName(item.providerId || 'claude-code')
  const label = item.cwd ? `${typeLabel}: ${item.cwd}` : typeLabel
  return `${provider} · ${label}`
}

export function externalImportProjectSettingItems(detect: any): ExternalImportItem[] {
  const items: ExternalImportItem[] = Array.isArray(detect?.items) ? detect.items : []
  const settingTypes = new Set([
    'CONFIG', 'SKILLS', 'AGENTS_MD', 'PLUGINS',
    'MCP_SERVER_CONFIG', 'SUBAGENTS', 'HOOKS', 'COMMANDS',
  ])
  return items.filter(item => settingTypes.has(item?.itemType || ''))
}

export function externalImportItemTypeTitle(item: ExternalImportItem): string {
  const map = itemTypeLabelMap()
  delete (map as any).PROJECTS
  delete (map as any).SESSIONS
  return map[item?.itemType || ''] || item?.itemType || t('external_import_options')
}

export function externalImportProjectItemDescription(item: ExternalImportItem): string {
  return item?.description || externalImportItemLabel(item)
}

export function externalImportHeaderSourceProviderId(): string {
  const providers = externalImportProviders()
  const selectedProviderIds = externalImportState.selectedProviderIds
  return providers.find(provider => selectedProviderIds?.has(provider.id))?.id
    || providers[0]?.id
    || 'claude-code'
}

// ---- 动作 ----

export function toggleProvider(id: string): void {
  if (!externalImportProviders().some(provider => provider.id === id && provider.itemCount > 0)) return
  const selected = externalImportState.selectedProviderIds || new Set()
  if (selected.has(id)) selected.delete(id)
  else selected.add(id)
  externalImportState.selectedProviderIds = selected
  emit()
}

export function setStep(step: 'provider' | 'items'): void {
  externalImportState.step = step
  emit()
}

export function toggleGroup(group: 'tools' | 'projects' | 'chats'): void {
  const summary = externalImportSummary()
  const groupItems = group === 'tools' ? summary.tools : group === 'projects' ? summary.projects : summary.chats
  const state = externalImportGroupState(groupItems)
  groupItems.forEach(({ id }) => {
    if (state === 'on') externalImportState.selectedItemIds.delete(id)
    else externalImportState.selectedItemIds.add(id)
  })
  emit()
}

export function toggleItem(id: string): void {
  if (externalImportState.selectedItemIds.has(id)) externalImportState.selectedItemIds.delete(id)
  else externalImportState.selectedItemIds.add(id)
  emit()
}

export function replaceSelectedItemIds(next: Set<string>): void {
  externalImportState.selectedItemIds = next
  emit()
}

export async function dismissOnboarding(): Promise<void> {
  try {
    const result = await w().settingsApi.kv.set(EXTERNAL_IMPORT_ONBOARDING_DISMISSED_KEY, '1')
    if (result?.ok === false || result?.error) throw new Error(result.error || t('settings_failed'))
    externalImportState.error = ''
    emit()
  } catch (error: any) {
    externalImportState.error = error?.message || t('settings_failed')
    emit()
    throw error
  }
}

/** 执行导入；成功置 complete + 播报 + 广播完成事件，失败落 error。 */
export async function externalImportRun(options: { requireOnboardingDismissal?: boolean } = {}): Promise<boolean> {
  const items = externalImportSelectedItems()
  if (!items.length || externalImportState.pending) return false
  externalImportState.pending = true
  externalImportState.error = ''
  externalImportState.notice = ''
  emit()
  let result: any
  try {
    result = await w().klaus.externalAgentImport.import(items)
    if (!result?.ok) throw new Error(result?.errors?.length ? result.errors.join('\n') : (result?.error || t('external_import_failed')))
  } catch (err: any) {
    externalImportState.pending = false
    externalImportState.error = err?.message || String(err) || t('external_import_failed')
    emit()
    return false
  }
  externalImportState.pending = false
  externalImportState.complete = true
  // Children that could not be read (e.g. a link leaving its source folder) are
  // left out of the import; say so without failing the run that saved the rest.
  const skipped = Array.isArray(result?.skipped) ? result.skipped.filter((value: unknown) => typeof value === 'string') as string[] : []
  externalImportState.notice = skipped.length ? t('external_import_partial').replace('{count}', String(skipped.length)) : ''
  emit()
  try {
    await dismissOnboarding()
  } catch (error: any) {
    if (options.requireOnboardingDismissal) {
      // The first-run overlay stays open so Skip can retry only the dismissal
      // preference without importing everything again.
      return false
    }
    // A manual settings/project import already succeeded. A secondary
    // preference failure must not turn that durable result into a failed run.
    w().showToast(error?.message || t('settings_failed'))
    externalImportState.error = ''
    emit()
  }
  w().showToast(t('external_import_success'))
  window.dispatchEvent(new CustomEvent('klaus:external-import-complete', { detail: result }))
  return true
}
