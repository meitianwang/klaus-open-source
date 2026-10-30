// digram 渲染器的 golden 测试。
//
// 用确定性度量（approximateMeasurer）而不是 canvas：`render()` 的产物要在 bun 里
// 可复现，字宽一旦依赖真实字体，快照就会随系统字体版本漂。面板里注入的 canvas 版
// 只是把估值换成精确值，结构不变。
//
// 断言的是**结构与语义**（形状路径出现了、颜色按 tone/variant 派生了、次序对了），
// 不是整串字符相等——整串相等的快照一改主题就全红，没人会去逐条确认，最后就是无脑
// 更新快照。
import { describe, expect, test } from 'bun:test'
import { approximateMeasurer, wrapLabel } from './measure'
import { arrowHead, edgeGeometry, polylinePath, shapePath } from './geometry'
import { makeTheme, radiusFor, resolveEdgeTone, resolveTone } from './theme'
import { render } from './render'
import type { DigramDocument, DigramEdge, DigramNode, Shape } from './types'

const theme = makeTheme('light')
const dark = makeTheme('dark')

function node(over: Partial<DigramNode> & { id: string }): DigramNode {
  return { x: 0, y: 0, w: 160, h: 60, ...over }
}

function doc(nodes: DigramNode[], edges: DigramEdge[] = []): DigramDocument {
  return { id: 'dgm-test', pages: [{ id: 'p1', nodes, edges }] }
}

const opts = { measurer: approximateMeasurer, theme }

