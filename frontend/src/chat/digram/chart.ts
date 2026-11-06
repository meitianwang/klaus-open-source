// Data charts inside a node box.
//
// chartSvg is a pure function like the rest of the renderer: node box, resolved
// theme and measurer in, SVG fragment out. Every label goes through escapeText
// and every number through n(), so the fragment is safe to concatenate into the
// single render() trust boundary. All layout math is deterministic — no clocks,
// no randomness — so golden tests can pin exact output.
//
// The chart draws inside the node's frame (render.ts paints the frame first and
// skips the normal label path for chart nodes); node.label becomes the chart
// title. Charts never touch the node border: everything stays inside a padded
// inner rect, and a box too small for a chart renders title-only instead of
// garbage.

import { n, type Rect } from './geometry'
import type { TextMeasurer } from './measure'
import { baseColor, inkColor, mixColors, resolveEdgeTone, type DigramTheme } from './theme'
import { escapeText } from './escape'
import type { ChartFlow, ChartSeries, ChartSlice, ChartSpec, ChartTask, DigramNode, Tone } from './types'

const PAD = 14
/** Series without an explicit tone cycle through this order: accent leads. */
const ROTATION: Tone[] = ['accent', 'info', 'success', 'warning', 'violet', 'teal', 'danger', 'neutral']

// ------------------------------------------------------------------ helpers

function textEl(
  content: string,
  x: number,
  y: number,
  size: number,
  fill: string,
  anchor: 'start' | 'middle' | 'end',
  weight: 400 | 500 = 400,
): string {
  return (
    `<text x="${n(x)}" y="${n(y)}" font-size="${n(size)}" font-weight="${weight}"`
    + ` fill="${fill}" text-anchor="${anchor}">${escapeText(content)}</text>`
  )
}

/** Truncate to fit a pixel budget, ending with an ellipsis. */
function fitText(text: string, maxWidth: number, size: number, measurer: TextMeasurer): string {
  if (maxWidth <= 0) return ''
  if (measurer.width(text, size, 'regular') <= maxWidth) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    if (measurer.width(`${text.slice(0, mid)}…`, size, 'regular') <= maxWidth) low = mid
    else high = mid - 1
  }
  return low > 0 ? `${text.slice(0, low)}…` : '…'
}

function trimNumber(value: number, decimals: number): string {
  const fixed = value.toFixed(decimals)
  return fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed
}

/** Compact value labels: 1200 → 1.2k, 3400000 → 3.4M, small values keep 2 decimals. */
function formatValue(value: number, unit?: string): string {
  const abs = Math.abs(value)
  let text: string
  if (abs >= 1e6) text = `${trimNumber(value / 1e6, 1)}M`
  else if (abs >= 1e4) text = `${trimNumber(value / 1e3, 1)}k`
  else text = trimNumber(value, abs < 10 && !Number.isInteger(value) ? 2 : 0)
  return unit ? `${text} ${unit}` : text
}

interface Scale {
  min: number
  max: number
  ticks: number[]
}

/** Human-friendly axis scale: 1/2/2.5/5×10ⁿ steps, domain padded to tick bounds. */
function niceScale(min: number, max: number, target = 4): Scale {
  if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) return { min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] }
  if (min === max) {
    if (min === 0) max = 1
    else {
      const pad = Math.abs(min) * 0.1 || 1
      min -= pad
      max += pad
    }
  }
  const rawStep = (max - min) / Math.max(1, target)
  const mag = 10 ** Math.floor(Math.log10(rawStep))
  const norm = rawStep / mag
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag
  const niceMin = Math.floor(min / step) * step
  const niceMax = Math.ceil(max / step) * step
  const ticks: number[] = []
  for (let value = niceMin; value <= niceMax + step * 0.5; value += step) ticks.push(Number(value.toFixed(10)))
  return { min: niceMin, max: niceMax, ticks }
}

function seriesColor(theme: DigramTheme, series: { tone?: Tone }, index: number): string {
  return baseColor(theme, series.tone ?? ROTATION[index % ROTATION.length]!)
}

interface LegendItem {
  label: string
  color: string
}

/** One horizontal legend row; items that do not fit collapse into "+N". */
function legendRow(
  items: LegendItem[],
  x: number,
  y: number,
  maxWidth: number,
  size: number,
  measurer: TextMeasurer,
  color: string,
): string {
  const parts: string[] = []
  let cursor = x
  let shown = 0
  for (const item of items) {
    const width = 8 + 4 + measurer.width(item.label, size, 'regular')
    if (shown > 0 && cursor + width > x + maxWidth) break
    parts.push(`<rect x="${n(cursor)}" y="${n(y - size * 0.75)}" width="8" height="8" rx="2" fill="${item.color}"/>`)
    parts.push(textEl(fitText(item.label, Math.max(24, x + maxWidth - cursor - 12), size, measurer), cursor + 12, y, size, color, 'start'))
    cursor += width + 14
    shown += 1
  }
  if (shown < items.length) parts.push(textEl(`+${items.length - shown}`, cursor, y, size, color, 'start'))
  return parts.join('')
}

