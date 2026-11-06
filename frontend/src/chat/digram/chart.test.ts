// chart.ts 的结构断言：每种图表的关键 SVG 形态、确定性、转义与品牌主题合并。
// 用 approximateMeasurer + 固定数据，golden 可复现；不锁整串 SVG（数字密度太高，
// 锁整串会让任何布局微调都变成维护负担），锁「结构特征 + 无 NaN + 确定性」。

import { describe, expect, test } from 'bun:test'
import { render } from './render'
import { makeTheme } from './theme'
import { approximateMeasurer } from './measure'
import type { ChartSpec, DigramDocument, DigramNode } from './types'

function docWith(chart: ChartSpec, extra: Partial<DigramNode> = {}, docExtra: Partial<DigramDocument> = {}): DigramDocument {
  return {
    id: 'd1',
    title: 'Charts',
    pages: [
      {
        id: 'p1',
        nodes: [{ id: 'c', x: 0, y: 0, w: 560, h: 360, label: 'Chart title', ...extra, chart }],
        edges: [],
      },
    ],
    ...docExtra,
  }
}

function svgOf(doc: DigramDocument): string {
  return render(doc, { theme: makeTheme('light'), measurer: approximateMeasurer }).svg
}

const CLEAN = /NaN|Infinity|undefined/

