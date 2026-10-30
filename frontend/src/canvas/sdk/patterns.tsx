// Pattern components: semantic blocks assembled from the primitives, for the
// shapes that keep recurring in generated canvases.
//
// The line between this file and `data-primitives.tsx` is who decides the
// meaning. A `Table` renders whatever rows it is handed; a `RiskHeatmap` knows
// that likelihood times impact is a risk level and colours itself accordingly.
// Patterns carry an opinion, which is exactly why they belong in the SDK rather
// than being re-derived, slightly differently, in every canvas that needs one.

import type { CSSProperties, ReactNode } from 'react'
import { useMemo, useState } from 'react'

import type { Tone } from './core-primitives'
import { Card, Divider, Grid, H2, H3, Link, Row, Stack, Tag, Text, toneColors } from './core-primitives'
import { Delta, FieldList } from './data-primitives'
import { useHostTheme } from './hooks'

// ── Metrics grid ──────────────────────────────────────────────────────────────

export interface MetricItem {
  label: ReactNode
  value: ReactNode
  unit?: ReactNode
  /** Percent change. Rendered as a `Delta`; omit when there is no baseline. */
  change?: number
  /** Which direction is good for THIS metric. Defaults to up-is-good. */
  changeDirection?: 'normal' | 'inverse'
  tone?: Tone
  description?: ReactNode
}

export interface MetricsGridProps {
  metrics: MetricItem[]
  /** Boxed cards, or a plain row of figures. Plain reads better above a chart. */
  variant?: 'card' | 'plain'
  columns?: number
  style?: CSSProperties
}

/**
 * The headline figures of a report or dashboard.
 *
 * `change` is per-metric rather than a grid-wide flag because direction is a
 * property of the metric: cost down is good, throughput down is not. A single
 * grid routinely mixes both, and getting it wrong paints a regression green.
 */