/** Wrapped legend block (pie/donut use it at the bottom). Returns consumed height. */
function legendWrap(
  items: LegendItem[],
  x: number,
  y: number,
  maxWidth: number,
  size: number,
  measurer: TextMeasurer,
  color: string,
  maxRows: number,
): { svg: string; height: number } {
  const rowHeight = size + 6
  const rows: LegendItem[][] = [[]]
  let rowWidth = 0
  for (const item of items) {
    const width = 8 + 4 + measurer.width(item.label, size, 'regular') + 14
    if (rowWidth + width > maxWidth && rows[rows.length - 1]!.length) {
      if (rows.length >= maxRows) break
      rows.push([])
      rowWidth = 0
    }
    rows[rows.length - 1]!.push(item)
    rowWidth += width
  }
  const packed = rows.flat().length
  const parts: string[] = []
  rows.forEach((row, rowIndex) => {
    let cursor = x
    for (const item of row) {
      parts.push(`<rect x="${n(cursor)}" y="${n(y + rowIndex * rowHeight - size * 0.75)}" width="8" height="8" rx="2" fill="${item.color}"/>`)
      parts.push(textEl(item.label, cursor + 12, y + rowIndex * rowHeight, size, color, 'start'))
      cursor += 8 + 4 + measurer.width(item.label, size, 'regular') + 14
    }
  })
  if (packed < items.length) parts.push(textEl(`+${items.length - packed} more`, x, y + rows.length * rowHeight, size, color, 'start'))
  const height = (packed < items.length ? rows.length + 1 : rows.length) * rowHeight
  return { svg: parts.join(''), height }
}

interface AxisFrame {
  svg: string
  plotL: number
  plotR: number
  plotT: number
  plotB: number
  yFor: (value: number) => number
}

/**
 * Value axis for bar/line/area: left tick gutter, horizontal gridlines, axis
 * strokes and an optional bottom gutter reserved for category labels.
 */
function valueAxisFrame(
  scale: Scale,
  plot: Rect,
  theme: DigramTheme,
  measurer: TextMeasurer,
  size: number,
  unit: string | undefined,
  bottomGutter: number,
): AxisFrame {
  const axis = resolveEdgeTone(theme, 'neutral')
  const tickLabels = scale.ticks.map((tick) => formatValue(tick, unit))
  const gutterL = Math.min(72, Math.max(24, ...tickLabels.map((label) => measurer.width(label, size, 'regular'))) + 10)
  const plotL = plot.x + gutterL
  const plotR = plot.x + plot.w
  const plotT = plot.y
  const plotB = plot.y + plot.h - bottomGutter
  const plotH = Math.max(1, plotB - plotT)
  const span = scale.max - scale.min || 1
  const yFor = (value: number): number => plotB - ((value - scale.min) / span) * plotH
  const parts: string[] = []
  scale.ticks.forEach((tick) => {
    const y = yFor(tick)
    parts.push(`<line x1="${n(plotL)}" y1="${n(y)}" x2="${n(plotR)}" y2="${n(y)}" stroke="${theme.grid}" stroke-width="1"/>`)
  })
  parts.push(`<line x1="${n(plotL)}" y1="${n(plotT)}" x2="${n(plotL)}" y2="${n(plotB)}" stroke="${axis.stroke}" stroke-width="1"/>`)
  parts.push(`<line x1="${n(plotL)}" y1="${n(plotB)}" x2="${n(plotR)}" y2="${n(plotB)}" stroke="${axis.stroke}" stroke-width="1"/>`)
  scale.ticks.forEach((tick, index) => {
    parts.push(textEl(tickLabels[index]!, plotL - 5, yFor(tick) + size * 0.35, size, axis.text, 'end'))
  })
  return { svg: parts.join(''), plotL, plotR, plotT, plotB, yFor }
}

/** Shared top-of-plot legend for series charts; shrinks the plot when shown. */
function seriesLegend(
  seriesList: ChartSeries[],
  theme: DigramTheme,
  plot: Rect,
  measurer: TextMeasurer,
  size: number,
): { svg: string; plot: Rect } {
  const named = seriesList.length > 1 || seriesList.some((series) => Boolean(series.name))
  if (!named) return { svg: '', plot }
  const items = seriesList.map((series, index) => ({
    label: series.name ?? `Series ${index + 1}`,
    color: seriesColor(theme, series, index),
  }))
  const axis = resolveEdgeTone(theme, 'neutral')
  const svg = legendRow(items, plot.x, plot.y + size, plot.w, size, measurer, axis.text)
  return { svg, plot: { ...plot, y: plot.y + size + 8, h: Math.max(1, plot.h - size - 8) } }
}