describe('theme', () => {
  test('每个 tone 在明暗两套下都解析出可用的三件套', () => {
    const tones = ['neutral', 'accent', 'info', 'success', 'warning', 'danger', 'violet', 'teal'] as const
    for (const kind of [theme, dark]) {
      for (const tone of tones) {
        const soft = resolveTone(kind, tone, 'soft')
        expect(soft.fill).toMatch(/^#[0-9a-f]{6}$/)
        expect(soft.stroke).toMatch(/^#[0-9a-f]{6}$/)
        expect(soft.text).toMatch(/^#[0-9a-f]{6}$/)
      }
    }
  })

  // 同一份文档要在浅色和深色下都对，这是不写 hex 而写语义键的全部理由。
  test('同一个 tone 在明暗两套下解析出不同的颜色', () => {
    expect(resolveTone(theme, 'accent', 'soft').fill).not.toBe(
      resolveTone(dark, 'accent', 'soft').fill,
    )
  })

  test('ghost 不描边，outline 用纸色底，solid 的字取纸色', () => {
    expect(resolveTone(theme, 'info', 'ghost').stroke).toBe('none')
    expect(resolveTone(theme, 'info', 'outline').fill).toBe(theme.paper)
    expect(resolveTone(theme, 'info', 'solid').text).toBe(theme.paper)
  })

  test('soft 的填充比 outline 的纸底更有色，描边比填充更深', () => {
    const soft = resolveTone(theme, 'danger', 'soft')
    expect(soft.fill).not.toBe(theme.paper)
    // 浅色主题下混得越多越深，描边混了 0.45 而填充只混了 0.1。
    expect(soft.stroke < soft.fill).toBe(true)
  })

  test('边的描边比节点描边更深，线跨过淡底块时才看得见', () => {
    expect(resolveEdgeTone(theme, 'neutral').stroke < resolveTone(theme, 'neutral', 'soft').stroke).toBe(
      true,
    )
  })

  test('圆角按形状语义给：rect 是直角，pill 是半高，显式值被夹在半高内', () => {
    expect(radiusFor(theme, 'rect', 60)).toBe(0)
    expect(radiusFor(theme, 'pill', 60)).toBe(30)
    expect(radiusFor(theme, 'rounded', 60)).toBe(theme.radius)
    expect(radiusFor(theme, 'rounded', 60, 999)).toBe(30)
  })
})

describe('geometry', () => {
  const SHAPES: Shape[] = [
    'rect',
    'rounded',
    'pill',
    'ellipse',
    'diamond',
    'hexagon',
    'parallelogram',
    'cylinder',
    'document',
    'note',
    'actor',
    'cloud',
    'icon',
    'text',
    'group',
  ]

  // 形状表是闭集，每一项都必须真的画得出一条路径——加了枚举值忘了写路径，就会在
  // 界面上静默退化成矩形。
  test('每种形状都产出非空且只含合法路径指令的 path', () => {
    for (const shape of SHAPES) {
      const path = shapePath(shape, { x: 10, y: 20, w: 120, h: 60 }, 8)
      expect(path.length > 0).toBe(true)
      expect(path.startsWith('M ')).toBe(true)
      expect(path).not.toMatch(/NaN|Infinity|undefined/)
      expect(path.replace(/[-0-9.\s]/g, '')).toMatch(/^[MLHVACQZ]+$/)
    }
  })

  test('rect 是直角四边，rounded 带弧线段', () => {
    const rect = shapePath('rect', { x: 0, y: 0, w: 100, h: 50 }, 0)
    expect(rect).not.toContain('A ')
    expect(shapePath('rounded', { x: 0, y: 0, w: 100, h: 50 }, 8)).toContain('A ')
  })

  test('auto 锚点按长宽归一化后的主轴选边，扁框左右接而不是顶边出', () => {
    // 两个扁框水平排开：右框在右侧，所以左框从 right 出、右框从 left 进。
    const wide = edgeGeometry(
      { x: 0, y: 0, w: 400, h: 40 },
      { x: 600, y: 30, w: 400, h: 40 },
      'auto',
      'auto',
      'orthogonal',
      undefined,
      18,
    )
    expect(wide.from.side).toBe('right')
    expect(wide.to.side).toBe('left')
    // 上下排：走上下。
    const stacked = edgeGeometry(
      { x: 0, y: 0, w: 120, h: 60 },
      { x: 10, y: 300, w: 120, h: 60 },
      'auto',
      'auto',
      'orthogonal',
      undefined,
      18,
    )
    expect(stacked.from.side).toBe('bottom')
    expect(stacked.to.side).toBe('top')
  })

  test('显式 side 优先于 auto 推断', () => {
    const geometry = edgeGeometry(
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 300, y: 0, w: 100, h: 100 },
      'top',
      'bottom',
      'orthogonal',
      undefined,
      18,
    )
    expect(geometry.from.side).toBe('top')
    expect(geometry.to.side).toBe('bottom')
  })

  // 竖直对齐时硬折 stub 会画出多余的台阶，看着像路由坏了。
  test('两端已经对齐时正交走线退化成一条直线', () => {
    const geometry = edgeGeometry(
      { x: 0, y: 0, w: 100, h: 40 },
      { x: 0, y: 200, w: 100, h: 40 },
      'auto',
      'auto',
      'orthogonal',
      undefined,
      18,
    )
    expect(geometry.points.length).toBe(2)
  })

  test('显式 waypoints 照走，不被自动路由推翻', () => {
    const geometry = edgeGeometry(
      { x: 0, y: 0, w: 100, h: 40 },
      { x: 400, y: 400, w: 100, h: 40 },
      'auto',
      'auto',
      'orthogonal',
      [{ x: 50, y: 250 }],
      18,
    )
    expect(geometry.points).toContainEqual({ x: 50, y: 250 })
  })

  test('折线拐角倒圆角，短段不会被啃穿', () => {
    const path = polylinePath(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 100 },
      ],
      8,
    )
    expect(path).toContain('Q ')
    // 段长只有 4 时半径被夹到 2，仍是合法路径而不是负半径。
    const tight = polylinePath(
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
      ],
      8,
    )
    expect(tight).not.toMatch(/NaN|-\d+\.?\d*e/)
  })

  // 线不缩短的话，线头会从三角形尖端探出来一个毛刺。
  test('箭头把线段截短到三角底边，且三种箭头都是闭合形', () => {
    const tip = { x: 100, y: 0 }
    const from = { x: 0, y: 0 }
    const arrow = arrowHead('arrow', tip, from, 9)!
    expect(arrow.trimTo.x < tip.x).toBe(true)
    expect(arrow.path.endsWith('Z')).toBe(true)
    expect(arrowHead('dot', tip, from, 9)!.path.endsWith('Z')).toBe(true)
    expect(arrowHead('diamond', tip, from, 9)!.path.endsWith('Z')).toBe(true)
    expect(arrowHead('none', tip, from, 9)).toBe(null)
  })
})

