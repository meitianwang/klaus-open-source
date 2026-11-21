// Klaus Desktop — i18n (Chinese / English) + 外观主题系统（迁自 js/i18n.js，逻辑原样）。

// 文案字典迁至 src/i18n/messages.ts（Batch 3）：单一来源，js 与 React 共用。
import { I18N } from '../i18n/messages'
import { loadDesktopDistribution } from './distribution'
import { appearanceTypographyProperties, DEFAULT_CODE_FONT_SIZE, DEFAULT_UI_FONT_SIZE } from './typography'

const w = () => window as any

// Platform-aware file-manager labels: macOS calls it "Finder", Windows/Linux
// have no Finder. Patch the reveal/open labels at load time so a mac user sees
// "Finder" and a Windows user sees "资源管理器 / File Explorer" for the same
// action — the underlying IPC reveal handler already maps to the right OS tool.
const IS_MAC_UI = /Mac|iPhone|iPad|iPod/i.test(navigator.platform || '')
if (!IS_MAC_UI) {
  ;(I18N as any).en.project_menu_reveal = 'Show in File Explorer'
  ;(I18N as any).en.memory_reveal = 'Show in File Explorer'
  ;(I18N as any).zh.project_menu_reveal = '在资源管理器中显示'
  ;(I18N as any).zh.memory_reveal = '在资源管理器中显示'
}

w().currentLang = 'en'

export function tt(key: string): string {
  return (I18N as any)[w().currentLang]?.[key] ?? (I18N as any)['en']?.[key] ?? key
}

/**
 * A counted label, with `{count}` substituted.
 *
 * English needs one/two message forms and Chinese needs one, so the plural pair is
 * expressed as two keys rather than as an ICU `{count, plural, ...}` string the
 * dictionary cannot parse — `tt` has no interpolation at all, and a queue row
 * summary is not worth teaching it a whole message-format grammar.
 *
 * The `_one` key is only consulted in languages that inflect for singular; every
 * other language reads the bare key. A missing singular form therefore falls back
 * to the plural text instead of rendering a raw key.
 */
export function ttCount(key: string, count: number): string {
  const lang = w().currentLang
  const dict = (I18N as any)[lang] ?? (I18N as any)['en'] ?? {}
  const safe = Number.isFinite(count) ? count : 0
  const picked = safe === 1 && lang === 'en' ? (dict[`${key}_one`] ?? dict[key]) : dict[key]
  const template: string = picked ?? (I18N as any)['en']?.[key] ?? key
  return template.replace(/\{count\}/g, String(safe))
}

export function applyI18n() {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    const t = tt(el.dataset.i18n!)
    if (t) el.textContent = t
  })
  document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach(el => {
    const t = tt(el.dataset.i18nPlaceholder!)
    if (t) el.placeholder = t
  })
  document.querySelectorAll<HTMLElement>('[data-i18n-title]').forEach(el => {
    const t = tt(el.dataset.i18nTitle!)
    if (t) el.title = t
  })
  document.querySelectorAll<HTMLElement>('[data-i18n-aria-label]').forEach(el => {
    const t = tt(el.dataset.i18nAriaLabel!)
    if (t) el.setAttribute('aria-label', t)
  })
}

export function setLanguage(lang: string) {
  w().currentLang = lang
  applyI18n()
  // Notify JS-rendered UI (custom selects, dynamic lists) to re-resolve their
  // i18n keys. The DOM walk in applyI18n only catches statically-authored
  // [data-i18n] nodes, not items created later via innerHTML.
  window.dispatchEvent(new CustomEvent('klaus:lang-change', { detail: { lang } }))
  if (typeof w().settingsVisible !== 'undefined' && w().settingsVisible && typeof w().loadSettingsTab === 'function' && typeof w().currentSettingsTab === 'string') {
    w().loadSettingsTab(w().currentSettingsTab)
  }
}

type Variant = 'light' | 'dark'
type Hex = string

const KLAUS_DEFAULT_APPEARANCE_THEMES: Record<Variant, any> = {
  dark: {
    accent: '#339cff',
    contrast: 50,
    fonts: { code: null, ui: null },
    ink: '#dfdfdf',
    opaqueWindows: false,
    semanticColors: { diffAdded: '#00a240', diffRemoved: '#e02e2a', skill: '#b06dff' },
    surface: '#181818',
  },
  light: {
    accent: '#339cff',
    contrast: 45,
    fonts: { code: null, ui: null },
    ink: '#1a1c1f',
    opaqueWindows: true,
    semanticColors: { diffAdded: '#00a240', diffRemoved: '#e02e2a', skill: '#751ed9' },
    surface: '#ffffff',
  },
}

