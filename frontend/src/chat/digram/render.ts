// 文档 → SVG。digram 的渲染核心。
//
// 纯函数：`render(doc, options) -> { svg, width, height, ... }`。不碰 DOM、不读全局
// 状态、不依赖主题 CSS 变量（颜色在 theme.ts 里算成 hex）。三个理由：
//   * golden 测试能在 bun 里直接断言整串 SVG；
//   * 导出 PNG/JPG 就是把同一串 SVG 喂 canvas，屏上和导出的图必然一致；
//   * 面板重渲只是替换一次 innerHTML，没有增量 diff 的状态可以错。
//
// 绘制次序（决定了图好不好看，值得写下来）：
//   1. 纸底与网格
//   2. 容器（group）按嵌套深度，浅的先画 —— 层背景压在层内组件后面
//   3. 边 —— 画在容器之上、叶子节点之下。所以一条线穿过无关的框时会从框「后面」
//      过去，而不是压在框上；它自己两端的框由锚点收在边界外，不会被盖住
//   4. 叶子节点
//   5. 边标签 —— 最后画，压在线和框之上，否则标签会被后画的东西吃掉

import {
  arrowHead,
  centerOf,
  curvePath,
  edgeGeometry,
  n,
  polylinePath,
  rectOf,
  roundedRectPath,
  shapePath,
  type Rect,
} from './geometry'
import { LINE_HEIGHT, approximateMeasurer, wrapLabel, type TextMeasurer } from './measure'
import { makeTheme, radiusFor, resolveEdgeTone, resolveTone, type DigramTheme } from './theme'
import {
  EDGE_DEFAULTS,
  NODE_DEFAULTS,
  PAGE_DEFAULTS,
  isContainer,
  placementOf,
  shapeOf,
  type DigramDocument,
  type DigramEdge,
  type DigramNode,
  type DigramPage,
} from './types'

export interface RenderOptions {
  /** 画哪一页（id 或下标）。缺省第一页。 */
  page?: string
  theme?: DigramTheme
  measurer?: TextMeasurer
  /** 画网格。编辑态开，导出关。 */
  showGrid?: boolean
  /** 选中的 id 集合。编辑态用；导出时传空。 */
  selected?: ReadonlySet<string>
  /** 内容外扩的留白（px，图坐标系）。 */
  padding?: number
  /** 图标键 → SVG path。目录由面板注入，渲染器不认识具体图标。 */
  icons?: Readonly<Record<string, string>>
  /** 背景强制为透明（导出带 alpha 的 PNG 用）。 */
  transparent?: boolean
}

export interface RenderResult {
  svg: string
  /** 内容边界（含 padding），也是 viewBox。 */
  viewBox: Rect
  width: number
  height: number
  /** 参与命中测试的节点矩形，按绘制次序（后画的在后，命中要倒序找）。 */
  hitTargets: Array<{ id: string; rect: Rect; container: boolean }>
}

const DEFAULT_PADDING = 24
/** 边标签底衬的内边距。 */
const EDGE_LABEL_PAD = 4

export function render(doc: DigramDocument, options: RenderOptions = {}): RenderResult {
  const theme = options.theme ?? makeTheme('light')
  const measurer = options.measurer ?? approximateMeasurer
  const padding = options.padding ?? DEFAULT_PADDING
  const page = pickPage(doc, options.page)
  const nodes = page.nodes ?? []
  const edges = page.edges ?? []
  const byId = new Map(nodes.map((node) => [node.id, node]))

  const viewBox = contentBounds(nodes, edges, padding, theme, measurer)
  const ordered = paintOrder(nodes)
  const containers = ordered.filter(isContainer)
  const leaves = ordered.filter((node) => !isContainer(node))

  const body: string[] = []
  if (!options.transparent && (page.background ?? PAGE_DEFAULTS.background) === 'paper') {
    body.push(
      `<rect x="${n(viewBox.x)}" y="${n(viewBox.y)}" width="${n(viewBox.w)}" height="${n(viewBox.h)}" fill="${theme.paper}"/>`,
    )
  }
  if (options.showGrid) {
    body.push(gridLayer(viewBox, page.grid ?? PAGE_DEFAULTS.grid, theme))
  }
  for (const node of containers) body.push(nodeSvg(node, theme, measurer, options))
  for (const edge of edges) body.push(edgeSvg(edge, byId, theme))
  for (const node of leaves) body.push(nodeSvg(node, theme, measurer, options))
  for (const edge of edges) body.push(edgeLabelSvg(edge, byId, theme, measurer))
  if (options.selected?.size) {
    for (const node of ordered) {
      if (options.selected.has(node.id)) body.push(selectionSvg(rectOf(node), theme))
    }
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(viewBox.w)}" height="${n(viewBox.h)}"`
    + ` viewBox="${n(viewBox.x)} ${n(viewBox.y)} ${n(viewBox.w)} ${n(viewBox.h)}"`
    + ` font-family="${escapeAttr(theme.fontFamily)}">`
    + body.filter(Boolean).join('')
    + '</svg>'

  // This string is the ONE trust boundary for the panel's innerHTML/insertAdjacentHTML:
  // every value from the document that reaches the markup goes through escapeText
  // (labels) or escapeAttr (icon path, fontFamily); colours are computed hex, and
  // node ids are never emitted (they live only in hitTargets). Numbers pass through
  // `n()`. So the panel can inject this without a second sanitize pass.
  return {
    svg,
    viewBox,
    width: viewBox.w,
    height: viewBox.h,
    hitTargets: ordered.map((node) => ({
      id: node.id,
      rect: rectOf(node),
      container: isContainer(node),
    })),
  }
}

