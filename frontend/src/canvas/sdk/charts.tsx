// Canvas charts. Hand-drawn SVG rather than a charting library, for three
// reasons that all point the same way:
//
//   - A canvas embeds its data, so nothing here needs a library's update,
//     animation, or virtualization machinery. The whole job is one static render.
//   - Every colour, gridline, and label has to come from the theme tokens. A
//     library means either fighting its theme layer or overriding it per prop at
//     every call site, and the second is what makes generated chart code long
//     and inconsistent.
//   - It is a dependency the desktop bundle otherwise does not carry.
//
// All charts share one geometry model: a fixed `height`, a width that follows the
// container via `viewBox` + `preserveAspectRatio`, and a plot rect inset by the
// axis gutters. Series colour comes from `tokens.chart.sequence` by index unless
// the caller names one, so two charts in the same canvas agree on what "series 2"
// looks like without the author tracking it.

import type { CSSProperties, ReactNode } from 'react'
import { useId, useLayoutEffect, useRef, useState } from 'react'

import { Row, Stack, Text } from './core-primitives'
import { useHostTheme } from './hooks'
import type { CanvasTokens } from './tokens'

/**
 * The width the chart actually has on screen, in CSS pixels.
 *
 * Charts render at their true width rather than at a fixed `viewBox` scaled with
 * `preserveAspectRatio="none"`. That shortcut is what a first cut reaches for and
 * it is visibly wrong: squashing a 640-wide viewBox into a 560-wide column
 * compresses every glyph and stroke horizontally but not vertically, so axis
 * labels come out narrow and the whole chart looks subtly off. Measuring also
 * makes label thinning honest — it can only decide how many labels fit if it
 * knows how much room there is.
 *
 * `FALLBACK_WIDTH` covers the first paint, before layout has happened.
 */
const FALLBACK_WIDTH = 640

function useMeasuredWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(FALLBACK_WIDTH)
  // Layout effect, not effect: this reads geometry, and doing it after paint
  // shows one frame at the fallback width on every mount.
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const apply = () => {
      const next = Math.round(element.getBoundingClientRect().width)
      // A collapsed container (a closed disclosure, a hidden tab) measures 0.
      // Keeping the last good width means reopening it does not flash a
      // zero-width chart before the observer fires again.
      if (next > 0) setWidth(next)
    }
    apply()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(apply)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

/** One named series. `color` overrides the palette slot for this series. */
export interface ChartSeries {
  /** Legend label and accessible name. */
  name: string
  values: number[]
  color?: string
}

export interface ChartContainerProps {
  title?: ReactNode
  /** What the numbers are: `ms`, `requests`, `USD`. Shown next to the title. */
  unit?: ReactNode
  /** Where the data came from, or the window it covers. */
  caption?: ReactNode
  /**
   * Legend entries. Only the names and colours are read here, so a hand-drawn
   * chart can pass `[{ name: 'p95', values: [] }]` for a legend swatch alone.
   */
  series?: ChartSeries[]
  showLegend?: boolean
  children: ReactNode
  style?: CSSProperties
}

type ChartFrameProps = ChartContainerProps & {
  series: ChartSeries[]
  /**
   * Draw the legend at one series too. Off for the built-in charts, where a lone
   * series name just repeats the title; on for `ChartContainer`, whose caller
   * named the series specifically to get a swatch.
   */
  forceLegend?: boolean
}

/**
 * The shared chrome: title, unit, legend, caption. Factored out because a chart
 * without a title and units is not self-describing, and making the frame the
 * default path is how that stops being optional.
 */
function ChartFrame({
  title,
  unit,
  caption,
  series,
  showLegend = true,
  forceLegend = false,
  children,
  style,
}: ChartFrameProps) {
  const { tokens } = useHostTheme()
  const legend = showLegend && series.length > (forceLegend ? 0 : 1)
  return (
    <Stack gap="inline" style={style}>
      {title || unit ? (
        <Row gap="micro" justify="space-between">
          <Row gap="micro">
            {title ? <Text weight="medium">{title}</Text> : null}
            {unit ? (
              <Text tone="quaternary" size="small">
                {unit}
              </Text>
            ) : null}
          </Row>
        </Row>
      ) : null}
      {children}
      {legend ? (
        <Row gap="component" wrap>
          {series.map((entry, index) => (
            <Row key={entry.name} gap="micro">
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  flexShrink: 0,
                  background: colorFor(tokens, entry, index),
                }}
              />
              <Text tone="secondary" size="small">
                {entry.name}
              </Text>
            </Row>
          ))}
        </Row>
      ) : null}
      {caption ? (
        <Text tone="quaternary" size="small">
          {caption}
        </Text>
      ) : null}
    </Stack>
  )
}