const KLAUS_DEFAULT_APPEARANCE_SYNTAX_COLORS: Record<Variant, Record<string, Hex>> = {
  dark: {
    brace: '#999999',
    keyword: '#b06dff',
    number: '#6dcbf4',
    operator: '#6dcbf4',
    property: '#fa994c',
    punctuation: '#999999',
    string: '#85df7b',
    type: '#b06dff',
    variable: '#fa994c',
  },
  light: {
    brace: '#666666',
    keyword: '#751ed9',
    number: '#0071ea',
    operator: '#0071ea',
    property: '#bd5800',
    punctuation: '#666666',
    string: '#008809',
    type: '#751ed9',
    variable: '#bd5800',
  },
}

const KLAUS_HLJS_TOKEN_KEYS = [
  'comment', 'code', 'formula', 'quote', 'doctag', 'keyword', 'metaKeyword',
  'templateTag', 'type', 'variableLanguage', 'title', 'titleClass',
  'titleClassInherited', 'titleFunction', 'name', 'section', 'attr',
  'attribute', 'literal', 'meta', 'number', 'variable', 'selectorAttr',
  'selectorClass', 'selectorId', 'operator', 'punctuation', 'tag', 'regexp',
  'string', 'builtIn', 'symbol', 'property', 'bullet', 'link', 'params',
  'subst', 'strong', 'emphasis',
]

function syntaxTokenColorsFromSyntax(syntax: Record<string, Hex>): Record<string, Hex> {
  return {
    comment: syntax.punctuation,
    code: syntax.punctuation,
    formula: syntax.punctuation,
    quote: syntax.punctuation,
    doctag: syntax.keyword,
    keyword: syntax.keyword,
    metaKeyword: syntax.keyword,
    templateTag: syntax.keyword,
    type: syntax.type,
    variableLanguage: syntax.variable,
    title: syntax.type,
    titleClass: syntax.type,
    titleClassInherited: syntax.type,
    titleFunction: syntax.type,
    name: syntax.type,
    section: syntax.type,
    attr: syntax.property,
    attribute: syntax.property,
    literal: syntax.number,
    meta: syntax.punctuation,
    number: syntax.number,
    variable: syntax.variable,
    selectorAttr: syntax.property,
    selectorClass: syntax.property,
    selectorId: syntax.type,
    operator: syntax.operator,
    punctuation: syntax.punctuation,
    tag: syntax.operator,
    regexp: syntax.string,
    string: syntax.string,
    builtIn: syntax.property,
    symbol: syntax.string,
    property: syntax.property,
    bullet: syntax.string,
    link: syntax.string,
    params: syntax.variable,
    subst: syntax.variable,
    strong: syntax.keyword,
    emphasis: syntax.keyword,
  }
}