function pickPage(doc: DigramDocument, selector?: string): DigramPage {
  const pages = doc.pages ?? []
  if (!pages.length) return { id: 'p1' }
  if (!selector) return pages[0]
  const byId = pages.find((page) => page.id === selector)
  if (byId) return byId
  const index = Number.parseInt(selector, 10)
  return Number.isInteger(index) && index >= 0 && index < pages.length ? pages[index] : pages[0]
}

/**
 * 绘制次序：按 parent 深度升序，同深度按 z 升序，再按文档顺序稳定排。
 *
 * 深度优先于 z：一个层（group）必须画在它的组件后面，否则层底色会盖掉组件。让 z
 * 跨深度生效就会出现「组件被自己的层盖住」，那是作者永远调不出来的。
 */
function paintOrder(nodes: DigramNode[]): DigramNode[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const depthOf = (node: DigramNode): number => {
    let depth = 0
    let cursor = node.parent
    const seen = new Set<string>([node.id])
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      depth += 1
      cursor = byId.get(cursor)?.parent
    }
    return depth
  }
  return nodes
    .map((node, index) => ({ node, index, depth: depthOf(node) }))
    .sort(
      (a, b) =>
        a.depth - b.depth
        || (a.node.z ?? NODE_DEFAULTS.z) - (b.node.z ?? NODE_DEFAULTS.z)
        || a.index - b.index,
    )
    .map((entry) => entry.node)
}

/**
 * 内容边界。不用页面 size：页面尺寸是作者声明的画布，实际内容常常只占一角或者
 * 超出去，按内容收边才能让面板「适应窗口」真的贴合。
 *
 * 框外标签（icon 的 below、text 的 above）会伸出节点矩形，所以要按渲染后的文字块
 * 高度把边界撑开——否则导出的 PNG 会把图标下面的字裁掉。
 */
function contentBounds(
  nodes: DigramNode[],
  edges: DigramEdge[],
  padding: number,
  theme: DigramTheme,
  measurer: TextMeasurer,
): Rect {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  const grow = (x: number, y: number) => {
    minX = Math.min(minX, x)
    minY = Math.min(minY, y)
    maxX = Math.max(maxX, x)
    maxY = Math.max(maxY, y)
  }
  for (const node of nodes) {
    grow(node.x, node.y)
    grow(node.x + node.w, node.y + node.h)
    const placement = placementOf(node)
    if (node.label && placement !== 'inside') {
      const block = outsideLabel(node, theme, measurer)
      grow(node.x, block.y)
      grow(node.x + node.w, block.y + block.height)
    }
  }
  for (const edge of edges) {
    for (const point of edge.waypoints ?? []) grow(point.x, point.y)
  }
  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 320, h: 180 }
  return {
    x: minX - padding,
    y: minY - padding,
    w: Math.max(1, maxX - minX + padding * 2),
    h: Math.max(1, maxY - minY + padding * 2),
  }
}

function gridLayer(viewBox: Rect, grid: number, theme: DigramTheme): string {
  if (!grid || grid < 2) return ''
  const lines: string[] = []
  const first = (value: number) => Math.ceil(value / grid) * grid
  for (let x = first(viewBox.x); x < viewBox.x + viewBox.w; x += grid) {
    lines.push(`M ${n(x)} ${n(viewBox.y)} V ${n(viewBox.y + viewBox.h)}`)
  }
  for (let y = first(viewBox.y); y < viewBox.y + viewBox.h; y += grid) {
    lines.push(`M ${n(viewBox.x)} ${n(y)} H ${n(viewBox.x + viewBox.w)}`)
  }
  return `<path d="${lines.join(' ')}" stroke="${theme.grid}" stroke-width="1" fill="none"/>`
}

