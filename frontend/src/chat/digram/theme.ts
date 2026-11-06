// digram 的配色与排版规格。
//
// 绘图风格：低饱和、暖中性纸面、细描边、微圆角、无阴影无渐变。不是
// drawio 那套高饱和蓝框（#dae8fc/#6c8ebf）——那套在深色下直接失效。
//
// 两条硬约束决定了这个文件的写法：
//
// 1. **必须算出具体 hex，不能用 CSS 变量或 color-mix。** 渲染产物要被序列化成独立
//    SVG 再喂给 canvas 做 PNG/JPG 导出；脱离文档的 SVG 里 `var(--fg)` 解析不到，
//    `color-mix()` 的支持面也不可靠。所以颜色在 TS 里算完，落成字面量。
// 2. **一个色只写一次基色，其余按规则派生。** 8 个 tone × 4 个 variant × 明暗两套
//    = 64 组填充/描边/文字，手写必然互相不自洽。这里只写 8 个基色 + 一套混色规则。

import type { DocumentTheme, ThemeColor, Tone, Variant } from './types'

/** 一个 tone 解析出来的三件套。`fill: 'none'` 是真的不填。 */
export interface ToneColors {
  fill: string
  stroke: string
  text: string
}

export interface DigramTheme {
  kind: 'light' | 'dark'
  /** 画布底色。`Background: 'transparent'` 时不画，导出保留 alpha。 */
  paper: string
  /** 网格线颜色（极淡，只在编辑时开）。 */
  grid: string
  /** 选中态描边（编辑面用）。 */
  selection: string
  /** 语义色基色表。默认是 BASE；文档级品牌主题（DocumentTheme.palette）合并进来，
   *  resolveTone/resolveEdgeTone/图表都从这里取色，覆盖才能全局生效。 */
  palette: Record<Tone, { light: string; dark: string }>
  fontFamily: string
  /** 正文字号。层名等标题位由节点自己的 fontSize 覆盖。 */
  fontSize: number
  /** 形状默认圆角。对齐仓内「按钮统一微圆角矩形 radius-sm」的取向。 */
  radius: number
  /** 描边宽度。节点与边同一个值，图看起来才是一套线。 */
  strokeWidth: number
  /** 折线拐角的圆角半径。 */
  cornerRadius: number
  /** 折线从锚点先直出的一小段，避免箭头贴着框根出发。 */
  stubLength: number
  /** 箭头长度。 */
  arrowSize: number
}

/** 基色表。浅色一列是「实心态」的颜色，深色一列是同一语义在深底上的对应色。
 *  取的是 Claude 那种去饱和的暖中性 + 低饱和彩色，不是原色。 */
const BASE: Record<Tone, { light: string; dark: string }> = {
  // 暖灰，不是蓝灰：中性块占图面最大，偏蓝会让整张图发冷。
  neutral: { light: '#6b6862', dark: '#a8a49c' },
  // Claude 的赤陶色，作主强调。
  accent: { light: '#c2673f', dark: '#dd8f66' },
  info: { light: '#4a72a8', dark: '#7ea8dc' },
  success: { light: '#3f7a52', dark: '#74b489' },
  warning: { light: '#9a6b1e', dark: '#d5a94f' },
  danger: { light: '#b04a41', dark: '#e08b81' },
  violet: { light: '#6b52a3', dark: '#a992d8' },
  teal: { light: '#3a7a76', dark: '#6fb3ae' },
}

const LIGHT_PAPER = '#ffffff'
const DARK_PAPER = '#1a1c1f'
const LIGHT_INK = '#1a1c1f'
const DARK_INK = '#e8e6e3'

/** `#rrggbb` → [r,g,b]。只接受 6 位十六进制，因为基色表就只有这一种写法。 */
function parseHex(hex: string): [number, number, number] {
  const value = hex.replace('#', '')
  return [
    parseInt(value.slice(0, 2), 16),
    parseInt(value.slice(2, 4), 16),
    parseInt(value.slice(4, 6), 16),
  ]
}

function toHex(channels: [number, number, number]): string {
  return (
    '#'
    + channels
      .map((channel) => Math.max(0, Math.min(255, Math.round(channel))).toString(16).padStart(2, '0'))
      .join('')
  )
}

/** `amount` 份 a 混 `1-amount` 份 b。sRGB 线性混合——够用且可预测，不引色彩空间库。 */
function mix(a: string, b: string, amount: number): string {
  const [ar, ag, ab] = parseHex(a)
  const [br, bg, bb] = parseHex(b)
  return toHex([
    ar * amount + br * (1 - amount),
    ag * amount + bg * (1 - amount),
    ab * amount + bb * (1 - amount),
  ])
}

/** 派生规则表。改这里就是改全图风格，不用逐个 tone 调。 */
const DERIVE: Record<Variant, { fill: number | 'none'; stroke: number | 'none'; solidText: boolean }> = {
  // 淡底 + 同色描边。主力形态。
  soft: { fill: 0.1, stroke: 0.45, solidText: false },
  // 实心。留给必须压场的一两个框。
  solid: { fill: 1, stroke: 1, solidText: true },
  // 纸底 + 描边。层上的组件就是这个。
  outline: { fill: 0, stroke: 0.4, solidText: false },
  // 更淡的底，无描边。
  ghost: { fill: 0.06, stroke: 'none', solidText: false },
}

