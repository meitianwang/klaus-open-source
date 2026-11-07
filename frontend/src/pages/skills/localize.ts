// 技能/插件市场的本地化与分类 helpers（迁自 js/pages/skills.js）。
// 数据表（SKILL_TEXT_I18N / PLUGIN_* / KLAUS_GLYPH_LIBRARY）仍住 settings.js，
// 经 window 桥消费（随 settings 批次 TS 化）；本模块的函数被 plugins/agents/
// chat 等多处跨文件消费，继续挂 window（见 index.tsx）。
import { fillGlyph24 } from '../../icons/registry'
import styles from './skills.module.css'

const w = () => window as any

export interface SkillItem {
  name?: string
  dirName?: string
  description?: string
  source?: string
  installed?: boolean
  hasUpdate?: boolean
  version?: string
  latestVersion?: string
  upstreamSlug?: string
  userEnabled?: boolean
  userInvocable?: boolean
  tags?: Record<string, unknown>
  /** Server-side catalog icon URL (market listings only). */
  icon?: string
  /** Skill-declared emoji from SKILL.md metadata (any source). */
  emoji?: string
  dependencyStatus?: string
  missingBins?: string[]
  missingEnv?: string[]
  /** Owning folder for workspace-scope rows (a workspace tab spans several). */
  root?: string
  error?: string
}

export function normalizeMarketKey(value: unknown): string {
  return String(value || '').trim().toLowerCase()
}

export function getMarketUiLang(): string {
  if (typeof w().currentLang !== 'undefined') return w().currentLang
  if (typeof w().getLang === 'function') return w().getLang()
  return 'en'
}

function getMarketLangEntry(entry: any): any {
  if (!entry) return null
  return entry[getMarketUiLang()] || entry.en || null
}

function getSkillTextEntry(skill: SkillItem | null | undefined): string[] | null {
  const key = normalizeMarketKey(skill?.dirName || skill?.name)
  return getMarketLangEntry(w().SKILL_TEXT_I18N[key])
}

export function localizeSkillName(skill: SkillItem | null | undefined): string {
  const entry = getSkillTextEntry(skill)
  return entry?.[0] || skill?.name || skill?.dirName || ''
}

export function localizeSkillDescription(skill: SkillItem | null | undefined): string {
  const entry = getSkillTextEntry(skill)
  return entry?.[1] || skill?.description || ''
}

export function getPluginBaseName(plugin: any): string {
  const raw = String(plugin?.id || plugin?.name || '').split('@')[0]
  return normalizeMarketKey(raw || plugin?.name)
}

function titleizePluginName(name: unknown): string {
  return String(name || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, ch => ch.toUpperCase())
}

function inferPluginLspName(key: string): string {
  const normalized = normalizeMarketKey(key).replace(/-lsp$/, '')
  const names = w().PLUGIN_LSP_LANGUAGE_NAMES as Record<string, string>
  const direct = names[normalized]
  if (direct) return `${direct} 语言服务`
  const pair = Object.entries(names).find(([token]) => normalized.includes(token))
  return pair ? `${pair[1]} 语言服务` : ''
}

function titleizePluginNameZh(key: string, rawName: unknown): string {
  if (!key) return titleizePluginName(rawName)
  const tokens = key.split(/[-_\s]+/).filter(Boolean)
  if (!tokens.length) return titleizePluginName(rawName)
  const tokenZh = w().PLUGIN_NAME_TOKEN_ZH as Record<string, string>
  return tokens.map(token => {
    const mapped = tokenZh[token]
    if (mapped) return mapped
    if (/^[a-z]+\d+$/i.test(token)) return token.toUpperCase()
    if (token.length <= 3) return token.toUpperCase()
    return token.charAt(0).toUpperCase() + token.slice(1)
  }).join(' ')
}

export function localizePluginName(plugin: any): string {
  const key = getPluginBaseName(plugin)
  if (getMarketUiLang() === 'en') return w().PLUGIN_NAME_EN_OVERRIDES[key] || plugin?.name || ''
  if (w().PLUGIN_NAME_ZH_OVERRIDES[key]) return w().PLUGIN_NAME_ZH_OVERRIDES[key]
  if (plugin?.hasLsp || key.endsWith('-lsp')) return inferPluginLspName(key) || titleizePluginNameZh(key, plugin?.name)
  return titleizePluginNameZh(key, plugin?.name)
}