function categoriesOf(chart: ChartSpec, seriesList: ChartSeries[]): string[] {
  const count = Math.max(0, ...seriesList.map((series) => series.values?.length ?? 0))
  return chart.categories ?? Array.from({ length: count }, (_, index) => String(index + 1))
}

function categoryScale(chart: ChartSpec, seriesList: ChartSeries[], stacked: boolean, zeroBased = true): Scale {
  let min = zeroBased ? 0 : Infinity
  let max = zeroBased ? 0 : -Infinity
  if (stacked) {
    const count = Math.max(chart.categories?.length ?? 0, ...seriesList.map((series) => series.values?.length ?? 0), 0)
    for (let index = 0; index < count; index += 1) {
      let positive = 0
      let negative = 0
      for (const series of seriesList) {
        const value = series.values?.[index] ?? 0
        if (value >= 0) positive += value
        else negative += value
      }
      max = Math.max(max, positive)
      min = Math.min(min, negative)
    }
  }
  else {
    for (const series of seriesList) for (const value of series.values ?? []) { max = Math.max(max, value); min = Math.min(min, value) }
  }
  if (!Number.isFinite(min)) min = 0
  if (!Number.isFinite(max)) max = min + 1
  if (max < min) max = min
  return niceScale(chart.min ?? min, chart.max ?? max)
}

function categoryLabels(
  categories: string[],
  plotL: number,
  plotR: number,
  plotB: number,
  size: number,
  measurer: TextMeasurer,
  color: string,
): string {
  if (!categories.length) return ''
  const bandW = (plotR - plotL) / categories.length
  const parts: string[] = []
  categories.forEach((category, index) => {
    const label = fitText(category, Math.max(8, bandW - 6), size, measurer)
    parts.push(textEl(label, plotL + bandW * (index + 0.5), plotB + size + 3, size, color, 'middle'))
  })
  return parts.join('')
}
// ------------------------------------------------------------ chart kinds

function barChart(chart: ChartSpec, plotIn: Rect, theme: DigramTheme, measurer: TextMeasurer, size: number): string {
  const seriesList = chart.series ?? []
  const categories = categoriesOf(chart, seriesList)
  const count = Math.max(categories.length, 1)
  const stacked = chart.stacked === true
  const legend = seriesLegend(seriesList, theme, plotIn, measurer, size)
  const plot = legend.plot
  const scale = categoryScale(chart, seriesList, stacked)
  const axis = valueAxisFrame(scale, plot, theme, measurer, size, chart.unit, size + 10)
  const axisColor = resolveEdgeTone(theme, 'neutral')
  const bandW = Math.max(1, axis.plotR - axis.plotL) / count
  const barW = stacked
    ? Math.min(Math.max(2, bandW * 0.6), 72)
    : Math.min(Math.max(2, (bandW * 0.72) / Math.max(1, seriesList.length)), 72)
  const zeroY = axis.yFor(Math.max(scale.min, Math.min(0, scale.max)))
  const parts: string[] = [legend.svg, axis.svg]
  const positive = new Array<number>(count).fill(0)
  const negative = new Array<number>(count).fill(0)
  seriesList.forEach((series, seriesIndex) => {
    const color = seriesColor(theme, series, seriesIndex)
    const values = series.values ?? []
    for (let index = 0; index < Math.min(values.length, count); index += 1) {
      const value = values[index]!
      if (!Number.isFinite(value) || value === 0) continue
      const x = stacked
        ? axis.plotL + bandW * index + (bandW - barW) / 2
        : axis.plotL + bandW * index + (bandW - barW * seriesList.length) / 2 + barW * seriesIndex
      let yTop: number
      let yBottom: number
      if (stacked) {
        if (value > 0) {
          const base = positive[index]!
          yTop = axis.yFor(base + value)
          yBottom = axis.yFor(base)
          positive[index] = base + value
        }
        else {
          const base = negative[index]!
          yTop = axis.yFor(base)
          yBottom = axis.yFor(base + value)
          negative[index] = base + value
        }
      }
      else {
        const valueY = axis.yFor(value)
        yTop = Math.min(valueY, zeroY)
        yBottom = Math.max(valueY, zeroY)
      }
      parts.push(`<rect x="${n(x)}" y="${n(yTop)}" width="${n(barW)}" height="${n(Math.max(1, yBottom - yTop))}" rx="2" fill="${color}"/>`)
      if (!stacked && seriesList.length === 1 && barW >= 20) {
        parts.push(textEl(formatValue(value, chart.unit), x + barW / 2, yTop - 4, Math.max(8, size - 1), axisColor.text, 'middle'))
      }
    }
  })
  parts.push(categoryLabels(categories, axis.plotL, axis.plotR, axis.plotB, size, measurer, axisColor.text))
  return parts.join('')
}

