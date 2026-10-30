// Canvas 令牌的防漂移门。
//
// Canvas 在自己的窗口里渲染，且刻意不加载 css/styles.css —— 它要求值一段模型写
// 的代码，必须在别的东西全挂掉的情况下也能画出来。代价是同一套配色在仓里存了两
// 份：styles.css 的 :root / [data-theme="dark"]，和 sdk/tokens.ts 里的字面值。
//
// 两份就会漂。这份测试把它们钉在一起：改了 app 的配色而没改 canvas 的，这里先
// 红，而不是等到用户发现 canvas 窗口跟主界面不是一个产品。
//
// 断言「源」而不是 computedStyle：两边都是源码里的定值，直接读就是事实，不需要
// 拉起 DOM。
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { canvasTokensDark, canvasTokensLight, canvasTokensFor } from './tokens'

const readFrontendFile = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../../../${relative}`, import.meta.url)), 'utf8')
const STYLES_CSS = readFrontendFile('css/styles.css')
const CANVAS_CSS = readFrontendFile('src/canvas/canvas-window.css')

/**
 * 从 styles.css 的某个选择器块里读一个自定义属性的值。
 *
 * 只取第一个匹配块：:root 和 [data-theme="dark"] 各自只声明一次基色，后面重复
 * 出现的同名属性都在更窄的选择器里（.app-opaque 之类），不是这一层的事实。
 */
function cssVar(selector: string, name: string): string {
  const block = new RegExp(`${escapeRegExp(selector)}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(STYLES_CSS)
  if (!block) throw new Error(`styles.css 里找不到 ${selector} 块`)
  const declaration = new RegExp(`\\n\\s*${escapeRegExp(name)}\\s*:\\s*([^;]+);`).exec(block[1])
  if (!declaration) throw new Error(`${selector} 里找不到 ${name}`)
  return declaration[1].trim()
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * canvas 令牌路径 → styles.css 变量名。
 *
 * 只列「同一个视觉角色」的对子。canvas 有 styles.css 没有的东西（chart.sequence
 * 的分类色序、图表网格线），那些不在这里 —— 硬凑一个对应关系比没有更糟。
 */
const LIGHT_PAIRS: [string, string][] = [
  ['bg.editor', '--bg'],
  ['bg.chrome', '--bg-surface'],
  ['bg.elevated', '--bg-elevated'],
  ['bg.under', '--bg-under'],
  ['bg.hover', '--bg-hover'],
  ['text.primary', '--fg'],
  ['text.secondary', '--fg-secondary'],
  ['text.tertiary', '--fg-tertiary'],
  ['text.quaternary', '--fg-quaternary'],
  ['text.link', '--theme-accent'],
  ['text.onAccent', '--accent-text'],
  ['stroke.primary', '--border'],
  ['stroke.secondary', '--border-subtle'],
  ['accent.primary', '--accent'],
  ['accent.control', '--accent'],
  ['accent.controlHover', '--accent-hover'],
  ['accent.highlight', '--theme-accent'],
  ['accent.highlightBg', '--theme-accent-bg'],
  ['status.success', '--status-ok'],
  ['status.warning', '--status-attn'],
  ['status.danger', '--status-error'],
  ['status.info', '--status-busy'],
  ['diff.added', '--theme-diff-added'],
  ['diff.addedBg', '--theme-diff-added-bg'],
  ['diff.removed', '--theme-diff-removed'],
  ['diff.removedBg', '--theme-diff-removed-bg'],
  ['syntax.keyword', '--syntax-keyword'],
  ['syntax.string', '--syntax-string'],
  ['syntax.number', '--syntax-number'],
  ['syntax.property', '--syntax-property'],
  ['syntax.punctuation', '--syntax-punctuation'],
]

/** 暗档只列在 [data-theme="dark"] 里被重新声明过的那些。 */
const DARK_PAIRS: [string, string][] = [
  ['bg.editor', '--bg'],
  ['bg.chrome', '--bg-surface'],
  ['bg.elevated', '--bg-elevated'],
  ['bg.under', '--bg-under'],
  ['bg.hover', '--bg-hover'],
  ['text.primary', '--fg'],
  ['text.secondary', '--fg-secondary'],
  ['text.tertiary', '--fg-tertiary'],
  ['text.quaternary', '--fg-quaternary'],
  ['text.onAccent', '--accent-text'],
  ['stroke.primary', '--border'],
  ['stroke.secondary', '--border-subtle'],
  ['accent.primary', '--accent'],
  ['accent.controlHover', '--accent-hover'],
  ['status.success', '--status-ok'],
  ['status.warning', '--status-attn'],
  ['status.danger', '--status-error'],
  ['status.info', '--status-busy'],
  ['syntax.keyword', '--syntax-keyword'],
  ['syntax.number', '--syntax-number'],
]

