// Data-display primitives: the components that carry the numbers and findings a
// canvas exists to show. Tables, stats, progress, deltas, callouts, timelines.
//
// The table is the centre of gravity here. It takes two shapes on purpose:
// a `columns` + `rows` form for real data with per-cell rendering, and a
// `headers` + `rows` form for a quick literal grid. The second exists because a
// canvas is often assembled from a handful of hand-written rows, and forcing a
// column descriptor for three strings produces worse generated code, not better.

import type { CSSProperties, ReactNode } from 'react'
import { useId, useState } from 'react'

import type { Tone, CellAlign, TrendDirection } from './core-primitives'
import { Row, Stack, Text, toneColors } from './core-primitives'
import { useHostTheme } from './hooks'
import type { CanvasTokens } from './tokens'

// ── Table ─────────────────────────────────────────────────────────────────────

export type TableDensity = 'compact' | 'default' | 'comfortable'

/** Row tint. Semantic, not decorative — tint a row only when its STATE differs. */
export type TableRowTone = 'default' | 'muted' | Tone

export interface TableColumn<T = Record<string, unknown>> {
  /** Property to read when there is no `render`. */
  key: string
  /** Header cell. Falls back to `key`. */
  title?: ReactNode
  align?: CellAlign
  width?: string
  /** Single-line ellipsis for this column's cells. */
  truncate?: boolean
  render?: (row: T, index: number) => ReactNode
}

interface TableCommon {
  /** Bound the height and the header sticks while the body scrolls. */
  maxHeight?: number | string
  density?: TableDensity
  /** Shown instead of the body when there are no rows. */
  emptyText?: ReactNode
  ariaLabel?: string
  style?: CSSProperties
}

export interface DataTableProps<T = Record<string, unknown>> extends TableCommon {
  columns: TableColumn<T>[]
  rows: T[]
  /** Stable key per row. Falls back to the index. */
  rowKey?: (row: T, index: number) => string
  rowTone?: (row: T, index: number) => TableRowTone
}

export interface SimpleTableProps extends TableCommon {
  headers: ReactNode[]
  rows: ReactNode[][]
  rowTone?: TableRowTone[]
}

export type TableProps<T = Record<string, unknown>> = DataTableProps<T> | SimpleTableProps

const DENSITY_PADDING: Record<TableDensity, string> = {
  compact: '4px 8px',
  default: '7px 10px',
  comfortable: '10px 12px',
}

function isSimple<T>(props: TableProps<T>): props is SimpleTableProps {
  return 'headers' in props
}

function rowBackground(tokens: CanvasTokens, tone: TableRowTone | undefined) {
  if (!tone || tone === 'default') return undefined
  if (tone === 'muted') return tokens.fill.tertiary
  return toneColors(tokens, tone).bg
}

