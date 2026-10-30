// 技能页数据缓存层（迁自 js/pages/skills.js）：并行拉取 + promise 去重 +
// 空闲预热 + 安装/更新/启停的缓存原位标记。模块级状态与旧版语义一致。
import { skillErrorText, unpackBuiltinSkillsReply } from './builtin-reply'
import { normalizeMarketKey, type SkillItem } from './localize'

const w = () => window as any

export interface SkillsData {
  installed: SkillItem[]
  market: SkillItem[]
  builtin: SkillItem[]
  errors: {
    installed: string | null
    market: string | null
    builtin: string | null
  }
  marketNextCursor: string | null
  marketIsRemote: boolean
}

let cache: SkillsData | null = null
let loadPromise: Promise<SkillsData> | null = null
let loadSeq = 0
export let marketCursor: string | null = null
export let marketIsRemote = false
let installedStale = false

const errorText = skillErrorText

function arrayResult(value: unknown, label: string): { items: SkillItem[]; error: string | null } {
  if (Array.isArray(value)) return { items: value, error: null }
  return { items: [], error: `${label} returned an invalid response` }
}

export function normalizeSkillsData(
  installedResult: PromiseSettledResult<unknown>,
  marketSettled: PromiseSettledResult<unknown>,
  builtinSettled: PromiseSettledResult<unknown>,
): SkillsData {
  const installed = installedResult.status === 'fulfilled'
    ? arrayResult(installedResult.value, 'Installed skills')
    : { items: [], error: errorText(installedResult.reason) }

  const marketValue: any = marketSettled.status === 'fulfilled' ? marketSettled.value : null
  const market = marketSettled.status === 'rejected'
    ? { items: [], error: errorText(marketSettled.reason) }
    : arrayResult(marketValue?.items ?? (Array.isArray(marketValue) ? marketValue : undefined), 'Skill market')

  const builtin = builtinSettled.status === 'rejected'
    ? { items: [], error: errorText(builtinSettled.reason) }
    : unpackBuiltinSkillsReply<SkillItem>(builtinSettled.value)

  return {
    installed: installed.items,
    market: market.items,
    builtin: builtin.items,
    errors: {
      installed: installed.error,
      market: market.error || (marketValue?.error ? errorText(marketValue.error) : null),
      builtin: builtin.error,
    },
    marketNextCursor: typeof marketValue?.nextCursor === 'string' ? marketValue.nextCursor : null,
    marketIsRemote: marketValue?.isRemote === true,
  }
}

export function invalidateSkillsDataCache(): void {
  loadSeq++
  cache = null
  loadPromise = null
  marketCursor = null
  marketIsRemote = false
}

export function getSkillsCache(): SkillsData | null { return cache }

export function setMarketCursor(cursor: string | null): void { marketCursor = cursor }

export function markSkillInstalledInCache(dirName: string): void {
  if (!cache) return
  const item = cache.market.find(s => (s.upstreamSlug || s.dirName || s.name) === dirName)
  if (item) { item.installed = true; item.hasUpdate = false }
}

export function markSkillUpdatedInCache(slug: string, version?: string): void {
  if (!cache) return
  const item = cache.market.find(s => (s.upstreamSlug || s.dirName || s.name) === slug)
  if (item) { item.hasUpdate = false; if (version) item.version = version }
}

export function markInstalledCacheStale(): void { installedStale = true }
export function consumeInstalledStale(): boolean {
  const stale = installedStale
  installedStale = false
  return stale
}
export function isInstalledStale(): boolean { return installedStale }

export function updateCachedSkillEnabled(skillName: string, enabled: boolean): void {
  if (!cache) return
  const target = normalizeMarketKey(skillName)
  for (const list of [cache.installed, cache.market, cache.builtin]) {
    for (const skill of list) {
      if (normalizeMarketKey(skill?.dirName || skill?.name) === target) {
        ;(skill as any).userEnabled = enabled
      }
    }
  }
}

/** 远程搜索/分页把新目录页并进缓存。 */
export function replaceMarketInCache(items: SkillItem[], nextCursor: string | null, isRemote: boolean): void {
  if (!cache) return
  cache.market = items
  cache.marketNextCursor = nextCursor
  cache.marketIsRemote = isRemote
  marketCursor = nextCursor
  marketIsRemote = isRemote
}

export function appendMarketToCache(items: SkillItem[], nextCursor: string | null): SkillItem[] {
  if (!cache || !items.length) {
    marketCursor = null
    if (cache) cache.marketNextCursor = null
    return []
  }
  const existingNames = new Set(cache.market.map(s => s.dirName || s.name))
  const newItems = items.filter(s => !existingNames.has(s.dirName || s.name))
  cache.market = [...cache.market, ...newItems]
  cache.marketNextCursor = nextCursor
  marketCursor = nextCursor
  return newItems
}

export async function loadSkillsData(forceRefresh = false): Promise<SkillsData> {
  if (forceRefresh) {
    invalidateSkillsDataCache()
  }
  if (!forceRefresh && cache) return cache
  if (!forceRefresh && loadPromise) return loadPromise

  const seq = ++loadSeq
  const promise = Promise.allSettled([
    w().klaus.skills.list(),
    w().klaus.skills.market(),
    w().klaus.skills.builtin(),
  ]).then(([installed, marketResult, builtin]) => {
    const data = normalizeSkillsData(installed, marketResult, builtin)
    if (data.errors.installed && data.errors.market && data.errors.builtin) {
      throw new Error([data.errors.installed, data.errors.market, data.errors.builtin].join('; '))
    }
    if (seq === loadSeq) {
      cache = data
      marketCursor = data.marketNextCursor
      marketIsRemote = data.marketIsRemote
    }
    return data
  }).finally(() => {
    if (loadPromise === promise) loadPromise = null
  })

  loadPromise = promise
  return promise
}

// 数据预热：应用空闲时预拉已装清单 + 市场目录，首次打开技能页直接命中缓存
// 秒渲染（刷新按钮仍强制重拉）。idle 回调避开启动关键路径。
export function scheduleSkillsPrewarm(): void {
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(() => { loadSkillsData().catch(() => { /* 预热失败静默 */ }) }, { timeout: 8000 })
  } else {
    setTimeout(() => { loadSkillsData().catch(() => { /* 预热失败静默 */ }) }, 3000)
  }
}