function colorFor(tokens: CanvasTokens, series: ChartSeries, index: number): string {
  return series.color ?? tokens.chart.sequence[index % tokens.chart.sequence.length]
}

/** Plot geometry. `right` leaves room for the last category label, which is
 *  centred on the final data point and would otherwise overhang the viewBox. */
const PLOT = { left: 44, right: 24, top: 8, bottom: 22 }

/**
 * A "nice" axis maximum: the smallest 1/2/5×10ⁿ step at or above the data max, so
 * gridlines land on numbers a reader can do arithmetic with. Raw data maxima
 * produce axes labelled 3847.2, which is technically correct and useless.
 */
function niceCeiling(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  const normalized = value / magnitude
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10
  return step * magnitude
}

function formatTick(value: number): string {
  const absolute = Math.abs(value)
  if (absolute >= 1_000_000_000) return `${trim(value / 1_000_000_000)}B`
  if (absolute >= 1_000_000) return `${trim(value / 1_000_000)}M`
  if (absolute >= 1_000) return `${trim(value / 1_000)}k`
  if (absolute > 0 && absolute < 1) return String(trim(value, 2))
  return String(trim(value))
}

function trim(value: number, precision = 1): number {
  return Number.parseFloat(value.toFixed(precision))
}

interface AxesProps {
  width: number
  height: number
  max: number
  labels: string[]
  tokens: CanvasTokens
  /** Ticks including 0. 4 gridlines reads as structure; 10 reads as a grid. */
  tickCount?: number
  /**
   * Where a category sits on the x axis, and it must match how the marks are
   * placed or the labels point at the wrong data.
   *
   * `point` — categories sit ON the plot edges, evenly spaced by
   * `plotWidth / (n - 1)`. This is line and area geometry: the first vertex is at
   * x=0 and the last at x=plotWidth.
   *
   * `band` — each category owns a slot of `plotWidth / n` and its label sits at
   * the slot's CENTRE. This is bar geometry. Using the point scale for bars is
   * how the labels ended up visibly left of the bars they named.
   */
  scale?: 'point' | 'band'
}

/** Horizontal gridlines with value labels, plus the category labels below. */
function Axes({
  width,
  height,
  max,
  labels,
  tokens,
  tickCount = 4,
  scale = 'point',
}: AxesProps) {
  const plotHeight = height - PLOT.top - PLOT.bottom
  const plotWidth = width - PLOT.left - PLOT.right
  const ticks = Array.from({ length: tickCount + 1 }, (_, index) => (max / tickCount) * index)
  // Thin out category labels rather than overlapping them. 48px is about the
  // widest a short label gets at 10px, so it is the spacing that keeps adjacent
  // labels from touching.
  const step = Math.max(1, Math.ceil(labels.length / Math.max(1, Math.floor(plotWidth / 48))))
  const lastIndex = Math.max(0, labels.length - 1)
  const band = plotWidth / Math.max(1, labels.length)
  const labelX = (index: number) =>
    scale === 'band'
      ? PLOT.left + band * index + band / 2
      : PLOT.left + (plotWidth / Math.max(1, lastIndex || 1)) * index
  return (
    <g aria-hidden="true">
      {ticks.map((tick) => {
        const y = PLOT.top + plotHeight - (tick / max) * plotHeight
        return (
          <g key={tick}>
            <line
              x1={PLOT.left}
              x2={width - PLOT.right}
              y1={y}
              y2={y}
              stroke={tokens.chart.gridline}
              strokeWidth={1}
            />
            <text
              x={PLOT.left - 6}
              y={y + 3}
              textAnchor="end"
              fill={tokens.text.quaternary}
              fontSize={10}
            >
              {formatTick(tick)}
            </text>
          </g>
        )
      })}
      {labels.map((label, index) => {
        if (index % step !== 0 && index !== lastIndex) return null
        // On a point scale the first and last labels sit ON the plot edges, so
        // centring them puts half the text outside the viewBox. Band labels are
        // already inset by half a slot and stay centred.
        const anchor =
          scale === 'band' ? 'middle' : index === 0 ? 'start' : index === lastIndex ? 'end' : 'middle'
        return (
          <text
            key={index}
            x={labelX(index)}
            y={height - 6}
            textAnchor={anchor}
            fill={tokens.text.quaternary}
            fontSize={10}
          >
            {label}
          </text>
        )
      })}
    </g>
  )
}

