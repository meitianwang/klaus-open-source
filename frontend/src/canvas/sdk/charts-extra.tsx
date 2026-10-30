// Additional chart types, split from `charts.tsx` to keep both files readable.
//
// Same rules as the cartesian charts: hand-drawn SVG, every colour from
// `useHostTheme()`, and geometry computed from a MEASURED width rather than a
// fixed viewBox — see `charts.tsx` for why scaling a fixed viewBox is wrong.
//
// These four exist because each answers a question the line/bar/pie set cannot:
// a radar compares one subject across many dimensions at once, a radial bar shows
// progress toward a target, a quadrant sorts items by two axes into an action
// recommendation, and a comparison grid puts two charts on one shared scale.

import type { CSSProperties, ReactNode } from 'react'
import { useLayoutEffect, useRef, useState } from 'react'

import { Grid, Row, Stack, Text, toneColors } from './core-primitives'
import type { Tone } from './core-primitives'
import { useHostTheme } from './hooks'

/** Local copy of the measure hook. Kept private to each chart module so neither
 *  file has to export internals to the other. */
function useMeasuredWidth(fallback = 480): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(fallback)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const apply = () => {
      const next = Math.round(element.getBoundingClientRect().width)
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

// ── Radar ─────────────────────────────────────────────────────────────────────

export interface RadarSeries {
  name: string
  /** One value per axis, in the same order as `axes`. */
  values: number[]
  color?: string
}

export interface RadarChartProps {
  /** Dimension labels, clockwise from the top. */
  axes: string[]
  series: RadarSeries[]
  title?: ReactNode
  /** Top of the scale. Every axis shares it, so the shape is comparable. */
  max?: number
  /** Concentric rings drawn as reference. */
  rings?: number
  size?: number
  caption?: ReactNode
  style?: CSSProperties
}

/**
 * One or more subjects compared across shared dimensions.
 *
 * A single `max` across every axis on purpose. Per-axis normalization makes every
 * subject look balanced and the shape stops meaning anything — which is the
 * standard way a radar chart lies.
 */
export function RadarChart({
  axes,
  series,
  title,
  max,
  rings = 4,
  size = 260,
  caption,
  style,
}: RadarChartProps) {
  const { tokens } = useHostTheme()
  const dataMax =
    max ?? Math.max(1, ...series.flatMap((entry) => entry.values.filter(Number.isFinite)))
  // Axis labels sit OUTSIDE the plot circle, anchored outward, so the widest one
  // decides how much horizontal room the drawing needs. A fixed pad clipped any
  // label wider than it — "Security" came out as "ecurity".
  //
  // The room is added by widening the viewBox rather than by shrinking the circle:
  // a long label should push the frame out, not make the chart smaller. ~5.6px per
  // character is the measured average for this font at 10px.
  const longest = axes.reduce((widest, label) => Math.max(widest, label.length), 0)
  const sidePad = Math.ceil(Math.min(110, Math.max(8, longest * 5.6 - 10)))
  // Vertical room only has to fit the top and bottom labels, which are centred.
  const verticalPad = 26
  const radius = Math.max(40, size / 2 - verticalPad)
  const center = size / 2
  const count = Math.max(3, axes.length)
  // Start at 12 o'clock and go clockwise, which is how a radar is read.
  const angleFor = (index: number) => -Math.PI / 2 + (index / count) * Math.PI * 2
  const point = (index: number, value: number) => {
    const ratio = Math.min(1, Math.max(0, value / dataMax))
    const angle = angleFor(index)
    return {
      x: center + radius * ratio * Math.cos(angle),
      y: center + radius * ratio * Math.sin(angle),
    }
  }
  return (
    <Stack gap="inline" style={style}>
      {title ? <Text weight="medium">{title}</Text> : null}
      <Row gap="section" align="center" wrap>
        <svg
          width={size + sidePad * 2}
          height={size}
          viewBox={`${-sidePad} 0 ${size + sidePad * 2} ${size}`}
          role="img"
          aria-label={`${title ?? 'Radar chart'}: ${axes.join(', ')}`}
          style={{ flexShrink: 0, maxWidth: '100%' }}
        >
          <g aria-hidden="true">
            {Array.from({ length: rings }, (_, ring) => {
              const ratio = (ring + 1) / rings
              const polygon = axes
                .map((_, index) => {
                  const angle = angleFor(index)
                  return `${center + radius * ratio * Math.cos(angle)},${
                    center + radius * ratio * Math.sin(angle)
                  }`
                })
                .join(' ')
              return (
                <polygon
                  key={ring}
                  points={polygon}
                  fill="none"
                  stroke={tokens.chart.gridline}
                  strokeWidth={1}
                />
              )
            })}
            {axes.map((label, index) => {
              const angle = angleFor(index)
              const spokeX = center + radius * Math.cos(angle)
              const spokeY = center + radius * Math.sin(angle)
              const labelX = center + (radius + 14) * Math.cos(angle)
              const labelY = center + (radius + 14) * Math.sin(angle)
              // Anchor by which side of the circle the label is on, so text grows
              // away from the plot instead of over it.
              const anchor = Math.abs(labelX - center) < 4 ? 'middle' : labelX > center ? 'start' : 'end'
              return (
                <g key={label}>
                  <line
                    x1={center}
                    y1={center}
                    x2={spokeX}
                    y2={spokeY}
                    stroke={tokens.chart.gridline}
                    strokeWidth={1}
                  />
                  <text
                    x={labelX}
                    y={labelY + 3}
                    textAnchor={anchor}
                    fill={tokens.text.quaternary}
                    fontSize={10}
                  >
                    {label}
                  </text>
                </g>
              )
            })}
          </g>
          {series.map((entry, seriesIndex) => {
            const color =
              entry.color ?? tokens.chart.sequence[seriesIndex % tokens.chart.sequence.length]
            const polygon = axes
              .map((_, index) => {
                const { x, y } = point(index, entry.values[index] ?? 0)
                return `${x},${y}`
              })
              .join(' ')
            return (
              <polygon
                key={entry.name}
                points={polygon}
                fill={color}
                fillOpacity={0.16}
                stroke={color}
                strokeWidth={1.75}
                strokeLinejoin="round"
              />
            )
          })}
        </svg>
        <Stack gap="micro">
          {series.map((entry, index) => (
            <Row key={entry.name} gap="micro">
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  flexShrink: 0,
                  background:
                    entry.color ?? tokens.chart.sequence[index % tokens.chart.sequence.length],
                }}
              />
              <Text tone="secondary" size="small">
                {entry.name}
              </Text>
            </Row>
          ))}
        </Stack>
      </Row>
      {caption ? (
        <Text tone="quaternary" size="small">
          {caption}
        </Text>
      ) : null}
    </Stack>
  )
}

