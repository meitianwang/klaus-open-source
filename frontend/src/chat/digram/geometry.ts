// 几何：形状轮廓、边的锚点与走线、箭头。
//
// 全部是纯函数，输入数字输出路径串——这样每种形状和每种走线都能在 bun 测试里断言，
// 不需要 DOM。
//
// 箭头刻意用显式三角路径而不是 SVG `<marker>`：产物要被序列化成独立 SVG 再喂
// canvas 做 PNG/JPG，marker 在这条链上有实现差异（`context-stroke` 尤其），而每个
// tone 一个 marker 又要造八份 defs。算出三角形三个点最省事也最稳。

import type { Arrow, DigramNode, Point, Route, Shape, Side } from './types'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const rectOf = (node: DigramNode): Rect => ({ x: node.x, y: node.y, w: node.w, h: node.h })
export const centerOf = (rect: Rect): Point => ({ x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 })

/** 数字落成路径串。定长小数，golden 快照才不会因浮点尾差抖动。 */
export const n = (value: number): string => {
  const rounded = Math.round(value * 100) / 100
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

// ------------------------------------------------------------------ 形状轮廓

/** 一个形状的 SVG path。`radius` 只对矩形族有意义。 */
export function shapePath(shape: Shape, rect: Rect, radius: number): string {
  const { x, y, w, h } = rect
  const right = x + w
  const bottom = y + h
  switch (shape) {
    case 'ellipse':
      return ellipsePath(rect)
    case 'diamond':
      return `M ${n(x + w / 2)} ${n(y)} L ${n(right)} ${n(y + h / 2)} L ${n(x + w / 2)} ${n(bottom)} L ${n(x)} ${n(y + h / 2)} Z`
    case 'hexagon': {
      // 斜边取高的 1/4，宽窄框都还认得出是六边形。
      const inset = Math.min(w / 4, h / 2)
      return `M ${n(x + inset)} ${n(y)} L ${n(right - inset)} ${n(y)} L ${n(right)} ${n(y + h / 2)} L ${n(right - inset)} ${n(bottom)} L ${n(x + inset)} ${n(bottom)} L ${n(x)} ${n(y + h / 2)} Z`
    }
    case 'parallelogram': {
      const skew = Math.min(w / 5, h / 2)
      return `M ${n(x + skew)} ${n(y)} L ${n(right)} ${n(y)} L ${n(right - skew)} ${n(bottom)} L ${n(x)} ${n(bottom)} Z`
    }
    case 'cylinder': {
      // 上下各一个椭圆盖；盖高取高的 1/6，封顶但不至于把框吃满。
      const lid = Math.min(h / 6, w / 4)
      return (
        `M ${n(x)} ${n(y + lid)} A ${n(w / 2)} ${n(lid)} 0 0 1 ${n(right)} ${n(y + lid)}`
        + ` L ${n(right)} ${n(bottom - lid)} A ${n(w / 2)} ${n(lid)} 0 0 1 ${n(x)} ${n(bottom - lid)} Z`
      )
    }
    case 'document': {
      // 底边一道波浪，是「文档/报表」的通用画法。
      const wave = Math.min(h / 6, 18)
      return (
        `M ${n(x)} ${n(y)} L ${n(right)} ${n(y)} L ${n(right)} ${n(bottom - wave)}`
        + ` C ${n(right - w / 4)} ${n(bottom)} ${n(x + w / 4)} ${n(bottom - wave * 2)} ${n(x)} ${n(bottom - wave)} Z`
      )
    }
    case 'note': {
      // 右上折角。
      const fold = Math.min(w / 5, h / 3, 20)
      return (
        `M ${n(x)} ${n(y)} L ${n(right - fold)} ${n(y)} L ${n(right)} ${n(y + fold)}`
        + ` L ${n(right)} ${n(bottom)} L ${n(x)} ${n(bottom)} Z`
      )
    }
    case 'actor':
      return actorPath(rect)
    case 'cloud':
      return cloudPath(rect)
    default:
      // rect / rounded / pill / group / icon / text 都是圆角矩形族，差别只在半径。
      return roundedRectPath(rect, radius)
  }
}

export function roundedRectPath(rect: Rect, radius: number): string {
  const { x, y, w, h } = rect
  const r = Math.max(0, Math.min(radius, w / 2, h / 2))
  if (r <= 0) {
    return `M ${n(x)} ${n(y)} H ${n(x + w)} V ${n(y + h)} H ${n(x)} Z`
  }
  return (
    `M ${n(x + r)} ${n(y)} H ${n(x + w - r)} A ${n(r)} ${n(r)} 0 0 1 ${n(x + w)} ${n(y + r)}`
    + ` V ${n(y + h - r)} A ${n(r)} ${n(r)} 0 0 1 ${n(x + w - r)} ${n(y + h)}`
    + ` H ${n(x + r)} A ${n(r)} ${n(r)} 0 0 1 ${n(x)} ${n(y + h - r)}`
    + ` V ${n(y + r)} A ${n(r)} ${n(r)} 0 0 1 ${n(x + r)} ${n(y)} Z`
  )
}

function ellipsePath(rect: Rect): string {
  const cx = rect.x + rect.w / 2
  const rx = rect.w / 2
  const ry = rect.h / 2
  const cy = rect.y + ry
  return (
    `M ${n(rect.x)} ${n(cy)} A ${n(rx)} ${n(ry)} 0 0 1 ${n(rect.x + rect.w)} ${n(cy)}`
    + ` A ${n(rx)} ${n(ry)} 0 0 1 ${n(rect.x)} ${n(cy)} Z`
  )
}

/** 火柴人。头是圆，身体四笔；用一条 path 画完，描边即可，不需要填充。 */
function actorPath(rect: Rect): string {
  const cx = rect.x + rect.w / 2
  const headR = Math.min(rect.w / 4, rect.h / 5)
  const headCy = rect.y + headR
  const shoulders = headCy + headR * 1.4
  const hip = rect.y + rect.h * 0.62
  const bottom = rect.y + rect.h
  const arm = rect.w / 2
  return (
    `M ${n(cx - headR)} ${n(headCy)} A ${n(headR)} ${n(headR)} 0 0 1 ${n(cx + headR)} ${n(headCy)}`
    + ` A ${n(headR)} ${n(headR)} 0 0 1 ${n(cx - headR)} ${n(headCy)}`
    + ` M ${n(cx)} ${n(headCy + headR)} V ${n(hip)}`
    + ` M ${n(cx - arm)} ${n(shoulders)} H ${n(cx + arm)}`
    + ` M ${n(cx)} ${n(hip)} L ${n(cx - arm * 0.7)} ${n(bottom)}`
    + ` M ${n(cx)} ${n(hip)} L ${n(cx + arm * 0.7)} ${n(bottom)}`
  )
}

/** 云。三个上凸弧 + 一条底边，比 drawio 那个九段云简单但读得出来。 */
function cloudPath(rect: Rect): string {
  const { x, y, w, h } = rect
  const bottom = y + h
  const baseY = y + h * 0.72
  return (
    `M ${n(x + w * 0.2)} ${n(bottom)}`
    + ` A ${n(w * 0.2)} ${n(h * 0.28)} 0 0 1 ${n(x + w * 0.18)} ${n(baseY)}`
    + ` A ${n(w * 0.22)} ${n(h * 0.34)} 0 0 1 ${n(x + w * 0.42)} ${n(y + h * 0.24)}`
    + ` A ${n(w * 0.24)} ${n(h * 0.3)} 0 0 1 ${n(x + w * 0.78)} ${n(y + h * 0.3)}`
    + ` A ${n(w * 0.2)} ${n(h * 0.3)} 0 0 1 ${n(x + w * 0.86)} ${n(bottom)}`
    + ` Z`
  )
}

// ------------------------------------------------------------------ 边的走线

interface Anchor {
  point: Point
  side: Exclude<Side, 'auto'>
}

/** 一条边解出来的走线：折点序列（含两端锚点）。 */
export interface EdgeGeometry {
  points: Point[]
  from: Anchor
  to: Anchor
}

/**
 * 解锚点。`auto` 按两框中心的相对位置选主轴那一侧——两框左右排就左右接，上下排就
 * 上下接。这是绝大多数边不需要显式写 side 的原因。
 */
function resolveAnchor(rect: Rect, other: Point, requested: Side): Anchor {
  const center = centerOf(rect)
  let side: Exclude<Side, 'auto'>
  if (requested !== 'auto') {
    side = requested
  } else {
    const dx = other.x - center.x
    const dy = other.y - center.y
    // 用框的长宽归一化再比：扁框该走左右，高框该走上下，直接比像素会让扁框从顶边出。
    side
      = Math.abs(dx) / Math.max(1, rect.w) >= Math.abs(dy) / Math.max(1, rect.h)
        ? dx >= 0
          ? 'right'
          : 'left'
        : dy >= 0
          ? 'bottom'
          : 'top'
  }
  const point
    = side === 'top'
      ? { x: center.x, y: rect.y }
      : side === 'bottom'
        ? { x: center.x, y: rect.y + rect.h }
        : side === 'left'
          ? { x: rect.x, y: center.y }
          : { x: rect.x + rect.w, y: center.y }
  return { point, side }
}

const OUTWARD: Record<Exclude<Side, 'auto'>, Point> = {
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
}

/**
 * 算一条边的折点。
 *
 * 有显式 waypoints 就照走（作者手调过的线不能被自动路由推翻）。没有的话：
 *   - straight：两锚点直连；
 *   - orthogonal：两端各先按法线出一小段（stub），再用一条 Z/L 折线连起来；
 *   - curve：两锚点 + 两个按法线外推的控制点，交给渲染面画三次贝塞尔。
 */
export function edgeGeometry(
  fromRect: Rect,
  toRect: Rect,
  fromSide: Side,
  toSide: Side,
  route: Route,
  waypoints: Point[] | undefined,
  stub: number,
): EdgeGeometry {
  const via = waypoints && waypoints.length ? waypoints : null
  const from = resolveAnchor(fromRect, via ? via[0] : centerOf(toRect), fromSide)
  const to = resolveAnchor(toRect, via ? via[via.length - 1] : centerOf(fromRect), toSide)
  if (via) {
    return { points: [from.point, ...via, to.point], from, to }
  }
  if (route === 'straight' || route === 'curve') {
    return { points: [from.point, to.point], from, to }
  }
  return { points: orthogonalPoints(from, to, stub), from, to }
}

/** 正交折线。同轴对齐时直连，否则在两个 stub 端点之间按出发侧的轴向折一次。 */
function orthogonalPoints(from: Anchor, to: Anchor, stub: number): Point[] {
  const a = from.point
  const b = to.point
  const aOut = OUTWARD[from.side]
  const bOut = OUTWARD[to.side]
  const a1 = { x: a.x + aOut.x * stub, y: a.y + aOut.y * stub }
  const b1 = { x: b.x + bOut.x * stub, y: b.y + bOut.y * stub }
  // 已经对齐：一条直线就够，硬折出 stub 反而画出多余的台阶。
  if (Math.abs(a.x - b.x) < 0.5 && aOut.x === 0 && bOut.x === 0) return [a, b]
  if (Math.abs(a.y - b.y) < 0.5 && aOut.y === 0 && bOut.y === 0) return [a, b]
  const horizontalFirst = aOut.x !== 0
  const mid = horizontalFirst
    ? [
        { x: a1.x, y: a1.y },
        { x: a1.x, y: b1.y },
        { x: b1.x, y: b1.y },
      ]
    : [
        { x: a1.x, y: a1.y },
        { x: b1.x, y: a1.y },
        { x: b1.x, y: b1.y },
      ]
  return dedupe([a, ...mid, b])
}

function dedupe(points: Point[]): Point[] {
  const out: Point[] = []
  for (const point of points) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.x - point.x) < 0.5 && Math.abs(last.y - point.y) < 0.5) continue
    out.push(point)
  }
  return out
}