function lineAreaChart(chart: ChartSpec, plotIn: Rect, theme: DigramTheme, measurer: TextMeasurer, size: number, area: boolean): string {
  const seriesList = chart.series ?? []
  const categories = categoriesOf(chart, seriesList)
  const count = Math.max(categories.length, 1)
  const legend = seriesLegend(seriesList, theme, plotIn, measurer, size)
  const plot = legend.plot
  const scale = categoryScale(chart, seriesList, false, false)
  const axis = valueAxisFrame(scale, plot, theme, measurer, size, chart.unit, size + 10)
  const axisColor = resolveEdgeTone(theme, 'neutral')
  const bandW = Math.max(1, axis.plotR - axis.plotL) / count
  const xFor = (index: number): number => axis.plotL + bandW * (index + 0.5)
  const baselineY = axis.yFor(Math.max(scale.min, Math.min(0, scale.max)))
  const parts: string[] = [legend.svg, axis.svg]
  seriesList.forEach((series, seriesIndex) => {
    const color = seriesColor(theme, series, seriesIndex)
    const values = series.values ?? []
    const points: Array<{ x: number; y: number }> = []
    for (let index = 0; index < Math.min(values.length, count); index += 1) {
      const value = values[index]!
      if (!Number.isFinite(value)) continue
      points.push({ x: xFor(index), y: axis.yFor(value) })
    }
    if (!points.length) return
    const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${n(point.x)} ${n(point.y)}`).join(' ')
    if (area) {
      parts.push(
        `<path d="${line} L ${n(points[points.length - 1]!.x)} ${n(baselineY)} L ${n(points[0]!.x)} ${n(baselineY)} Z"`
        + ` fill="${color}" fill-opacity="0.14" stroke="none"/>`,
      )
    }
    const dash = series.dash ? ' stroke-dasharray="6 4"' : ''
    parts.push(
      `<path d="${line}" fill="none" stroke="${color}" stroke-width="${n(Math.max(1.5, theme.strokeWidth))}"`
      + ` stroke-linejoin="round" stroke-linecap="round"${dash}/>`,
    )
    if (points.length <= 32) {
      for (const point of points) parts.push(`<circle cx="${n(point.x)}" cy="${n(point.y)}" r="2.5" fill="${color}" stroke="${theme.paper}" stroke-width="1"/>`)
    }
  })
  parts.push(categoryLabels(categories, axis.plotL, axis.plotR, axis.plotB, size, measurer, axisColor.text))
  return parts.join('')
}

/** Pie/donut wedge. A full circle needs two half-arcs: a single arc whose
 *  endpoints coincide renders nothing. */
function arcSlice(cx: number, cy: number, r: number, inner: number, a0: number, a1: number, fill: string, separator: string): string {
  const sweep = a1 - a0
  const at = (radius: number, angle: number): { x: number; y: number } => ({ x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius })
  if (sweep >= Math.PI * 2 - 1e-6) {
    if (inner) {
      return (
        `<path d="M ${n(cx - r)} ${n(cy)} A ${n(r)} ${n(r)} 0 1 1 ${n(cx + r)} ${n(cy)} A ${n(r)} ${n(r)} 0 1 1 ${n(cx - r)} ${n(cy)} Z`
        + ` M ${n(cx - inner)} ${n(cy)} A ${n(inner)} ${n(inner)} 0 1 0 ${n(cx + inner)} ${n(cy)} A ${n(inner)} ${n(inner)} 0 1 0 ${n(cx - inner)} ${n(cy)} Z"`
        + ` fill="${fill}" fill-rule="evenodd" stroke="none"/>`
      )
    }
    return `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="${fill}" stroke="none"/>`
  }
  const large = sweep > Math.PI ? 1 : 0
  const s0 = at(r, a0)
  const s1 = at(r, a1)
  if (inner) {
    const i0 = at(inner, a0)
    const i1 = at(inner, a1)
    return (
      `<path d="M ${n(s0.x)} ${n(s0.y)} A ${n(r)} ${n(r)} 0 ${large} 1 ${n(s1.x)} ${n(s1.y)}`
      + ` L ${n(i1.x)} ${n(i1.y)} A ${n(inner)} ${n(inner)} 0 ${large} 0 ${n(i0.x)} ${n(i0.y)} Z"`
      + ` fill="${fill}" stroke="${separator}" stroke-width="1.5"/>`
    )
  }
  return (
    `<path d="M ${n(cx)} ${n(cy)} L ${n(s0.x)} ${n(s0.y)} A ${n(r)} ${n(r)} 0 ${large} 1 ${n(s1.x)} ${n(s1.y)} Z"`
    + ` fill="${fill}" stroke="${separator}" stroke-width="1.5"/>`
  )
}