describe('measure', () => {
  test('折行塞进给定宽度', () => {
    const wrapped = wrapLabel('one two three four five', 60, 1000, 14, 'regular', approximateMeasurer)
    expect(wrapped.lines.length > 1).toBe(true)
    for (const line of wrapped.lines) {
      expect(approximateMeasurer.width(line, wrapped.fontSize, 'regular')).toBeLessThanOrEqual(60)
    }
  })

  // 中文没有词间空格，只按空白断会把整句当一个 token 然后切在随机位置。
  test('中文按字断行', () => {
    const wrapped = wrapLabel('上下文构建与压缩', 40, 1000, 14, 'regular', approximateMeasurer)
    expect(wrapped.lines.length > 1).toBe(true)
    expect(wrapped.lines.join('')).toBe('上下文构建与压缩')
  })

  test('高度不够时降字号，降到下限仍不够就截断并标记', () => {
    const shrunk = wrapLabel('a b c d e f g h', 40, 20, 14, 'regular', approximateMeasurer)
    expect(shrunk.fontSize).toBeLessThan(14)
    const cut = wrapLabel('a b c d e f g h i j k l m n', 30, 12, 14, 'regular', approximateMeasurer)
    expect(cut.truncated).toBe(true)
    expect(cut.lines[cut.lines.length - 1]).toContain('…')
  })

  test('显式换行被保留', () => {
    const wrapped = wrapLabel('one\ntwo', 400, 1000, 14, 'regular', approximateMeasurer)
    expect(wrapped.lines).toEqual(['one', 'two'])
  })

  test('超宽单词硬断而不是溢出框', () => {
    const wrapped = wrapLabel('aVeryLongIdentifierWithoutSpaces', 40, 1000, 14, 'regular', approximateMeasurer)
    for (const line of wrapped.lines) {
      expect(approximateMeasurer.width(line, wrapped.fontSize, 'regular')).toBeLessThanOrEqual(40)
    }
  })

  test('空标签不产出行', () => {
    expect(wrapLabel('', 100, 100, 14, 'regular', approximateMeasurer).lines).toEqual([])
  })
})