/**
 * The label a composer plugin mention shows, plus the extra names it answers to.
 *
 * The @-menu row and the inserted chip show the same localized product name the
 * plugin page shows, because that is the name users actually learn. The raw
 * package slug and the other-language product names stay addressable as search
 * aliases, and the slug rides along as the row's secondary line, so the original
 * name remains visible and typeable everywhere.
 */
export function pluginMentionNames(plugin: any): { display: string; aliases: string[] } {
  const key = getPluginBaseName(plugin)
  const raw = String(plugin?.name || key || '')
  const display = localizePluginName(plugin) || raw
  const tables = [w().PLUGIN_NAME_EN_OVERRIDES, w().PLUGIN_NAME_ZH_OVERRIDES] as Array<Record<string, string> | undefined>
  const overrides = tables.map(table => (table && key ? table[key] : '')).filter(Boolean)
  const candidates = [raw, key, ...overrides, titleizePluginName(raw)]
  const aliases = [...new Set(candidates.filter((value): value is string => !!value && value !== display))]
  return { display, aliases }
}

export function localizePluginBadge(label: string): string {
  const lang = getMarketUiLang()
  const allLabels = w().PLUGIN_BADGE_LABELS as Record<string, Record<string, string>>
  const labels = allLabels[lang] || allLabels.en
  return labels[label] || labels[normalizeMarketKey(label)] || label
}

/**
 * 词表命中判定（插件图标规则与中文简介规则共用）。以字母数字开头的词必须落在
 * 词首才算命中：原来是裸 substring，`built-in` 里的 `ui` 会把内置浏览器插件判成
 * 设计类（图标给调色板、简介给「设计协作插件」），`rapid` 里的 `api`、`build` 里的
 * `ui` 同理——短词在别的单词肚子里出现，跟这条规则想说的事没有任何关系。
 * 词尾刻意不设边界：词表收了派生形（logs / documentation / spreadsheets），掐死
 * 词尾会把这些本该命中的写法全丢掉。非字母数字开头的词（' lsp' / '-lsp' /
 * 'claude.md'）自带分隔符，按原样 substring 比。
 */
function marketTermMatches(text: string, term: string): boolean {
  const needle = String(term || '').toLowerCase()
  if (!needle) return false
  if (!/^[a-z0-9]/.test(needle)) return text.includes(needle)
  for (let from = 0; ;) {
    const at = text.indexOf(needle, from)
    if (at < 0) return false
    if (at === 0 || !/[a-z0-9]/.test(text[at - 1]!)) return true
    from = at + 1
  }
}

export function localizePluginDescription(plugin: any): string {
  if (getMarketUiLang() === 'en') return plugin?.description || ''
  const key = getPluginBaseName(plugin)
  const name = localizePluginName(plugin)
  const overrides = w().PLUGIN_DESCRIPTION_ZH_OVERRIDES as Record<string, string>
  if (overrides[normalizeMarketKey(plugin?.id)]) return overrides[normalizeMarketKey(plugin?.id)]
  if (overrides[key]) return overrides[key]
  const text = `${key} ${plugin?.name || ''} ${plugin?.description || ''} ${plugin?.category || ''} ${(plugin?.badges || []).join(' ')}`.toLowerCase()
  const rules = w().PLUGIN_DESCRIPTION_ZH_RULES as { terms: string[]; text: string | ((n: string) => string) }[]
  const rule = rules.find(item => item.terms.some(term => marketTermMatches(text, term)))
  if (rule) return typeof rule.text === 'function' ? rule.text(name) : rule.text
  const byCategory = w().PLUGIN_DESCRIPTION_ZH_BY_CATEGORY as Record<string, string | ((n: string) => string)>
  const fallback = byCategory[plugin?.category || 'other'] || byCategory.other
  return typeof fallback === 'function' ? fallback(name) : fallback
}

export function sortSkillsByName(skills: SkillItem[]): SkillItem[] {
  return [...skills].sort((a, b) => localizeSkillName(a).localeCompare(localizeSkillName(b)))
}

export function getSkillCategory(skill: SkillItem): string {
  if (skill.tags && typeof skill.tags === 'object') {
    const tagVal = Object.values(skill.tags).find(Boolean)
    if (tagVal) return String(tagVal).toLowerCase()
  }
  return 'other'
}