function read(tokens: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) => (value as Record<string, unknown>)[key], tokens)
}

describe('canvas 令牌跟随 app 配色', () => {
  // 一个 test 里跑完整张表，并把所有不一致收成一份清单：改配色往往一改一批，
  // 逐条断言只能看到第一个坏的，而清单一次把该改的全部告诉你。
  test('亮档每个语义角色都等于 styles.css 里的同一个值', () => {
    const drift: string[] = []
    for (const [path, variable] of LIGHT_PAIRS) {
      const actual = read(canvasTokensLight, path)
      const expected = cssVar(':root', variable)
      if (actual !== expected) drift.push(`${path}=${actual} ≠ ${variable}=${expected}`)
    }
    expect(drift).toEqual([])
  })

  test('暗档每个语义角色都等于 styles.css 里的同一个值', () => {
    const drift: string[] = []
    for (const [path, variable] of DARK_PAIRS) {
      const actual = read(canvasTokensDark, path)
      const expected = cssVar('[data-theme="dark"]', variable)
      if (actual !== expected) drift.push(`${path}=${actual} ≠ ${variable}=${expected}`)
    }
    expect(drift).toEqual([])
  })

  test('对子表本身不能被删空 —— 否则上面两条会静默通过', () => {
    expect(LIGHT_PAIRS.length).toBeGreaterThan(25)
    expect(DARK_PAIRS.length).toBeGreaterThan(15)
  })

  test('圆角与字号刻度跟随 app', () => {
    expect(canvasTokensLight.radius.xxs).toBe(4)
    expect(canvasTokensLight.radius.xs).toBe(6)
    expect(canvasTokensLight.radius.sm).toBe(8)
    expect(canvasTokensLight.radius.md).toBe(12)
    // --radius-sm: 8px 是全端按钮的圆角，canvas 的按钮也用它。
    expect(cssVar(':root', '--radius-sm')).toBe('8px')
    expect(canvasTokensLight.fontSize.body).toBe(cssVar(':root', '--text-body'))
    expect(canvasTokensLight.fontSize.small).toBe(cssVar(':root', '--text-small'))
    expect(canvasTokensLight.fontSize.title).toBe(cssVar(':root', '--text-title'))
  })

  test('字重只有 regular/medium/semibold —— 不准冒出 bold', () => {
    expect(Object.keys(canvasTokensLight.weight).sort()).toEqual([
      'medium',
      'regular',
      'semibold',
    ])
    expect(canvasTokensLight.weight.regular).toBe(430)
    expect(canvasTokensLight.weight.medium).toBe(500)
    expect(canvasTokensLight.weight.semibold).toBe(600)
    // 排版刻度里也不准出现 700。
    for (const style of Object.values(canvasTokensLight.typography)) {
      expect(style.fontWeight).toBeLessThanOrEqual(600)
    }
  })

  test('canvas 窗口自己的 CSS 也用同一批值', () => {
    // canvas-window.css 是窗口外壳（标题栏/报错面板），它不经过 tokens.ts，
    // 所以单独钉一遍：外壳与内容配色不一致会直接看出来。
    expect(CANVAS_CSS).toContain(`--cv-bg: ${canvasTokensDark.bg.editor}`)
    expect(CANVAS_CSS).toContain(`--cv-fg: ${canvasTokensDark.text.primary}`)
    expect(CANVAS_CSS).toContain(`--cv-border: ${canvasTokensDark.stroke.primary}`)
    expect(CANVAS_CSS).toContain(`--cv-danger: ${canvasTokensDark.status.danger}`)
  })
})

describe('主题解析', () => {
  test('只有 light 解析成亮档，其余一律暗档', () => {
    expect(canvasTokensFor('light')).toBe(canvasTokensLight)
    expect(canvasTokensFor('dark')).toBe(canvasTokensDark)
    expect(canvasTokensFor(undefined)).toBe(canvasTokensDark)
    expect(canvasTokensFor('system')).toBe(canvasTokensDark)
  })

  test('图表分类色序两端都够长且无重复', () => {
    for (const tokens of [canvasTokensLight, canvasTokensDark]) {
      expect(tokens.chart.sequence.length).toBeGreaterThanOrEqual(8)
      expect(new Set(tokens.chart.sequence).size).toBe(tokens.chart.sequence.length)
    }
  })

  test('令牌里没有 var() 引用 —— canvas 不加载 app 样式表', () => {
    const serialized = JSON.stringify([canvasTokensLight, canvasTokensDark])
    expect(serialized).not.toContain('var(')
  })
})