function pieChart(chart: ChartSpec, plot: Rect, theme: DigramTheme, measurer: TextMeasurer, size: number, donut: boolean): string {
  const slices = (chart.slices ?? []).filter((slice) => Number.isFinite(slice.value) && slice.value > 0)
  const total = slices.reduce((sum, slice) => sum + slice.value, 0)
  if (!slices.length || total <= 0) return ''
  const axisColor = resolveEdgeTone(theme, 'neutral')
  const items = slices.map((slice, index) => ({
    label: `${slice.label || `Slice ${index + 1}`} ${trimNumber((slice.value / total) * 100, 1)}%`,
    color: seriesColor(theme, slice, index),
  }))
  // Measure the wrapped legend height first, then give the circle the rest.
  const measured = legendWrap(items, plot.x, 0, plot.w, size, measurer, axisColor.text, 3)
  const availH = Math.max(20, plot.h - measured.height - 4)
  const r = Math.max(8, Math.min(plot.w, availH) / 2 - 4)
  const cx = plot.x + plot.w / 2
  const cy = plot.y + availH / 2
  const inner = donut ? r * 0.58 : 0
  const parts: string[] = []
  let angle = -Math.PI / 2
  slices.forEach((slice, index) => {
    const sweep = (slice.value / total) * Math.PI * 2
    parts.push(arcSlice(cx, cy, r, inner, angle, angle + sweep, seriesColor(theme, slice, index), theme.paper))
    if (sweep >= 0.5) {
      const mid = angle + sweep / 2
      const labelR = inner ? (r + inner) / 2 : r * 0.62
      parts.push(
        textEl(
          `${Math.round((slice.value / total) * 100)}%`,
          cx + Math.cos(mid) * labelR,
          cy + Math.sin(mid) * labelR + size * 0.35,
          size,
          theme.paper,
          'middle',
          500,
        ),
      )
    }
    angle += sweep
  })
  const legend = legendWrap(items, plot.x, plot.y + availH + 4 + size, plot.w, size, measurer, axisColor.text, 3)
  parts.push(legend.svg)
  return parts.join('')
}

function scatterChart(chart: ChartSpec, plotIn: Rect, theme: DigramTheme, measurer: TextMeasurer, size: number): string {
  const seriesList = chart.series ?? []
  const collected: Array<{ series: ChartSeries; index: number; points: Array<{ x: number; y: number }> }> = []
  let xMin = Infinity
  let xMax = -Infinity
  let yMin = Infinity
  let yMax = -Infinity
  seriesList.forEach((series, index) => {
    const points = series.points?.length
      ? series.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
      : (series.values ?? []).map((value, at) => ({ x: at, y: value })).filter((point) => Number.isFinite(point.y))
    for (const point of points) {
      xMin = Math.min(xMin, point.x)
      xMax = Math.max(xMax, point.x)
      yMin = Math.min(yMin, point.y)
      yMax = Math.max(yMax, point.y)
    }
    collected.push({ series, index, points })
  })
  if (!Number.isFinite(xMin) || !Number.isFinite(yMin)) return ''
  const legend = seriesLegend(seriesList, theme, plotIn, measurer, size)
  const plot = legend.plot
  const yScale = niceScale(chart.min ?? yMin, chart.max ?? yMax)
  const xScale = niceScale(xMin, xMax)
  const axisColor = resolveEdgeTone(theme, 'neutral')
  const axis = valueAxisFrame(yScale, plot, theme, measurer, size, chart.unit, size + 10)
  const parts: string[] = [legend.svg, axis.svg]
  const xSpan = xScale.max - xScale.min || 1
  const xFor = (value: number): number => axis.plotL + ((value - xScale.min) / xSpan) * Math.max(1, axis.plotR - axis.plotL)
  for (const tick of xScale.ticks) {
    const x = xFor(tick)
    parts.push(`<line x1="${n(x)}" y1="${n(axis.plotT)}" x2="${n(x)}" y2="${n(axis.plotB)}" stroke="${theme.grid}" stroke-width="1"/>`)
    parts.push(textEl(formatValue(tick), x, axis.plotB + size + 3, size, axisColor.text, 'middle'))
  }
  for (const { series, index, points } of collected) {
    const color = seriesColor(theme, series, index)
    for (const point of points) {
      parts.push(`<circle cx="${n(xFor(point.x))}" cy="${n(axis.yFor(point.y))}" r="3.5" fill="${color}" fill-opacity="0.85"/>`)
    }
  }
  return parts.join('')
}