export function MetricsGrid({ metrics, variant = 'card', columns, style }: MetricsGridProps) {
  const { tokens } = useHostTheme()
  const content = (metric: MetricItem) => {
    const colors = toneColors(tokens, metric.tone)
    return (
      <Stack gap="micro">
        <Text tone="tertiary" size="small">
          {metric.label}
        </Text>
        <Row gap="micro" align="end">
          <span
            style={{
              fontSize: tokens.fontSize.title,
              fontWeight: tokens.weight.semibold,
              lineHeight: 1.2,
              color: metric.tone && metric.tone !== 'neutral' ? colors.fg : tokens.text.primary,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {metric.value}
          </span>
          {metric.unit ? (
            <span style={{ fontSize: tokens.fontSize.small, color: tokens.text.tertiary }}>
              {metric.unit}
            </span>
          ) : null}
          {metric.change !== undefined ? (
            <Delta value={metric.change} direction={metric.changeDirection} />
          ) : null}
        </Row>
        {metric.description ? (
          <Text tone="quaternary" size="small">
            {metric.description}
          </Text>
        ) : null}
      </Stack>
    )
  }
  return (
    <Grid columns={columns ?? Math.min(4, Math.max(1, metrics.length))} style={style}>
      {metrics.map((metric, index) =>
        variant === 'card' ? (
          <Card key={index} size="sm">
            {content(metric)}
          </Card>
        ) : (
          <div key={index}>{content(metric)}</div>
        ),
      )}
    </Grid>
  )
}

// ── Risk heatmap ──────────────────────────────────────────────────────────────

export type RiskLevel = 'low' | 'moderate' | 'high' | 'critical'

export interface RiskItem {
  /** 1-based position on the likelihood axis. */
  likelihood: number
  /** 1-based position on the impact axis. */
  impact: number
  label: string
  detail?: ReactNode
}

export interface RiskHeatmapProps {
  /** Likelihood axis labels, lowest first. */
  likelihoodLabels: string[]
  /** Impact axis labels, lowest first. */
  impactLabels: string[]
  items: RiskItem[]
  title?: ReactNode
  /** Called when a populated cell is clicked. */
  onSelect?: (item: RiskItem) => void
  style?: CSSProperties
}

/**
 * Likelihood against impact, with items placed in cells.
 *
 * The level is DERIVED from the two axes rather than taken as an input, because a
 * matrix whose colours disagree with its own axes is worse than no matrix: the
 * reader trusts the colour and the colour is a lie. Normalizing by axis length
 * keeps a 3×3 and a 5×5 grid on the same scale.
 */
export function RiskHeatmap({
  likelihoodLabels,
  impactLabels,
  items,
  title,
  onSelect,
  style,
}: RiskHeatmapProps) {
  const { tokens } = useHostTheme()
  const levelFor = (likelihood: number, impact: number): RiskLevel => {
    const share =
      ((likelihood / likelihoodLabels.length) * (impact / impactLabels.length)) as number
    if (share >= 0.6) return 'critical'
    if (share >= 0.35) return 'high'
    if (share >= 0.15) return 'moderate'
    return 'low'
  }
  const levelTone: Record<RiskLevel, Tone> = {
    low: 'success',
    moderate: 'info',
    high: 'warning',
    critical: 'danger',
  }
  const cellItems = (likelihood: number, impact: number) =>
    items.filter((item) => item.likelihood === likelihood && item.impact === impact)

  return (
    <Stack gap="inline" style={style}>
      {title ? <Text weight="medium">{title}</Text> : null}
      <div data-canvas-scroll style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'separate', borderSpacing: 3 }}>
          <tbody>
            {/* Impact descends down the page so the worst cell is top-right,
                which is the orientation every risk matrix is read in. */}
            {[...impactLabels].reverse().map((impactLabel, reversedIndex) => {
              const impact = impactLabels.length - reversedIndex
              return (
                <tr key={impactLabel}>
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
                    {impactLabel}
                  </th>
                  {likelihoodLabels.map((_, likelihoodIndex) => {
                    const likelihood = likelihoodIndex + 1
                    const level = levelFor(likelihood, impact)
                    const colors = toneColors(tokens, levelTone[level])
                    const cell = cellItems(likelihood, impact)
                    return (
                      <td
                        key={likelihoodIndex}
                        style={{
                          minWidth: 96,
                          height: 56,
                          verticalAlign: 'top',
                          padding: 5,
                          borderRadius: tokens.radius.xs,
                          background: colors.bg,
                          border: `1px solid ${cell.length ? colors.border : 'transparent'}`,
                        }}
                      >
                        <Stack gap="micro">
                          {cell.map((item) => (
                            <button
                              key={item.label}
                              type="button"
                              onClick={onSelect ? () => onSelect(item) : undefined}
                              title={typeof item.detail === 'string' ? item.detail : item.label}
                              style={{
                                border: 'none',
                                background: 'transparent',
                                padding: 0,
                                textAlign: 'left',
                                font: 'inherit',
                                fontSize: tokens.fontSize.caption,
                                color: colors.fg,
                                cursor: onSelect ? 'pointer' : 'default',
                              }}
                            >
                              {item.label}
                            </button>
                          ))}
                        </Stack>
                      </td>
                    )
                  })}
                </tr>
              )
            })}
            <tr>
              <th />
              {likelihoodLabels.map((label) => (
                <td
                  key={label}
                  style={{
                    fontSize: 10,
                    color: tokens.text.quaternary,
                    textAlign: 'center',
                    paddingTop: 2,
                  }}
                >
                  {label}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <Row gap="component" wrap>
        {(['low', 'moderate', 'high', 'critical'] as RiskLevel[]).map((level) => (
          <Tag key={level} tone={levelTone[level]}>
            {level}
          </Tag>
        ))}
      </Row>
    </Stack>
  )
}

// ── Risk callout ──────────────────────────────────────────────────────────────

export interface RiskCalloutProps {
  title: ReactNode
  level: RiskLevel
  /** What happens if this lands. */
  impact: ReactNode
  /** What would stop it. */
  mitigation?: ReactNode
  style?: CSSProperties
}

/** One risk, stated as level + impact + mitigation. A risk without a stated
 *  impact is a worry; with one it is something that can be decided about. */
export function RiskCallout({ title, level, impact, mitigation, style }: RiskCalloutProps) {
  const { tokens } = useHostTheme()
  const tone: Tone =
    level === 'critical' ? 'danger' : level === 'high' ? 'warning' : level === 'moderate' ? 'info' : 'success'
  const colors = toneColors(tokens, tone)
  return (
    <div
      style={{
        padding: '10px 12px',
        borderRadius: tokens.radius.sm,
        background: colors.bg,
        borderLeft: `2px solid ${colors.fg}`,
        ...style,
      }}
    >
      <Stack gap="micro">
        <Row gap="inline">
          <Tag tone={tone}>{level}</Tag>
          <Text weight="medium">{title}</Text>
        </Row>
        <Text tone="secondary" size="small">
          {impact}
        </Text>
        {mitigation ? (
          <Text tone="tertiary" size="small">
            Mitigation: {mitigation}
          </Text>
        ) : null}
      </Stack>
    </div>
  )
}

// ── Reference panel ───────────────────────────────────────────────────────────

export type ReferenceKind = 'file' | 'url' | 'commit' | 'doc' | 'note'

export interface ReferenceItem {
  kind: ReferenceKind
  label: string
  /** A path, a URL, a SHA. Rendered monospace. */
  locator?: string
  note?: ReactNode
}

export interface ReferencePanelProps {
  references: ReferenceItem[]
  title?: ReactNode
  style?: CSSProperties
}

/**
 * Where the canvas's claims came from.
 *
 * Its own component because provenance is the first thing a reader challenges and
 * the first thing a generated report drops. A `url` becomes a real link; every
 * other kind stays inert text, since a file path is not something the preview
 * window can or should open.
 */
export function ReferencePanel({ references, title = 'References', style }: ReferencePanelProps) {
  const { tokens } = useHostTheme()
  const KIND_LABEL: Record<ReferenceKind, string> = {
    file: 'File',
    url: 'Link',
    commit: 'Commit',
    doc: 'Doc',
    note: 'Note',
  }
  return (
    <Stack gap="inline" style={style}>
      <Text tone="tertiary" size="small">
        {title}
      </Text>
      <Stack gap="micro">
        {references.map((reference, index) => (
          <Row key={index} gap="inline" align="start">
            <Tag>{KIND_LABEL[reference.kind]}</Tag>
            <Stack gap="micro" style={{ minWidth: 0 }}>
              {reference.kind === 'url' && reference.locator ? (
                <Link href={reference.locator}>{reference.label}</Link>
              ) : (
                <Text size="small">{reference.label}</Text>
              )}
              {reference.locator && reference.kind !== 'url' ? (
                <span
                  style={{
                    fontFamily: tokens.fontFamily.mono,
                    fontSize: tokens.fontSize.caption,
                    color: tokens.text.quaternary,
                    wordBreak: 'break-all',
                  }}
                >
                  {reference.locator}
                </span>
              ) : null}
              {reference.note ? (
                <Text tone="quaternary" size="small">
                  {reference.note}
                </Text>
              ) : null}
            </Stack>
          </Row>
        ))}
      </Stack>
    </Stack>
  )
}

// ── Docs section ──────────────────────────────────────────────────────────────

export interface DocsSectionProps {
  title: ReactNode
  /** A one-line summary under the heading. */
  summary?: ReactNode
  children?: ReactNode
  /** Right-aligned header content: a tag, a count, a control. */
  trailing?: ReactNode
  /** A rule above the heading. Use between sibling sections, not on the first. */
  divided?: boolean
  level?: 2 | 3
  style?: CSSProperties
}

/** A titled section with optional summary. The structural unit a long report is
 *  built from, so the spacing between title, summary, and body is decided once. */
export function DocsSection({
  title,
  summary,
  children,
  trailing,
  divided,
  level = 2,
  style,
}: DocsSectionProps) {
  const Heading = level === 2 ? H2 : H3
  return (
    <Stack gap="container" style={style}>
      {divided ? <Divider /> : null}
      <Stack gap="micro">
        <Row justify="space-between">
          <Heading>{title}</Heading>
          {trailing}
        </Row>
        {summary ? (
          <Text tone="secondary" size="small">
            {summary}
          </Text>
        ) : null}
      </Stack>
      {children}
    </Stack>
  )
}

// ── Findings list ─────────────────────────────────────────────────────────────

export interface FindingItem {
  id?: string
  title: ReactNode
  severity: 'critical' | 'high' | 'medium' | 'low'
  /** Where it is: a file and line, a component, an endpoint. */
  location?: string
  /** The concrete consequence. */
  impact?: ReactNode
  /** What to change. */
  fix?: ReactNode
  /** Rendered at the right of the header, e.g. a SendToChatButton. */
  action?: ReactNode
}

export interface FindingsListProps {
  findings: FindingItem[]
  /** Group under severity headings instead of one flat list. */
  grouped?: boolean
  style?: CSSProperties
}

const SEVERITY_ORDER: FindingItem['severity'][] = ['critical', 'high', 'medium', 'low']
const SEVERITY_TONE: Record<FindingItem['severity'], Tone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'info',
}

/**
 * A prioritized list of problems, each with evidence and a fix.
 *
 * Sorted by severity here rather than trusting input order: a review is only
 * actionable in the order things should be fixed, and a generated list arrives in
 * whatever order the files were read. An empty severity group is dropped rather
 * than rendered as a bare heading.
 */
export function FindingsList({ findings, grouped = true, style }: FindingsListProps) {
  const { tokens } = useHostTheme()
  const sorted = useMemo(
    () =>
      [...findings].sort(
        (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity),
      ),
    [findings],
  )

  const card = (finding: FindingItem, index: number) => (
    <Card key={finding.id ?? index}>
      <Stack gap="component">
        <Row gap="inline" justify="space-between">
          <Row gap="inline" style={{ minWidth: 0 }}>
            <Tag tone={SEVERITY_TONE[finding.severity]}>{finding.id ?? finding.severity}</Tag>
            <Text weight="medium">{finding.title}</Text>
          </Row>
          {finding.action}
        </Row>
        {finding.location ? (
          <span
            style={{
              fontFamily: tokens.fontFamily.mono,
              fontSize: tokens.fontSize.caption,
              color: tokens.text.tertiary,
              wordBreak: 'break-all',
            }}
          >
            {finding.location}
          </span>
        ) : null}
        {finding.impact ? (
          <Text tone="secondary" size="small">
            {finding.impact}
          </Text>
        ) : null}
        {finding.fix ? (
          <Text size="small">
            <span style={{ fontWeight: tokens.weight.medium }}>Fix: </span>
            {finding.fix}
          </Text>
        ) : null}
      </Stack>
    </Card>
  )

  if (!grouped) {
    return (
      <Stack gap="component" style={style}>
        {sorted.map(card)}
      </Stack>
    )
  }

  return (
    <Stack gap="section" style={style}>
      {SEVERITY_ORDER.map((severity) => {
        const group = sorted.filter((finding) => finding.severity === severity)
        if (group.length === 0) return null
        return (
          <Stack key={severity} gap="container">
            <Row gap="inline">
              <H3>{severity[0].toUpperCase() + severity.slice(1)}</H3>
              <Text tone="quaternary" size="small">
                {group.length}
              </Text>
            </Row>
            {group.map(card)}
          </Stack>
        )
      })}
    </Stack>
  )
}

// ── Comparison matrix ─────────────────────────────────────────────────────────

export interface ComparisonOption {
  name: string
  /** Verdict tag shown under the column head. */
  verdict?: { label: string; tone: Tone }
}

export interface ComparisonCriterion {
  name: string
  /** Why this criterion matters. */
  note?: ReactNode
  /** One value per option, in the same order. `null` renders the unknown mark. */
  values: (ReactNode | null)[]
}

export interface ComparisonMatrixProps {
  options: ComparisonOption[]
  criteria: ComparisonCriterion[]
  /** Shown for a `null` value, with a footnote explaining it. */
  unknownMark?: string
  style?: CSSProperties
}

/**
 * Options against shared criteria.
 *
 * `null` renders as an explicit unknown mark with a footnote, because a blank
 * cell in a comparison reads as zero when it almost always means "not
 * investigated" — and that misreading decides things.
 */
export function ComparisonMatrix({
  options,
  criteria,
  unknownMark = '—',
  style,
}: ComparisonMatrixProps) {
  const { tokens } = useHostTheme()
  const hasUnknown = criteria.some((criterion) => criterion.values.some((value) => value === null))
  const cell: CSSProperties = {
    padding: '8px 10px',
    verticalAlign: 'top',
    borderBottom: `1px solid ${tokens.stroke.secondary}`,
    fontSize: tokens.fontSize.bodySm,
  }
  return (
    <Stack gap="inline" style={style}>
      <div
        data-canvas-scroll
        style={{
          overflowX: 'auto',
          border: `1px solid ${tokens.stroke.primary}`,
          borderRadius: tokens.radius.sm,
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
          <thead>
            <tr>
              <th
                style={{
                  ...cell,
                  textAlign: 'left',
                  background: tokens.bg.chrome,
                  color: tokens.text.tertiary,
                  fontSize: tokens.fontSize.caption,
                  fontWeight: tokens.weight.medium,
                }}
              >
                Criterion
              </th>
              {options.map((option) => (
                <th
                  key={option.name}
                  style={{
                    ...cell,
                    textAlign: 'left',
                    background: tokens.bg.chrome,
                    color: tokens.text.primary,
                    fontWeight: tokens.weight.medium,
                  }}
                >
                  <Stack gap="micro">
                    <span>{option.name}</span>
                    {option.verdict ? (
                      <Tag tone={option.verdict.tone}>{option.verdict.label}</Tag>
                    ) : null}
                  </Stack>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {criteria.map((criterion) => (
              <tr key={criterion.name}>
                <th scope="row" style={{ ...cell, textAlign: 'left', fontWeight: tokens.weight.regular }}>
                  <Stack gap="micro">
                    <Text size="small">{criterion.name}</Text>
                    {criterion.note ? (
                      <Text tone="quaternary" size="small">
                        {criterion.note}
                      </Text>
                    ) : null}
                  </Stack>
                </th>
                {options.map((option, index) => {
                  const value = criterion.values[index]
                  return (
                    <td key={option.name} style={cell}>
                      {value === null || value === undefined ? (
                        <span style={{ color: tokens.text.quaternary }}>{unknownMark}</span>
                      ) : (
                        value
                      )}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {hasUnknown ? (
        <Text tone="quaternary" size="small">
          {unknownMark} means not applicable or not investigated, never zero.
        </Text>
      ) : null}
    </Stack>
  )
}

// ── Key/value summary with disclosure ─────────────────────────────────────────

export interface MethodologyProps {
  /** What was covered. */
  scope: ReactNode
  /** How it was done. */
  method: ReactNode
  /** What was deliberately left out. Stating this is the point. */
  notCovered?: ReactNode
  /** When the work was done. */
  asOf?: ReactNode
  style?: CSSProperties
}

/**
 * Scope, method, and exclusions.
 *
 * `notCovered` is a first-class field, not a free-text note, because "what this
 * did NOT look at" is the single most useful line in an audit and the first one
 * a generated report leaves out.
 */
export function Methodology({ scope, method, notCovered, asOf, style }: MethodologyProps) {
  const items = [
    { label: 'Scope', value: scope },
    { label: 'Method', value: method },
    ...(notCovered ? [{ label: 'Not covered', value: notCovered }] : []),
    ...(asOf ? [{ label: 'As of', value: asOf }] : []),
  ]
  return <FieldList items={items} style={style} />
}

// ── Diff-free before/after ────────────────────────────────────────────────────

export interface BeforeAfterProps {
  before: { label?: ReactNode; children: ReactNode }
  after: { label?: ReactNode; children: ReactNode }
  style?: CSSProperties
}

/** Two panels side by side, stacking when narrow. For state comparisons that are
 *  not code (a config, a layout, a policy). */
export function BeforeAfter({ before, after, style }: BeforeAfterProps) {
  return (
    <Grid columns={2} minColumnWidth={260} style={style}>
      <Card>
        <Stack gap="inline">
          <Text tone="tertiary" size="small">
            {before.label ?? 'Before'}
          </Text>
          {before.children}
        </Stack>
      </Card>
      <Card>
        <Stack gap="inline">
          <Text tone="tertiary" size="small">
            {after.label ?? 'After'}
          </Text>
          {after.children}
        </Stack>
      </Card>
    </Grid>
  )
}

// ── Expandable detail row ─────────────────────────────────────────────────────

export interface DisclosureProps {
  summary: ReactNode
  children: ReactNode
  /** Right-aligned summary content. */
  trailing?: ReactNode
  defaultOpen?: boolean
  style?: CSSProperties
}

/** A one-line disclosure, lighter than `CollapsibleSection`: no card, no border.
 *  For a long tail of rows where a bordered box per row would be noise. */
export function Disclosure({ summary, children, trailing, defaultOpen = false, style }: DisclosureProps) {
  const { tokens } = useHostTheme()
  const [open, setOpen] = useState(defaultOpen)
  return (
    <Stack gap="micro" style={style}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          width: '100%',
          padding: '4px 0',
          background: 'transparent',
          border: 'none',
          borderBottom: `1px solid ${tokens.stroke.secondary}`,
          cursor: 'pointer',
          font: 'inherit',
          fontSize: tokens.fontSize.bodySm,
          color: tokens.text.primary,
          textAlign: 'left',
        }}
      >
        <span
          aria-hidden="true"
          style={{ color: tokens.text.quaternary, fontSize: 9, width: 9, flexShrink: 0 }}
        >
          {open ? '▾' : '▸'}
        </span>
        <span style={{ flex: 1, minWidth: 0 }}>{summary}</span>
        {trailing}
      </button>
      {open ? <div style={{ paddingLeft: 15 }}>{children}</div> : null}
    </Stack>
  )
}

// ── Report scaffolding ────────────────────────────────────────────────────────

export type ReportShellWidth = 'narrow' | 'default' | 'wide' | 'full'
export type ReportShellDensity = 'comfortable' | 'compact'

export interface ReportShellProps {
  children?: ReactNode
  title?: ReactNode
  subtitle?: ReactNode
  /** Line under the title: who ran it, over what, when. */
  meta?: ReactNode
  /** Top-right slot — a SendToChatButton, a status Tag. */
  action?: ReactNode
  width?: ReportShellWidth
  density?: ReportShellDensity
  style?: CSSProperties
}

const SHELL_WIDTH: Record<ReportShellWidth, number | undefined> = {
  narrow: 680,
  default: 860,
  wide: 1100,
  full: undefined,
}

/**
 * The outer frame of a report: measured column, one header, consistent rhythm.
 *
 * Reading width is the reason this is a component and not advice in a recipe. Set
 * loose in a maximised window, body text runs to 1600px and the eye loses the
 * line it was on. Every generated report re-deciding its own max width is how a
 * set of reports stops looking like one product.
 */
export function ReportShell({
  children,
  title,
  subtitle,
  meta,
  action,
  width = 'default',
  density = 'comfortable',
  style,
}: ReportShellProps) {
  const { tokens } = useHostTheme()
  const maxWidth = SHELL_WIDTH[width]
  return (
    <Stack
      gap={density === 'compact' ? 'container' : 'section'}
      style={{ width: '100%', maxWidth, margin: maxWidth ? '0 auto' : undefined, ...style }}
    >
      {title || subtitle || meta || action ? (
        <Stack gap="component">
          <Row justify="space-between" gap="component">
            <Stack gap="micro" style={{ minWidth: 0 }}>
              {title ? <H2 style={{ margin: 0 }}>{title}</H2> : null}
              {subtitle ? <Text tone="secondary">{subtitle}</Text> : null}
            </Stack>
            {action ? <div style={{ flexShrink: 0 }}>{action}</div> : null}
          </Row>
          {meta ? (
            <Text tone="quaternary" size="small">
              {meta}
            </Text>
          ) : null}
          <Divider />
        </Stack>
      ) : null}
      {children}
    </Stack>
  )
}

export interface ReportSectionHeaderProps {
  title: ReactNode
  /** One line saying what the section answers. */
  description?: ReactNode
  /** Right-aligned slot: a count, a Tag, a jump link. */
  trailing?: ReactNode
  style?: CSSProperties
}

/**
 * A section heading with its own one-line brief.
 *
 * Separate from `ReportSection` so a section that needs custom layout under the
 * heading can still use the same heading treatment instead of hand-rolling an
 * `H3` and hoping the spacing matches.
 */
export function ReportSectionHeader({
  title,
  description,
  trailing,
  style,
}: ReportSectionHeaderProps) {
  return (
    <Stack gap="micro" style={style}>
      <Row justify="space-between" gap="component">
        <H3 style={{ margin: 0 }}>{title}</H3>
        {trailing ? <div style={{ flexShrink: 0 }}>{trailing}</div> : null}
      </Row>
      {description ? (
        <Text tone="secondary" size="small">
          {description}
        </Text>
      ) : null}
    </Stack>
  )
}

export interface ReportSectionProps extends ReportSectionHeaderProps {
  children?: ReactNode
  /** Rule above the heading. On for every section but the first. */
  divided?: boolean
}

/** One section of a report: heading, brief, body. */
export function ReportSection({
  children,
  divided = false,
  style,
  ...header
}: ReportSectionProps) {
  return (
    <Stack gap="container" style={style}>
      {divided ? <Divider /> : null}
      <ReportSectionHeader {...header} />
      {children}
    </Stack>
  )
}

export interface ImprovementItem {
  title: ReactNode
  /** What it buys, stated as an outcome rather than an activity. */
  outcome?: ReactNode
  /** Rough cost: `1 day`, `one sprint`. */
  effort?: ReactNode
  /** Where it applies — a path, a service, a team. */
  scope?: ReactNode
  tone?: Tone
  /** A per-item action, usually a SendToChatButton that starts the work. */
  action?: ReactNode
}

export interface ImprovementListProps {
  items: ImprovementItem[]
  /** Number the rows. On by default: a recommendation list is a priority order. */
  ordered?: boolean
  style?: CSSProperties
}

/**
 * Ranked recommendations.
 *
 * Numbered by default, because an unordered list of improvements invites the
 * reader to start with the easiest one. If the order does not carry priority the
 * caller should say so by turning it off, not by leaving it ambiguous.
 */
export function ImprovementList({ items, ordered = true, style }: ImprovementListProps) {
  const { tokens } = useHostTheme()
  return (
    <Stack gap="component" style={style}>
      {items.map((item, index) => {
        const colors = toneColors(tokens, item.tone ?? 'accent')
        return (
          <Row key={index} gap="component" align="start">
            {ordered ? (
              <span
                aria-hidden="true"
                style={{
                  flexShrink: 0,
                  width: 22,
                  height: 22,
                  borderRadius: 999,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: colors.bg,
                  color: colors.fg,
                  fontSize: tokens.fontSize.caption,
                  fontWeight: tokens.weight.semibold,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {index + 1}
              </span>
            ) : null}
            <Stack gap="micro" style={{ minWidth: 0, flex: 1 }}>
              <Text weight="medium">{item.title}</Text>
              {item.outcome ? (
                <Text tone="secondary" size="small">
                  {item.outcome}
                </Text>
              ) : null}
              {item.effort || item.scope ? (
                <Row gap="component" wrap>
                  {item.effort ? <Tag tone="neutral">{item.effort}</Tag> : null}
                  {item.scope ? (
                    <Text tone="quaternary" size="small">
                      {item.scope}
                    </Text>
                  ) : null}
                </Row>
              ) : null}
            </Stack>
            {item.action ? <div style={{ flexShrink: 0 }}>{item.action}</div> : null}
          </Row>
        )
      })}
    </Stack>
  )
}