export interface CartesianChartProps {
  /** Category labels along the x axis. */
  labels: string[]
  series: ChartSeries[]
  title?: ReactNode
  unit?: ReactNode
  caption?: ReactNode
  height?: number
  showLegend?: boolean
  /** Pin the y axis maximum instead of deriving it from the data. */
  max?: number
  style?: CSSProperties
}

function useChartGeometry(
  series: ChartSeries[],
  explicitMax: number | undefined,
  height: number,
  width: number,
) {
  const { tokens } = useHostTheme()
  const dataMax = Math.max(0, ...series.flatMap((entry) => entry.values.filter(Number.isFinite)))
  const max = explicitMax ?? niceCeiling(dataMax)
  const plotHeight = height - PLOT.top - PLOT.bottom
  const plotWidth = width - PLOT.left - PLOT.right
  const x = (index: number, count: number) =>
    PLOT.left + (plotWidth / Math.max(1, count - 1 || 1)) * index
  const y = (value: number) => PLOT.top + plotHeight - (Math.max(0, value) / max) * plotHeight
  return { tokens, max, plotHeight, plotWidth, x, y }
}

/**
 * SVG attributes for a chart drawn at its measured width.
 *
 * `viewBox` tracks the real width and `preserveAspectRatio` stays at the default
 * `xMidYMid meet`, so one user unit is one CSS pixel and nothing is distorted.
 */
function svgProps(width: number, height: number) {
  return {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    style: { display: 'block', maxWidth: '100%' } as CSSProperties,
    role: 'img' as const,
  }
}

/**
 * The chart chrome, on its own.
 *
 * Every built-in chart already renders inside it. This export is for the chart
 * that is NOT built in: a hand-written SVG, an embedded image, a table standing
 * in for a plot. Wrapping it here is what keeps its title, units, legend and
 * source line looking like every other chart on the page instead of a one-off.
 *
 * Unlike the built-in charts, ONE series still draws a legend. A built-in chart
 * suppresses it because a single named series repeats the title; here the caller
 * had to name the series by hand, which is only worth doing to get the swatch.
 */
export function ChartContainer({ series = [], showLegend, ...rest }: ChartContainerProps) {
  return (
    <ChartFrame
      {...rest}
      series={series}
      showLegend={showLegend ?? series.length > 0}
      forceLegend
    />
  )
}

/** A trend over an ordered category axis. */
export function LineChart({
  labels,
  series,
  title,
  unit,
  caption,
  height = 220,
  showLegend,
  max,
  style,
}: CartesianChartProps) {
  const [ref, width] = useMeasuredWidth()
  const geometry = useChartGeometry(series, max, height, width)
  const description = `${title ?? 'Line chart'}: ${series.map((s) => s.name).join(', ')}`
  return (
    <ChartFrame
      title={title}
      unit={unit}
      caption={caption}
      series={series}
      showLegend={showLegend}
      style={style}
    >
      <div ref={ref} style={{ width: '100%' }}>
        <svg {...svgProps(width, height)} aria-label={description}>
          <Axes
            width={width}
            height={height}
            max={geometry.max}
            labels={labels}
            tokens={geometry.tokens}
          />
          {series.map((entry, index) => {
            const color = colorFor(geometry.tokens, entry, index)
            const points = entry.values
              .map(
                (value, position) =>
                  `${geometry.x(position, entry.values.length)},${geometry.y(value)}`,
              )
              .join(' ')
            return (
              <polyline
                key={entry.name}
                points={points}
                fill="none"
                stroke={color}
                strokeWidth={1.75}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )
          })}
        </svg>
      </div>
    </ChartFrame>
  )
}

/** A trend with the area under it filled. One or two series at most — stacked
 *  translucent fills stop being readable past that. */