function heatmapChart(chart: ChartSpec, plot: Rect, theme: DigramTheme, measurer: TextMeasurer, size: number): string {
  const matrix = chart.values ?? []
  const rows = matrix.length
  const cols = rows ? Math.max(...matrix.map((row) => row.length)) : 0
  if (!rows || !cols) return ''
  const rowLabels = chart.rows?.length === rows ? chart.rows : Array.from({ length: rows }, (_, index) => String(index + 1))
  const colLabels = chart.columns?.length === cols ? chart.columns : Array.from({ length: cols }, (_, index) => String(index + 1))
  const axisColor = resolveEdgeTone(theme, 'neutral')
  const gutterL = Math.max(20, Math.min(plot.w * 0.3, Math.max(...rowLabels.map((label) => measurer.width(label, size, 'regular'))) + 10))
  const gutterT = size + 6
  const cellW = Math.max(1, (plot.w - gutterL) / cols)
  const cellH = Math.max(1, (plot.h - gutterT) / rows)
  let vMin = Infinity
  let vMax = -Infinity
  for (const row of matrix) for (const value of row) { if (Number.isFinite(value)) { vMin = Math.min(vMin, value); vMax = Math.max(vMax, value) } }
  if (!Number.isFinite(vMin)) return ''
  const span = vMax - vMin || 1
  const heat = baseColor(theme, chart.tone ?? 'accent')
  const parts: string[] = []
  colLabels.forEach((label, column) => {
    parts.push(textEl(fitText(label, Math.max(8, cellW - 2), size, measurer), plot.x + gutterL + cellW * (column + 0.5), plot.y + size, size, axisColor.text, 'middle'))
  })
  matrix.forEach((row, rowIndex) => {
    parts.push(textEl(fitText(rowLabels[rowIndex]!, gutterL - 6, size, measurer), plot.x + gutterL - 4, plot.y + gutterT + cellH * (rowIndex + 0.5) + size * 0.35, size, axisColor.text, 'end'))
    row.forEach((value, column) => {
      if (!Number.isFinite(value)) return
      const t = (value - vMin) / span
      const x = plot.x + gutterL + cellW * column
      const y = plot.y + gutterT + cellH * rowIndex
      // mixColors(a, b, amount) 是 a 占 amount 份：纸色占比随强度下降，格子才越热越深。
      parts.push(`<rect x="${n(x)}" y="${n(y)}" width="${n(cellW)}" height="${n(cellH)}" fill="${mixColors(theme.paper, heat, 0.9 - 0.8 * t)}" stroke="${theme.paper}" stroke-width="1"/>`)
      if (cellW >= 26 && cellH >= 15) {
        parts.push(textEl(formatValue(value, chart.unit), x + cellW / 2, y + cellH / 2 + size * 0.35, Math.max(8, size - 1), t > 0.55 ? theme.paper : inkColor(theme), 'middle'))
      }
    })
  })
  return parts.join('')
}

/** Clamp to the range Date can serialize, so a hand-edited document with an
 *  extreme timestamp cannot throw inside toISOString. */
function safeDate(ms: number): Date {
  return new Date(Math.min(Math.max(ms, -8.64e15), 8.64e15))
}

function formatGanttDate(ms: number, span: number): string {
  const iso = safeDate(ms).toISOString()
  return span > 3 * 86400000 ? iso.slice(0, 10) : `${iso.slice(5, 10)} ${iso.slice(11, 16)}`
}

function ganttChart(chart: ChartSpec, plot: Rect, theme: DigramTheme, measurer: TextMeasurer, size: number): string {
  const time = (value: string | number): number => (typeof value === 'number' ? value : Date.parse(value))
  const tasks = (chart.tasks ?? []).filter((task) => Number.isFinite(time(task.start)) && Number.isFinite(time(task.end)) && time(task.start) < time(task.end))
  if (!tasks.length) return ''
  let t0 = Infinity
  let t1 = -Infinity
  for (const task of tasks) { t0 = Math.min(t0, time(task.start)); t1 = Math.max(t1, time(task.end)) }
  if (t0 === t1) t1 = t0 + 86400000
  const span = t1 - t0
  interface Row { kind: 'section' | 'task'; label: string; start?: number; end?: number; tone?: Tone }
  const rows: Row[] = []
  const sections = new Map<string, ChartTask[]>()
  for (const task of tasks) {
    const key = task.section ?? ''
    if (!sections.has(key)) sections.set(key, [])
    sections.get(key)!.push(task)
  }
  const hasSections = sections.size > 1 || (sections.size === 1 && !sections.has(''))
  for (const [section, sectionTasks] of sections) {
    if (hasSections && section) rows.push({ kind: 'section', label: section })
    for (const task of sectionTasks) rows.push({ kind: 'task', label: task.label, start: time(task.start), end: time(task.end), tone: task.tone })
  }
  const axisColor = resolveEdgeTone(theme, 'neutral')
  const axisH = size + 12
  const gutterL = Math.max(24, Math.min(plot.w * 0.34, Math.max(...rows.filter((row) => row.kind === 'task').map((row) => measurer.width(row.label, size, 'regular'))) + 12))
  const trackX = plot.x + gutterL
  const trackW = Math.max(1, plot.x + plot.w - trackX)
  const rowH = Math.min(26, Math.max(10, (plot.h - axisH) / Math.max(1, rows.length)))
  const barH = Math.min(12, Math.max(4, rowH - 6))
  const xFor = (t: number): number => trackX + ((t - t0) / span) * trackW
  const parts: string[] = []
  const tickCount = 4
  for (let index = 0; index <= tickCount; index += 1) {
    const t = t0 + (span * index) / tickCount
    const x = xFor(t)
    parts.push(`<line x1="${n(x)}" y1="${n(plot.y + axisH - 4)}" x2="${n(x)}" y2="${n(plot.y + plot.h)}" stroke="${theme.grid}" stroke-width="1"/>`)
    const anchor = index === 0 ? 'start' : index === tickCount ? 'end' : 'middle'
    parts.push(textEl(formatGanttDate(t, span), x, plot.y + size, size, axisColor.text, anchor))
  }
  parts.push(`<line x1="${n(trackX)}" y1="${n(plot.y + axisH - 4)}" x2="${n(trackX + trackW)}" y2="${n(plot.y + axisH - 4)}" stroke="${axisColor.stroke}" stroke-width="1"/>`)
  const accent = baseColor(theme, chart.tone ?? 'accent')
  let y = plot.y + axisH
  for (const row of rows) {
    if (row.kind === 'section') {
      parts.push(textEl(fitText(row.label, gutterL + trackW * 0.5, Math.max(8, size - 1), measurer), plot.x + 2, y + rowH * 0.35 + size * 0.3, Math.max(8, size - 1), axisColor.text, 'start', 500))
      y += rowH * 0.7
      continue
    }
    parts.push(textEl(fitText(row.label, gutterL - 8, size, measurer), trackX - 6, y + rowH / 2 + size * 0.35, size, axisColor.text, 'end'))
    const x0 = xFor(row.start!)
    const x1 = xFor(row.end!)
    parts.push(`<rect x="${n(x0)}" y="${n(y + (rowH - barH) / 2)}" width="${n(Math.max(2, x1 - x0))}" height="${n(barH)}" rx="3" fill="${row.tone ? baseColor(theme, row.tone) : accent}"/>`)
    y += rowH
  }
  return parts.join('')
}