let cachedAppearancePreferences: any = null
let systemThemeListenerBound = false

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  if (value == null || value === '') return fallback
  const n = Number(value)
  if (Number.isNaN(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(value.trim())
}

function normalizeHex(value: unknown, fallback: Hex): Hex {
  return isHexColor(value) ? value.trim().toLowerCase() : fallback
}

function normalizeNullableFont(value: unknown): string | null {
  const text = String(value ?? '').trim()
  return text ? text : null
}

function normalizeTokenColors(colors: any, fallback: Record<string, Hex>) {
  const result: Record<string, Hex> = {}
  for (const key of KLAUS_HLJS_TOKEN_KEYS) result[key] = normalizeHex(colors?.[key], fallback[key])
  return result
}

function normalizeAppearanceTheme(theme: any, variant: Variant) {
  const fallback = KLAUS_DEFAULT_APPEARANCE_THEMES[variant] || KLAUS_DEFAULT_APPEARANCE_THEMES.dark
  const syntaxFallback = KLAUS_DEFAULT_APPEARANCE_SYNTAX_COLORS[variant] || KLAUS_DEFAULT_APPEARANCE_SYNTAX_COLORS.dark
  const semantic = theme?.semanticColors || {}
  const syntax = theme?.syntaxColors || {}
  const normalizedSyntax = {
    brace: normalizeHex(syntax.brace, syntaxFallback.brace),
    keyword: normalizeHex(syntax.keyword, syntaxFallback.keyword),
    number: normalizeHex(syntax.number, syntaxFallback.number),
    operator: normalizeHex(syntax.operator, syntaxFallback.operator),
    property: normalizeHex(syntax.property, syntaxFallback.property),
    punctuation: normalizeHex(syntax.punctuation, syntaxFallback.punctuation),
    string: normalizeHex(syntax.string, syntaxFallback.string),
    type: normalizeHex(syntax.type, syntaxFallback.type),
    variable: normalizeHex(syntax.variable, syntaxFallback.variable),
  }
  return {
    accent: normalizeHex(theme?.accent, fallback.accent),
    contrast: clampNumber(theme?.contrast, fallback.contrast, 0, 100),
    codeTokenColors: normalizeTokenColors(theme?.codeTokenColors, syntaxTokenColorsFromSyntax(normalizedSyntax)),
    fonts: {
      code: normalizeNullableFont(theme?.fonts?.code),
      ui: normalizeNullableFont(theme?.fonts?.ui),
    },
    ink: normalizeHex(theme?.ink, fallback.ink),
    opaqueWindows: theme?.opaqueWindows ?? fallback.opaqueWindows,
    semanticColors: {
      diffAdded: normalizeHex(semantic.diffAdded, fallback.semanticColors.diffAdded),
      diffRemoved: normalizeHex(semantic.diffRemoved, fallback.semanticColors.diffRemoved),
      skill: normalizeHex(semantic.skill, fallback.semanticColors.skill),
    },
    surface: normalizeHex(theme?.surface, fallback.surface),
    syntaxColors: normalizedSyntax,
  }
}

function normalizeThemeChoice(theme: unknown): 'light' | 'dark' | 'system' {
  return theme === 'light' || theme === 'dark' || theme === 'system' ? theme : 'system'
}

function getSystemThemeVariant(): Variant {
  try {
    if (window.matchMedia?.('(prefers-color-scheme: dark)')?.matches) return 'dark'
  } catch {}
  return 'light'
}

function resolveThemeVariant(themeChoice: unknown): Variant {
  const choice = normalizeThemeChoice(themeChoice)
  return choice === 'system' ? getSystemThemeVariant() : choice
}

function hexToRgb(hex: string) {
  const clean = hex.replace('#', '')
  return {
    r: Number.parseInt(clean.slice(0, 2), 16),
    g: Number.parseInt(clean.slice(2, 4), 16),
    b: Number.parseInt(clean.slice(4, 6), 16),
  }
}

function toHexChannel(value: number) {
  return Math.round(value).toString(16).padStart(2, '0')
}

function mixHex(from: string, to: string, amount: number) {
  const a = hexToRgb(from)
  const b = hexToRgb(to)
  const t = Math.min(1, Math.max(0, amount))
  return `#${toHexChannel(a.r + (b.r - a.r) * t)}${toHexChannel(a.g + (b.g - a.g) * t)}${toHexChannel(a.b + (b.b - a.b) * t)}`
}

function relativeLuminance(hex: string) {
  const { r, g, b } = hexToRgb(hex)
  const convert = (channel: number) => {
    const value = channel / 255
    return value <= 0.03928 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * convert(r) + 0.7152 * convert(g) + 0.0722 * convert(b)
}

function contrastRatio(a: string, b: string) {
  const light = Math.max(relativeLuminance(a), relativeLuminance(b))
  const dark = Math.min(relativeLuminance(a), relativeLuminance(b))
  return (light + 0.05) / (dark + 0.05)
}

// Label colour for a filled surface (accent / danger buttons, checked checkbox).
// White is the product's default on a filled surface; dark text is only correct
// when the fill is light enough that white becomes unreadable. Comparing the two
// WCAG ratios head-to-head does NOT express that: the two curves cross at
// luminance ~0.179, so any mid-tone saturated fill lands on the wrong side by a
// hair. The destructive red #e02e2a scores 4.571 against white and 4.594 against
// black — black won by 0.023 and every danger button in the product rendered
// black-on-red. So: take white whenever it still clears AA (4.5), and only fall
// back to the higher-contrast option when white genuinely fails.
// Contrast curve shared by accent-derived text colours: linear up to the
// palette's default contrast, then steepened so raising contrast above the
// default visibly separates accent text from the surface.
function appearanceAccentContrast(themeContrast: number, variant: Variant) {
  const anchor = KLAUS_DEFAULT_APPEARANCE_THEMES[variant].contrast
  const base = anchor / 100
  const linear = themeContrast / 100 + (themeContrast - anchor) / 60 * 0.7
  return themeContrast <= anchor ? linear : base + (linear - base) * 2
}

// Accent used as a text colour (links and other inline accent text). On light
// surfaces the accent is already legible; on dark surfaces it is lifted toward
// white in proportion to the contrast setting.
function appearanceTextAccent(theme: any, variant: Variant) {
  if (variant === 'light') return theme.accent
  return mixHex(theme.accent, '#ffffff', 0.3 + 0.15 * appearanceAccentContrast(theme.contrast, variant))
}

function readableTextOn(background: string) {
  const onWhite = contrastRatio(background, '#ffffff')
  if (onWhite >= 4.5) return '#ffffff'
  return onWhite >= contrastRatio(background, '#000000') ? '#ffffff' : '#000000'
}

function appearanceSurfaceUnderColor(theme: any, variant: Variant) {
  const defaultContrast = variant === 'light'
    ? KLAUS_DEFAULT_APPEARANCE_THEMES.light.contrast
    : KLAUS_DEFAULT_APPEARANCE_THEMES.dark.contrast
  const baseAmount = variant === 'light' ? 0.04 : 0.16
  const contrastStep = variant === 'light' ? 0.0012 : 0.0015
  const amount = baseAmount + (theme.contrast - defaultContrast) * contrastStep
  return variant === 'light'
    ? mixHex(theme.surface, theme.ink, amount)
    : mixHex(theme.surface, '#000000', amount)
}

function rgbaFromHex(hex: string, alpha: number) {
  const c = hexToRgb(hex)
  const a = Math.min(1, Math.max(0, alpha)).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${a})`
}

function setRootProperties(root: HTMLElement, values: Record<string, string>) {
  for (const [key, value] of Object.entries(values)) root.style.setProperty(key, value)
}

function kebabTokenName(name: string) {
  return name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
}

function applyAppearanceThemeTokens(theme: any, variant: Variant) {
  const root = document.documentElement
  const contrast = theme.contrast / 100
  const surfaceUnder = appearanceSurfaceUnderColor(theme, variant)
  const panel = variant === 'dark'
    ? mixHex(theme.surface, '#000000', 0.12 + contrast * 0.10)
    : mixHex(theme.surface, theme.ink, 0.035 + contrast * 0.02)
  const elevated = variant === 'dark'
    ? mixHex(theme.surface, theme.ink, 0.045 + contrast * 0.045)
    : mixHex(theme.surface, theme.ink, 0.018 + contrast * 0.025)
  const hover = rgbaFromHex(theme.ink, variant === 'dark' ? 0.035 + contrast * 0.04 : 0.03 + contrast * 0.035)
  const border = rgbaFromHex(theme.ink, 0.055 + contrast * 0.04)
  const borderSubtle = rgbaFromHex(theme.ink, 0.03 + contrast * 0.025)
  const defaultTheme = KLAUS_DEFAULT_APPEARANCE_THEMES[variant]
  const neutralText = theme.ink === defaultTheme.ink && theme.surface === defaultTheme.surface
  // Neutral desktop text has separate primary and secondary ink: dark body
  // copy uses gray-150 while the secondary ramp is derived from white.
  const secondaryInk = neutralText && variant === 'dark' ? '#ffffff' : theme.ink
  const fgSecondary = rgbaFromHex(secondaryInk, neutralText ? 0.7 : variant === 'dark' ? 0.65 + contrast * 0.1 : 0.62 + contrast * 0.1)
  const fgTertiary = rgbaFromHex(secondaryInk, neutralText ? 0.5 : variant === 'dark' ? 0.42 + contrast * 0.13 : 0.42 + contrast * 0.1)
  const fgQuaternary = rgbaFromHex(secondaryInk, neutralText ? 0.35 : 0.26 + contrast * 0.09)
  const previewRemovedBg = rgbaFromHex(theme.semanticColors.diffRemoved, variant === 'dark' ? 0.23 + contrast * 0.08 : 0.14 + contrast * 0.07)
  const previewAddedBg = rgbaFromHex(theme.semanticColors.diffAdded, variant === 'dark' ? 0.2 + contrast * 0.08 : 0.12 + contrast * 0.07)
  const syntax = theme.syntaxColors || KLAUS_DEFAULT_APPEARANCE_SYNTAX_COLORS[variant] || KLAUS_DEFAULT_APPEARANCE_SYNTAX_COLORS.dark
  const tokenFallbacks = syntaxTokenColorsFromSyntax(syntax)
  const codeTokens = theme.codeTokenColors || tokenFallbacks
  const tokenColor = (name: string, fallback: string = tokenFallbacks[name]) => normalizeHex(codeTokens[name], fallback)
  const codeTokenProperties: Record<string, string> = {}
  for (const name of KLAUS_HLJS_TOKEN_KEYS) {
    codeTokenProperties[`--syntax-hljs-${kebabTokenName(name)}`] = tokenColor(name)
  }
  // The theme accent is a hue for text, focus and tints. Solid primary
  // controls are filled with the body ink instead, so a coloured accent never
  // turns every primary button into a coloured block. The neutral dark palette
  // keeps its pure white fill, matching its secondary ink above.
  const primarySolid = neutralText && variant === 'dark' ? '#ffffff' : theme.ink
  const accentText = readableTextOn(primarySolid)
  const accentHover = mixHex(primarySolid, accentText === '#ffffff' ? '#000000' : '#ffffff', 0.14)
  const textAccent = appearanceTextAccent(theme, variant)
  const codeBg = variant === 'dark'
    ? mixHex(theme.surface, theme.ink, 0.06 + contrast * 0.03)
    : mixHex(theme.surface, theme.ink, 0.035 + contrast * 0.025)
  // 这三个只喂给终端 ANSI 调色板与 diff/语法呈现——它们属于代码主题域。
  // 状态语义色（--status-ok/attn/error/busy 以及 --success/--warning/--danger/
  // --info/--error-* 这些别名）刻意不在这里写：状态色是固定语义，定值在
  // css/styles.css 的 status feedback scale 块里。曾经把 --success←diffAdded、
  // --warning←syntax.number、--danger←diffRemoved 派生出来，结果换代码主题会把
  // 「待授权」染成蓝/绿、「已连接」染成灰黑，甚至与「失败」撞成同色。
  const success = theme.semanticColors.diffAdded
  const danger = theme.semanticColors.diffRemoved
  const warning = tokenColor('number', syntax.number || syntax.operator || theme.accent)
  const semanticBgAlpha = variant === 'dark' ? 0.14 + contrast * 0.08 : 0.09 + contrast * 0.06

  setRootProperties(root, {
    '--bg': theme.surface,
    '--bg-under': surfaceUnder,
    '--bg-window-translucent': rgbaFromHex(theme.surface, 0.55),
    '--bg-surface': panel,
    '--bg-elevated': elevated,
    '--bg-hover': hover,
    '--border': border,
    '--border-subtle': borderSubtle,
    '--input-bg': elevated,
    '--input-border': rgbaFromHex(theme.ink, 0.08 + contrast * 0.05),
    '--input-focus': theme.accent,
    '--fg': theme.ink,
    '--fg-secondary': fgSecondary,
    '--fg-tertiary': fgTertiary,
    '--fg-quaternary': fgQuaternary,
    '--accent': primarySolid,
    '--accent-text': accentText,
    '--text-accent': textAccent,
    '--accent-hover': accentHover,
    '--code-bg': codeBg,
    '--bg-code': codeBg,
    '--msg-user-bg': rgbaFromHex(theme.ink, variant === 'dark' ? 0.035 + contrast * 0.035 : 0.035 + contrast * 0.025),
    '--theme-accent': theme.accent,
    '--theme-accent-bg': rgbaFromHex(theme.accent, semanticBgAlpha),
    '--theme-diff-added': theme.semanticColors.diffAdded,
    '--theme-diff-removed': theme.semanticColors.diffRemoved,
    '--theme-diff-added-bg': previewAddedBg,
    '--theme-diff-removed-bg': previewRemovedBg,
    '--theme-skill': theme.semanticColors.skill,
    '--syntax-brace': syntax.brace,
    '--syntax-keyword': tokenColor('keyword', syntax.keyword),
    '--syntax-number': tokenColor('number', syntax.number),
    '--syntax-operator': tokenColor('operator', syntax.operator),
    '--syntax-property': tokenColor('property', syntax.property),
    '--syntax-punctuation': tokenColor('punctuation', syntax.punctuation),
    '--syntax-string': tokenColor('string', syntax.string),
    '--syntax-type': tokenColor('type', syntax.type),
    '--syntax-variable': tokenColor('variable', syntax.variable),
    '--workspace-token-keyword': tokenColor('keyword', syntax.keyword),
    '--workspace-token-entity': tokenColor('title', syntax.type),
    '--workspace-token-string': tokenColor('string', syntax.string),
    '--workspace-token-number': tokenColor('number', syntax.number),
    '--workspace-token-comment': tokenColor('comment', fgTertiary),
    '--workspace-token-meta': tokenColor('meta', syntax.punctuation),
    '--workspace-token-invalid': danger,
    ...codeTokenProperties,
    '--terminal-background': theme.surface,
    '--terminal-foreground': theme.ink,
    '--terminal-cursor': theme.ink,
    '--terminal-cursor-accent': theme.surface,
    '--terminal-selection': rgbaFromHex(theme.ink, variant === 'dark' ? 0.18 : 0.14),
    '--terminal-ansi-black': variant === 'dark' ? mixHex(theme.surface, '#000000', 0.62) : mixHex(theme.ink, '#000000', 0.18),
    '--terminal-ansi-red': danger,
    '--terminal-ansi-green': success,
    '--terminal-ansi-yellow': warning,
    '--terminal-ansi-blue': tokenColor('operator', syntax.operator || theme.accent),
    '--terminal-ansi-magenta': theme.semanticColors.skill || tokenColor('keyword', syntax.keyword),
    '--terminal-ansi-cyan': tokenColor('type', syntax.type || syntax.operator),
    '--terminal-ansi-white': fgSecondary,
    '--terminal-ansi-bright-black': fgTertiary,
    '--terminal-ansi-bright-red': mixHex(danger, '#ffffff', variant === 'dark' ? 0.18 : 0.08),
    '--terminal-ansi-bright-green': mixHex(success, '#ffffff', variant === 'dark' ? 0.18 : 0.08),
    '--terminal-ansi-bright-yellow': mixHex(warning, '#ffffff', variant === 'dark' ? 0.18 : 0.08),
    '--terminal-ansi-bright-blue': mixHex(tokenColor('operator', syntax.operator || theme.accent), '#ffffff', variant === 'dark' ? 0.18 : 0.08),
    '--terminal-ansi-bright-magenta': mixHex(theme.semanticColors.skill || tokenColor('keyword', syntax.keyword), '#ffffff', variant === 'dark' ? 0.18 : 0.08),
    '--terminal-ansi-bright-cyan': mixHex(tokenColor('type', syntax.type || syntax.operator), '#ffffff', variant === 'dark' ? 0.18 : 0.08),
    '--terminal-ansi-bright-white': theme.ink,
  })
  root.style.setProperty('--font', theme.fonts.ui || "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif")
  root.style.setProperty('--font-mono', theme.fonts.code || "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace")
}

function applyAppearanceScalarPreferences(preferences: any) {
  const root = document.documentElement
  setRootProperties(root, appearanceTypographyProperties(
    clampNumber(preferences.uiFontSize, DEFAULT_UI_FONT_SIZE, 11, 16),
    clampNumber(preferences.codeFontSize, DEFAULT_CODE_FONT_SIZE, 8, 24),
  ))
}

export function applyTheme(theme?: unknown, preferences: any = cachedAppearancePreferences) {
  const themeChoice = normalizeThemeChoice(theme || preferences?.themeChoice)
  const variant = resolveThemeVariant(themeChoice)
  const pref = preferences || {
    themeChoice,
    themes: KLAUS_DEFAULT_APPEARANCE_THEMES,
    uiFontSize: DEFAULT_UI_FONT_SIZE,
    codeFontSize: DEFAULT_CODE_FONT_SIZE,
  }
  const activeTheme = normalizeAppearanceTheme(pref.themes?.[variant], variant)
  cachedAppearancePreferences = { ...pref, themeChoice }
  document.documentElement.setAttribute('data-theme', variant)
  document.documentElement.dataset.themeChoice = themeChoice
  // Opaque windows opt out of the translucent background; `data-theme` already
  // carries the light/dark variant, so only this one needs a class.
  document.documentElement.classList.toggle('app-opaque', activeTheme.opaqueWindows === true)
  applyAppearanceThemeTokens(activeTheme, variant)
  applyAppearanceScalarPreferences(pref)
  // Windows: 让右上角原生窗口控件 overlay 跟随当前主题真实背景色(--bg)。
  // 放在 token 应用之后读取，才能拿到自定义预设/变体的最终颜色。macOS no-op。
  syncTitleBarOverlayToTheme()
  try {
    window.dispatchEvent(new CustomEvent('klaus:theme-change', { detail: { themeChoice, variant } }))
  } catch {}
}

// Windows: 把右上角原生窗口控件 overlay 颜色同步成当前主题真实背景色。
// 读 :root 的 --bg(主题/预设/变体最终值)，按亮度选深/浅符号色，发给主进程。
// macOS/Linux：preload 的 setTitleBarColors 是 win32-only，no-op。失败忽略。
function syncTitleBarOverlayToTheme() {
  try {
    const setColors = w().klaus?.window?.setTitleBarColors
    if (typeof setColors !== 'function') return
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim()
    const rgb = parseCssColorToRgb(raw)
    if (!rgb) return
    // 相对亮度(感知加权)：亮底用深符号，暗底用浅符号。
    const lum = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255
    const symbolColor = lum > 0.5 ? '#333333' : '#cccccc'
    const hex = '#' + [rgb.r, rgb.g, rgb.b].map(n => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')).join('')
    setColors(hex, symbolColor)
  } catch {}
}

// 解析 '#rgb' / '#rrggbb' / 'rgb(r,g,b)' / 'rgba(r,g,b,a)' 成 {r,g,b}。
function parseCssColorToRgb(input: string): { r: number; g: number; b: number } | null {
  if (!input) return null
  const s = String(input).trim()
  if (s[0] === '#') {
    let hex = s.slice(1)
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('')
    if (hex.length < 6) return null
    const r = Number.parseInt(hex.slice(0, 2), 16)
    const g = Number.parseInt(hex.slice(2, 4), 16)
    const b = Number.parseInt(hex.slice(4, 6), 16)
    if ([r, g, b].some(Number.isNaN)) return null
    return { r, g, b }
  }
  const m = s.match(/rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i)
  if (m) return { r: Math.round(+m[1]), g: Math.round(+m[2]), b: Math.round(+m[3]) }
  return null
}

async function readAppearancePreferences() {
  const kv = w().klaus?.settings?.kv
  const themeChoice = normalizeThemeChoice(await kv?.get('theme'))
  const [uiFontRaw, codeFontRaw] = await Promise.all([
    kv?.get('appearance.ui_font_size'),
    kv?.get('appearance.code_font_size'),
  ])
  return {
    themeChoice,
    themes: {
      light: normalizeAppearanceTheme(KLAUS_DEFAULT_APPEARANCE_THEMES.light, 'light'),
      dark: normalizeAppearanceTheme(KLAUS_DEFAULT_APPEARANCE_THEMES.dark, 'dark'),
    },
    uiFontSize: clampNumber(uiFontRaw, DEFAULT_UI_FONT_SIZE, 11, 16),
    codeFontSize: clampNumber(codeFontRaw, DEFAULT_CODE_FONT_SIZE, 8, 24),
  }
}

// Appearance is edited from the sidebar user menu, so the read/apply/persist
// cycle lives next to the preference cache instead of inside a settings panel.
const KLAUS_APPEARANCE_FONT_FIELDS: Record<string, { key: string; min: number; max: number; fallback: number }> = {
  uiFontSize: { key: 'appearance.ui_font_size', min: 11, max: 16, fallback: DEFAULT_UI_FONT_SIZE },
  codeFontSize: { key: 'appearance.code_font_size', min: 8, max: 24, fallback: DEFAULT_CODE_FONT_SIZE },
}

async function ensureAppearancePreferences() {
  if (!cachedAppearancePreferences) cachedAppearancePreferences = await readAppearancePreferences()
  return cachedAppearancePreferences
}

async function persistAppearancePreference(key: string, value: string) {
  try {
    await w().klaus?.settings?.kv?.set(key, value)
  } catch (err) {
    console.warn('[Appearance] failed to persist', key, err)
  }
}

async function setAppearanceThemeChoice(choice: unknown) {
  const themeChoice = normalizeThemeChoice(choice)
  const pref = await ensureAppearancePreferences()
  cachedAppearancePreferences = { ...pref, themeChoice }
  applyTheme(themeChoice, cachedAppearancePreferences)
  await persistAppearancePreference('theme', themeChoice)
}

async function setAppearanceFontSize(field: string, value: unknown) {
  const spec = KLAUS_APPEARANCE_FONT_FIELDS[field]
  if (!spec) return
  const pref = await ensureAppearancePreferences()
  const next = clampNumber(value, pref[field] ?? spec.fallback, spec.min, spec.max)
  if (next === pref[field]) return
  cachedAppearancePreferences = { ...pref, [field]: next }
  applyTheme(cachedAppearancePreferences.themeChoice, cachedAppearancePreferences)
  await persistAppearancePreference(spec.key, String(next))
}

function bindSystemThemeListener() {
  if (systemThemeListenerBound) return
  systemThemeListenerBound = true
  try {
    const listener = () => {
      if (document.documentElement.dataset.themeChoice === 'system') applyTheme('system')
    }
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (media?.addEventListener) media.addEventListener('change', listener)
    else if ((media as any)?.addListener) (media as any).addListener(listener)
  } catch {}
}

async function loadPreferences() {
  const distribution = await loadDesktopDistribution()
  try {
    const lang = await w().klaus.settings.kv.get('language')
    // Route through setLanguage so the klaus:lang-change event fires —
    // klsSelect instances bound during script eval (before prefs load) keep
    // their English default labels otherwise (e.g. the cron status filter).
    if (lang) setLanguage(lang)
    else if (distribution.defaultLanguage) setLanguage(distribution.defaultLanguage)
    else setLanguage(/^zh(?:[-_]|$)/i.test(navigator.language) ? 'zh' : 'en')
    cachedAppearancePreferences = await readAppearancePreferences()
    applyTheme(cachedAppearancePreferences.themeChoice, cachedAppearancePreferences)
    bindSystemThemeListener()
  } catch {}
}

// classic-script 时代的跨文件全局面；chat.js / React 侧 / bridge 仍经 window 消费。
w().tt = tt
w().applyI18n = applyI18n
w().setLanguage = setLanguage
w().getLang = () => w().currentLang
w().applyTheme = applyTheme
w().loadPreferences = loadPreferences
w().ensureAppearancePreferences = ensureAppearancePreferences
w().setAppearanceThemeChoice = setAppearanceThemeChoice
w().setAppearanceFontSize = setAppearanceFontSize
w().KLAUS_APPEARANCE_FONT_FIELDS = KLAUS_APPEARANCE_FONT_FIELDS

// A setting written from OUTSIDE this window — the agent, via klaus_action — has
// no widget behind it to keep the screen current. Appearance and language are
// read once at boot (below), and a settings panel reads its rows when its tab
// opens; every setter in this file applies its own change locally before saving,
// which is exactly what an external write cannot do. Without this the change is
// real in the store and invisible on screen, which reads as "the agent said it
// changed the theme and nothing happened". So re-read the same way boot does.
// Registered in both windows that load this module, because the artifact preview
// window has its own copy of the theme.
try {
  w().klaus?.on?.appPreferencesChanged?.((payload?: { key?: string }) => {
    // The browser page owns plugin enablement through its snapshot subscription
    // and pending edits. Reapplying preferences here would remount that page
    // twice, discarding its live controls before the mutation settles.
    if (payload?.key === 'plugins' && w().settingsVisible && w().currentSettingsTab === 'browser') return
    Promise.resolve(loadPreferences()).then(() => {
      // loadPreferences covers appearance and language. This covers every other
      // row: a settings tab that is open right now is showing what it read when
      // it opened. Same guard as the language switch above.
      if (typeof w().settingsVisible !== 'undefined' && w().settingsVisible && typeof w().loadSettingsTab === 'function' && typeof w().currentSettingsTab === 'string' && w().currentSettingsTab !== 'runtime') {
        w().loadSettingsTab(w().currentSettingsTab)
      }
    }).catch(() => {})
  })
} catch {}

loadPreferences()
