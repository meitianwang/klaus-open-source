import type { ProfileActivity, ProfileActivityDay, ProfileActivityModel } from '../../../../contracts/profile'

export type UsageWindow = '7d' | '30d' | '90d' | 'all'
export type UsageGroupBy = 'model' | 'source'
export type TimelineCadence = 'daily' | 'weekly' | 'monthly'

export type ModelBrand =
  | 'claude'
  | 'openai'
  | 'gemini'
  | 'qwen'
  | 'deepseek'
  | 'kimi'
  | 'zhipu'
  | 'minimax'
  | 'xai'
  | 'ark'
  | 'cursor'
  | 'qoder'
  | 'antigravity'
  | 'trae'
  | 'kiro'
  | 'bailian'
  | 'custom'
  | 'other'

interface BrandVisual {
  logo?: string
  shades: readonly [string, string, string]
}

const DAY_MS = 86_400_000

const KNOWN_SOURCE_PREFIXES = new Set([
  'subscription',
  'custom',
  'codex',
  'cursor',
  'qoder',
  'qwenwork',
  'workbuddy',
  'antigravity',
  'trae',
  'kiro',
  'kimi',
  'bailian',
  'minimax',
  'zhipu',
  'ark',
  'deepseek',
])

const BRAND_VISUALS: Record<ModelBrand, BrandVisual> = {
  claude: { logo: 'import-claude-logo.png', shades: ['#d97757', '#e5987d', '#b85b3d'] },
  openai: { logo: 'codex-logo.png', shades: ['#10a37f', '#34bd9a', '#0c7c60'] },
  gemini: { shades: ['#3b82f6', '#60a5fa', '#2563eb'] },
  qwen: { logo: 'qwen-logo.png', shades: ['#6366f1', '#818cf8', '#4f46e5'] },
  deepseek: { logo: 'deepseek-logo.png', shades: ['#0ea5e9', '#38bdf8', '#0284c7'] },
  kimi: { logo: 'kimi-icon-rounded-corner.png', shades: ['#f59e0b', '#fbbf24', '#d97706'] },
  zhipu: { logo: 'zhipu-logo.png', shades: ['#0891b2', '#22d3ee', '#0e7490'] },
  minimax: { logo: 'minimax-logo.svg', shades: ['#ec4899', '#f472b6', '#db2777'] },
  xai: { shades: ['#64748b', '#94a3b8', '#475569'] },
  ark: { logo: 'ark-logo.png', shades: ['#2563eb', '#60a5fa', '#1d4ed8'] },
  antigravity: { logo: 'antigravity-logo.svg', shades: ['#7c3aed', '#a78bfa', '#6d28d9'] },
  cursor: { logo: 'cursor-logo.png', shades: ['#475569', '#64748b', '#334155'] },
  qoder: { logo: 'qoder-logo.png', shades: ['#059669', '#34d399', '#047857'] },
  bailian: { logo: 'bailian-logo.svg', shades: ['#4f46e5', '#818cf8', '#4338ca'] },
  trae: { logo: 'trae-logo.svg', shades: ['#14b8a6', '#2dd4bf', '#0d9488'] },
  kiro: { logo: 'kiro-logo.png', shades: ['#8b5cf6', '#a78bfa', '#7c3aed'] },
  custom: { shades: ['#78716c', '#a8a29e', '#57534e'] },
  other: { shades: ['#94a3b8', '#cbd5e1', '#64748b'] },
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface NormalizedModelIdentity {
  key: string
  label: string
  brand: ModelBrand
  source: string
  logo?: string
  isCustomPlaceholder?: boolean
}

export interface AggregatedUsageRow {
  key: string
  label: string
  brand: ModelBrand
  logo?: string
  color: string
  tokens: number
  share: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  requests: number
  activeDays: number
  peakDayTokens: number
  sources: string[]
  modelCount: number
  days: Map<string, number>
}

export interface TokenComposition {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  totalRequests: number
  cacheShare: number
  inputShare: number
  outputShare: number
}

export interface AggregatedModelUsage {
  window: UsageWindow
  groupBy: UsageGroupBy
  totalTokens: number
  rows: AggregatedUsageRow[]
  composition: TokenComposition
}

export interface TimelineSegment {
  key: string
  label: string
  color: string
  tokens: number
}

export interface TimelineBucket {
  key: string
  startDate: string
  endDate: string
  totalTokens: number
  segments: TimelineSegment[]
}

function titleToken(word: string): string {
  const lower = word.toLowerCase()
  if (lower === 'gpt') return 'GPT'
  if (lower === 'glm') return 'GLM'
  if (lower === 'qwq') return 'QwQ'
  if (lower === 'vl') return 'VL'
  if (lower === 'r1' || lower === 'v2' || lower === 'v3') return lower.toUpperCase()
  if (/^v\d+(\.\d+)*$/i.test(lower)) return 'V' + lower.slice(1)
  if (/^m\d+(\.\d+)*$/i.test(lower)) return 'M' + lower.slice(1)
  if (/^k\d+(\.\d+)*$/i.test(lower)) return 'K' + lower.slice(1)
  if (/^\d+(\.\d+)*b$/i.test(lower)) return lower.toUpperCase()
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function formatTailWords(tail: string | undefined): string {
  if (!tail) return ''
  return tail
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map(titleToken)
    .join(' ')
}

function sourceToBrand(source: string): ModelBrand {
  switch (source) {
    case 'subscription': return 'claude'
    case 'codex': return 'openai'
    case 'cursor': return 'cursor'
    case 'qoder': return 'qoder'
    case 'qwenwork': return 'qwen'
    case 'antigravity': return 'antigravity'
    case 'trae': return 'trae'
    case 'kiro': return 'kiro'
    case 'kimi': return 'kimi'
    case 'bailian': return 'bailian'
    case 'minimax': return 'minimax'
    case 'zhipu': return 'zhipu'
    case 'ark': return 'ark'
    case 'deepseek': return 'deepseek'
    case 'custom': return 'custom'
    default: return 'other'
  }
}

export function brandLogoForSource(source: string): string | undefined {
  if (source === 'qwenwork') return 'qwenwork-logo.png'
  if (source === 'workbuddy') return 'import-workbuddy-logo.svg'
  return BRAND_VISUALS[sourceToBrand(source)]?.logo
}

/** Normalize provider-qualified or effort-suffixed model IDs into stable model families. */
export function normalizeModelIdentity(rawModel: string, rawSource = ''): NormalizedModelIdentity {
  let text = rawModel.trim()
  let extractedSource = rawSource.trim().toLowerCase()

  const colonIndex = text.indexOf(':')
  if (colonIndex > 0) {
    const maybePrefix = text.slice(0, colonIndex).trim().toLowerCase()
    const rest = text.slice(colonIndex + 1).trim()
    if (rest && KNOWN_SOURCE_PREFIXES.has(maybePrefix)) {
      if (!extractedSource) extractedSource = maybePrefix
      text = rest
    }
  }

  // Strip runtime parameter blocks such as "[context=500k,fast=true]@max".
  text = text.replace(/\[[^\]]*\]/g, '').replace(/@[a-z0-9_-]+$/i, '').trim()

  if (!text || UUID_PATTERN.test(text)) {
    const brand = extractedSource ? sourceToBrand(extractedSource) : 'custom'
    return {
      key: 'custom-model',
      label: 'Custom Model',
      brand,
      source: extractedSource || 'custom',
      logo: BRAND_VISUALS[brand].logo,
      isCustomPlaceholder: true,
    }
  }

  let slug = text.toLowerCase().replace(/^aicodemirror-/, 'claude-')

  // Strip snapshot date suffixes (YYYYMMDD, YYMMDD on vendor snapshots, or MMDD on flash/preview builds).
  slug = slug.replace(/-20\d{6}$/, '')
  if (/^(?:doubao|deepseek|kimi|glm|qwen)/.test(slug)) {
    slug = slug.replace(/-\d{6}$/, '').replace(/-(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])$/, '')
  }

  // Strip reasoning-effort suffixes on families where effort is encoded in the model slug.
  if (/^(?:claude|gemini|gpt|o\d|grok)\b/.test(slug)) {
    let previous = ''
    while (previous !== slug) {
      previous = slug
      slug = slug.replace(/-(?:low|medium|high|xhigh|minimal|ultra)$/, '')
      if (/^claude-/.test(slug)) slug = slug.replace(/-(?:max|thinking)$/, '')
    }
  }

  // Claude family (claude-opus-5-5, claude-3-5-sonnet, bare opus/sonnet/haiku)
  const claudeModern = slug.match(/^(?:claude-)?(opus|sonnet|haiku)(?:-(\d+)(?:[-.](\d+))?)?$/)
  if (claudeModern) {
    const tier = titleToken(claudeModern[1])
    const version = claudeModern[2] ? (claudeModern[3] ? `${claudeModern[2]}.${claudeModern[3]}` : claudeModern[2]) : ''
    const key = version ? `claude-${claudeModern[1]}-${version}` : `claude-${claudeModern[1]}`
    return {
      key,
      label: version ? `Claude ${tier} ${version}` : `Claude ${tier}`,
      brand: 'claude',
      source: extractedSource,
      logo: BRAND_VISUALS.claude.logo,
    }
  }
  const claudeLegacy = slug.match(/^claude-(\d+)(?:[-.](\d+))?-(opus|sonnet|haiku)$/)
  if (claudeLegacy) {
    const version = claudeLegacy[2] ? `${claudeLegacy[1]}.${claudeLegacy[2]}` : claudeLegacy[1]
    const tier = titleToken(claudeLegacy[3])
    return {
      key: `claude-${claudeLegacy[3]}-${version}`,
      label: `Claude ${version} ${tier}`,
      brand: 'claude',
      source: extractedSource,
      logo: BRAND_VISUALS.claude.logo,
    }
  }

  // OpenAI GPT and reasoning families
  const gptMatch = slug.match(/^gpt-([0-9]+(?:\.[0-9]+)?)(?:-(.+))?$/)
  if (gptMatch) {
    const tail = formatTailWords(gptMatch[2])
    const key = gptMatch[2] ? `gpt-${gptMatch[1]}-${gptMatch[2]}` : `gpt-${gptMatch[1]}`
    return {
      key,
      label: tail ? `GPT-${gptMatch[1]} ${tail}` : `GPT-${gptMatch[1]}`,
      brand: 'openai',
      source: extractedSource,
      logo: BRAND_VISUALS.openai.logo,
    }
  }
  if (/^o\d+(?:-(?:mini|pro|preview))?$/.test(slug)) {
    return {
      key: slug,
      label: slug,
      brand: 'openai',
      source: extractedSource,
      logo: BRAND_VISUALS.openai.logo,
    }
  }

  // Gemini family
  const geminiMatch = slug.match(/^gemini-([0-9]+(?:\.[0-9]+)?)(?:-(.+))?$/)
  if (geminiMatch) {
    const tail = formatTailWords(geminiMatch[2])
    const key = geminiMatch[2] ? `gemini-${geminiMatch[1]}-${geminiMatch[2]}` : `gemini-${geminiMatch[1]}`
    return {
      key,
      label: tail ? `Gemini ${geminiMatch[1]} ${tail}` : `Gemini ${geminiMatch[1]}`,
      brand: 'gemini',
      source: extractedSource,
    }
  }

  // Qwen / QwQ family
  const qwenMatch = slug.match(/^qwen-?([0-9]+(?:\.[0-9]+)?)?(?:-(.+))?$/)
  if (qwenMatch && (qwenMatch[1] || qwenMatch[2])) {
    const version = qwenMatch[1] || ''
    const tail = formatTailWords(qwenMatch[2])
    const parts = ['Qwen', version, tail].filter(Boolean)
    const keyParts = ['qwen', version, qwenMatch[2] || ''].filter(Boolean)
    return {
      key: keyParts.join('-'),
      label: parts.join(' '),
      brand: 'qwen',
      source: extractedSource,
      logo: BRAND_VISUALS.qwen.logo,
    }
  }
  if (slug.startsWith('qwq')) {
    const rest = formatTailWords(slug.slice(3).replace(/^-/, ''))
    return {
      key: slug,
      label: rest ? `QwQ ${rest}` : 'QwQ',
      brand: 'qwen',
      source: extractedSource,
      logo: BRAND_VISUALS.qwen.logo,
    }
  }

  // DeepSeek family
  if (slug.startsWith('deepseek-')) {
    const rest = slug.slice('deepseek-'.length)
    return {
      key: `deepseek-${rest}`,
      label: `DeepSeek ${formatTailWords(rest)}`,
      brand: 'deepseek',
      source: extractedSource,
      logo: BRAND_VISUALS.deepseek.logo,
    }
  }

  // Kimi / Moonshot family
  const kimiMatch = slug.match(/^(?:kimi-)?(k\d+(?:\.\d+)?(?:-(?:pro|thinking|turbo|preview))?)$/)
  if (kimiMatch || extractedSource === 'kimi' || slug.startsWith('moonshot-')) {
    const core = kimiMatch ? kimiMatch[1] : slug.replace(/^kimi-/, '')
    return {
      key: `kimi-${core}`,
      label: slug.startsWith('moonshot-') ? `Moonshot ${formatTailWords(slug.slice('moonshot-'.length))}` : `Kimi ${formatTailWords(core)}`,
      brand: 'kimi',
      source: extractedSource,
      logo: BRAND_VISUALS.kimi.logo,
    }
  }

  // Zhipu GLM family
  const glmMatch = slug.match(/^glm-([0-9]+(?:\.[0-9]+)?)(?:-(.+))?$/)
  if (glmMatch) {
    const tail = formatTailWords(glmMatch[2])
    return {
      key: slug,
      label: tail ? `GLM-${glmMatch[1]} ${tail}` : `GLM-${glmMatch[1]}`,
      brand: 'zhipu',
      source: extractedSource,
      logo: BRAND_VISUALS.zhipu.logo,
    }
  }

  // MiniMax family
  if (slug.startsWith('minimax-') || slug.startsWith('abab')) {
    const tail = slug.startsWith('minimax-') ? formatTailWords(slug.slice('minimax-'.length)) : slug.toUpperCase()
    return {
      key: slug,
      label: slug.startsWith('minimax-') ? `MiniMax ${tail}` : `MiniMax ${tail}`,
      brand: 'minimax',
      source: extractedSource,
      logo: BRAND_VISUALS.minimax.logo,
    }
  }

  // Grok family
  const grokMatch = slug.match(/^grok-([0-9]+(?:\.[0-9]+)?)(?:-(.+))?$/)
  if (grokMatch) {
    const tail = formatTailWords(grokMatch[2])
    return {
      key: slug,
      label: tail ? `Grok ${grokMatch[1]} ${tail}` : `Grok ${grokMatch[1]}`,
      brand: 'xai',
      source: extractedSource,
    }
  }

  // Doubao / Ark family
  if (slug.startsWith('doubao-')) {
    return {
      key: slug,
      label: `Doubao ${formatTailWords(slug.slice('doubao-'.length))}`,
      brand: 'ark',
      source: extractedSource,
      logo: BRAND_VISUALS.ark.logo,
    }
  }

  const fallbackBrand = extractedSource ? sourceToBrand(extractedSource) : 'other'
  return {
    key: slug,
    label: formatTailWords(slug) || text,
    brand: fallbackBrand,
    source: extractedSource,
    logo: BRAND_VISUALS[fallbackBrand].logo,
  }
}