function sankeyChart(chart: ChartSpec, plot: Rect, theme: DigramTheme, measurer: TextMeasurer, size: number): string {
  const flows = (chart.flows ?? []).filter((flow) => Number.isFinite(flow.value) && flow.value > 0 && flow.from !== flow.to)
  if (!flows.length) return ''
  // Node order: first appearance, `from` before `to` per flow.
  const ids: string[] = []
  const seen = new Set<string>()
  for (const flow of flows) for (const id of [flow.from, flow.to]) if (!seen.has(id)) { seen.add(id); ids.push(id) }
  const out = new Map<string, ChartFlow[]>(ids.map((id) => [id, []]))
  const incoming = new Map<string, ChartFlow[]>(ids.map((id) => [id, []]))
  for (const flow of flows) { out.get(flow.from)!.push(flow); incoming.get(flow.to)!.push(flow) }
  // Rank by longest path, ignoring feedback edges — the same discipline the
  // host layout uses, so a cyclic hand-edited spec degrades instead of hanging.
  const rank = new Map<string, number>(ids.map((id) => [id, 0]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const order: string[] = []
  const walk = (id: string): void => {
    if (visited.has(id) || visiting.has(id)) return
    visiting.add(id)
    for (const flow of out.get(id) ?? []) walk(flow.to)
    visiting.delete(id)
    visited.add(id)
    order.unshift(id)
  }
  for (const id of ids) walk(id)
  const passed = new Set<string>()
  for (const id of order) {
    passed.add(id)
    for (const flow of out.get(id) ?? []) if (!passed.has(flow.to)) rank.set(flow.to, Math.max(rank.get(flow.to)!, rank.get(id)! + 1))
  }
  const columns = Math.min(ids.length, Math.max(1, ...ids.map((id) => rank.get(id)!)) + 1)
  const nodeW = 10
  const colGap = columns > 1 ? (plot.w - nodeW) / (columns - 1) : 0
  const throughput = new Map<string, number>(ids.map((id) => [
    id,
    Math.max(
      (out.get(id) ?? []).reduce((sum, flow) => sum + flow.value, 0),
      (incoming.get(id) ?? []).reduce((sum, flow) => sum + flow.value, 0),
    ),
  ]))
  const byColumn: string[][] = Array.from({ length: columns }, () => [])
  for (const id of ids) byColumn[Math.min(rank.get(id)!, columns - 1)]!.push(id)
  const gap = 10
  const maxColSum = Math.max(...byColumn.map((column) => column.reduce((sum, id) => sum + throughput.get(id)!, 0)), 1e-9)
  const maxNodesInCol = Math.max(...byColumn.map((column) => column.length))
  const scale = Math.max(1e-9, (plot.h - (maxNodesInCol - 1) * gap) / maxColSum)
  const pos = new Map<string, { x: number; y: number; h: number }>()
  byColumn.forEach((column, columnIndex) => {
    const heights = column.map((id) => Math.max(3, throughput.get(id)! * scale))
    const totalH = heights.reduce((sum, h) => sum + h, 0) + gap * Math.max(0, column.length - 1)
    let y = plot.y + Math.max(0, (plot.h - totalH) / 2)
    const x = plot.x + colGap * columnIndex
    column.forEach((id, index) => {
      pos.set(id, { x, y, h: heights[index]! })
      y += heights[index]! + gap
    })
  })
  // Order ribbons by the other endpoint's vertical position to reduce crossings.
  for (const id of ids) {
    out.get(id)!.sort((a, b) => pos.get(a.to)!.y - pos.get(b.to)!.y)
    incoming.get(id)!.sort((a, b) => pos.get(a.from)!.y - pos.get(b.from)!.y)
  }
  const axisColor = resolveEdgeTone(theme, 'neutral')
  const nodeColor = baseColor(theme, 'neutral')
  const parts: string[] = []
  const outOffset = new Map<string, number>(ids.map((id) => [id, 0]))
  const inOffset = new Map<string, number>(ids.map((id) => [id, 0]))
  for (const id of ids) {
    const source = pos.get(id)!
    for (const flow of out.get(id)!) {
      const thickness = Math.max(1, flow.value * scale)
      const sy = source.y + outOffset.get(id)! + thickness / 2
      outOffset.set(id, outOffset.get(id)! + thickness)
      const target = pos.get(flow.to)!
      const ty = target.y + inOffset.get(flow.to)! + thickness / 2
      inOffset.set(flow.to, inOffset.get(flow.to)! + thickness)
      const color = flow.tone ? baseColor(theme, flow.tone) : baseColor(theme, ROTATION[ids.indexOf(id) % ROTATION.length]!)
      const x0 = source.x + nodeW
      const x1 = target.x
      const mx = (x0 + x1) / 2
      parts.push(`<path d="M ${n(x0)} ${n(sy)} C ${n(mx)} ${n(sy)} ${n(mx)} ${n(ty)} ${n(x1)} ${n(ty)}" fill="none" stroke="${color}" stroke-width="${n(thickness)}" stroke-opacity="0.35"/>`)
    }
  }
  for (const id of ids) {
    const at = pos.get(id)!
    parts.push(`<rect x="${n(at.x)}" y="${n(at.y)}" width="${n(nodeW)}" height="${n(at.h)}" rx="2" fill="${nodeColor}"/>`)
    const lastColumn = rank.get(id)! >= columns - 1
    const maxLabelW = Math.max(24, (columns > 1 ? colGap : plot.w) * 0.75 - nodeW - 10)
    const x = lastColumn ? at.x - 5 : at.x + nodeW + 5
    parts.push(textEl(fitText(id, maxLabelW, size, measurer), x, at.y + at.h / 2 + size * 0.35, size, axisColor.text, lastColumn ? 'end' : 'start'))
  }
  return parts.join('')
}

// -------------------------------------------------------------------- entry

/**
 * Render the node's chart inside its box. The frame belongs to render.ts; this
 * only paints the interior: optional title from node.label, then the kind's
 * layout. A box too small for a chart renders title-only rather than garbage.
 */
export function chartSvg(node: DigramNode, rect: Rect, theme: DigramTheme, measurer: TextMeasurer): string {
  const chart = node.chart
  if (!chart) return ''
  const size = Math.max(9, theme.fontSize - 3)
  const parts: string[] = []
  let top = rect.y + PAD
  if (node.label) {
    const titleSize = theme.fontSize
    const align = node.labelAlign ?? 'center'
    const anchorX = align === 'start' ? rect.x + PAD : align === 'end' ? rect.x + rect.w - PAD : rect.x + rect.w / 2
    const anchor = align === 'start' ? 'start' : align === 'end' ? 'end' : 'middle'
    parts.push(textEl(fitText(node.label, rect.w - PAD * 2, titleSize, measurer), anchorX, top + titleSize * 0.85, titleSize, inkColor(theme), anchor, 500))
    top += titleSize + 10
  }
  const plot: Rect = { x: rect.x + PAD, y: top, w: rect.w - PAD * 2, h: rect.y + rect.h - PAD - top }
  if (plot.w < 48 || plot.h < 48) return parts.join('')
  switch (chart.kind) {
    case 'bar': parts.push(barChart(chart, plot, theme, measurer, size)); break
    case 'line': parts.push(lineAreaChart(chart, plot, theme, measurer, size, false)); break
    case 'area': parts.push(lineAreaChart(chart, plot, theme, measurer, size, true)); break
    case 'pie': parts.push(pieChart(chart, plot, theme, measurer, size, false)); break
    case 'donut': parts.push(pieChart(chart, plot, theme, measurer, size, true)); break
    case 'scatter': parts.push(scatterChart(chart, plot, theme, measurer, size)); break
    case 'heatmap': parts.push(heatmapChart(chart, plot, theme, measurer, size)); break
    case 'gantt': parts.push(ganttChart(chart, plot, theme, measurer, size)); break
    case 'sankey': parts.push(sankeyChart(chart, plot, theme, measurer, size)); break
  }
  return parts.filter(Boolean).join('')
}