describe('render', () => {
  test('产出带 viewBox 的 svg，尺寸按内容而不是页面声明', () => {
    const result = render(doc([node({ id: 'a', x: 100, y: 100, w: 200, h: 80 })]), opts)
    expect(result.svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
    expect(result.svg.endsWith('</svg>')).toBe(true)
    // padding 24 各一边：200 + 48。页面声明的 1600×900 不参与。
    expect(result.width).toBe(248)
    expect(result.height).toBe(128)
    expect(result.viewBox.x).toBe(76)
  })

  test('产物里没有 NaN、undefined 或未解析的 CSS 变量', () => {
    const result = render(
      doc(
        [
          node({ id: 'layer', shape: 'group', w: 600, h: 150, tone: 'info' }),
          node({ id: 'comp', parent: 'layer', x: 40, y: 40, w: 120, h: 70, variant: 'outline', label: '组件' }),
          node({ id: 'ic', shape: 'icon', icon: 'path:M0 0h24v24H0z', x: 400, y: 40, w: 48, h: 48, label: 'CPU' }),
        ],
        [{ id: 'e', from: 'comp', to: 'ic', label: '调用' }],
      ),
      opts,
    )
    expect(result.svg).not.toMatch(/NaN|undefined|var\(--|color-mix/)
  })

  // 层底色画在层内组件上面，就是「组件被自己的层盖住」，作者永远调不出来。
  test('容器画在自己的孩子之前，深度优先于 z', () => {
    const result = render(
      doc([
        node({ id: 'child', parent: 'layer', z: -10, label: 'CHILD' }),
        node({ id: 'layer', shape: 'group', z: 99, w: 600, h: 200, label: 'LAYER' }),
      ]),
      opts,
    )
    expect(result.svg.indexOf('LAYER')).toBeLessThan(result.svg.indexOf('CHILD'))
  })

  // 边压在框上很难看；画在容器之上、叶子之下，穿过无关框时会从框后面过。
  test('边画在容器之后、叶子节点之前', () => {
    const result = render(
      doc(
        [
          node({ id: 'layer', shape: 'group', w: 800, h: 300, label: 'LAYER' }),
          node({ id: 'a', parent: 'layer', x: 40, y: 40, label: 'AAA' }),
          node({ id: 'b', parent: 'layer', x: 400, y: 40, label: 'BBB' }),
        ],
        [{ id: 'e', from: 'a', to: 'b' }],
      ),
      opts,
    )
    const layerAt = result.svg.indexOf('LAYER')
    const edgeAt = result.svg.indexOf('stroke-linecap="round"')
    const leafAt = result.svg.indexOf('AAA')
    expect(layerAt).toBeLessThan(edgeAt)
    expect(edgeAt).toBeLessThan(leafAt)
  })

  test('边标签最后画，压在线和框之上', () => {
    const result = render(
      doc([node({ id: 'a', label: 'AAA' }), node({ id: 'b', x: 400, label: 'BBB' })], [
        { id: 'e', from: 'a', to: 'b', label: 'EDGELABEL' },
      ]),
      opts,
    )
    expect(result.svg.indexOf('BBB')).toBeLessThan(result.svg.indexOf('EDGELABEL'))
  })

  test('icon 的标签默认摆到框下，并把内容边界撑开', () => {
    const withLabel = render(
      doc([node({ id: 'a', shape: 'icon', icon: 'path:M0 0h24v24H0z', w: 48, h: 48, label: '很长的图标名字' })]),
      opts,
    )
    const withoutLabel = render(
      doc([node({ id: 'a', shape: 'icon', icon: 'path:M0 0h24v24H0z', w: 48, h: 48 })]),
      opts,
    )
    expect(withLabel.height).toBeGreaterThan(withoutLabel.height)
  })

  // 静默消失会让作者以为图标名写对了。
  test('图标字形缺失时画虚线占位而不是什么都不画', () => {
    const result = render(
      doc([node({ id: 'a', shape: 'icon', icon: 'phosphor:nope', w: 48, h: 48 })]),
      opts,
    )
    expect(result.svg).toContain('stroke-dasharray="3 2"')
  })

  test('注入的图标目录被内联成 path', () => {
    const result = render(
      doc([node({ id: 'a', shape: 'icon', icon: 'phosphor:cpu', w: 48, h: 48 })]),
      { ...opts, icons: { 'phosphor:cpu': 'M1 2h3v4H1z' } },
    )
    expect(result.svg).toContain('M1 2h3v4H1z')
    expect(result.svg).not.toContain('stroke-dasharray="3 2"')
  })

  test('text 形状不画框，actor 只描边不填充', () => {
    const text = render(doc([node({ id: 'a', shape: 'text', label: 'bare' })]), opts)
    expect(text.svg).not.toContain('<path d="M')
    const actor = render(doc([node({ id: 'a', shape: 'actor', w: 60, h: 90 })]), opts)
    expect(actor.svg).toContain('fill="none"')
  })

  test('label 里的尖括号与 & 被转义，不会破坏 svg', () => {
    const result = render(doc([node({ id: 'a', label: '<b>&' })]), opts)
    expect(result.svg).toContain('&lt;b&gt;&amp;')
    expect(result.svg).not.toContain('<b>')
  })

  test('transparent 与 background:transparent 都不画纸底', () => {
    const forced = render(doc([node({ id: 'a' })]), { ...opts, transparent: true })
    expect(forced.svg).not.toContain(`fill="${theme.paper}"/>`)
    const declared = render(
      { id: 'd', pages: [{ id: 'p1', background: 'transparent', nodes: [node({ id: 'a' })] }] },
      opts,
    )
    expect(declared.svg.indexOf(`<rect x=`)).toBe(-1)
  })

  test('showGrid 才画网格', () => {
    expect(render(doc([node({ id: 'a' })]), opts).svg).not.toContain(theme.grid)
    expect(render(doc([node({ id: 'a' })]), { ...opts, showGrid: true }).svg).toContain(theme.grid)
  })

  test('选中态叠虚线描边', () => {
    const result = render(doc([node({ id: 'a' })]), { ...opts, selected: new Set(['a']) })
    expect(result.svg).toContain(theme.selection)
  })

  test('rotate 包一层 transform，不旋转就不包', () => {
    expect(render(doc([node({ id: 'a', rotate: 45 })]), opts).svg).toContain('transform="rotate(45')
    expect(render(doc([node({ id: 'a' })]), opts).svg).not.toContain('rotate(')
  })

  test('命中目标按绘制次序给出，容器带标记', () => {
    const result = render(
      doc([
        node({ id: 'child', parent: 'layer' }),
        node({ id: 'layer', shape: 'group', w: 600, h: 200 }),
      ]),
      opts,
    )
    expect(result.hitTargets.map((target) => target.id)).toEqual(['layer', 'child'])
    expect(result.hitTargets[0].container).toBe(true)
    expect(result.hitTargets[1].container).toBe(false)
  })

  test('页面选择器认 id 与下标，越界退回第一页', () => {
    const two: DigramDocument = {
      id: 'd',
      pages: [
        { id: 'p1', nodes: [node({ id: 'one', label: 'ONE' })] },
        { id: 'p2', nodes: [node({ id: 'two', label: 'TWO' })] },
      ],
    }
    expect(render(two, { ...opts, page: 'p2' }).svg).toContain('TWO')
    expect(render(two, { ...opts, page: '1' }).svg).toContain('TWO')
    expect(render(two, { ...opts, page: 'nope' }).svg).toContain('ONE')
  })

  test('端点缺失的边被跳过而不是抛异常', () => {
    const result = render(doc([node({ id: 'a' })], [{ id: 'e', from: 'a', to: 'ghost' }]), opts)
    expect(result.svg).toContain('<svg')
  })

  test('空文档也产出合法 svg', () => {
    expect(render({ id: 'd', pages: [] }, opts).svg).toContain('<svg')
    expect(render({ id: 'd', pages: [{ id: 'p1' }] }, opts).svg).toContain('</svg>')
  })

  test('三种走线都产出不同的路径形状', () => {
    const pair = [node({ id: 'a' }), node({ id: 'b', x: 400, y: 200 })]
    const ortho = render(doc(pair, [{ id: 'e', from: 'a', to: 'b', route: 'orthogonal' }]), opts).svg
    const straight = render(doc(pair, [{ id: 'e', from: 'a', to: 'b', route: 'straight' }]), opts).svg
    const curve = render(doc(pair, [{ id: 'e', from: 'a', to: 'b', route: 'curve' }]), opts).svg
    expect(ortho).toContain('Q ')
    expect(straight).not.toContain('Q ')
    expect(curve).toContain('C ')
  })

  test('dash 边带 stroke-dasharray', () => {
    const result = render(
      doc([node({ id: 'a' }), node({ id: 'b', x: 400 })], [{ id: 'e', from: 'a', to: 'b', dash: true }]),
      opts,
    )
    expect(result.svg).toContain('stroke-dasharray="6 4"')
  })
})