// -------------------------------------------------------------------- 节点

function nodeSvg(
  node: DigramNode,
  theme: DigramTheme,
  measurer: TextMeasurer,
  options: RenderOptions,
): string {
  const shape = shapeOf(node)
  const rect = rectOf(node)
  const colors = resolveTone(
    theme,
    node.tone ?? NODE_DEFAULTS.tone,
    node.variant ?? NODE_DEFAULTS.variant,
  )
  const parts: string[] = []

  if (shape === 'text') {
    // 无框：只有字，连描边都不画。
    parts.push(labelSvg(node, rect, colors.text, theme, measurer))
    return group(node, parts, theme)
  }

  if (shape === 'actor') {
    // 火柴人是线条形，填充没有意义。
    parts.push(
      `<path d="${shapePath(shape, rect, 0)}" fill="none" stroke="${colors.stroke === 'none' ? colors.text : colors.stroke}"`
      + ` stroke-width="${n(theme.strokeWidth)}" stroke-linecap="round"/>`,
    )
    parts.push(labelSvg(node, rect, colors.text, theme, measurer))
    return group(node, parts, theme)
  }

  const radius = radiusFor(theme, shape, node.h, node.radius)
  const fill = colors.fill === 'none' ? 'none' : colors.fill
  const stroke
    = colors.stroke === 'none'
      ? ''
      : ` stroke="${colors.stroke}" stroke-width="${n(theme.strokeWidth)}"`
  parts.push(`<path d="${shapePath(shape, rect, radius)}" fill="${fill}"${stroke}/>`)

  if (shape === 'icon') {
    parts.push(iconSvg(node, rect, colors.text, options))
  }
  parts.push(labelSvg(node, rect, colors.text, theme, measurer))
  return group(node, parts, theme)
}

/** 旋转过的节点包一层 transform；没旋转就不包，产物少一层噪声。 */
function group(node: DigramNode, parts: string[], _theme: DigramTheme): string {
  const body = parts.filter(Boolean).join('')
  const rotate = node.rotate ?? NODE_DEFAULTS.rotate
  if (!rotate) return body
  const center = centerOf(rectOf(node))
  return `<g transform="rotate(${n(rotate)} ${n(center.x)} ${n(center.y)})">${body}</g>`
}

/**
 * 图标字形。目录由面板注入（`options.icons`），渲染器只把字形缩放到框内。
 * 目录图标来自 phosphor，256 网格；内联 `path:` 是手写逐字形，按 SVG 惯例的
 * 24 网格。找不到字形时画一个描边占位方框而不是什么都不画——静默消失会让作者
 * 以为图标名对了。
 */
function iconSvg(
  node: DigramNode,
  rect: Rect,
  color: string,
  options: RenderOptions,
): string {
  const key = node.icon ?? ''
  // `path:<d>` 是内联逃生口：自带字形不必先进目录。
  const inline = key.startsWith('path:') ? key.slice(5) : undefined
  const path = inline ?? options.icons?.[key]
  // 图标画在框内居中的正方形里，四周留 15%，字才不会贴边。
  const side = Math.min(rect.w, rect.h) * 0.7
  const left = rect.x + (rect.w - side) / 2
  const top = rect.y + (rect.h - side) / 2
  if (!path) {
    return (
      `<rect x="${n(left)}" y="${n(top)}" width="${n(side)}" height="${n(side)}" rx="3"`
      + ` fill="none" stroke="${color}" stroke-width="1" stroke-dasharray="3 2" opacity="0.5"/>`
    )
  }
  const grid = inline ? 24 : 256
  const scale = side / grid
  return (
    `<g transform="translate(${n(left)} ${n(top)}) scale(${n(scale)})">`
    + `<path d="${escapeAttr(path)}" fill="${color}"/></g>`
  )
}

/** 框外标签占的那一块（y 与高度），用于撑开内容边界并给 labelSvg 定位。 */
function outsideLabel(
  node: DigramNode,
  theme: DigramTheme,
  measurer: TextMeasurer,
): { y: number; height: number; wrapped: ReturnType<typeof wrapLabel> } {
  const fontSize = node.fontSize ?? theme.fontSize
  const weight = node.fontWeight ?? NODE_DEFAULTS.fontWeight
  // 框外标签的可用宽度放宽到节点宽的 1.6 倍：图标只有 48px 宽，标签按 48 折行会
  // 一个字一行。
  const wrapped = wrapLabel(node.label ?? '', Math.max(node.w * 1.6, 80), 1e6, fontSize, weight, measurer)
  const gap = 6
  const below = placementOf(node) === 'below'
  return {
    y: below ? node.y + node.h + gap : node.y - gap - wrapped.height,
    height: wrapped.height,
    wrapped,
  }
}