/** 分类的显示名：走 skills_category_<key> 字典。分类值本身是技能 frontmatter
 *  的原始 tag（`dev` / `docs` / …），远端目录还可能带字典里没有的新分类，那种
 *  只能原样显示——但绝不能因此让已有字典的分类也漏翻成英文。 */
export function skillCategoryLabel(category: string): string {
  return categoryLabel('skills_category_', category)
}

/** 插件分类的显示名：同上，只是字典前缀不同（宿主 normalize_category 归一出的
 *  dev / security / database / monitoring / productivity / design / lsp / other）。 */
export function pluginCategoryLabel(category: string): string {
  return categoryLabel('plugins_category_', category)
}

function categoryLabel(prefix: string, category: string): string {
  const key = `${prefix}${category}`
  const label = w().tt?.(key)
  return !label || label === key ? category : label
}

export function groupSkillsByCategory(skills: SkillItem[]): Map<string, SkillItem[]> {
  const groups = new Map<string, SkillItem[]>()
  sortSkillsByName(skills).forEach(skill => {
    const category = getSkillCategory(skill)
    if (!groups.has(category)) groups.set(category, [])
    groups.get(category)!.push(skill)
  })
  return groups
}

export function getSkillIconName(skill: SkillItem): string {
  const dirName = String(skill.dirName || skill.name || '').toLowerCase()
  if (w().SKILL_ICON_OVERRIDES[dirName]) return w().SKILL_ICON_OVERRIDES[dirName]
  return w().SKILL_ICON_BY_CATEGORY[getSkillCategory(skill)] || 'sparkles'
}

/** Brand tiles for the curated first-party skills (128px PNGs generated into
 *  public/skill-logos/). Code-drawn glyphs read as placeholder art at card
 *  size; this set ships real brand tiles instead. Anything outside the table
 *  keeps the glyph path, so market rows never lose an icon. */
const SKILL_LOGO_BY_DIR: Record<string, string> = {
  'canvas': 'skill-logos/canvas.png',
  'computer-use': 'skill-logos/computer-use.png',
  'cron-manager': 'skill-logos/cron-manager.png',
  'deep-research': 'skill-logos/deep-research.png',
  'frontend-design': 'skill-logos/frontend-design.png',
  'klaus-docs': 'skill-logos/klaus-docs.png',
  'pdf': 'skill-logos/pdf.png',
  'product-feature-video': 'skill-logos/product-feature-video.png',
  'skill-creator': 'skill-logos/skill-creator.png',
  'slash-command-creator': 'skill-logos/slash-command-creator.png',
}

/** Logo source for a skill row/card, or '' when the skill has no brand tile. */
export function getSkillLogoSrc(skill: SkillItem | null | undefined): string {
  return SKILL_LOGO_BY_DIR[normalizeMarketKey(skill?.dirName || skill?.name)] || ''
}

/** Class lists carry the hashed module class (browser build) plus its literal
 *  twin: bun tests import CSS modules as the raw stylesheet string, so the
 *  hashed lookup is undefined there and assertions need the literal name. */
function logoClasses(key: string, literal: string): string {
  return [styles[key], literal].filter(Boolean).join(' ')
}

/** Market-card brand tile: the image is already a finished square tile, so it
 *  replaces the glyph outright; the caller neutralizes the card's brick shell
 *  via MarketCard's iconClassName. */
export function skillLogoImgHtml(src: string): string {
  return `<img class="${logoClasses('sk-logo-img', 'sk-logo-img')}" src="${src}" alt="" draggable="false">`
}

/** Installed-row brand tile: same brick shell as renderLineIcon so the row
 *  rhythm holds, with the brick chrome stepping aside for the logo image. */
