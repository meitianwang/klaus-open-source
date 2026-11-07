// 选区收口决策契约：三击/拖拽过冲让选区一端越出可引用消息时，引用浮层必须
// 把越界端收口回消息内而不是整条丢弃（选中答案最后一段必然越进下方改动卡片）。
// decideSelectionClamp 只做身份比较，用桩元素即可钉住全部五态。
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

let decideSelectionClamp: typeof import('./quote-selection').decideSelectionClamp
let previousWindow: unknown
beforeAll(async () => {
  previousWindow = (globalThis as any).window
  ;(globalThis as any).window = previousWindow ?? { addEventListener() {}, removeEventListener() {} }
  ;({ decideSelectionClamp } = await import('./quote-selection'))
})
afterAll(() => { (globalThis as any).window = previousWindow })

const STYLES_CSS = readFileSync(fileURLToPath(new URL('../../../css/styles.css', import.meta.url)), 'utf8')

const stub = (name: string) => ({ name }) as unknown as Element

describe('decideSelectionClamp', () => {
  test('起止同一条消息保持原选区', () => {
    const msg = stub('msg')
    expect(decideSelectionClamp(msg, msg)).toBe('keep')
  })

  test('仅起点在消息内收口终点', () => {
    expect(decideSelectionClamp(stub('msg'), null)).toBe('clamp-end')
  })

  test('仅终点在消息内收口起点', () => {
    expect(decideSelectionClamp(null, stub('msg'))).toBe('clamp-start')
  })

  test('两端都不在消息内拒绝', () => {
    expect(decideSelectionClamp(null, null)).toBe('reject')
  })

  test('跨两条消息拒绝', () => {
    expect(decideSelectionClamp(stub('a'), stub('b'))).toBe('reject')
  })
})

// 滚动容器不吃全局 focus-visible 兜底描边：否则选完文字按任意键，转录列整框
// 2px 描边的底边正好压在输入卡顶边上，读作一条凭空的全宽横线。
describe('scroll container focus outline', () => {
  test('transcript columns opt out of the focus-visible floor', () => {
    const start = STYLES_CSS.indexOf('#messages:focus-visible')
    expect(start).toBeGreaterThanOrEqual(0)
    const end = STYLES_CSS.indexOf('}', start)
    const rule = STYLES_CSS.slice(start, end)
    expect(rule).toContain(':is(#side-messages, #left-side-messages):focus-visible')
    expect(rule).toContain('outline: none;')
  })
})