function labelSvg(
  node: DigramNode,
  rect: Rect,
  color: string,
  theme: DigramTheme,
  measurer: TextMeasurer,
): string {
  if (!node.label) return ''
  const placement = placementOf(node)
  const align = node.labelAlign ?? NODE_DEFAULTS.labelAlign
  const weight = node.fontWeight ?? NODE_DEFAULTS.fontWeight
  const fontSize = node.fontSize ?? theme.fontSize

  if (placement !== 'inside') {
    const block = outsideLabel(node, theme, measurer)
    return textBlock(
      block.wrapped.lines,
      block.wrapped.fontSize,
      weight,
      color,
      // 框外标签一律以节点水平中心为基准居中：图标下面的字偏一边看着像错位。
      rect.x + rect.w / 2,
      block.y,
      'center',
    )
  }

  // 框内：左右各留一个内边距，垂直按 valign 摆。group（层）的内边距给大一些，层名
  // 才不会贴在层框的边线上。
  const padX = isContainer(node) ? 22 : 10
  const padY = 6
  const wrapped = wrapLabel(
    node.label,
    Math.max(8, rect.w - padX * 2),
    Math.max(fontSize, rect.h - padY * 2),
    fontSize,
    weight,
    measurer,
  )
  if (!wrapped.lines.length) return ''
  const valign = node.labelValign ?? NODE_DEFAULTS.labelValign
  const top
    = valign === 'top'
      ? rect.y + padY
      : valign === 'bottom'
        ? rect.y + rect.h - padY - wrapped.height
        : rect.y + (rect.h - wrapped.height) / 2
  const anchorX
    = align === 'start'
      ? rect.x + padX
      : align === 'end'
        ? rect.x + rect.w - padX
        : rect.x + rect.w / 2
  return textBlock(wrapped.lines, wrapped.fontSize, weight, color, anchorX, top, align)
}

/** 一块多行文字。`top` 是文字块顶边，第一行基线由行高推出。 */
function textBlock(
  lines: string[],
  fontSize: number,
  weight: 'regular' | 'medium',
  color: string,
  anchorX: number,
  top: number,
  align: 'start' | 'center' | 'end',
): string {
  if (!lines.length) return ''
  const anchor = align === 'start' ? 'start' : align === 'end' ? 'end' : 'middle'
  // 基线放在行盒内偏下：行高 1.35 里字身约占 0.72，视觉居中在 ~0.75 处。
  const firstBaseline = top + fontSize * 0.75 + (fontSize * (LINE_HEIGHT - 1)) / 2
  const spans = lines
    .map(
      (line, index) =>
        `<tspan x="${n(anchorX)}" y="${n(firstBaseline + index * fontSize * LINE_HEIGHT)}">${escapeText(line)}</tspan>`,
    )
    .join('')
  return (
    `<text text-anchor="${anchor}" font-size="${n(fontSize)}"`
    + ` font-weight="${weight === 'medium' ? 500 : 400}" fill="${color}">${spans}</text>`
  )
}

// ---------------------------------------------------------------------- 边

function edgeSvg(
  edge: DigramEdge,
  byId: Map<string, DigramNode>,
  theme: DigramTheme,
): string {
  const geometry = geometryFor(edge, byId, theme)
  if (!geometry) return ''
  const colors = resolveEdgeTone(theme, edge.tone ?? EDGE_DEFAULTS.tone)
  const route = edge.route ?? EDGE_DEFAULTS.route
  const points = geometry.points.slice()

  const heads: string[] = []
  const toKind = edge.arrowTo ?? EDGE_DEFAULTS.arrowTo
  const fromKind = edge.arrowFrom ?? EDGE_DEFAULTS.arrowFrom
  // 箭头先算、线后画：箭头要把线截短，否则线头会从三角尖端探出去。
  if (toKind !== 'none' && points.length >= 2) {
    const head = arrowHead(toKind, points[points.length - 1], points[points.length - 2], theme.arrowSize)
    if (head) {
      heads.push(`<path d="${head.path}" fill="${colors.stroke}"/>`)
      points[points.length - 1] = head.trimTo
    }
  }
  if (fromKind !== 'none' && points.length >= 2) {
    const head = arrowHead(fromKind, points[0], points[1], theme.arrowSize)
    if (head) {
      heads.push(`<path d="${head.path}" fill="${colors.stroke}"/>`)
      points[0] = head.trimTo
    }
  }

  const path
    = route === 'curve'
      ? curvePath({ ...geometry, points }, theme.stubLength * 2)
      : polylinePath(points, route === 'straight' ? 0 : theme.cornerRadius)
  const dash = (edge.dash ?? EDGE_DEFAULTS.dash) ? ' stroke-dasharray="6 4"' : ''
  return (
    `<path d="${path}" fill="none" stroke="${colors.stroke}" stroke-width="${n(theme.strokeWidth)}"`
    + ` stroke-linecap="round" stroke-linejoin="round"${dash}/>`
    + heads.join('')
  )
}

