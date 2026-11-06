// Klaus Desktop — i18n (Chinese / English) + 外观主题系统（迁自 js/i18n.js，逻辑原样）。

// 文案字典迁至 src/i18n/messages.ts（Batch 3）：单一来源，js 与 React 共用。
import { I18N } from '../i18n/messages'
import { loadDesktopDistribution } from './distribution'
// 代码主题 token 色表（Batch 4 S1 已 TS 化）：从模块直接取，window 挂接仍在。
import { KLAUS_APPEARANCE_CODE_THEME_TOKEN_COLORS } from './code-token-themes'
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
    accent: '#ffffff',
    contrast: 50,
    fonts: { code: null, ui: null },
    ink: '#dfdfdf',
    opaqueWindows: false,
    semanticColors: { diffAdded: '#00a240', diffRemoved: '#e02e2a', skill: '#b06dff' },
    surface: '#181818',
  },
  light: {
    accent: '#1a1c1f',
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

const KLAUS_APPEARANCE_CODE_THEME_SYNTAX: Record<Variant, Record<string, Record<string, Hex>>> = {
  light: {
    absolutely: { keyword: '#ff5f38', variable: '#2d2d2b', type: '#bc7559', operator: '#ff5f38', property: '#bc7559', string: '#00c853', number: '#ff5f38', punctuation: '#2d2d2b', brace: '#2d2d2b' },
    catppuccin: { keyword: '#8839ef', variable: '#4c4f69', type: '#df8e1d', operator: '#179299', property: '#4c4f69', string: '#40a02b', number: '#fe640b', punctuation: '#179299', brace: '#7c7f93' },
    codex: { keyword: '#d53538', variable: '#bd5800', type: '#d53538', operator: '#d53538', property: '#bd5800', string: '#008809', number: '#0071ea', punctuation: '#666666', brace: '#666666' },
    everforest: { keyword: '#3a94c5', variable: '#5c6a72', type: '#3a94c5', operator: '#f57d26', property: '#5c6a72', string: '#dfa000', number: '#df69ba', punctuation: '#5c6a72', brace: '#5c6a72' },
    github: { keyword: '#cf222e', variable: '#1f2328', type: '#953800', operator: '#cf222e', property: '#1f2328', string: '#0a3069', number: '#0550ae', punctuation: '#1f2328', brace: '#1f2328' },
    gruvbox: { keyword: '#af3a03', variable: '#076678', type: '#b57614', operator: '#427b58', property: '#076678', string: '#79740e', number: '#8f3f71', punctuation: '#7c6f64', brace: '#7c6f64' },
    'klaus-default': { keyword: '#751ed9', variable: '#bd5800', type: '#751ed9', operator: '#0071ea', property: '#bd5800', string: '#008809', number: '#0071ea', punctuation: '#666666', brace: '#666666' },
    linear: { keyword: '#5e6ad2', variable: '#2a3140', type: '#4380d8', operator: '#6f7788', property: '#2a3140', string: '#0f8f83', number: '#b4831f', punctuation: '#6f7788', brace: '#6f7788' },
    notion: { keyword: '#0000ff', variable: '#37352f', type: '#267f99', operator: '#37352f', property: '#37352f', string: '#a31515', number: '#098658', punctuation: '#37352f', brace: '#37352f' },
    one: { keyword: '#a626a4', variable: '#e45649', type: '#c18401', operator: '#0184bc', property: '#e45649', string: '#50a14f', number: '#986801', punctuation: '#383a42', brace: '#383a42' },
    proof: { keyword: '#5f6ac2', variable: '#2f312d', type: '#5f6ac2', operator: '#7a766d', property: '#2f312d', string: '#3d755d', number: '#d3b45b', punctuation: '#7a766d', brace: '#7a766d' },
    raycast: { keyword: '#666666', variable: '#000000', type: '#c75d07', operator: '#666666', property: '#000000', string: '#c03030', number: '#000000', punctuation: '#666666', brace: '#666666' },
    'rose-pine': { keyword: '#286983', variable: '#575279', type: '#56949f', operator: '#286983', property: '#575279', string: '#ea9d34', number: '#d7827e', punctuation: '#797593', brace: '#797593' },
    solarized: { keyword: '#586e75', variable: '#268bd2', type: '#cb4b16', operator: '#859900', property: '#268bd2', string: '#2aa198', number: '#d33682', punctuation: '#657b83', brace: '#657b83' },
    vercel: { keyword: '#006aff', variable: '#171717', type: '#0059d1', operator: '#666666', property: '#171717', string: '#28a948', number: '#a100f8', punctuation: '#666666', brace: '#666666' },
    'vscode-plus': { keyword: '#0000ff', variable: '#001080', type: '#267f99', operator: '#000000', property: '#001080', string: '#a31515', number: '#098658', punctuation: '#000000', brace: '#000000' },
    xcode: { keyword: '#9b2393', variable: '#326d74', type: '#0b4f79', operator: '#9b2393', property: '#326d74', string: '#c41a16', number: '#1c00cf', punctuation: '#000000', brace: '#000000' },
  },
  dark: {
    absolutely: { keyword: '#ff5f38', variable: '#f9f9f7', type: '#d28e73', operator: '#ff5f38', property: '#d28e73', string: '#00c853', number: '#ff5f38', punctuation: '#f9f9f7', brace: '#f9f9f7' },
    ayu: { keyword: '#ff8f40', variable: '#bfbdb6', type: '#59c2ff', operator: '#f29668', property: '#bfbdb6', string: '#aad94c', number: '#d2a6ff', punctuation: '#bfbdb6', brace: '#bfbdb6' },
    catppuccin: { keyword: '#cba6f7', variable: '#cdd6f4', type: '#f9e2af', operator: '#94e2d5', property: '#cdd6f4', string: '#a6e3a1', number: '#fab387', punctuation: '#94e2d5', brace: '#9399b2' },
    codex: { keyword: '#f67576', variable: '#fa994c', type: '#f67576', operator: '#f67576', property: '#fa994c', string: '#85df7b', number: '#6dcbf4', punctuation: '#999999', brace: '#999999' },
    dracula: { keyword: '#ff79c6', variable: '#f8f8f2', type: '#8be9fd', operator: '#ff79c6', property: '#f8f8f2', string: '#f1fa8c', number: '#bd93f9', punctuation: '#ff79c6', brace: '#ff79c6' },
    everforest: { keyword: '#7fbbb3', variable: '#d3c6aa', type: '#7fbbb3', operator: '#e69875', property: '#d3c6aa', string: '#dbbc7f', number: '#d699b6', punctuation: '#d3c6aa', brace: '#d3c6aa' },
    github: { keyword: '#ff7b72', variable: '#e6edf3', type: '#ffa657', operator: '#ff7b72', property: '#e6edf3', string: '#a5d6ff', number: '#79c0ff', punctuation: '#e6edf3', brace: '#e6edf3' },
    gruvbox: { keyword: '#fe8019', variable: '#83a598', type: '#fabd2f', operator: '#8ec07c', property: '#83a598', string: '#b8bb26', number: '#d3869b', punctuation: '#a89984', brace: '#a89984' },
    'klaus-default': { keyword: '#b06dff', variable: '#fa994c', type: '#b06dff', operator: '#6dcbf4', property: '#fa994c', string: '#85df7b', number: '#6dcbf4', punctuation: '#999999', brace: '#999999' },
    linear: { keyword: '#8c97ff', variable: '#e6e9ef', type: '#73b7ff', operator: '#b5bccb', property: '#e6e9ef', string: '#7ad9c0', number: '#f5c56a', punctuation: '#b5bccb', brace: '#b5bccb' },
    lobster: { keyword: '#ff5c5c', variable: '#e4e4e7', type: '#3b82f6', operator: '#ff7070', property: '#e4e4e7', string: '#14b8a6', number: '#f59e0b', punctuation: '#a1a1aa', brace: '#71717a' },
    material: { keyword: '#c792ea', variable: '#eeffff', type: '#ffcb6b', operator: '#89ddff', property: '#eeffff', string: '#c3e88d', number: '#f78c6c', punctuation: '#89ddff', brace: '#89ddff' },
    matrix: { keyword: '#1eff5a', variable: '#b8ffca', type: '#3adf6a', operator: '#6bd985', property: '#b8ffca', string: '#7dff95', number: '#55ff7d', punctuation: '#6bd985', brace: '#6bd985' },
    monokai: { keyword: '#66d9ef', variable: '#f8f8f2', type: '#a6e22e', operator: '#f92672', property: '#f8f8f2', string: '#e6db74', number: '#ae81ff', punctuation: '#f8f8f2', brace: '#f8f8f2' },
    'night-owl': { keyword: '#c792ea', variable: '#c5e478', type: '#c5e478', operator: '#c792ea', property: '#baebe2', string: '#ecc48d', number: '#f78c6c', punctuation: '#d6deeb', brace: '#d6deeb' },
    nord: { keyword: '#81a1c1', variable: '#d8dee9', type: '#8fbcbb', operator: '#81a1c1', property: '#d8dee9', string: '#a3be8c', number: '#b48ead', punctuation: '#eceff4', brace: '#eceff4' },
    notion: { keyword: '#569cd6', variable: '#d9d9d8', type: '#4ec9b0', operator: '#d4d4d4', property: '#d9d9d8', string: '#ce9178', number: '#b5cea8', punctuation: '#d4d4d4', brace: '#d4d4d4' },
    one: { keyword: '#c678dd', variable: '#e06c75', type: '#e5c07b', operator: '#56b6c2', property: '#e06c75', string: '#98c379', number: '#d19a66', punctuation: '#abb2bf', brace: '#abb2bf' },
    oscurange: { keyword: '#9099a1', variable: '#e6e6e6', type: '#ffa16c', operator: '#9099a1', property: '#e6e6e6', string: '#e6e6e6', number: '#f9b98c', punctuation: '#5c6974', brace: '#5c6974' },
    raycast: { keyword: '#999999', variable: '#ffffff', type: '#ff9217', operator: '#999999', property: '#ffffff', string: '#ff6363', number: '#ffffff', punctuation: '#999999', brace: '#999999' },
    'rose-pine': { keyword: '#3e8fb0', variable: '#e0def4', type: '#9ccfd8', operator: '#3e8fb0', property: '#e0def4', string: '#f6c177', number: '#ea9a97', punctuation: '#908caa', brace: '#908caa' },
    sentry: { keyword: '#7055f6', variable: '#e6dff9', type: '#c39bff', operator: '#c8bedf', property: '#e6dff9', string: '#8ee6d7', number: '#f4c46a', punctuation: '#c8bedf', brace: '#c8bedf' },
    solarized: { keyword: '#93a1a1', variable: '#268bd2', type: '#cb4b16', operator: '#859900', property: '#268bd2', string: '#2aa198', number: '#d33682', punctuation: '#839496', brace: '#839496' },
    temple: { keyword: '#e4f222', variable: '#c7e6da', type: '#859419', operator: '#788617', property: '#c7e6da', string: '#c7e6da', number: '#e4f222', punctuation: '#4f5e13', brace: '#4f5e13' },
    'tokyo-night': { keyword: '#bb9af7', variable: '#c0caf5', type: '#c0caf5', operator: '#89ddff', property: '#7dcfff', string: '#9ece6a', number: '#ff9e64', punctuation: '#89ddff', brace: '#9abdf5' },
    vercel: { keyword: '#006efe', variable: '#ededed', type: '#52a8ff', operator: '#a1a1a1', property: '#ededed', string: '#00ad3a', number: '#9540d5', punctuation: '#a1a1a1', brace: '#a1a1a1' },
    'vscode-plus': { keyword: '#569cd6', variable: '#9cdcfe', type: '#4ec9b0', operator: '#d4d4d4', property: '#9cdcfe', string: '#ce9178', number: '#b5cea8', punctuation: '#d4d4d4', brace: '#d4d4d4' },
    xcode: { keyword: '#fc5fa3', variable: '#67b7a4', type: '#5dd8ff', operator: '#fc5fa3', property: '#67b7a4', string: '#fc6a5d', number: '#d0bf69', punctuation: '#ffffff', brace: '#ffffff' },
  },
}

const KLAUS_APPEARANCE_CODE_THEME_SEEDS: Record<Variant, Record<string, any>> = {
  light: {
    absolutely: { accent: '#cc7d5e', ink: '#2d2d2b', semanticColors: { diffAdded: '#00c853', diffRemoved: '#ff5f38', skill: '#cc7d5e' }, surface: '#f9f9f7' },
    catppuccin: { accent: '#8839ef', ink: '#4c4f69', semanticColors: { diffAdded: '#40a02b', diffRemoved: '#d20f39', skill: '#8839ef' }, surface: '#eff1f5' },
    codex: { accent: '#0169cc', ink: '#0d0d0d', semanticColors: { diffAdded: '#00a240', diffRemoved: '#e02e2a', skill: '#751ed9' }, surface: '#ffffff' },
    everforest: { accent: '#93b259', ink: '#5c6a72', semanticColors: { diffAdded: '#8da101', diffRemoved: '#f85552', skill: '#df69ba' }, surface: '#fdf6e3' },
    github: { accent: '#0969da', ink: '#1f2328', semanticColors: { diffAdded: '#1a7f37', diffRemoved: '#cf222e', skill: '#8250df' }, surface: '#ffffff' },
    gruvbox: { accent: '#458588', ink: '#3c3836', semanticColors: { diffAdded: '#3c3836', diffRemoved: '#cc241d', skill: '#b16286' }, surface: '#fbf1c7' },
    'klaus-default': { accent: '#1a1c1f', ink: '#1a1c1f', semanticColors: { diffAdded: '#00a240', diffRemoved: '#e02e2a', skill: '#751ed9' }, surface: '#ffffff' },
    linear: { accent: '#5e6ad2', ink: '#1b1b1b', semanticColors: { diffAdded: '#52a450', diffRemoved: '#c94446', skill: '#8160d8' }, surface: '#fcfcfd', fonts: { ui: 'Inter' }, opaqueWindows: true },
    notion: { accent: '#3183d8', ink: '#37352f', semanticColors: { diffAdded: '#008000', diffRemoved: '#a31515', skill: '#0000ff' }, surface: '#ffffff', fonts: { code: null, ui: null }, opaqueWindows: true },
    one: { accent: '#526fff', ink: '#383a42', semanticColors: { diffAdded: '#3bba54', diffRemoved: '#e45649', skill: '#526fff' }, surface: '#fafafa' },
    proof: { accent: '#3d755d', ink: '#2f312d', semanticColors: { diffAdded: '#3d755d', diffRemoved: '#ba2623', skill: '#5f6ac2' }, surface: '#f5f3ed', fonts: { code: null, ui: null }, opaqueWindows: false },
    raycast: { accent: '#ff6363', ink: '#030303', semanticColors: { diffAdded: '#006b4f', diffRemoved: '#b12424', skill: '#9a1b6e' }, surface: '#ffffff', fonts: { code: '"Jetbrains Mono"', ui: 'Inter' }, opaqueWindows: false },
    'rose-pine': { accent: '#d7827e', ink: '#575279', semanticColors: { diffAdded: '#56949f', diffRemoved: '#797593', skill: '#907aa9' }, surface: '#faf4ed' },
    solarized: { accent: '#b58900', ink: '#657b83', semanticColors: { diffAdded: '#859900', diffRemoved: '#dc322f', skill: '#d33682' }, surface: '#fdf6e3' },
    vercel: { accent: '#006aff', ink: '#171717', semanticColors: { diffAdded: '#28A948', diffRemoved: '#EB001D', skill: '#A100F8' }, surface: '#ffffff', contrast: 40, fonts: { code: '"Geist Mono", ui-monospace, "SFMono-Regular"', ui: 'Geist, Inter' }, opaqueWindows: true },
    'vscode-plus': { accent: '#007acc', ink: '#000000', semanticColors: { diffAdded: '#008000', diffRemoved: '#ee0000', skill: '#0000ff' }, surface: '#ffffff' },
    xcode: { accent: '#0e0eff', ink: '#000000d9', semanticColors: { diffAdded: '#00a240', diffRemoved: '#c41a16', skill: '#0e0eff' }, surface: '#ffffff', fonts: { code: '"SFMono-Regular"' } },
  },
  dark: {
    absolutely: { accent: '#cc7d5e', ink: '#f9f9f7', semanticColors: { diffAdded: '#00c853', diffRemoved: '#ff5f38', skill: '#cc7d5e' }, surface: '#2d2d2b' },
    ayu: { accent: '#e6b450', ink: '#bfbdb6', semanticColors: { diffAdded: '#7fd962', diffRemoved: '#ea6c73', skill: '#cda1fa' }, surface: '#0b0e14' },
    catppuccin: { accent: '#cba6f7', ink: '#cdd6f4', semanticColors: { diffAdded: '#a6e3a1', diffRemoved: '#f38ba8', skill: '#cba6f7' }, surface: '#1e1e2e' },
    codex: { accent: '#0169cc', ink: '#fcfcfc', semanticColors: { diffAdded: '#00a240', diffRemoved: '#e02e2a', skill: '#b06dff' }, surface: '#111111' },
    dracula: { accent: '#ff79c6', ink: '#f8f8f2', semanticColors: { diffAdded: '#50fa7b', diffRemoved: '#ff5555', skill: '#ff79c6' }, surface: '#282a36' },
    everforest: { accent: '#a7c080', ink: '#d3c6aa', semanticColors: { diffAdded: '#a7c080', diffRemoved: '#e67e80', skill: '#d699b6' }, surface: '#2d353b' },
    github: { accent: '#1f6feb', ink: '#e6edf3', semanticColors: { diffAdded: '#3fb950', diffRemoved: '#f85149', skill: '#bc8cff' }, surface: '#0d1117' },
    gruvbox: { accent: '#458588', ink: '#ebdbb2', semanticColors: { diffAdded: '#ebdbb2', diffRemoved: '#cc241d', skill: '#b16286' }, surface: '#282828' },
    'klaus-default': { accent: '#ffffff', ink: '#dfdfdf', semanticColors: { diffAdded: '#00a240', diffRemoved: '#e02e2a', skill: '#b06dff' }, surface: '#181818' },
    linear: { accent: '#606acc', ink: '#e3e4e6', semanticColors: { diffAdded: '#69c967', diffRemoved: '#ff7e78', skill: '#c2a1ff' }, surface: '#0f0f11', fonts: { ui: 'Inter' }, opaqueWindows: true },
    lobster: { accent: '#ff5c5c', ink: '#e4e4e7', semanticColors: { diffAdded: '#22c55e', diffRemoved: '#ff5c5c', skill: '#3b82f6' }, surface: '#111827', fonts: { ui: 'Satoshi' } },
    material: { accent: '#80cbc4', ink: '#eeffff', semanticColors: { diffAdded: '#c3e88d', diffRemoved: '#f07178', skill: '#c792ea' }, surface: '#212121' },
    matrix: { accent: '#1eff5a', ink: '#b8ffca', semanticColors: { diffAdded: '#1eff5a', diffRemoved: '#fa423e', skill: '#1eff5a' }, surface: '#040805', fonts: { code: null, ui: 'ui-monospace, "SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace' }, opaqueWindows: true },
    monokai: { accent: '#99947c', ink: '#f8f8f2', semanticColors: { diffAdded: '#86b42b', diffRemoved: '#c4265e', skill: '#8c6bc8' }, surface: '#272822' },
    'night-owl': { accent: '#44596b', ink: '#d6deeb', semanticColors: { diffAdded: '#c5e478', diffRemoved: '#ef5350', skill: '#c792ea' }, surface: '#011627' },
    nord: { accent: '#88c0d0', ink: '#d8dee9', semanticColors: { diffAdded: '#a3be8c', diffRemoved: '#bf616a', skill: '#b48ead' }, surface: '#2e3440' },
    notion: { accent: '#3183d8', ink: '#d9d9d8', semanticColors: { diffAdded: '#4ec9b0', diffRemoved: '#fa423e', skill: '#3183d8' }, surface: '#191919', fonts: { code: null, ui: null }, opaqueWindows: true },
    one: { accent: '#4d78cc', ink: '#abb2bf', semanticColors: { diffAdded: '#8cc265', diffRemoved: '#e05561', skill: '#c162de' }, surface: '#282c34' },
    oscurange: { accent: '#f9b98c', ink: '#e6e6e6', semanticColors: { diffAdded: '#40c977', diffRemoved: '#fa423e', skill: '#479ffa' }, surface: '#0b0b0f' },
    raycast: { accent: '#ff6363', ink: '#fefefe', semanticColors: { diffAdded: '#59d499', diffRemoved: '#ff6363', skill: '#cf2f98' }, surface: '#101010', fonts: { code: '"Jetbrains Mono"', ui: 'Inter' }, opaqueWindows: false },
    'rose-pine': { accent: '#ea9a97', ink: '#e0def4', semanticColors: { diffAdded: '#9ccfd8', diffRemoved: '#908caa', skill: '#c4a7e7' }, surface: '#232136' },
    sentry: { accent: '#7055f6', ink: '#e6dff9', semanticColors: { diffAdded: '#8ee6d7', diffRemoved: '#fa423e', skill: '#7055f6' }, surface: '#2d2935', fonts: { code: null, ui: null } },
    solarized: { accent: '#d30102', ink: '#839496', semanticColors: { diffAdded: '#859900', diffRemoved: '#dc322f', skill: '#d33682' }, surface: '#002b36' },
    temple: { accent: '#e4f222', ink: '#c7e6da', semanticColors: { diffAdded: '#40c977', diffRemoved: '#fa423e', skill: '#e4f222' }, surface: '#02120c' },
    'tokyo-night': { accent: '#3d59a1', ink: '#a9b1d6', semanticColors: { diffAdded: '#449dab', diffRemoved: '#914c54', skill: '#9d7cd8' }, surface: '#1a1b26' },
    vercel: { accent: '#006efe', ink: '#ededed', semanticColors: { diffAdded: '#00AD3A', diffRemoved: '#F13342', skill: '#9540D5' }, surface: '#000000', contrast: 50, fonts: { code: '"Geist Mono", ui-monospace, "SFMono-Regular"', ui: 'Geist, Inter' }, opaqueWindows: true },
    'vscode-plus': { accent: '#007acc', ink: '#d4d4d4', semanticColors: { diffAdded: '#369432', diffRemoved: '#f44747', skill: '#000080' }, surface: '#1e1e1e' },
    xcode: { accent: '#5482ff', ink: '#ffffffd9', semanticColors: { diffAdded: '#67b7a4', diffRemoved: '#fc6a5d', skill: '#5482ff' }, surface: '#1f1f24', fonts: { code: '"SFMono-Medium"' } },
  },
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

function appearanceCodeThemeKey(variant: Variant) {
  return `appearance.${variant}.code_theme_id`
}

function isAppearanceCodeThemeAvailable(id: string, variant: Variant) {
  return !!KLAUS_APPEARANCE_CODE_THEME_SEEDS[variant]?.[id]
}

function appearanceFallbackCodeThemeId(id: unknown, variant: Variant) {
  return isAppearanceCodeThemeAvailable(String(id), variant) ? String(id) : 'klaus-default'
}

function appearanceThemeFromCodeThemeId(id: unknown, variant: Variant) {
  const codeThemeId = appearanceFallbackCodeThemeId(id, variant)
  const seed = KLAUS_APPEARANCE_CODE_THEME_SEEDS[variant]?.[codeThemeId] || {}
  const syntaxColors = KLAUS_APPEARANCE_CODE_THEME_SYNTAX[variant]?.[codeThemeId]
  const codeTokenColors = (KLAUS_APPEARANCE_CODE_THEME_TOKEN_COLORS as any)[variant]?.[codeThemeId]
  return normalizeAppearanceTheme({ ...seed, syntaxColors, codeTokenColors }, variant)
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
  const accentText = readableTextOn(theme.accent)
  const accentHover = mixHex(theme.accent, accentText === '#ffffff' ? '#000000' : '#ffffff', 0.14)
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
    '--accent': theme.accent,
    '--accent-text': accentText,
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
  const [lightCodeThemeRaw, darkCodeThemeRaw, uiFontRaw, codeFontRaw] = await Promise.all([
    kv?.get(appearanceCodeThemeKey('light')),
    kv?.get(appearanceCodeThemeKey('dark')),
    kv?.get('appearance.ui_font_size'),
    kv?.get('appearance.code_font_size'),
  ])
  const codeThemeIds = {
    light: appearanceFallbackCodeThemeId(lightCodeThemeRaw, 'light'),
    dark: appearanceFallbackCodeThemeId(darkCodeThemeRaw, 'dark'),
  }
  return {
    themeChoice,
    codeThemeIds,
    themes: {
      light: appearanceThemeFromCodeThemeId(codeThemeIds.light, 'light'),
      dark: appearanceThemeFromCodeThemeId(codeThemeIds.dark, 'dark'),
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

// Palette display name. Keyed off the theme id with hyphens folded to
// underscores so the i18n dictionary stays a flat key space.
function appearanceThemeName(id: string) {
  const key = `theme_name_${String(id).replace(/-/g, '_')}`
  const name = tt(key)
  return name === key ? String(id) : name
}

// Palettes available for one variant, default first then by display name — a
// variant only offers what it has a seed for, no silent substitution.
function appearanceThemeOptions(variant: Variant) {
  const seeds = KLAUS_APPEARANCE_CODE_THEME_SEEDS[variant] || {}
  const collation = w().currentLang === 'zh' ? 'zh-Hans-CN' : 'en'
  return Object.keys(seeds)
    .map(id => ({ id, name: appearanceThemeName(id), accent: seeds[id].accent, surface: seeds[id].surface }))
    .sort((a, b) => {
      if (a.id === 'klaus-default') return -1
      if (b.id === 'klaus-default') return 1
      return a.name.localeCompare(b.name, collation)
    })
}

async function setAppearanceThemeChoice(choice: unknown) {
  const themeChoice = normalizeThemeChoice(choice)
  const pref = await ensureAppearancePreferences()
  cachedAppearancePreferences = { ...pref, themeChoice }
  applyTheme(themeChoice, cachedAppearancePreferences)
  await persistAppearancePreference('theme', themeChoice)
}

async function setAppearanceCodeTheme(variant: Variant, id: string) {
  const pref = await ensureAppearancePreferences()
  const codeThemeId = appearanceFallbackCodeThemeId(id, variant)
  cachedAppearancePreferences = {
    ...pref,
    codeThemeIds: { ...pref.codeThemeIds, [variant]: codeThemeId },
    themes: { ...pref.themes, [variant]: appearanceThemeFromCodeThemeId(codeThemeId, variant) },
  }
  applyTheme(cachedAppearancePreferences.themeChoice, cachedAppearancePreferences)
  await persistAppearancePreference(appearanceCodeThemeKey(variant), codeThemeId)
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
w().resolveAppearanceVariant = resolveThemeVariant
w().appearanceThemeName = appearanceThemeName
w().appearanceThemeOptions = appearanceThemeOptions
w().setAppearanceThemeChoice = setAppearanceThemeChoice
w().setAppearanceCodeTheme = setAppearanceCodeTheme
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
  w().klaus?.on?.appPreferencesChanged?.(() => {
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