export function AreaChart({
  labels,
  series,
  title,
  unit,
  caption,
  height = 220,
  showLegend,
  max,
  style,
}: CartesianChartProps) {
  const [ref, width] = useMeasuredWidth()
  const geometry = useChartGeometry(series, max, height, width)
  const gradientBase = useId()
  const baseline = PLOT.top + geometry.plotHeight
  return (
    <ChartFrame
      title={title}
      unit={unit}
      caption={caption}
      series={series}
      showLegend={showLegend}
      style={style}
    >
      <div ref={ref} style={{ width: '100%' }}>
        <svg {...svgProps(width, height)} aria-label={`${title ?? 'Area chart'}`}>
          <defs>
            {series.map((entry, index) => {
              const color = colorFor(geometry.tokens, entry, index)
              return (
                <linearGradient
                  key={entry.name}
                  id={`${gradientBase}-${index}`}
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor={color} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={color} stopOpacity={0.02} />
                </linearGradient>
              )
            })}
          </defs>
          <Axes
            width={width}
            height={height}
            max={geometry.max}
            labels={labels}
            tokens={geometry.tokens}
          />
          {series.map((entry, index) => {
            const color = colorFor(geometry.tokens, entry, index)
            const count = entry.values.length
            const line = entry.values
              .map((value, position) => `${geometry.x(position, count)},${geometry.y(value)}`)
              .join(' ')
            const area = `${geometry.x(0, count)},${baseline} ${line} ${geometry.x(count - 1, count)},${baseline}`
            return (
              <g key={entry.name}>
                <polygon points={area} fill={`url(#${gradientBase}-${index})`} />
                <polyline
                  points={line}
                  fill="none"
                  stroke={color}
                  strokeWidth={1.75}
                  strokeLinejoin="round"
                />
              </g>
            )
          })}
        </svg>
      </div>
    </ChartFrame>
  )
}

export interface BarChartProps extends CartesianChartProps {
  /** Stack series instead of placing them side by side. */
  stacked?: boolean
  /** Horizontal bars. Use when category names are long enough to need the room. */
  horizontal?: boolean
}

/** Comparison across categories. */
export function BarChart({
  labels,
  series,
  title,
  unit,
  caption,
  height = 220,
  showLegend,
  max,
  stacked,
  horizontal,
  style,
}: BarChartProps) {
  const { tokens } = useHostTheme()
  const [ref, width] = useMeasuredWidth()
  if (horizontal) {
    return (
      <HorizontalBars
        labels={labels}
        series={series}
        title={title}
        unit={unit}
        caption={caption}
        showLegend={showLegend}
        max={max}
        style={style}
      />
    )
  }
  const totals = labels.map((_, position) =>
    series.reduce((sum, entry) => sum + Math.max(0, entry.values[position] ?? 0), 0),
  )
  const dataMax = stacked
    ? Math.max(0, ...totals)
    : Math.max(0, ...series.flatMap((entry) => entry.values.filter(Number.isFinite)))
  const resolvedMax = max ?? niceCeiling(dataMax)
  const plotHeight = height - PLOT.top - PLOT.bottom
  const plotWidth = width - PLOT.left - PLOT.right
  const slot = plotWidth / Math.max(1, labels.length)
  // Leave a quarter of the slot as breathing room so adjacent groups read as
  // separate categories rather than one continuous block.
  const groupWidth = slot * 0.72
  const barWidth = stacked ? groupWidth : groupWidth / Math.max(1, series.length)
  const scale = (value: number) => (Math.max(0, value) / resolvedMax) * plotHeight
  return (
    <ChartFrame
      title={title}
      unit={unit}
      caption={caption}
      series={series}
      showLegend={showLegend}
      style={style}
    >
      <div ref={ref} style={{ width: '100%' }}>
        <svg {...svgProps(width, height)} aria-label={`${title ?? 'Bar chart'}`}>
          <Axes
            width={width}
            height={height}
            max={resolvedMax}
            labels={labels}
            tokens={tokens}
            tickCount={4}
            scale="band"
          />
          {labels.map((label, position) => {
            // Bars are centred in their slot, so the group starts half the
            // leftover gap in rather than at the slot edge.
            const slotStart = PLOT.left + slot * position + (slot - groupWidth) / 2
            let stackTop = PLOT.top + plotHeight
            return (
              <g key={label}>
                {series.map((entry, index) => {
                  const value = Math.max(0, entry.values[position] ?? 0)
                  const barHeight = scale(value)
                  const x = stacked ? slotStart : slotStart + barWidth * index
                  const y = stacked ? stackTop - barHeight : PLOT.top + plotHeight - barHeight
                  if (stacked) stackTop -= barHeight
                  return (
                    <rect
                      key={entry.name}
                      x={x}
                      y={y}
                      width={Math.max(1, barWidth - (stacked ? 0 : 1))}
                      height={Math.max(0, barHeight)}
                      fill={colorFor(tokens, entry, index)}
                      rx={1.5}
                    />
                  )
                })}
              </g>
            )
          })}
        </svg>
      </div>
    </ChartFrame>
  )
}