/**
 * 折线 → path，拐角倒圆角。
 *
 * 圆角半径按相邻两段的一半取小，短段也不会被啃穿——这是折线看起来是「一条流畅的
 * 线」而不是「几根拼起来的棍」的关键。
 */
export function polylinePath(points: Point[], corner: number): string {
  if (points.length < 2) return ''
  if (points.length === 2) {
    return `M ${n(points[0].x)} ${n(points[0].y)} L ${n(points[1].x)} ${n(points[1].y)}`
  }
  let path = `M ${n(points[0].x)} ${n(points[0].y)}`
  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1]
    const current = points[index]
    const next = points[index + 1]
    const inLength = distance(previous, current)
    const outLength = distance(current, next)
    const r = Math.min(corner, inLength / 2, outLength / 2)
    if (r < 0.5) {
      path += ` L ${n(current.x)} ${n(current.y)}`
      continue
    }
    const enter = along(current, previous, r)
    const exit = along(current, next, r)
    path += ` L ${n(enter.x)} ${n(enter.y)} Q ${n(current.x)} ${n(current.y)} ${n(exit.x)} ${n(exit.y)}`
  }
  const last = points[points.length - 1]
  return `${path} L ${n(last.x)} ${n(last.y)}`
}

/** 单段三次贝塞尔，控制点按两端法线外推。`curve` 走线用。 */
export function curvePath(geometry: EdgeGeometry, bow: number): string {
  const a = geometry.points[0]
  const b = geometry.points[geometry.points.length - 1]
  const aOut = OUTWARD[geometry.from.side]
  const bOut = OUTWARD[geometry.to.side]
  const reach = Math.max(bow, distance(a, b) / 3)
  const c1 = { x: a.x + aOut.x * reach, y: a.y + aOut.y * reach }
  const c2 = { x: b.x + bOut.x * reach, y: b.y + bOut.y * reach }
  return `M ${n(a.x)} ${n(a.y)} C ${n(c1.x)} ${n(c1.y)} ${n(c2.x)} ${n(c2.y)} ${n(b.x)} ${n(b.y)}`
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** 从 `origin` 朝 `toward` 走 `length`。 */
function along(origin: Point, toward: Point, length: number): Point {
  const total = distance(origin, toward) || 1
  return {
    x: origin.x + ((toward.x - origin.x) / total) * length,
    y: origin.y + ((toward.y - origin.y) / total) * length,
  }
}

// -------------------------------------------------------------------- 箭头

export interface ArrowHead {
  /** 填充路径（arrow / diamond / dot 都是闭合形）。 */
  path: string
  /** 线段该缩到哪里——箭头占掉的那一截不能再画线，否则线头会从三角形尖端探出。 */
  trimTo: Point
}

/**
 * 端点箭头。`tip` 是端点，`from` 是线上的前一个点（决定朝向）。
 */
export function arrowHead(kind: Arrow, tip: Point, from: Point, size: number): ArrowHead | null {
  if (kind === 'none') return null
  const total = distance(from, tip) || 1
  const ux = (tip.x - from.x) / total
  const uy = (tip.y - from.y) / total
  // 法线，用来撑开三角形的两个底角。
  const nx = -uy
  const ny = ux
  if (kind === 'dot') {
    const r = size * 0.36
    const cx = tip.x - ux * r
    const cy = tip.y - uy * r
    return {
      path:
        `M ${n(cx - r)} ${n(cy)} A ${n(r)} ${n(r)} 0 0 1 ${n(cx + r)} ${n(cy)}`
        + ` A ${n(r)} ${n(r)} 0 0 1 ${n(cx - r)} ${n(cy)} Z`,
      trimTo: { x: tip.x - ux * r * 2, y: tip.y - uy * r * 2 },
    }
  }
  if (kind === 'diamond') {
    const half = size * 0.45
    const back = { x: tip.x - ux * size, y: tip.y - uy * size }
    const mid = { x: tip.x - ux * (size / 2), y: tip.y - uy * (size / 2) }
    return {
      path:
        `M ${n(tip.x)} ${n(tip.y)} L ${n(mid.x + nx * half)} ${n(mid.y + ny * half)}`
        + ` L ${n(back.x)} ${n(back.y)} L ${n(mid.x - nx * half)} ${n(mid.y - ny * half)} Z`,
      trimTo: back,
    }
  }
  const half = size * 0.42
  const back = { x: tip.x - ux * size, y: tip.y - uy * size }
  return {
    path:
      `M ${n(tip.x)} ${n(tip.y)} L ${n(back.x + nx * half)} ${n(back.y + ny * half)}`
      + ` L ${n(back.x - nx * half)} ${n(back.y - ny * half)} Z`,
    // 线缩到三角形底边稍内，避免线宽在尖角处露出毛刺。
    trimTo: { x: tip.x - ux * (size * 0.85), y: tip.y - uy * (size * 0.85) },
  }
}

/** 命中测试用：点在矩形内。编辑面共用，放这里以免几何判定散两处。 */
export function hitRect(rect: Rect, point: Point, slop = 0): boolean {
  return (
    point.x >= rect.x - slop
    && point.x <= rect.x + rect.w + slop
    && point.y >= rect.y - slop
    && point.y <= rect.y + rect.h + slop
  )
}