function geometryFor(
  edge: DigramEdge,
  byId: Map<string, DigramNode>,
  theme: DigramTheme,
): ReturnType<typeof edgeGeometry> | null {
  const from = byId.get(edge.from)
  const to = byId.get(edge.to)
  // 端点缺失的边在 Rust 侧就被校验拦住了；这里静默跳过而不是抛，是因为渲染器也
  // 服务编辑中的临时状态（正在拖一条新边）。
  if (!from || !to) return null
  return edgeGeometry(
    rectOf(from),
    rectOf(to),
    edge.fromSide ?? EDGE_DEFAULTS.fromSide,
    edge.toSide ?? EDGE_DEFAULTS.toSide,
    edge.route ?? EDGE_DEFAULTS.route,
    edge.waypoints,
    theme.stubLength,
  )
}

/** 边标签。带一块纸色底衬，压在线上才读得清。 */
function edgeLabelSvg(
  edge: DigramEdge,
  byId: Map<string, DigramNode>,
  theme: DigramTheme,
  measurer: TextMeasurer,
): string {
  if (!edge.label) return ''
  const geometry = geometryFor(edge, byId, theme)
  if (!geometry) return ''
  const anchor = midpointOf(geometry.points)
  const colors = resolveEdgeTone(theme, edge.tone ?? EDGE_DEFAULTS.tone)
  const fontSize = theme.fontSize - 2
  const wrapped = wrapLabel(edge.label, 220, 1e6, fontSize, 'regular', measurer)
  if (!wrapped.lines.length) return ''
  const width = wrapped.width + EDGE_LABEL_PAD * 2
  const height = wrapped.height + EDGE_LABEL_PAD
  return (
    `<rect x="${n(anchor.x - width / 2)}" y="${n(anchor.y - height / 2)}" width="${n(width)}"`
    + ` height="${n(height)}" rx="3" fill="${theme.paper}"/>`
    + textBlock(
      wrapped.lines,
      wrapped.fontSize,
      'regular',
      colors.text,
      anchor.x,
      anchor.y - wrapped.height / 2,
      'center',
    )
  )
}

/** 折线的中点（按弧长，不是折点数组的中间那个点）。标签摆在视觉中段才不会贴到框。 */
function midpointOf(points: Array<{ x: number; y: number }>): { x: number; y: number } {
  if (points.length < 2) return points[0] ?? { x: 0, y: 0 }
  const lengths: number[] = []
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    const segment = Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y)
    lengths.push(segment)
    total += segment
  }
  let walked = 0
  for (let index = 0; index < lengths.length; index += 1) {
    if (walked + lengths[index] >= total / 2) {
      const ratio = lengths[index] ? (total / 2 - walked) / lengths[index] : 0
      return {
        x: points[index].x + (points[index + 1].x - points[index].x) * ratio,
        y: points[index].y + (points[index + 1].y - points[index].y) * ratio,
      }
    }
    walked += lengths[index]
  }
  return points[points.length - 1]
}

function selectionSvg(rect: Rect, theme: DigramTheme): string {
  const pad = 3
  const outline: Rect = {
    x: rect.x - pad,
    y: rect.y - pad,
    w: rect.w + pad * 2,
    h: rect.h + pad * 2,
  }
  return (
    `<path d="${roundedRectPath(outline, 4)}" fill="none" stroke="${theme.selection}"`
    + ` stroke-width="1.5" stroke-dasharray="4 3"/>`
  )
}

// ------------------------------------------------------------------- 转义

/** SVG 文本节点转义。`&` 必须先换，否则会二次转义已生成的实体。 */
function escapeText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(text: string): string {
  return escapeText(text).replace(/"/g, '&quot;')
}