/**
 * Horizontal bars, laid out with DOM rather than SVG. Category labels here are
 * long by definition (that is why the caller went horizontal), and text layout —
 * wrapping, ellipsis, real font metrics — is something the browser does properly
 * and hand-computed SVG text does not.
 */
function HorizontalBars({
  labels,
  series,
  title,
  unit,
  caption,
  showLegend,
  max,
  style,
}: Omit<CartesianChartProps, 'height'>) {
  const { tokens } = useHostTheme()
  const dataMax = Math.max(0, ...series.flatMap((entry) => entry.values.filter(Number.isFinite)))
  const resolvedMax = max ?? niceCeiling(dataMax)
  return (
    <ChartFrame
      title={title}
      unit={unit}
      caption={caption}
      series={series}
      showLegend={showLegend}
      style={style}
    >
      <Stack gap="inline">
        {labels.map((label, position) => (
          <Row key={label} gap="component" align="center">
            <div style={{ width: 140, flexShrink: 0 }}>
              <Text tone="secondary" size="small" truncate>
                {label}
              </Text>
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0 }}>
              {series.map((entry, index) => {
                const value = Math.max(0, entry.values[position] ?? 0)
                return (
                  <div
                    key={entry.name}
                    style={{ height: 10, background: tokens.fill.tertiary, borderRadius: 2 }}
                  >
                    <div
                      style={{
                        width: `${(value / resolvedMax) * 100}%`,
                        height: '100%',
                        borderRadius: 2,
                        background: colorFor(tokens, entry, index),
                      }}
                    />
                  </div>
                )
              })}
            </div>
            <div style={{ width: 56, flexShrink: 0, textAlign: 'right' }}>
              <Text tone="tertiary" size="small" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {formatTick(series[0]?.values[position] ?? 0)}
              </Text>
            </div>
          </Row>
        ))}
      </Stack>
    </ChartFrame>
  )
}

export interface PieChartProps {
  slices: { name: string; value: number; color?: string }[]
  title?: ReactNode
  caption?: ReactNode
  /** A hole in the middle, 0–0.9. Non-zero makes it a donut. */
  innerRadius?: number
  height?: number
  /** Shown in the middle of a donut: usually the total. */
  centerLabel?: ReactNode
  style?: CSSProperties
}

/** Composition of a whole. Only for parts that genuinely sum to something — a
 *  pie of unrelated quantities is a bar chart that lost its axis. */