export function skillLogoBrickHtml(src: string): string {
  const shell = logoClasses('sk-card-icon', 'sk-card-icon')
  const modifier = logoClasses('sk-card-icon-logo', 'sk-card-icon-logo')
  return `<span class="${shell} ${modifier}" aria-hidden="true"><img src="${src}" alt="" draggable="false"></span>`
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Market-slot tile for a server-side catalog icon URL. The catalog is
 *  server-operated content, so its icon must not cost a client release: the
 *  URL travels with the listing and renders straight into the card slot. */
export function skillRemoteIconHtml(src: string): string {
  return `<img class="${logoClasses('sk-logo-img', 'sk-logo-img')}" src="${escapeHtmlAttribute(src)}" alt="" draggable="false">`
}

/** Brick tile carrying a skill-declared emoji (SKILL.md metadata). Keeps the
 *  brick shell so text-sized art sits in the same rhythm as glyph tiles. */
export function skillEmojiBrickHtml(emoji: string): string {
  const shell = logoClasses('sk-card-icon', 'sk-card-icon')
  const modifier = logoClasses('sk-card-icon-emoji', 'sk-card-icon-emoji')
  return `<span class="${shell} ${modifier}" aria-hidden="true">${escapeHtmlText(emoji)}</span>`
}

/** Bare emoji glyph for the market card slot: the slot is already a brick, so
 *  the emoji rides inside it as text and the slot takes the size modifier via
 *  MarketCard's iconClassName. */
export function skillEmojiGlyphHtml(emoji: string): string {
  return escapeHtmlText(emoji)
}

export type SkillBrandTile =
  | { kind: 'logo'; src: string }
  | { kind: 'icon'; src: string }
  | { kind: 'emoji'; emoji: string }

/** Iconography precedence: shipped brand tiles for built-in skills first
 *  (offline-safe identity), then server-side catalog icons, then the skill's
 *  own emoji declaration. Callers fall back to the code glyph when null. */
export function getSkillBrandTile(skill: SkillItem | null | undefined): SkillBrandTile | null {
  const logo = getSkillLogoSrc(skill)
  if (logo) return { kind: 'logo', src: logo }
  const icon = String(skill?.icon || '').trim()
  if (icon) return { kind: 'icon', src: icon }
  const emoji = String(skill?.emoji || '').trim()
  if (emoji) return { kind: 'emoji', emoji }
  return null
}

export function getPluginIconName(plugin: any): string {
  const text = `${plugin.id || ''} ${plugin.name || ''} ${plugin.description || ''} ${plugin.category || ''} ${(plugin.badges || []).join(' ')}`.toLowerCase()
  const rules = w().PLUGIN_ICON_RULES as { terms: string[]; icon: string }[]
  const rule = rules.find(item => item.terms.some(term => marketTermMatches(text, term)))
  if (rule) return rule.icon
  if (plugin.hasLsp) return 'code'
  return w().PLUGIN_ICON_BY_CATEGORY[plugin.category] || 'package'
}

/** 裸字形（不带图标砖外壳）：市场卡片自带砖体，只需字形。 */
export function skillGlyphSvg(iconName: string): string {
  const body = w().KLAUS_GLYPH_LIBRARY[iconName] || w().KLAUS_GLYPH_LIBRARY.sparkles
  return fillGlyph24(body)
}

/** 图标砖外壳版（行式列表/空态用）。toneVar 传身份色 CSS 变量名时，砖体与字形
 *  按该色着色（agents 页卡片用）；不传保持中性砖。 */
export function renderLineIcon(iconName: string, toneVar?: string): string {
  const tone = toneVar ? ` ${styles['sk-card-icon-toned']}" style="--kls-icon-tone:var(${toneVar})` : ''
  return `<span class="${styles['sk-card-icon']}${tone}" aria-hidden="true">${skillGlyphSvg(iconName)}</span>`
}

/** agent 类型 → 字形名。未归类的 agent 落回 bot（与差异化前一致）。 */
export function getAgentIconName(agentType: unknown): string {
  return (w().AGENT_ICON_BY_TYPE || {})[String(agentType || '').trim().toLowerCase()] || 'bot'
}

/** agent 类型 → 身份色 CSS 变量名。未归类的 agent 返回 null（中性砖）。
 *  亮/暗两档取值由 CSS 里的 --agent-tone-* 变量族持有（对齐 COVER_PALETTE 与
 *  其暗档提亮版），这里只选变量名，不持色值。 */
export function getAgentIconToneVar(agentType: unknown): string | null {
  const tone = (w().AGENT_ICON_TONE || {})[String(agentType || '').trim().toLowerCase()]
  return tone ? `--agent-tone-${tone}` : null
}

export function getSkillSearchValuesLocal(skill: SkillItem): unknown[] {
  // ui-shared.js 的 getSkillSearchValues 是搜索口径唯一来源（window 桥）。
  return w().getSkillSearchValues(skill)
}