describe('chart kinds', () => {
  test('bar：每个数据点一个柱，轴与刻度存在，单序列柱顶有数值标签', () => {
    const svg = svgOf(docWith({ kind: 'bar', categories: ['Q1', 'Q2', 'Q3'], series: [{ values: [10, 40, 25] }] }))
    expect(svg).toContain('Chart title')
    // 3 根柱 rx=2 + 图例不出现（单序列无名）
    expect(svg.match(/rx="2" fill="#/g)?.length).toBe(3)
    expect(svg).toContain('<line')
    expect(svg).not.toMatch(CLEAN)
    // 数值标签
    expect(svg).toContain('>40</text>')
  })

  test('bar 堆叠：stacked 把同分类的序列叠起来', () => {
    const stacked = svgOf(docWith({ kind: 'bar', stacked: true, categories: ['a', 'b'], series: [{ name: 'S1', values: [10, 20] }, { name: 'S2', values: [5, 5] }] }))
    // 4 根柱 + 2 个图例 swatch（swatch 也是 rx="2" 的 rect）
    expect(stacked.match(/rx="2" fill="#/g)?.length).toBe(6)
    expect(stacked.match(/width="8" height="8" rx="2"/g)?.length).toBe(2)
    // 多序列有图例
    expect(stacked).toContain('S1')
    expect(stacked).toContain('S2')
    expect(stacked).not.toMatch(CLEAN)
  })

  test('line/area：折线路径 + 数据点圆点；area 另有半透明填充', () => {
    const line = svgOf(docWith({ kind: 'line', categories: ['a', 'b', 'c'], series: [{ values: [1, 5, 3] }] }))
    expect(line.match(/<path d="M [\d.]+ [\d.]+ L/g)?.length ?? 0).toBeGreaterThanOrEqual(1)
    expect(line.match(/r="2.5"/g)?.length).toBe(3)
    const area = svgOf(docWith({ kind: 'area', categories: ['a', 'b', 'c'], series: [{ values: [1, 5, 3] }] }))
    expect(area).toContain('fill-opacity="0.14"')
    expect(line).not.toMatch(CLEAN)
    expect(area).not.toMatch(CLEAN)
  })

  test('pie/donut：每片一个扇形路径，图例带百分比；单片满圆退化为 circle', () => {
    const pie = svgOf(docWith({ kind: 'pie', slices: [{ label: 'A', value: 60 }, { label: 'B', value: 40 }] }))
    expect(pie.match(/ A [\d.]+ [\d.]+ 0 [01] 1 /g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(pie).toContain('60%')
    expect(pie).toContain('40%')
    const donut = svgOf(docWith({ kind: 'donut', slices: [{ label: 'A', value: 60 }, { label: 'B', value: 40 }] }))
    // 每片捐两段弧（外弧 sweep=1 + 内弧 sweep=0）；evenodd 只属于单片满圆的环
    expect(donut.match(/ A [\d.]+ [\d.]+ 0 [01] 1 /g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    expect(donut.match(/ A [\d.]+ [\d.]+ 0 [01] 0 /g)?.length ?? 0).toBeGreaterThanOrEqual(2)
    const donutSingle = svgOf(docWith({ kind: 'donut', slices: [{ label: 'All', value: 1 }] }))
    expect(donutSingle).toContain('fill-rule="evenodd"')
    const single = svgOf(docWith({ kind: 'pie', slices: [{ label: 'All', value: 1 }] }))
    expect(single).toContain('<circle')
    expect(donut).not.toMatch(CLEAN)
    expect(single).not.toMatch(CLEAN)
  })

  test('scatter：points 与 values 两种数据形态都画点', () => {
    const points = svgOf(docWith({ kind: 'scatter', series: [{ points: [{ x: 1, y: 2 }, { x: 3, y: 8 }] }] }))
    expect(points.match(/r="3.5"/g)?.length).toBe(2)
    const values = svgOf(docWith({ kind: 'scatter', series: [{ values: [2, 4, 6] }] }))
    expect(values.match(/r="3.5"/g)?.length).toBe(3)
    expect(points).not.toMatch(CLEAN)
    expect(values).not.toMatch(CLEAN)
  })

  test('heatmap：单元格数 = 行×列，强度随值变化，值文本进格', () => {
    const svg = svgOf(docWith({
      kind: 'heatmap',
      rows: ['r1', 'r2'],
      columns: ['c1', 'c2', 'c3'],
      values: [[1, 5, 9], [2, 4, 8]],
    }))
    // 6 个格子（stroke=paper 分隔）
    expect(svg.match(/stroke="#ffffff" stroke-width="1"\/>/g)?.length).toBe(6)
    expect(svg).toContain('>r1</text>')
    expect(svg).toContain('>c3</text>')
    expect(svg).toContain('>9</text>')
    expect(svg).not.toMatch(CLEAN)
  })

  test('gantt：任务条数量与日期刻度；section 头出现', () => {
    const svg = svgOf(docWith({
      kind: 'gantt',
      tasks: [
        { label: 'Design', start: '2026-01-01', end: '2026-01-10', section: 'Phase 1' },
        { label: 'Build', start: '2026-01-08', end: '2026-01-20', section: 'Phase 2', tone: 'info' },
      ],
    }))
    expect(svg.match(/rx="3" fill="#/g)?.length).toBe(2)
    expect(svg).toContain('2026-01-')
    expect(svg).toContain('Phase 1')
    expect(svg).toContain('>Design</text>')
    expect(svg).not.toMatch(CLEAN)
  })

  test('sankey：每条流一条缎带路径，节点按列排布并带标签', () => {
    const svg = svgOf(docWith({
      kind: 'sankey',
      flows: [
        { from: 'Sources', to: 'Ingest', value: 30 },
        { from: 'Ingest', to: 'Store', value: 20 },
        { from: 'Ingest', to: 'Drop', value: 10 },
      ],
    }))
    expect(svg.match(/stroke-opacity="0.35"\/>/g)?.length).toBe(3)
    expect(svg).toContain('>Sources</text>')
    expect(svg).toContain('>Ingest</text>')
    expect(svg).toContain('>Store</text>')
    expect(svg).not.toMatch(CLEAN)
  })

  test('sankey 带环也不悬挂：回边被降级，仍产出有限几何', () => {
    const svg = svgOf(docWith({ kind: 'sankey', flows: [{ from: 'a', to: 'b', value: 1 }, { from: 'b', to: 'a', value: 2 }] }))
    expect(svg).toContain('>a</text>')
    expect(svg).not.toMatch(CLEAN)
  })
})

describe('chart integration', () => {
  test('标签转义：chart 标题与数据标签走同一转义边界', () => {
    const svg = svgOf(docWith({ kind: 'pie', slices: [{ label: '<script>alert(1)</script>', value: 1 }] }, { label: 'A&B <title>' }))
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;script&gt;')
    expect(svg).toContain('A&amp;B &lt;title&gt;')
  })

  test('确定性：同一文档两次渲染逐字节一致', () => {
    const doc = docWith({ kind: 'bar', categories: ['a', 'b'], series: [{ values: [3, 4] }, { name: 'S', values: [1, 2] }] })
    expect(svgOf(doc)).toBe(svgOf(doc))
  })

  test('暗色主题渲染不抛错且纸色跟随', () => {
    const svg = render(docWith({ kind: 'bar', categories: ['a'], series: [{ values: [1] }] }), { theme: makeTheme('dark'), measurer: approximateMeasurer }).svg
    expect(svg).toContain('#1a1c1f')
    expect(svg).not.toMatch(CLEAN)
  })

  test('小框只画标题不画图表内容', () => {
    const svg = svgOf(docWith({ kind: 'bar', categories: ['a', 'b'], series: [{ values: [1, 2] }] }, { w: 200, h: 40, x: 0, y: 0 }))
    expect(svg).toContain('Chart title')
    expect(svg).not.toContain('rx="2" fill="#')
  })

  test('品牌主题：palette 覆盖进入图表序列色，fontFamily 覆盖进入 SVG 根', () => {
    const doc = docWith(
      { kind: 'bar', categories: ['a'], series: [{ tone: 'accent', values: [7] }] },
      {},
      { theme: { palette: { accent: '#123456' }, fontFamily: 'Inter, sans-serif' } },
    )
    const svg = svgOf(doc)
    expect(svg).toContain('#123456')
    expect(svg).toContain('font-family="Inter, sans-serif"')
    expect(svg).not.toMatch(CLEAN)
  })

  test('品牌主题明暗分档：light/dark 各取各的覆盖', () => {
    const doc = docWith(
      { kind: 'bar', categories: ['a'], series: [{ tone: 'accent', values: [7] }] },
      { variant: 'solid' },
      { theme: { palette: { accent: { light: '#111111', dark: '#222222' } } } },
    )
    expect(render(doc, { theme: makeTheme('light'), measurer: approximateMeasurer }).svg).toContain('#111111')
    expect(render(doc, { theme: makeTheme('dark'), measurer: approximateMeasurer }).svg).toContain('#222222')
  })

  test('非法主题覆盖被防御性忽略：手改文档喂不进坏颜色', () => {
    const doc = docWith(
      { kind: 'bar', categories: ['a'], series: [{ tone: 'accent', values: [7] }] },
      {},
      { theme: { palette: { accent: 'javascript:evil()' as unknown as string }, fontSize: -5 } },
    )
    const svg = svgOf(doc)
    expect(svg).not.toContain('javascript:')
    // 落回默认 accent 基色
    expect(svg).toContain('#c2673f')
    expect(svg).not.toMatch(CLEAN)
  })

  test('chart 节点仍参与命中测试与内容边界', () => {
    const result = render(docWith({ kind: 'line', categories: ['a', 'b'], series: [{ values: [1, 2] }] }), { theme: makeTheme('light'), measurer: approximateMeasurer })
    expect(result.hitTargets.some((target) => target.id === 'c')).toBe(true)
    expect(result.width).toBeGreaterThan(0)
    expect(result.height).toBeGreaterThan(0)
  })
})