export function PieChart({
  slices,
  title,
  caption,
  innerRadius = 0.6,
  height = 200,
  centerLabel,
  style,
}: PieChartProps) {
  const { tokens } = useHostTheme()
  const total = slices.reduce((sum, slice) => sum + Math.max(0, slice.value), 0)
  const radius = height / 2 - 4
  const hole = radius * Math.min(0.9, Math.max(0, innerRadius))
  let angle = -Math.PI / 2
  const paths = slices.map((slice, index) => {
    const share = total > 0 ? Math.max(0, slice.value) / total : 0
    const sweep = share * Math.PI * 2
    const start = angle
    const end = angle + sweep
    angle = end
    const color = slice.color ?? tokens.chart.sequence[index % tokens.chart.sequence.length]
    return { ...slice, share, start, end, color }
  })
  const center = { x: height / 2, y: height / 2 }
  const point = (r: number, theta: number) => ({
    x: center.x + r * Math.cos(theta),
    y: center.y + r * Math.sin(theta),
  })
  return (
    <ChartFrame title={title} caption={caption} series={[]} showLegend={false} style={style}>
      <Row gap="section" align="center" wrap>
        <svg
          width={height}
          height={height}
          role="img"
          aria-label={`${title ?? 'Pie chart'}`}
          style={{ flexShrink: 0 }}
        >
          {paths.map((slice) => {
            // A single slice covering the whole circle cannot be drawn as an arc
            // (start and end coincide), so it is a ring instead.
            if (slice.share >= 0.9999) {
              return (
                <g key={slice.name}>
                  <circle cx={center.x} cy={center.y} r={radius} fill={slice.color} />
                  {hole > 0 ? (
                    <circle cx={center.x} cy={center.y} r={hole} fill={tokens.bg.editor} />
                  ) : null}
                </g>
              )
            }
            if (slice.share <= 0) return null
            const outerStart = point(radius, slice.start)
            const outerEnd = point(radius, slice.end)
            const innerEnd = point(hole, slice.end)
            const innerStart = point(hole, slice.start)
            const large = slice.end - slice.start > Math.PI ? 1 : 0
            const d = [
              `M ${outerStart.x} ${outerStart.y}`,
              `A ${radius} ${radius} 0 ${large} 1 ${outerEnd.x} ${outerEnd.y}`,
              `L ${innerEnd.x} ${innerEnd.y}`,
              `A ${hole} ${hole} 0 ${large} 0 ${innerStart.x} ${innerStart.y}`,
              'Z',
            ].join(' ')
            return (
              <path
                key={slice.name}
                d={d}
                fill={slice.color}
                stroke={tokens.bg.editor}
                strokeWidth={1}
              />
            )
          })}
          {centerLabel && hole > 0 ? (
            <text
              x={center.x}
              y={center.y + 4}
              textAnchor="middle"
              fill={tokens.text.primary}
              fontSize={14}
              fontWeight={600}
            >
              {String(centerLabel)}
            </text>
          ) : null}
        </svg>
        <Stack gap="micro" style={{ minWidth: 0 }}>
          {paths.map((slice) => (
            <Row key={slice.name} gap="inline">
              <span
                style={{ width: 8, height: 8, borderRadius: 2, background: slice.color, flexShrink: 0 }}
              />
              <Text tone="secondary" size="small">
                {slice.name}
              </Text>
              <Text tone="quaternary" size="small" style={{ fontVariantNumeric: 'tabular-nums' }}>
                {(slice.share * 100).toFixed(1)}%
              </Text>
            </Row>
          ))}
        </Stack>
      </Row>
    </ChartFrame>
  )
}

export interface HeatmapProps {
  /** Column headers, left to right. */
  columns: string[]
  /** One row per entry, with a value per column. */
  rows: { name: string; values: (number | null)[] }[]
  title?: ReactNode
  caption?: ReactNode
  /** Pin the top of the colour scale. Derived from the data otherwise. */
  max?: number
  /** The ramp's hue. Defaults to the chart blue. */
  color?: string
  style?: CSSProperties
}

/** A value grid shaded by magnitude. For density over two dimensions — activity
 *  by day and hour, cost by service and region. */
export function Heatmap({ columns, rows, title, caption, max, color, style }: HeatmapProps) {
  const { tokens } = useHostTheme()
  const ramp = color ?? tokens.chart.blue
  const values = rows.flatMap((row) => row.values.filter((v): v is number => v !== null))
  const resolvedMax = max ?? Math.max(1, ...values)
  return (
    <ChartFrame title={title} caption={caption} series={[]} showLegend={false} style={style}>
      <div data-canvas-scroll style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 2 }}>
          <thead>
            <tr>
              <th />
              {columns.map((column) => (
                <th
                  key={column}
                  style={{
                    fontSize: 10,
                    fontWeight: tokens.weight.regular,
                    color: tokens.text.quaternary,
                    padding: '0 2px',
                  }}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.name}>
                <th
                  scope="row"
                  style={{
                    fontSize: 10,
                    fontWeight: tokens.weight.regular,
                    color: tokens.text.quaternary,
                    textAlign: 'right',
                    paddingRight: 6,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {row.name}
                </th>
                {columns.map((column, index) => {
                  const value = row.values[index] ?? null
                  // A null cell means "no data", which must not look like zero:
                  // it gets the empty-surface fill, not the ramp's bottom end.
                  const intensity = value === null ? null : Math.max(0, value) / resolvedMax
                  return (
                    <td
                      key={column}
                      title={`${row.name} · ${column}: ${value ?? 'no data'}`}
                      style={{
                        width: 15,
                        height: 15,
                        borderRadius: 2,
                        background:
                          intensity === null
                            ? tokens.fill.tertiary
                            : `color-mix(in srgb, ${ramp} ${Math.round(intensity * 100)}%, transparent)`,
                      }}
                    />
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </ChartFrame>
  )
}