export function makeTheme(kind: 'light' | 'dark'): DigramTheme {
  return {
    kind,
    paper: kind === 'light' ? LIGHT_PAPER : DARK_PAPER,
    grid: kind === 'light' ? '#f0efec' : '#25282b',
    selection: kind === 'light' ? '#4a72a8' : '#7ea8dc',
    palette: BASE,
    // 与外壳同一套字体栈（css/styles.css 的 --font）：图里的字和界面里的字必须
    // 是同一个形，否则贴进文档看着像两个产品。
    fontFamily:
      "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif",
    fontSize: 14,
    radius: 8,
    strokeWidth: 1.5,
    cornerRadius: 8,
    stubLength: 18,
    arrowSize: 9,
  }
}

/** 解析一个 tone + variant 在当前主题下的三件套。 */
export function resolveTone(theme: DigramTheme, tone: Tone, variant: Variant): ToneColors {
  const base = theme.palette[tone][theme.kind]
  const rule = DERIVE[variant]
  const ink = theme.kind === 'light' ? LIGHT_INK : DARK_INK
  const fill
    = rule.fill === 'none'
      ? 'none'
      : rule.fill === 0
        ? theme.paper
        : mix(base, theme.paper, rule.fill)
  const stroke = rule.stroke === 'none' ? 'none' : mix(base, theme.paper, rule.stroke)
  // 实心块上的字取纸色而不是白：深色主题下纯白会过亮，浅色下纸就是白。
  const text = rule.solidText
    ? theme.paper
    : tone === 'neutral'
      ? ink
      // 有色块里的字用基色本身压深一档：比纯墨色更成套，又比基色本身可读。
      : mix(base, ink, theme.kind === 'light' ? 0.55 : 0.75)
  return { fill, stroke, text }
}

/** 边的颜色。边没有 variant——它就是一条线，只需要一个可读的描边色和标签色。 */
export function resolveEdgeTone(theme: DigramTheme, tone: Tone): { stroke: string; text: string } {
  const base = theme.palette[tone][theme.kind]
  const ink = theme.kind === 'light' ? LIGHT_INK : DARK_INK
  return {
    // 比节点描边深一档：线要能从淡底块上跨过去还看得见。
    stroke: mix(base, theme.paper, tone === 'neutral' ? 0.62 : 0.72),
    text: tone === 'neutral' ? mix(ink, theme.paper, 0.62) : mix(base, ink, 0.6),
  }
}

/** 形状的圆角。节点显式 `radius` 优先；否则按形状给——pill 是半高，rect 是 0，
 *  其余走主题的 radius。这样「rect 和 rounded 有区别」是形状语义而不是作者手调。 */
export function radiusFor(
  theme: DigramTheme,
  shape: string,
  height: number,
  explicit?: number,
): number {
  if (typeof explicit === 'number') return Math.max(0, Math.min(explicit, height / 2))
  if (shape === 'pill') return height / 2
  if (shape === 'rect') return 0
  return theme.radius
}

/** 图表序列色：tone 在当前主题下的基色（品牌覆盖已并入 palette）。 */
export function baseColor(theme: DigramTheme, tone: Tone): string {
  return theme.palette[tone][theme.kind]
}

/** 正文墨色。品牌主题不覆盖它——文字对比度是渲染器的责任，不是品牌的。 */
export function inkColor(theme: DigramTheme): string {
  return theme.kind === 'light' ? LIGHT_INK : DARK_INK
}

/** 混色规则开放给图表渲染器（heatmap 强度渐变等）。 */
export function mixColors(a: string, b: string, amount: number): string {
  return mix(a, b, amount)
}

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

function resolveThemeColor(kind: 'light' | 'dark', value: ThemeColor, fallback: string): string {
  const hex = typeof value === 'string' ? value : value[kind]
  return typeof hex === 'string' && HEX_COLOR.test(hex) ? hex.toLowerCase() : fallback
}

/**
 * 文档级品牌覆盖合并进当前明暗主题。宿主 model.ts 已经校验过 hex 与取值范围，
 * 这里再做一次防御性过滤：手改过的文档文件也不能把非法颜色喂进 parseHex
 * （NaN 会污染整串 SVG），非法值一律落回主题默认。
 */
export function applyDocumentTheme(theme: DigramTheme, override?: DocumentTheme | null): DigramTheme {
  if (!override || typeof override !== 'object') return theme
  let next = theme
  if (override.palette) {
    const palette = { ...theme.palette }
    for (const tone of Object.keys(palette) as Tone[]) {
      const entry = override.palette[tone]
      if (entry === undefined) continue
      const base = palette[tone]!
      palette[tone] = {
        light: resolveThemeColor('light', entry, base.light),
        dark: resolveThemeColor('dark', entry, base.dark),
      }
    }
    next = { ...next, palette }
  }
  if (override.paper !== undefined) next = { ...next, paper: resolveThemeColor(next.kind, override.paper, next.paper) }
  if (typeof override.fontFamily === 'string' && override.fontFamily.length && override.fontFamily.length <= 300) next = { ...next, fontFamily: override.fontFamily }
  if (typeof override.fontSize === 'number' && Number.isFinite(override.fontSize) && override.fontSize >= 6 && override.fontSize <= 48) next = { ...next, fontSize: override.fontSize }
  if (typeof override.radius === 'number' && Number.isFinite(override.radius) && override.radius >= 0 && override.radius <= 64) next = { ...next, radius: override.radius }
  if (typeof override.strokeWidth === 'number' && Number.isFinite(override.strokeWidth) && override.strokeWidth >= 0.25 && override.strokeWidth <= 8) next = { ...next, strokeWidth: override.strokeWidth }
  if (typeof override.cornerRadius === 'number' && Number.isFinite(override.cornerRadius) && override.cornerRadius >= 0 && override.cornerRadius <= 64) next = { ...next, cornerRadius: override.cornerRadius }
  return next
}