// ── Radial bar ────────────────────────────────────────────────────────────────

export interface RadialBarChartProps {
  value: number
  max?: number
  label?: ReactNode
  /** Overrides the centre readout, which is otherwise the percentage. */
  centerLabel?: ReactNode
  tone?: Tone
  size?: number
  /** Ring thickness. */
  thickness?: number
  style?: CSSProperties
}

/**
 * One value against a target, as an arc.
 *
 * A 270° sweep rather than a full circle: with a full ring, 4% and 96% look
 * nearly the same at a glance because both are "almost all the way round". The
 * gap gives the eye a start and an end.
 */
export function RadialBarChart({
  value,
  max = 100,
  label,
  centerLabel,
  tone = 'accent',
  size = 130,
  thickness = 10,
  style,
}: RadialBarChartProps) {
  const { tokens } = useHostTheme()
  const safeMax = max > 0 ? max : 100
  const ratio = Math.min(1, Math.max(0, value / safeMax))
  // `chart.blue`, not `accent.control`: the control accent is the INK colour
  // (white on dark), and a white progress ring reads as "complete" no matter what
  // the number says. Chart elements take chart colours.
  const color = tone === 'accent' ? tokens.chart.blue : toneColors(tokens, tone).fg
  const radius = size / 2 - thickness / 2 - 2
  const center = size / 2
  const SWEEP = 270
  const START = 135
  const arc = (fromDegrees: number, toDegrees: number) => {
    const toRadians = (degrees: number) => (degrees * Math.PI) / 180
    const start = {
      x: center + radius * Math.cos(toRadians(fromDegrees)),
      y: center + radius * Math.sin(toRadians(fromDegrees)),
    }
    const end = {
      x: center + radius * Math.cos(toRadians(toDegrees)),
      y: center + radius * Math.sin(toRadians(toDegrees)),
    }
    const large = Math.abs(toDegrees - fromDegrees) > 180 ? 1 : 0
    return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${large} 1 ${end.x} ${end.y}`
  }
  return (
    <Stack gap="micro" align="center" style={style}>
      <svg
        width={size}
        height={size}
        role="img"
        aria-label={`${typeof label === 'string' ? label : 'Progress'}: ${value} of ${safeMax}`}
      >
        <path
          d={arc(START, START + SWEEP)}
          fill="none"
          stroke={tokens.fill.secondary}
          strokeWidth={thickness}
          strokeLinecap="round"
        />
        {ratio > 0 ? (
          <path
            d={arc(START, START + SWEEP * ratio)}
            fill="none"
            stroke={color}
            strokeWidth={thickness}
            strokeLinecap="round"
          />
        ) : null}
        <text
          x={center}
          y={center + 2}
          textAnchor="middle"
          fill={tokens.text.primary}
          fontSize={18}
          fontWeight={600}
        >
          {centerLabel ?? `${Math.round(ratio * 100)}%`}
        </text>
      </svg>
      {label ? (
        <Text tone="secondary" size="small">
          {label}
        </Text>
      ) : null}
    </Stack>
  )
}

// ── Priority quadrant ─────────────────────────────────────────────────────────

export interface QuadrantItem {
  label: string
  /** 0–1 along the x axis. */
  x: number
  /** 0–1 along the y axis. */
  y: number
  detail?: ReactNode
}

export interface QuadrantChartProps {
  items: QuadrantItem[]
  /** Axis names, e.g. `effort` and `impact`. */
  xLabel: string
  yLabel: string
  /** Corner captions, clockwise from top-left. Four entries. */
  quadrantLabels?: [string, string, string, string]
  title?: ReactNode
  height?: number
  style?: CSSProperties
}

/**
 * Items sorted by two axes into four quadrants.
 *
 * The quadrant captions are the payload: a scatter plot shows where things sit,
 * but "high impact, low effort → do first" is the recommendation the reader came
 * for. Labels are placed with an anchor chosen per corner so none of them
 * overhang the plot.
 */
export function QuadrantChart({
  items,
  xLabel,
  yLabel,
  quadrantLabels = ['Plan', 'Do first', 'Drop', 'Fill in'],
  title,
  height = 320,
  style,
}: QuadrantChartProps) {
  const { tokens } = useHostTheme()
  const [ref, width] = useMeasuredWidth()
  const pad = { left: 52, right: 16, top: 26, bottom: 34 }
  const plotWidth = Math.max(80, width - pad.left - pad.right)
  const plotHeight = height - pad.top - pad.bottom
  const px = (x: number) => pad.left + Math.min(1, Math.max(0, x)) * plotWidth
  // y is inverted: 1 is the TOP of the plot, which is what "high impact" means.
  const py = (y: number) => pad.top + (1 - Math.min(1, Math.max(0, y))) * plotHeight
  const midX = pad.left + plotWidth / 2
  const midY = pad.top + plotHeight / 2
  const corners: { x: number; y: number; anchor: 'start' | 'end'; text: string }[] = [
    { x: pad.left + 6, y: pad.top + 12, anchor: 'start', text: quadrantLabels[0] },
    { x: pad.left + plotWidth - 6, y: pad.top + 12, anchor: 'end', text: quadrantLabels[1] },
    { x: pad.left + plotWidth - 6, y: pad.top + plotHeight - 6, anchor: 'end', text: quadrantLabels[2] },
    { x: pad.left + 6, y: pad.top + plotHeight - 6, anchor: 'start', text: quadrantLabels[3] },
  ]
  return (
    <Stack gap="inline" style={style}>
      {title ? <Text weight="medium">{title}</Text> : null}
      <div ref={ref} style={{ width: '100%' }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="img"
          aria-label={`${title ?? 'Quadrant chart'}: ${xLabel} against ${yLabel}`}
          style={{ display: 'block', maxWidth: '100%' }}
        >
          <rect
            x={pad.left}
            y={pad.top}
            width={plotWidth}
            height={plotHeight}
            fill={tokens.fill.tertiary}
            stroke={tokens.stroke.primary}
            rx={4}
          />
          <line x1={midX} y1={pad.top} x2={midX} y2={pad.top + plotHeight} stroke={tokens.stroke.primary} />
          <line x1={pad.left} y1={midY} x2={pad.left + plotWidth} y2={midY} stroke={tokens.stroke.primary} />
          {corners.map((corner) => (
            <text
              key={corner.text}
              x={corner.x}
              y={corner.y}
              textAnchor={corner.anchor}
              fill={tokens.text.quaternary}
              fontSize={10}
            >
              {corner.text}
            </text>
          ))}
          {items.map((item, index) => {
            const cx = px(item.x)
            const cy = py(item.y)
            const color = tokens.chart.sequence[index % tokens.chart.sequence.length]
            // Labels flip to the left of their dot in the right half, so a dot near
            // the right edge does not push its text out of the plot.
            const flip = cx > midX
            return (
              <g key={item.label}>
                <circle cx={cx} cy={cy} r={5} fill={color} />
                <text
                  x={flip ? cx - 8 : cx + 8}
                  y={cy + 3}
                  textAnchor={flip ? 'end' : 'start'}
                  fill={tokens.text.secondary}
                  fontSize={10}
                >
                  {item.label}
                </text>
              </g>
            )
          })}
          <text
            x={pad.left + plotWidth / 2}
            y={height - 8}
            textAnchor="middle"
            fill={tokens.text.tertiary}
            fontSize={10}
          >
            {xLabel} →
          </text>
          <text
            x={12}
            y={pad.top + plotHeight / 2}
            textAnchor="middle"
            fill={tokens.text.tertiary}
            fontSize={10}
            transform={`rotate(-90 12 ${pad.top + plotHeight / 2})`}
          >
            {yLabel} →
          </text>
        </svg>
      </div>
    </Stack>
  )
}

// ── Comparison grid ───────────────────────────────────────────────────────────

export interface ChartComparisonGridProps {
  children: ReactNode
  /** Panels per row. Collapses when narrow. */
  columns?: number
  /** One caption for the whole comparison, e.g. the shared scale or window. */
  caption?: ReactNode
  style?: CSSProperties
}

/**
 * Two or more charts side by side.
 *
 * Exists so the SHARED caption has somewhere to live. Side-by-side charts are
 * only honest when they use one scale and one time window, and stating that once
 * under the pair is how the reader knows they can compare heights directly.
 */
export function ChartComparisonGrid({
  children,
  columns = 2,
  caption,
  style,
}: ChartComparisonGridProps) {
  return (
    <Stack gap="inline" style={style}>
      <Grid columns={columns} minColumnWidth={280}>
        {children}
      </Grid>
      {caption ? (
        <Text tone="quaternary" size="small">
          {caption}
        </Text>
      ) : null}
    </Stack>
  )
}

// ── Bubble ────────────────────────────────────────────────────────────────────

export interface MultiplierBubbleChartDatum {
  label: string
  /** Horizontal position, in the same unit as every other point. */
  x: number
  /** Vertical position. */
  y: number
  /** The third dimension, drawn as AREA. Defaults to 1. */
  size?: number
  color?: string
}

export interface MultiplierBubbleChartProps {
  data: MultiplierBubbleChartDatum[]
  title?: ReactNode
  xLabel?: ReactNode
  yLabel?: ReactNode
  /** What `size` counts, for the caption: `requests`, `files`, `USD`. */
  sizeLabel?: ReactNode
  caption?: ReactNode
  height?: number
  style?: CSSProperties
}

/**
 * Two axes plus a magnitude.
 *
 * The one shape the rest of the set cannot draw: a quadrant sorts into four
 * boxes and throws the distances away, a bar chart holds one number per
 * category. This keeps all three — "slow AND frequent AND expensive" is one
 * point out on its own, and that is usually the whole finding.
 *
 * Radius scales with the SQUARE ROOT of `size`, because the eye reads a disc by
 * area. Mapping size to radius directly makes a 4× value look 16× bigger, which
 * is how a bubble chart ends up lying about its own data.
 */
export function MultiplierBubbleChart({
  data,
  title,
  xLabel,
  yLabel,
  sizeLabel,
  caption,
  height = 300,
  style,
}: MultiplierBubbleChartProps) {
  const { tokens } = useHostTheme()
  const [ref, width] = useMeasuredWidth()
  const points = data.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))

  const sizeMax = Math.max(1, ...points.map((p) => Math.max(0, p.size ?? 1)))
  // 6px floor so a smallest-value point is still a target the eye can find.
  const radius = (size: number | undefined) =>
    6 + Math.sqrt(Math.max(0, size ?? 1) / sizeMax) * 22
  // The plot has to be inset by the LARGEST radius, not by a fixed margin. A
  // point at the top of its range sits on the plot edge, so half its disc lands
  // outside — clipped by the viewBox and covering the axis label it is nearest.
  const maxRadius = Math.max(0, ...points.map((p) => radius(p.size)))

  // Left pad carries the y tick labels; bottom pad carries the x ticks and the
  // axis title. Both grow by the bubble reach so nothing overlaps them.
  const pad = {
    left: 46 + maxRadius,
    right: 26 + maxRadius,
    top: 8 + maxRadius,
    bottom: (xLabel ? 40 : 26) + maxRadius,
  }
  // Where the tick labels actually sit. They have to clear the bubble reach, not
  // just the plot edge: a point at x=0 or y=0 spills a full radius outside the
  // plot, straight over a label drawn 8px off the axis.
  const yLabelX = pad.left - maxRadius - 8
  const xLabelY = (plotBottom: number) => plotBottom + maxRadius + 16
  const plotW = Math.max(40, width - pad.left - pad.right)
  const plotH = Math.max(40, height - pad.top - pad.bottom)

  const xs = points.map((p) => p.x)
  const ys = points.map((p) => p.y)
  const xMax = niceTop(Math.max(0, ...xs))
  const yMax = niceTop(Math.max(0, ...ys))

  const px = (value: number) => pad.left + (value / xMax) * plotW
  const py = (value: number) => pad.top + plotH - (value / yMax) * plotH

  const ticks = [0, 0.25, 0.5, 0.75, 1]
  const palette = [
    tokens.chart.blue,
    tokens.chart.purple,
    tokens.chart.teal,
    tokens.chart.orange,
    tokens.chart.pink,
    tokens.chart.green,
  ]

  return (
    <Stack gap="inline" style={style}>
      {title ? <Text weight="medium">{title}</Text> : null}
      <div ref={ref} style={{ width: '100%' }}>
        <svg
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={typeof title === 'string' ? title : 'bubble chart'}
        >
          {ticks.map((fraction) => {
            const y = pad.top + plotH - fraction * plotH
            return (
              <g key={`y${fraction}`}>
                <line
                  x1={pad.left}
                  x2={pad.left + plotW}
                  y1={y}
                  y2={y}
                  stroke={tokens.stroke.secondary}
                  strokeWidth={1}
                />
                <text
                  x={yLabelX}
                  y={y + 4}
                  textAnchor="end"
                  fill={tokens.text.quaternary}
                  fontSize={11}
                >
                  {formatCompact(yMax * fraction)}
                </text>
              </g>
            )
          })}
          {ticks.map((fraction) => (
            <text
              key={`x${fraction}`}
              x={px(xMax * fraction)}
              y={xLabelY(pad.top + plotH)}
              textAnchor={fraction === 0 ? 'start' : fraction === 1 ? 'end' : 'middle'}
              fill={tokens.text.quaternary}
              fontSize={11}
            >
              {formatCompact(xMax * fraction)}
            </text>
          ))}
          {points.map((point, index) => {
            const fill = point.color ?? palette[index % palette.length]
            return (
              <g key={`${point.label}-${index}`}>
                <circle
                  cx={px(point.x)}
                  cy={py(point.y)}
                  r={radius(point.size)}
                  fill={fill}
                  fillOpacity={0.28}
                  stroke={fill}
                  strokeWidth={1.5}
                />
                <text
                  x={px(point.x)}
                  y={py(point.y) + 4}
                  textAnchor="middle"
                  fill={tokens.text.primary}
                  fontSize={11}
                >
                  {point.label}
                </text>
              </g>
            )
          })}
          {xLabel ? (
            <text
              x={pad.left + plotW / 2}
              y={height - 6}
              textAnchor="middle"
              fill={tokens.text.tertiary}
              fontSize={11}
            >
              {typeof xLabel === 'string' ? xLabel : ''}
            </text>
          ) : null}
        </svg>
      </div>
      <Row gap="component" wrap>
        {yLabel ? (
          <Text tone="quaternary" size="small">
            ↑ {yLabel}
          </Text>
        ) : null}
        {sizeLabel ? (
          <Text tone="quaternary" size="small">
            ○ {sizeLabel}
          </Text>
        ) : null}
      </Row>
      {caption ? (
        <Text tone="quaternary" size="small">
          {caption}
        </Text>
      ) : null}
    </Stack>
  )
}

/** Round an axis maximum up to something with a readable tick sequence. */
function niceTop(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1
  const magnitude = 10 ** Math.floor(Math.log10(value))
  for (const step of [1, 2, 2.5, 5, 10]) {
    const candidate = step * magnitude
    if (candidate >= value) return candidate
  }
  return 10 * magnitude
}

/** Short axis numbers: 1.2k, 3.4M. A full integer axis pushes the plot right. */
function formatCompact(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1_000_000) return `${trimZero(value / 1_000_000)}M`
  if (abs >= 1_000) return `${trimZero(value / 1_000)}k`
  return trimZero(value)
}

function trimZero(value: number): string {
  const rounded = Math.round(value * 10) / 10
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
}