function utcDayMillis(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
}

function formatUtcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

function windowBounds(now: Date, window: UsageWindow): { start: string | null; end: string } {
  const today = utcDayMillis(now)
  const end = formatUtcDate(today)
  if (window === 'all') return { start: null, end }
  const spanDays = window === '7d' ? 7 : window === '30d' ? 30 : 90
  return { start: formatUtcDate(today - (spanDays - 1) * DAY_MS), end }
}

function filterDays(days: ProfileActivityDay[] | undefined, start: string | null, end: string): Map<string, number> {
  const map = new Map<string, number>()
  if (!days) return map
  for (const entry of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) || !Number.isFinite(entry.tokens) || entry.tokens <= 0) continue
    if (entry.date > end) continue
    if (start !== null && entry.date < start) continue
    map.set(entry.date, (map.get(entry.date) ?? 0) + entry.tokens)
  }
  return map
}

export interface AggregateOptions {
  window: UsageWindow
  groupBy: UsageGroupBy
  sourceLabel?: (source: string) => string
  customModelLabel?: string
  unattributedLabel?: string
}

export function aggregateModelUsage(
  activity: ProfileActivity,
  now: Date,
  options: AggregateOptions,
): AggregatedModelUsage {
  const { start, end } = windowBounds(now, options.window)
  const rawModels: ProfileActivityModel[] = activity.models && activity.models.length > 0
    ? activity.models
    : activity.totalTokens > 0
      ? [{
        model: '__unattributed__',
        tokens: activity.totalTokens,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        requests: 0,
        days: activity.days,
      }]
      : []

  interface MutableGroup {
    key: string
    label: string
    brand: ModelBrand
    logo?: string
    tokens: number
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
    requests: number
    sourceTokens: Map<string, number>
    models: Set<string>
    days: Map<string, number>
  }

  const groups = new Map<string, MutableGroup>()
  let compInput = 0
  let compOutput = 0
  let compCacheRead = 0
  let compCacheWrite = 0
  let compRequests = 0

  for (const item of rawModels) {
    compInput += item.inputTokens
    compOutput += item.outputTokens
    compCacheRead += item.cacheReadTokens
    compCacheWrite += item.cacheWriteTokens
    compRequests += item.requests

    const dayMap = filterDays(item.days, start, end)
    let windowTokens = 0
    for (const value of dayMap.values()) windowTokens += value
    const tokens = options.window === 'all' ? item.tokens : windowTokens
    if (tokens <= 0) continue

    const isUnattributed = item.model === '__unattributed__'
    const normalized = isUnattributed
      ? {
        key: 'unattributed',
        label: options.unattributedLabel || 'All models',
        brand: 'other' as ModelBrand,
        source: '',
      }
      : normalizeModelIdentity(item.model, item.source)

    const sourceKey = normalized.source || (item.source?.trim().toLowerCase() ?? '') || 'other'
    const groupKey = options.groupBy === 'source' ? `source:${sourceKey}` : normalized.key
    const groupBrand = options.groupBy === 'source' ? sourceToBrand(sourceKey) : normalized.brand
    const groupLogo = options.groupBy === 'source'
      ? (brandLogoForSource(sourceKey) ?? BRAND_VISUALS[groupBrand].logo)
      : normalized.logo
    const groupLabel = options.groupBy === 'source'
      ? (options.sourceLabel ? options.sourceLabel(sourceKey) : titleToken(sourceKey))
      : normalized.isCustomPlaceholder && options.customModelLabel
        ? options.customModelLabel
        : normalized.label

    let group = groups.get(groupKey)
    if (!group) {
      group = {
        key: groupKey,
        label: groupLabel,
        brand: groupBrand,
        logo: groupLogo,
        tokens: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        requests: 0,
        sourceTokens: new Map(),
        models: new Set(),
        days: new Map(),
      }
      groups.set(groupKey, group)
    }
    group.tokens += tokens
    group.inputTokens += item.inputTokens
    group.outputTokens += item.outputTokens
    group.cacheReadTokens += item.cacheReadTokens
    group.cacheWriteTokens += item.cacheWriteTokens
    group.requests += item.requests
    if (sourceKey && sourceKey !== 'other') {
      group.sourceTokens.set(sourceKey, (group.sourceTokens.get(sourceKey) ?? 0) + tokens)
    }
    if (!isUnattributed) group.models.add(normalized.key)
    for (const [date, count] of dayMap) {
      group.days.set(date, (group.days.get(date) ?? 0) + count)
    }
  }

  const sorted = [...groups.values()].sort((left, right) => right.tokens - left.tokens || left.label.localeCompare(right.label))
  const rowSum = sorted.reduce((sum, item) => sum + item.tokens, 0)
  const totalTokens = options.window === 'all' ? Math.max(activity.totalTokens, rowSum) : rowSum

  const brandOccurrences = new Map<ModelBrand, number>()
  const rows: AggregatedUsageRow[] = sorted.map(group => {
    const seen = brandOccurrences.get(group.brand) ?? 0
    brandOccurrences.set(group.brand, seen + 1)
    const shades = BRAND_VISUALS[group.brand].shades
    const color = shades[seen % shades.length]
    let peakDayTokens = 0
    for (const count of group.days.values()) {
      if (count > peakDayTokens) peakDayTokens = count
    }
    const sources = [...group.sourceTokens.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([src]) => src)

    return {
      key: group.key,
      label: group.label,
      brand: group.brand,
      logo: group.logo,
      color,
      tokens: group.tokens,
      share: totalTokens > 0 ? group.tokens / totalTokens : 0,
      inputTokens: group.inputTokens,
      outputTokens: group.outputTokens,
      cacheReadTokens: group.cacheReadTokens,
      cacheWriteTokens: group.cacheWriteTokens,
      requests: group.requests,
      activeDays: group.days.size,
      peakDayTokens,
      sources,
      modelCount: group.models.size,
      days: group.days,
    }
  })

  const billedSum = compInput + compOutput + compCacheRead + compCacheWrite
  const effectiveInput = compInput + compCacheWrite
  return {
    window: options.window,
    groupBy: options.groupBy,
    totalTokens,
    rows,
    composition: {
      inputTokens: effectiveInput,
      outputTokens: compOutput,
      cacheReadTokens: compCacheRead,
      cacheWriteTokens: compCacheWrite,
      totalRequests: compRequests,
      cacheShare: billedSum > 0 ? compCacheRead / billedSum : 0,
      inputShare: billedSum > 0 ? effectiveInput / billedSum : 0,
      outputShare: billedSum > 0 ? compOutput / billedSum : 0,
    },
  }
}

