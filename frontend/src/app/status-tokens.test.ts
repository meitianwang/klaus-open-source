// 状态色令牌的验收门（Step 1 的防复发测试）。
//
// 钉三件事，缺一件这个 bug 就会回来：
//  1. 主题引擎不得改写状态色 —— 它曾经把 --success←diffAdded、
//     --warning←syntax.number、--danger←diffRemoved 派生出来，结果 45 个代码
//     主题档里 9 档的「已连接」绿点不是绿的、absolutely 档「待授权」与「失败」
//     同值 #ff5f38、matrix 暗档「待授权」≈「已连接」。
//  2. 四个状态色对卡片底色的对比 ≥ 3:1（WCAG 1.4.11 非文本对比）。
//  3. 四个状态色两两 ΔE ≥ 35 —— 保证换成任意两态并排时肉眼能分。
//
// 断言的是「源」而不是运行时 computedStyle：状态色是 CSS 里的定值 + 主题引擎
// 的一条禁令，两者都是可以直接读源验证的事实，不需要拉起一个 DOM。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const readFrontendFile = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../${relative}`, import.meta.url)), 'utf8')
const STYLES_CSS = readFrontendFile('css/styles.css')
const THEME_ENGINE_TS = readFrontendFile('src/app/i18n.ts')

/** 状态色令牌与它们的兼容别名：主题引擎一个都不准写。 */
const STATUS_TOKENS = [
  '--status-ok', '--status-attn', '--status-error', '--status-busy', '--status-idle',
  '--success', '--warning', '--danger', '--info', '--unread-dot',
  '--success-bg', '--warning-bg', '--danger-bg', '--info-bg', '--danger-text',
  '--error-fg', '--error-accent',
]

/** 需要参与对比度/色差校验的四个语义色（idle 是灰阶，跟随前景令牌，不入校验）。 */
const CHECKED = ['--status-ok', '--status-attn', '--status-error', '--status-busy'] as const

/** 状态点可能落在的最深卡片底：亮档白/面板灰，暗档窗底/悬浮层。 */
const SURFACES = {
  light: ['#ffffff', '#f5f5f5', '#ededed'],
  dark: ['#181818', '#202020', '#262626'],
}

function blockOf(selector: string): string {
  const start = STYLES_CSS.indexOf(selector)
  expect(start > -1).toBe(true)
  const end = STYLES_CSS.indexOf('\n}', start)
  return STYLES_CSS.slice(start, end)
}

function statusPalette(variant: 'light' | 'dark'): Record<string, string> {
  // 亮档在 :root，暗档在 [data-theme="dark"]（只覆盖基色，别名与 -bg 配方复用 :root）。
  const block = blockOf(variant === 'light' ? ':root {' : '[data-theme="dark"] {')
  const out: Record<string, string> = {}
  for (const token of CHECKED) {
    const match = block.match(new RegExp(`${token}:\\s*(#[0-9a-fA-F]{6})`))
    if (match) out[token] = match[1].toLowerCase()
  }
  return out
}

function srgbToLinear(channel: number): number {
  const c = channel / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

function toRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '')
  return [0, 2, 4].map(i => Number.parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
}

function relativeLuminance(hex: string): number {
  const [r, g, b] = toRgb(hex).map(srgbToLinear)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a)
  const lb = relativeLuminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

function toLab(hex: string): [number, number, number] {
  const [r, g, b] = toRgb(hex).map(srgbToLinear)
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const [fx, fy, fz] = [f(x), f(y), f(z)]
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)]
}

function deltaE(a: string, b: string): number {
  const la = toLab(a)
  const lb = toLab(b)
  return Math.hypot(la[0] - lb[0], la[1] - lb[1], la[2] - lb[2])
}

describe('status feedback tokens', () => {
  test('主题引擎不写任何状态色令牌（状态语义不得由代码配色档派生）', () => {
    // 只看 setRootProperties 那一堆真正写进 :root 的键，注释里提到令牌名是允许的。
    const written = [...THEME_ENGINE_TS.matchAll(/'(--[a-z0-9-]+)':/g)].map(m => m[1])
    expect(written.length > 20).toBe(true) // 防守：正则失配时不要静默通过
    expect(written.filter(token => STATUS_TOKENS.includes(token))).toEqual([])
  })

  test('亮暗两档各自定义了四个状态色', () => {
    for (const variant of ['light', 'dark'] as const) {
      expect(Object.keys(statusPalette(variant)).sort()).toEqual([...CHECKED].sort())
    }
  })

  test('状态点对卡片底色的对比 ≥ 3:1（WCAG 1.4.11 非文本对比）', () => {
    // 违例收成数组再一次断言：失败时直接看到哪个令牌、哪个底色、差多少。
    const violations: string[] = []
    for (const variant of ['light', 'dark'] as const) {
      for (const [token, hex] of Object.entries(statusPalette(variant))) {
        for (const surface of SURFACES[variant]) {
          const ratio = contrastRatio(hex, surface)
          if (ratio < 3) violations.push(`${variant} ${token} ${hex} on ${surface} = ${ratio.toFixed(2)}:1`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test('四个状态色两两 ΔE ≥ 35（任意两态并排都能分开）', () => {
    const violations: string[] = []
    for (const variant of ['light', 'dark'] as const) {
      const entries = Object.entries(statusPalette(variant))
      for (let i = 0; i < entries.length; i++) {
        for (let j = i + 1; j < entries.length; j++) {
          const [tokenA, hexA] = entries[i]
          const [tokenB, hexB] = entries[j]
          const distance = deltaE(hexA, hexB)
          if (distance < 35) violations.push(`${variant} ${tokenA}~${tokenB} ΔE=${distance.toFixed(1)}`)
        }
      }
    }
    expect(violations).toEqual([])
  })

  test('状态点只有一套实现（.kls-status-dot），旧的三套不得复活', () => {
    // 比的是「规则定义」而不是「提到过这个类名」：注释里记下旧类名是有用的（说清
    // 为何不得重建），只有又写出一条 `.xxx {` 规则才是真的又开了一套。
    const revived = ['.mcp-dot-green {', '.s-dot-green {', '.ssh-conn-dot {'].filter(dead => STYLES_CSS.includes(dead))
    expect(revived).toEqual([])
    // 形状差异（实心圆 vs 甜甜圈）是色觉障碍下唯一可靠的区分位，不能被改回纯颜色。
    expect(STYLES_CSS.includes('.kls-status-dot.is-attn { background: transparent; border:')).toBe(true)
    expect(STYLES_CSS.includes('.kls-status-dot.is-busy { background: transparent; border:')).toBe(true)
  })
})