export function Table<T = Record<string, unknown>>(props: TableProps<T>) {
  const { tokens } = useHostTheme()
  const { maxHeight, density = 'default', emptyText, ariaLabel, style } = props
  const padding = DENSITY_PADDING[density]

  const headers: ReactNode[] = isSimple(props)
    ? props.headers
    : props.columns.map((column) => column.title ?? column.key)
  const alignments: (CellAlign | undefined)[] = isSimple(props)
    ? props.headers.map(() => undefined)
    : props.columns.map((column) => column.align)
  const widths: (string | undefined)[] = isSimple(props)
    ? props.headers.map(() => undefined)
    : props.columns.map((column) => column.width)

  const body: { key: string; tone: TableRowTone | undefined; cells: ReactNode[] }[] = isSimple(props)
    ? props.rows.map((cells, index) => ({
        key: String(index),
        tone: props.rowTone?.[index],
        cells,
      }))
    : props.rows.map((row, index) => ({
        key: props.rowKey?.(row, index) ?? String(index),
        tone: props.rowTone?.(row, index),
        cells: props.columns.map((column, columnIndex) => {
          if (column.render) return column.render(row, index)
          const value = (row as Record<string, unknown>)[column.key]
          // A missing field renders as nothing rather than "undefined": a table
          // built from heterogeneous rows is normal, and the string "undefined"
          // in a cell is always a bug the reader has to decode.
          return value === undefined || value === null ? '' : String(value)
        }),
      }))

  const headerCellStyle: CSSProperties = {
    padding,
    textAlign: 'left',
    fontSize: tokens.fontSize.caption,
    fontWeight: tokens.weight.medium,
    color: tokens.text.tertiary,
    background: tokens.bg.chrome,
    borderBottom: `1px solid ${tokens.stroke.primary}`,
    position: maxHeight ? 'sticky' : undefined,
    top: maxHeight ? 0 : undefined,
    zIndex: maxHeight ? 1 : undefined,
    whiteSpace: 'nowrap',
  }

  return (
    <div
      data-canvas-scroll
      style={{
        border: `1px solid ${tokens.stroke.primary}`,
        borderRadius: tokens.radius.sm,
        overflow: 'auto',
        maxHeight,
        ...style,
      }}
    >
      <table
        aria-label={ariaLabel}
        style={{
          width: '100%',
          borderCollapse: 'separate',
          borderSpacing: 0,
          fontSize: tokens.fontSize.bodySm,
          color: tokens.text.primary,
        }}
      >
        <thead>
          <tr>
            {headers.map((header, index) => (
              <th
                key={index}
                scope="col"
                style={{
                  ...headerCellStyle,
                  textAlign: alignments[index] ?? 'left',
                  width: widths[index],
                }}
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.length === 0 ? (
            <tr>
              <td
                colSpan={Math.max(1, headers.length)}
                style={{ padding: '18px 10px', textAlign: 'center', color: tokens.text.tertiary }}
              >
                {emptyText ?? 'No rows'}
              </td>
            </tr>
          ) : (
            body.map((row, rowIndex) => (
              <tr key={row.key} style={{ background: rowBackground(tokens, row.tone) }}>
                {row.cells.map((cell, columnIndex) => (
                  <td
                    key={columnIndex}
                    style={{
                      padding,
                      textAlign: alignments[columnIndex] ?? 'left',
                      verticalAlign: 'top',
                      borderBottom:
                        rowIndex === body.length - 1
                          ? 'none'
                          : `1px solid ${tokens.stroke.secondary}`,
                      ...(isSimple(props)
                        ? {}
                        : props.columns[columnIndex]?.truncate
                          ? {
                              maxWidth: 0,
                              whiteSpace: 'nowrap',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                            }
                          : {}),
                    }}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

// ── Numbers ───────────────────────────────────────────────────────────────────

export interface StatProps {
  label: ReactNode
  value: ReactNode
  /** A unit shown small next to the value: `%`, `ms`, `req/s`. */
  unit?: ReactNode
  tone?: Tone
  /** One line under the value: what it means, or where it came from. */
  description?: ReactNode
  /** A `Delta` or `Tag` sitting beside the value. */
  trailing?: ReactNode
  align?: CellAlign
  size?: 'sm' | 'md' | 'lg'
  style?: CSSProperties
}

const STAT_VALUE_SIZE: Record<'sm' | 'md' | 'lg', keyof CanvasTokens['fontSize']> = {
  sm: 'emphasis',
  md: 'title',
  lg: 'hero',
}

/** One headline number with its label. The unit is separate so it can be set
 *  smaller than the number — a unit at value size reads as part of the value. */
export function Stat({
  label,
  value,
  unit,
  tone,
  description,
  trailing,
  align = 'left',
  size = 'md',
  style,
}: StatProps) {
  const { tokens } = useHostTheme()
  const colors = toneColors(tokens, tone)
  return (
    <Stack gap="micro" style={{ textAlign: align, ...style }}>
      <Text tone="tertiary" size="small">
        {label}
      </Text>
      <Row gap="micro" align="end" justify={align === 'center' ? 'center' : 'start'}>
        <span
          style={{
            fontSize: tokens.fontSize[STAT_VALUE_SIZE[size]],
            fontWeight: tokens.weight.semibold,
            lineHeight: 1.2,
            color: tone && tone !== 'neutral' ? colors.fg : tokens.text.primary,
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {value}
        </span>
        {unit ? (
          <span style={{ fontSize: tokens.fontSize.small, color: tokens.text.tertiary }}>
            {unit}
          </span>
        ) : null}
        {trailing}
      </Row>
      {description ? (
        <Text tone="quaternary" size="small">
          {description}
        </Text>
      ) : null}
    </Stack>
  )
}

export interface DeltaProps {
  value: number
  /** Appended to the formatted number. Defaults to `%`. */
  suffix?: string
  /**
   * Which direction is good. `normal` means up is good (throughput); `inverse`
   * means down is good (latency, error rate, cost). Getting this right is the
   * whole point of the component — a red −40% on a latency chart is wrong.
   */
  direction?: 'normal' | 'inverse'
  precision?: number
  style?: CSSProperties
}

/** A signed change, coloured by whether it is good rather than by its sign. */
export function Delta({ value, suffix = '%', direction = 'normal', precision = 1, style }: DeltaProps) {
  const { tokens } = useHostTheme()
  const trend: TrendDirection = value > 0 ? 'up' : value < 0 ? 'down' : 'flat'
  const good = direction === 'inverse' ? value < 0 : value > 0
  const color =
    trend === 'flat'
      ? tokens.text.tertiary
      : good
        ? tokens.status.success
        : tokens.status.danger
  const arrow = trend === 'up' ? '↑' : trend === 'down' ? '↓' : '→'
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        color,
        fontSize: tokens.fontSize.small,
        fontWeight: tokens.weight.medium,
        fontVariantNumeric: 'tabular-nums',
        ...style,
      }}
    >
      <span aria-hidden="true">{arrow}</span>
      {Math.abs(value).toFixed(precision)}
      {suffix}
    </span>
  )
}

export interface ProgressProps {
  value: number
  max?: number
  tone?: Tone
  label?: ReactNode
  /** `percent` shows `62%`, `fraction` shows `31/50`, `none` shows no readout. */
  format?: 'percent' | 'fraction' | 'none'
  height?: number
  style?: CSSProperties
}

export function Progress({
  value,
  max = 100,
  tone = 'accent',
  label,
  format = 'percent',
  height = 6,
  style,
}: ProgressProps) {
  const { tokens } = useHostTheme()
  const safeMax = max > 0 ? max : 100
  const ratio = Math.min(1, Math.max(0, value / safeMax))
  // `chart.blue`, not `accent.control`: the control accent is the INK colour
  // (white on dark), and a white-filled bar reads as "complete" regardless of the
  // number beside it. A filled data bar takes a chart colour.
  const fill = tone === 'accent' ? tokens.chart.blue : toneColors(tokens, tone).fg
  const readout =
    format === 'percent'
      ? `${Math.round(ratio * 100)}%`
      : format === 'fraction'
        ? `${value}/${safeMax}`
        : null
  return (
    <Stack gap="micro" style={style}>
      {label || readout ? (
        <Row justify="space-between">
          {label ? (
            <Text tone="secondary" size="small">
              {label}
            </Text>
          ) : (
            <span />
          )}
          {readout ? (
            <Text tone="tertiary" size="small" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {readout}
            </Text>
          ) : null}
        </Row>
      ) : null}
      <div
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        style={{
          height,
          borderRadius: 999,
          background: tokens.fill.secondary,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            width: `${ratio * 100}%`,
            height: '100%',
            borderRadius: 999,
            background: fill,
            transition: `width ${tokens.motion.durationBase} ${tokens.motion.easeOut}`,
          }}
        />
      </div>
    </Stack>
  )
}

// ── Messages ──────────────────────────────────────────────────────────────────

export interface CalloutProps {
  children?: ReactNode
  title?: ReactNode
  tone?: Tone
  style?: CSSProperties
}

/** A tinted note. For a caveat, a limitation, or a conclusion worth isolating. */
export function Callout({ children, title, tone = 'info', style }: CalloutProps) {
  const { tokens } = useHostTheme()
  const colors = toneColors(tokens, tone)
  return (
    <div
      style={{
        display: 'flex',
        gap: 10,
        padding: '10px 12px',
        borderRadius: tokens.radius.sm,
        background: colors.bg,
        // A left rule rather than a full border: the tint already carries the
        // tone, and a ring around it makes a page of callouts read as noise.
        borderLeft: `2px solid ${colors.fg}`,
        ...style,
      }}
    >
      <Stack gap="micro" style={{ minWidth: 0 }}>
        {title ? (
          <span
            style={{
              color: colors.fg,
              fontSize: tokens.fontSize.bodySm,
              fontWeight: tokens.weight.semibold,
            }}
          >
            {title}
          </span>
        ) : null}
        {children ? (
          <div style={{ color: tokens.text.secondary, fontSize: tokens.fontSize.bodySm }}>
            {children}
          </div>
        ) : null}
      </Stack>
    </div>
  )
}

export interface BannerProps {
  children?: ReactNode
  title?: ReactNode
  tone?: Tone
  /** An action on the right — a SendToChatButton, usually. */
  action?: ReactNode
  style?: CSSProperties
}

/**
 * A page-level notice.
 *
 * The difference from `Callout` is placement, not decoration. A callout sits
 * INSIDE a section and annotates the thing above it; a banner sits at the top of
 * the canvas and qualifies everything below — "this data is from a cached run",
 * "three files could not be read". So it is full width, it has a real border on
 * all sides, and it holds an action.
 */
export function Banner({ children, title, tone = 'info', action, style }: BannerProps) {
  const { tokens } = useHostTheme()
  const colors = toneColors(tokens, tone)
  return (
    <div
      role="status"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        width: '100%',
        padding: '12px 14px',
        borderRadius: tokens.radius.md,
        background: colors.bg,
        border: `1px solid ${colors.border}`,
        boxSizing: 'border-box',
        ...style,
      }}
    >
      <Stack gap="micro" style={{ minWidth: 0, flex: 1 }}>
        {title ? (
          <span
            style={{
              color: colors.fg,
              fontSize: tokens.fontSize.body,
              fontWeight: tokens.weight.semibold,
            }}
          >
            {title}
          </span>
        ) : null}
        {children ? (
          <div style={{ color: tokens.text.secondary, fontSize: tokens.fontSize.bodySm }}>
            {children}
          </div>
        ) : null}
      </Stack>
      {action ? <div style={{ flexShrink: 0 }}>{action}</div> : null}
    </div>
  )
}

export interface SkeletonProps {
  width?: number | string
  height?: number | string
  style?: CSSProperties
}

/** A loading placeholder. Rare in a canvas — the data is embedded — but a
 *  canvas that computes something on interaction has a moment to fill. */
export function Skeleton({ width = '100%', height = 12, style }: SkeletonProps) {
  const { tokens } = useHostTheme()
  return (
    <div
      aria-hidden="true"
      style={{ width, height, borderRadius: tokens.radius.xxs, background: tokens.fill.secondary, ...style }}
    />
  )
}

// ── Timeline ──────────────────────────────────────────────────────────────────

export interface TimelineEvent {
  /** When it happened. Rendered as given — format it for the reader. */
  time: ReactNode
  title: ReactNode
  description?: ReactNode
  tone?: Tone
}

export interface TimelineProps {
  events: TimelineEvent[]
  style?: CSSProperties
}

/** An ordered sequence of events with a connecting rail. */
export function Timeline({ events, style }: TimelineProps) {
  const { tokens } = useHostTheme()
  return (
    <Stack gap={0} style={style}>
      {events.map((event, index) => {
        const colors = toneColors(tokens, event.tone)
        const last = index === events.length - 1
        return (
          <Row key={index} gap="component" align="start">
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                alignSelf: 'stretch',
                flexShrink: 0,
              }}
            >
              <span
                style={{
                  width: 7,
                  height: 7,
                  marginTop: 6,
                  borderRadius: 999,
                  background: event.tone && event.tone !== 'neutral' ? colors.fg : tokens.text.quaternary,
                  flexShrink: 0,
                }}
              />
              {last ? null : (
                <span style={{ width: 1, flex: 1, marginTop: 4, background: tokens.stroke.primary }} />
              )}
            </div>
            <Stack gap="micro" style={{ paddingBottom: last ? 0 : 16, minWidth: 0 }}>
              <Text tone="quaternary" size="small">
                {event.time}
              </Text>
              <Text weight="medium">{event.title}</Text>
              {event.description ? (
                <Text tone="secondary" size="small">
                  {event.description}
                </Text>
              ) : null}
            </Stack>
          </Row>
        )
      })}
    </Stack>
  )
}

// ── Key/value list ────────────────────────────────────────────────────────────

export interface FieldListProps {
  items: { label: ReactNode; value: ReactNode }[]
  /** Label column width. A fixed width keeps the values aligned. */
  labelWidth?: number | string
  style?: CSSProperties
}

/** Aligned label/value pairs. For metadata, config, and provenance — the things
 *  a table would over-structure and a paragraph would bury. */
export function FieldList({ items, labelWidth = 160, style }: FieldListProps) {
  const { tokens } = useHostTheme()
  return (
    <Stack gap="inline" style={style}>
      {items.map((item, index) => (
        <Row key={index} gap="component" align="start">
          <div style={{ width: labelWidth, flexShrink: 0 }}>
            <Text tone="tertiary" size="small">
              {item.label}
            </Text>
          </div>
          <div style={{ minWidth: 0, flex: 1, fontSize: tokens.fontSize.bodySm, color: tokens.text.primary }}>
            {item.value}
          </div>
        </Row>
      ))}
    </Stack>
  )
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

export interface TabsProps {
  tabs: { id: string; label: ReactNode; content: ReactNode }[]
  /** Uncontrolled initial tab. Defaults to the first. */
  defaultTab?: string
  /** Controlled selection, to pair with `useCanvasState`. */
  active?: string
  onActiveChange?: (id: string) => void
  style?: CSSProperties
}

/** A tab strip. For alternative views of one subject — not for navigation, and
 *  not as a place to hide content the reader needs to compare side by side. */
export function Tabs({ tabs, defaultTab, active, onActiveChange, style }: TabsProps) {
  const { tokens } = useHostTheme()
  const [internal, setInternal] = useState(defaultTab ?? tabs[0]?.id ?? '')
  const current = active ?? internal
  const groupId = useId()
  const selected = tabs.find((tab) => tab.id === current) ?? tabs[0]
  return (
    <Stack gap="container" style={style}>
      <div
        role="tablist"
        style={{ display: 'flex', gap: 2, borderBottom: `1px solid ${tokens.stroke.primary}` }}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === selected?.id
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`${groupId}-${tab.id}`}
              aria-selected={isActive}
              onClick={() => {
                if (active === undefined) setInternal(tab.id)
                onActiveChange?.(tab.id)
              }}
              style={{
                padding: '6px 10px',
                background: 'transparent',
                border: 'none',
                // The selected tab is marked with an ink underline rather than a
                // filled pill: a filled tab competes with the content below it.
                borderBottom: `2px solid ${isActive ? tokens.accent.primary : 'transparent'}`,
                marginBottom: -1,
                color: isActive ? tokens.text.primary : tokens.text.tertiary,
                font: 'inherit',
                fontSize: tokens.fontSize.bodySm,
                fontWeight: isActive ? tokens.weight.medium : tokens.weight.regular,
                cursor: 'pointer',
              }}
            >
              {tab.label}
            </button>
          )
        })}
      </div>
      <div role="tabpanel" aria-labelledby={selected ? `${groupId}-${selected.id}` : undefined}>
        {selected?.content}
      </div>
    </Stack>
  )
}