export function buildStackedTimeline(
  activity: ProfileActivity,
  rows: AggregatedUsageRow[],
  now: Date,
  cadence: TimelineCadence,
  otherLabel = 'Other',
): TimelineBucket[] {
  const todayMs = utcDayMillis(now)
  const todayStr = formatUtcDate(todayMs)
  const overallDays = filterDays(activity.days, null, todayStr)

  const bucketDefs: Array<{ key: string; startDate: string; endDate: string }> = []
  if (cadence === 'daily') {
    for (let index = 29; index >= 0; index--) {
      const date = formatUtcDate(todayMs - index * DAY_MS)
      bucketDefs.push({ key: date, startDate: date, endDate: date })
    }
  } else if (cadence === 'weekly') {
    const dayOfWeek = new Date(todayMs).getUTCDay()
    const currentWeekStart = todayMs - dayOfWeek * DAY_MS
    for (let index = 15; index >= 0; index--) {
      const weekStart = currentWeekStart - index * 7 * DAY_MS
      const weekEnd = Math.min(todayMs, weekStart + 6 * DAY_MS)
      const startDate = formatUtcDate(weekStart)
      const endDate = formatUtcDate(weekEnd)
      bucketDefs.push({ key: startDate, startDate, endDate })
    }
  } else {
    const year = now.getUTCFullYear()
    const month = now.getUTCMonth()
    for (let index = 11; index >= 0; index--) {
      const startMs = Date.UTC(year, month - index, 1)
      const nextMonthMs = Date.UTC(year, month - index + 1, 1) - DAY_MS
      const endMs = Math.min(todayMs, nextMonthMs)
      const startDate = formatUtcDate(startMs)
      const endDate = formatUtcDate(endMs)
      bucketDefs.push({ key: startDate.slice(0, 7), startDate, endDate })
    }
  }

  const topRows = rows.slice(0, 5)
  const restRows = rows.slice(5)

  const sumRange = (map: Map<string, number>, startDate: string, endDate: string): number => {
    let sum = 0
    for (const [date, tokens] of map) {
      if (date >= startDate && date <= endDate) sum += tokens
    }
    return sum
  }

  return bucketDefs.map(def => {
    const segments: TimelineSegment[] = []
    let attributedSum = 0
    for (const row of topRows) {
      const count = sumRange(row.days, def.startDate, def.endDate)
      if (count > 0) {
        segments.push({ key: row.key, label: row.label, color: row.color, tokens: count })
        attributedSum += count
      }
    }
    let restSum = 0
    for (const row of restRows) {
      restSum += sumRange(row.days, def.startDate, def.endDate)
    }
    const calendarSum = sumRange(overallDays, def.startDate, def.endDate)
    const remainder = Math.max(restSum, calendarSum - attributedSum)
    if (remainder > 0) {
      segments.push({
        key: '__other__',
        label: otherLabel,
        color: BRAND_VISUALS.other.shades[0],
        tokens: remainder,
      })
    }
    const totalTokens = Math.max(calendarSum, attributedSum + remainder)
    return {
      key: def.key,
      startDate: def.startDate,
      endDate: def.endDate,
      totalTokens,
      segments,
    }
  })
}
