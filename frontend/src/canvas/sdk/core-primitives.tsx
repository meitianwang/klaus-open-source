// Core canvas primitives: layout, text, containers, controls, tables, and the
// small data-display set. Everything here paints from `useHostTheme()` tokens,
// so a canvas inherits the app's appearance without asking for it.
//
// Two conventions run through the file.
//
// Inline styles, not CSS classes. A canvas is one file evaluated at runtime with
// no stylesheet of its own, and the model composes these components with `style`
// overrides constantly. Inline styles make the override order obvious (the
// caller's `style` spreads last and wins) where a class would need specificity
// arithmetic the model cannot see.
//
// Every visual decision is a token read. There are no literal colours below —
// that is the same rule the authoring contract puts on generated canvases, and
// the SDK holding itself to it is what makes the rule teachable.

import type { CSSProperties, MouseEventHandler, ReactNode } from 'react'
import { useCallback, useEffect, useId, useRef, useState } from 'react'

import type { CanvasSpacingValue, CanvasTokens } from './tokens'
import { canvasControlHeight, resolveSpacing } from './tokens'
import { sendToChat, useHostTheme } from './hooks'

// ── Shared vocabulary ─────────────────────────────────────────────────────────

/** The semantic tones a component can carry. `neutral` is the default. */
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info'
export type ControlSize = 'sm' | 'md' | 'lg'
export type TextTone = 'primary' | 'secondary' | 'tertiary' | 'quaternary'
export type TextWeight = 'regular' | 'medium' | 'semibold'
export type Align = 'start' | 'center' | 'end' | 'stretch'
export type Justify = 'start' | 'center' | 'end' | 'space-between'
export type CellAlign = 'left' | 'right' | 'center'
export type TrendDirection = 'up' | 'down' | 'flat'

/** Resolve a tone to its foreground / surface / border triple. */
export function toneColors(tokens: CanvasTokens, tone: Tone | undefined) {
  switch (tone) {
    case 'success':
      return {
        fg: tokens.status.success,
        bg: tokens.status.successBg,
        border: tokens.status.successBorder,
      }
    case 'warning':
      return {
        fg: tokens.status.warning,
        bg: tokens.status.warningBg,
        border: tokens.status.warningBorder,
      }
    case 'danger':
      return {
        fg: tokens.status.danger,
        bg: tokens.status.dangerBg,
        border: tokens.status.dangerBorder,
      }
    case 'info':
      return { fg: tokens.status.info, bg: tokens.status.infoBg, border: tokens.status.infoBorder }
    case 'accent':
      return {
        fg: tokens.accent.highlight,
        bg: tokens.accent.highlightBg,
        border: tokens.accent.highlight,
      }
    default:
      return { fg: tokens.text.secondary, bg: tokens.fill.tertiary, border: tokens.stroke.primary }
  }
}

const FLEX_ALIGN: Record<Align, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  stretch: 'stretch',
}

const FLEX_JUSTIFY: Record<Justify, string> = {
  start: 'flex-start',
  center: 'center',
  end: 'flex-end',
  'space-between': 'space-between',
}

// ── Layout ────────────────────────────────────────────────────────────────────

export interface StackProps {
  children?: ReactNode
  gap?: CanvasSpacingValue
  align?: Align
  justify?: Justify
  className?: string
  style?: CSSProperties
  onClick?: MouseEventHandler<HTMLDivElement>
}

/** Vertical flex group. A spacing helper — reach for a section or card first. */
export function Stack({ children, gap, align, justify, className, style, onClick }: StackProps) {
  return (
    <div
      className={className}
      onClick={onClick}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: resolveSpacing(gap, 'component'),
        alignItems: align ? FLEX_ALIGN[align] : undefined,
        justifyContent: justify ? FLEX_JUSTIFY[justify] : undefined,
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export interface RowProps extends Omit<StackProps, 'onClick'> {
  wrap?: boolean
}

/** Horizontal flex group. Defaults to centred items, which is what a row of
 *  labels, tags, and controls almost always wants. */
export function Row({ children, gap, align, justify, wrap, className, style }: RowProps) {
  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'row',
        gap: resolveSpacing(gap, 'inline'),
        alignItems: FLEX_ALIGN[align ?? 'center'],
        justifyContent: justify ? FLEX_JUSTIFY[justify] : undefined,
        flexWrap: wrap ? 'wrap' : undefined,
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export interface GridProps {
  children?: ReactNode
  /** A column count, or a raw `grid-template-columns` string. */
  columns: number | string
  gap?: CanvasSpacingValue
  align?: Align
  /** Below this width a numeric column count collapses. Ignored for a string. */
  minColumnWidth?: number
  /** False keeps the exact column count at every width. */
  responsive?: boolean
  className?: string
  style?: CSSProperties
}

/**
 * Grid. A numeric `columns` is responsive by default via `auto-fit`/`minmax`,
 * because a canvas is viewed in a window the user resizes and a fixed 4-column
 * grid of stat cards becomes unreadable well before it becomes narrow.
 */
export function Grid({
  children,
  columns,
  gap,
  align,
  minColumnWidth = 180,
  responsive = true,
  className,
  style,
}: GridProps) {
  const template =
    typeof columns === 'string'
      ? columns
      : responsive
        ? `repeat(auto-fit, minmax(min(${minColumnWidth}px, 100%), 1fr))`
        : `repeat(${Math.max(1, columns)}, minmax(0, 1fr))`
  return (
    <div
      className={className}
      style={{
        display: 'grid',
        gridTemplateColumns: template,
        gap: resolveSpacing(gap, 'container'),
        alignItems: align ? FLEX_ALIGN[align] : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

/** A horizontal rule at the section boundary. */
export function Divider({ style }: { style?: CSSProperties }) {
  const { tokens } = useHostTheme()
  return (
    <div
      role="separator"
      style={{ height: 1, background: tokens.stroke.primary, flexShrink: 0, ...style }}
    />
  )
}

/** Flexible gap that pushes what follows to the far edge of a Row. */
export function Spacer() {
  return <div style={{ flex: 1, minWidth: 0 }} />
}

export interface ScrollAreaProps {
  children?: ReactNode
  axis?: 'x' | 'y' | 'both'
  maxHeight?: number | string
  ariaLabel?: string
  style?: CSSProperties
}

/** A bounded scrolling region, for a long table or a wide diagram. */
export function ScrollArea({ children, axis = 'y', maxHeight, ariaLabel, style }: ScrollAreaProps) {
  return (
    <div
      aria-label={ariaLabel}
      data-canvas-scroll
      style={{
        overflowX: axis === 'y' ? 'hidden' : 'auto',
        overflowY: axis === 'x' ? 'hidden' : 'auto',
        maxHeight,
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

// ── Text ──────────────────────────────────────────────────────────────────────

export interface TextProps {
  children?: ReactNode
  tone?: TextTone
  size?: 'body' | 'small'
  weight?: TextWeight
  as?: 'p' | 'span' | 'div'
  italic?: boolean
  /** Single-line ellipsis. Needs a bounded width from the parent. */
  truncate?: boolean
  style?: CSSProperties
}

export function Text({
  children,
  tone = 'primary',
  size = 'body',
  weight = 'regular',
  as = 'div',
  italic,
  truncate,
  style,
}: TextProps) {
  const { tokens } = useHostTheme()
  const type = tokens.typography[size]
  const Tag = as
  return (
    <Tag
      style={{
        margin: 0,
        color: tokens.text[tone],
        fontSize: type.fontSize,
        lineHeight: type.lineHeight,
        fontWeight: tokens.weight[weight],
        fontStyle: italic ? 'italic' : undefined,
        ...(truncate
          ? { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }
          : {}),
        ...style,
      }}
    >
      {children}
    </Tag>
  )
}

function heading(level: 'h1' | 'h2' | 'h3') {
  return function Heading({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
    const { tokens } = useHostTheme()
    const type = tokens.typography[level]
    const Tag = level
    return (
      <Tag
        style={{
          margin: 0,
          color: tokens.text.primary,
          fontSize: type.fontSize,
          lineHeight: type.lineHeight,
          fontWeight: type.fontWeight,
          ...style,
        }}
      >
        {children}
      </Tag>
    )
  }
}

/** The largest type a canvas may use. */
export const H1 = heading('h1')
export const H2 = heading('h2')
export const H3 = heading('h3')

/** Inline monospace, for an identifier or a short literal. */
export function Code({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  const { tokens } = useHostTheme()
  return (
    <code
      style={{
        fontFamily: tokens.fontFamily.mono,
        fontSize: tokens.typography.mono.fontSize,
        background: tokens.fill.tertiary,
        color: tokens.text.primary,
        padding: '1px 5px',
        borderRadius: tokens.radius.xxs,
        ...style,
      }}
    >
      {children}
    </code>
  )
}

/**
 * A link. `rel="noreferrer"` is unconditional: a canvas renders untrusted-ish
 * generated markup in a window that holds the host bridge, and handing an
 * external page a `window.opener` handle to it is not worth any convenience.
 */
export function Link({
  children,
  href,
  style,
}: {
  children?: ReactNode
  href: string
  style?: CSSProperties
}) {
  const { tokens } = useHostTheme()
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      style={{ color: tokens.text.link, textDecoration: 'none', ...style }}
    >
      {children}
    </a>
  )
}

// ── Containers ────────────────────────────────────────────────────────────────

export interface CardProps {
  children?: ReactNode
  variant?: 'default' | 'borderless'
  size?: 'sm' | 'md' | 'lg'
  style?: CSSProperties
}

const CARD_PADDING: Record<'sm' | 'md' | 'lg', number> = { sm: 10, md: 14, lg: 18 }

export function Card({ children, variant = 'default', size = 'md', style }: CardProps) {
  const { tokens } = useHostTheme()
  return (
    <div
      style={{
        background: tokens.bg.elevated,
        border: variant === 'borderless' ? 'none' : `1px solid ${tokens.stroke.primary}`,
        borderRadius: tokens.radius.sm,
        padding: CARD_PADDING[size],
        minWidth: 0,
        ...style,
      }}
    >
      {children}
    </div>
  )
}

export interface CardHeaderProps {
  children?: ReactNode
  title?: ReactNode
  /** Right-aligned content: a tag, a count, a control. */
  trailing?: ReactNode
  style?: CSSProperties
}

export function CardHeader({ children, title, trailing, style }: CardHeaderProps) {
  return (
    <Row justify="space-between" style={{ marginBottom: 10, ...style }}>
      <div style={{ minWidth: 0 }}>
        {typeof title === 'string' ? <H3>{title}</H3> : (title ?? children)}
      </div>
      {trailing ? <div style={{ flexShrink: 0 }}>{trailing}</div> : null}
    </Row>
  )
}

export function CardBody({ children, style }: { children?: ReactNode; style?: CSSProperties }) {
  return <div style={{ minWidth: 0, ...style }}>{children}</div>
}

export interface CollapsibleSectionProps {
  children?: ReactNode
  title: ReactNode
  trailing?: ReactNode
  /**
   * A line that stays visible whether the section is open or shut — a severity, a
   * count, a one-sentence verdict. It sits between the header and the body, so a
   * closed section still says why it is worth opening.
   */
  summary?: ReactNode
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  style?: CSSProperties
  bodyStyle?: CSSProperties
}

/**
 * Disclosure for evidence, appendices, and long tails. Controlled when `open` is
 * passed, uncontrolled otherwise — the pattern a canvas needs to pair it with
 * `useCanvasState` so the user's open sections survive a reload.
 */
export function CollapsibleSection({
  children,
  title,
  trailing,
  summary,
  defaultOpen = false,
  open,
  onOpenChange,
  style,
  bodyStyle,
}: CollapsibleSectionProps) {
  const { tokens } = useHostTheme()
  const [internal, setInternal] = useState(defaultOpen)
  const isOpen = open ?? internal
  const bodyId = useId()
  const toggle = useCallback(() => {
    const next = !isOpen
    if (open === undefined) setInternal(next)
    onOpenChange?.(next)
  }, [isOpen, open, onOpenChange])
  return (
    <div
      style={{
        border: `1px solid ${tokens.stroke.primary}`,
        borderRadius: tokens.radius.sm,
        background: tokens.bg.elevated,
        overflow: 'hidden',
        ...style,
      }}
    >
      <button
        type="button"
        onClick={toggle}
        aria-expanded={isOpen}
        aria-controls={bodyId}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          padding: '9px 12px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
          color: tokens.text.primary,
          font: 'inherit',
        }}
      >
        <Chevron open={isOpen} color={tokens.text.tertiary} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: tokens.typography.h3.fontSize,
            fontWeight: tokens.weight.medium,
          }}
        >
          {title}
        </span>
        {trailing}
      </button>
      {summary ? (
        <div
          style={{
            padding: '0 12px 10px 32px',
            color: tokens.text.secondary,
            fontSize: tokens.fontSize.bodySm,
          }}
        >
          {summary}
        </div>
      ) : null}
      {isOpen ? (
        <div
          id={bodyId}
          style={{ padding: '0 12px 12px', borderTop: 'none', ...bodyStyle }}
        >
          {children}
        </div>
      ) : null}
    </div>
  )
}

export interface CollapsibleCardProps extends CollapsibleSectionProps {}

/**
 * A collapsible that starts open and keeps its summary visible when shut.
 *
 * The preset exists because the two uses pull opposite ways. An appendix should
 * be closed and give nothing away; a finding should be open, and when the reader
 * closes it the severity has to stay on screen or a page of collapsed findings is
 * a row of titles with no way to tell which one matters.
 */
export function CollapsibleCard(props: CollapsibleCardProps) {
  return <CollapsibleSection defaultOpen {...props} />
}

/** The one drawn glyph in the SDK: a disclosure caret. Everything else that
 *  looks like an icon is the caller's `ReactNode`. */
function Chevron({ open, color }: { open: boolean; color: string }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 10 10"
      aria-hidden="true"
      style={{
        flexShrink: 0,
        transform: open ? 'rotate(90deg)' : 'none',
        transition: 'transform 150ms cubic-bezier(0, 0, 0.2, 1)',
      }}
    >
      <path d="M3 1.5 L7 5 L3 8.5" fill="none" stroke={color} strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  )
}

// ── Controls ──────────────────────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export interface ButtonProps {
  children?: ReactNode
  variant?: ButtonVariant
  size?: ControlSize
  prefixIcon?: ReactNode
  suffixIcon?: ReactNode
  disabled?: boolean
  type?: 'button' | 'submit' | 'reset'
  style?: CSSProperties
  onClick?: () => void
}

/**
 * A button. Always a micro-rounded rectangle at the small radius — the app has
 * no capsule or circular buttons, and a canvas that grew one would read as
 * belonging to a different product. That is why there is no `rounded` prop.
 */
export function Button({
  children,
  variant = 'secondary',
  size = 'md',
  prefixIcon,
  suffixIcon,
  disabled,
  type = 'button',
  style,
  onClick,
}: ButtonProps) {
  const { tokens } = useHostTheme()
  const [hover, setHover] = useState(false)
  const skin = (() => {
    switch (variant) {
      case 'primary':
        return {
          background: hover ? tokens.accent.controlHover : tokens.accent.control,
          color: tokens.text.onAccent,
          border: '1px solid transparent',
        }
      case 'ghost':
        return {
          background: hover ? tokens.bg.hover : 'transparent',
          color: tokens.text.secondary,
          border: '1px solid transparent',
        }
      case 'danger':
        return {
          background: hover ? tokens.status.dangerBg : 'transparent',
          color: tokens.status.danger,
          border: `1px solid ${tokens.status.dangerBorder}`,
        }
      default:
        return {
          background: hover ? tokens.bg.hover : tokens.bg.elevated,
          color: tokens.text.primary,
          border: `1px solid ${tokens.stroke.primary}`,
        }
    }
  })()
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        height: canvasControlHeight[size],
        padding: size === 'sm' ? '0 8px' : '0 12px',
        borderRadius: tokens.radius.sm,
        fontFamily: 'inherit',
        fontSize: size === 'sm' ? tokens.fontSize.small : tokens.fontSize.bodySm,
        fontWeight: tokens.weight.medium,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        whiteSpace: 'nowrap',
        transition: `background ${tokens.motion.durationFast} ${tokens.motion.easeOut}`,
        ...skin,
        ...style,
      }}
    >
      {prefixIcon}
      {children}
      {suffixIcon}
    </button>
  )
}

export interface IconButtonProps {
  children: ReactNode
  onClick?: () => void
  disabled?: boolean
  title?: string
  size?: 'sm' | 'md'
  style?: CSSProperties
}

/** A square icon-only button. Same radius rule as `Button`. */
export function IconButton({ children, onClick, disabled, title, size = 'md', style }: IconButtonProps) {
  const { tokens } = useHostTheme()
  const [hover, setHover] = useState(false)
  const side = size === 'sm' ? canvasControlHeight.sm : canvasControlHeight.md
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: side,
        height: side,
        padding: 0,
        borderRadius: tokens.radius.xs,
        border: 'none',
        background: hover && !disabled ? tokens.bg.hover : 'transparent',
        color: tokens.text.secondary,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        ...style,
      }}
    >
      {children}
    </button>
  )
}

export interface TagProps {
  children?: ReactNode
  tone?: Tone
  size?: 'sm' | 'md'
  style?: CSSProperties
}

/** A small status label. Reads state; never an action. */
export function Tag({ children, tone = 'neutral', size = 'sm', style }: TagProps) {
  const { tokens } = useHostTheme()
  const colors = toneColors(tokens, tone)
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: size === 'sm' ? '1px 6px' : '2px 8px',
        borderRadius: tokens.radius.xxs,
        background: colors.bg,
        color: colors.fg,
        fontSize: size === 'sm' ? tokens.fontSize.badge : tokens.fontSize.caption,
        fontWeight: tokens.weight.medium,
        lineHeight: 1.6,
        whiteSpace: 'nowrap',
        ...style,
      }}
    >
      {children}
    </span>
  )
}

export interface PillProps {
  children?: ReactNode
  tone?: Tone
  style?: CSSProperties
}

/**
 * A count or short value in a rounded container.
 *
 * Distinct from `Tag` by role, not by looks: a Tag names a STATE ("resolved",
 * "critical"), a Pill carries a QUANTITY ("12", "3 open"). Keeping them separate
 * is what lets the two be restyled independently later without hunting through
 * canvases to work out which meaning each call site intended.
 */
export function Pill({ children, tone = 'neutral', style }: PillProps) {
  const { tokens } = useHostTheme()
  const colors = toneColors(tokens, tone)
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        minWidth: 18,
        padding: '0 5px',
        height: 17,
        borderRadius: tokens.radius.xxs,
        background: colors.bg,
        color: colors.fg,
        fontSize: tokens.fontSize.badge,
        fontWeight: tokens.weight.medium,
        fontVariantNumeric: 'tabular-nums',
        ...style,
      }}
    >
      {children}
    </span>
  )
}

export interface InputProps {
  value?: string
  onChange?: (value: string) => void
  placeholder?: string
  disabled?: boolean
  type?: 'text' | 'number' | 'search' | 'url'
  style?: CSSProperties
}

function fieldStyle(tokens: CanvasTokens): CSSProperties {
  return {
    width: '100%',
    background: tokens.bg.editor,
    color: tokens.text.primary,
    border: `1px solid ${tokens.stroke.primary}`,
    borderRadius: tokens.radius.sm,
    padding: '6px 9px',
    fontFamily: 'inherit',
    fontSize: tokens.fontSize.bodySm,
    outline: 'none',
  }
}

export function Input({ value, onChange, placeholder, disabled, type = 'text', style }: InputProps) {
  const { tokens } = useHostTheme()
  return (
    <input
      type={type}
      value={value ?? ''}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => onChange?.(event.target.value)}
      style={{ ...fieldStyle(tokens), height: canvasControlHeight.lg, ...style }}
    />
  )
}

export interface TextAreaProps extends Omit<InputProps, 'type'> {
  rows?: number
}

export function TextArea({ value, onChange, placeholder, disabled, rows = 4, style }: TextAreaProps) {
  const { tokens } = useHostTheme()
  return (
    <textarea
      value={value ?? ''}
      rows={rows}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => onChange?.(event.target.value)}
      style={{ ...fieldStyle(tokens), resize: 'vertical', ...style }}
    />
  )
}

export interface CheckboxProps {
  checked?: boolean
  onChange?: (checked: boolean) => void
  disabled?: boolean
  label?: ReactNode
  style?: CSSProperties
}

export function Checkbox({ checked, onChange, disabled, label, style }: CheckboxProps) {
  const { tokens } = useHostTheme()
  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        fontSize: tokens.fontSize.bodySm,
        color: tokens.text.primary,
        ...style,
      }}
    >
      <input
        type="checkbox"
        checked={!!checked}
        disabled={disabled}
        onChange={(event) => onChange?.(event.target.checked)}
        style={{ accentColor: tokens.accent.control, margin: 0 }}
      />
      {label}
    </label>
  )
}

export interface SwitchProps {
  checked?: boolean
  onChange?: (checked: boolean) => void
  disabled?: boolean
  style?: CSSProperties
}

/** A toggle. The one place a pill shape is correct, because a switch track is
 *  not a button. */
export function Switch({ checked, onChange, disabled, style }: SwitchProps) {
  const { tokens } = useHostTheme()
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      style={{
        width: 30,
        height: 18,
        flexShrink: 0,
        padding: 2,
        borderRadius: 999,
        border: 'none',
        background: checked ? tokens.accent.control : tokens.fill.primary,
        cursor: disabled ? 'default' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        transition: `background ${tokens.motion.durationBase} ${tokens.motion.easeOut}`,
        ...style,
      }}
    >
      <span
        style={{
          display: 'block',
          width: 14,
          height: 14,
          borderRadius: 999,
          background: checked ? tokens.text.onAccent : tokens.bg.elevated,
          transform: checked ? 'translateX(12px)' : 'none',
          transition: `transform ${tokens.motion.durationBase} ${tokens.motion.easeOut}`,
        }}
      />
    </button>
  )
}

export interface SelectOption<T extends string = string> {
  value: T
  label?: string
  disabled?: boolean
}

export interface SelectProps<T extends string = string> {
  value?: T
  onChange?: (value: T) => void
  options: SelectOption<T>[]
  disabled?: boolean
  style?: CSSProperties
}

export function Select<T extends string = string>({
  value,
  onChange,
  options,
  disabled,
  style,
}: SelectProps<T>) {
  const { tokens } = useHostTheme()
  return (
    <select
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => onChange?.(event.target.value as T)}
      style={{
        ...fieldStyle(tokens),
        width: 'auto',
        height: canvasControlHeight.md,
        padding: '0 8px',
        cursor: disabled ? 'default' : 'pointer',
        ...style,
      }}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label ?? option.value}
        </option>
      ))}
    </select>
  )
}

// ── Send to chat ──────────────────────────────────────────────────────────────

export interface SendToChatButtonProps {
  children?: ReactNode
  /** The text to place in the composer. A function is called on click. */
  text: string | (() => string)
  variant?: ButtonVariant
  icon?: ReactNode
  disabled?: boolean
  submit?: boolean
  style?: CSSProperties
}

/**
 * The bridge back to the conversation: turns something the user is looking at
 * into the next prompt. Shows its own pending / sent / failed state, because a
 * button whose whole job is a round trip must not look inert while it runs.
 */
export function SendToChatButton({
  children,
  text,
  variant = 'secondary',
  icon,
  disabled,
  submit,
  style,
}: SendToChatButtonProps) {
  const [phase, setPhase] = useState<'idle' | 'pending' | 'sent' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const click = useCallback(async () => {
    setPhase('pending')
    const body = typeof text === 'function' ? text() : text
    const ok = await sendToChat(body, { submit })
    setPhase(ok ? 'sent' : 'failed')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setPhase('idle'), 2000)
  }, [submit, text])
  const label =
    phase === 'pending'
      ? 'Sending…'
      : phase === 'sent'
        ? 'Sent'
        : phase === 'failed'
          ? 'Failed'
          : children
  return (
    <Button
      variant={variant}
      disabled={disabled || phase === 'pending'}
      prefixIcon={phase === 'idle' ? icon : undefined}
      onClick={() => void click()}
      style={style}
    >
      {label}
    </Button>
  )
}

// ── Overlay ──────────────────────────────────────────────────────────────

export interface DialogProps {
  /** Controlled visibility. Omit and pass `trigger` for the uncontrolled form. */
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  title: ReactNode
  description?: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** Click the backdrop to dismiss. On by default. */
  closeOnBackdrop?: boolean
  maxWidth?: number | string
  style?: CSSProperties
}

/**
 * A modal panel.
 *
 * Rendered inline in the canvas tree rather than portalled to `document.body`.
 * A portal would escape the canvas's own container, and the canvas does not own
 * the page — the window chrome does. Fixed positioning still covers the viewport,
 * which is what a modal actually needs.
 *
 * Escape closes it and focus moves to the panel on open, because a dialog a
 * keyboard user cannot dismiss is a trap.
 */
export function Dialog({
  open,
  defaultOpen = false,
  onOpenChange,
  title,
  description,
  children,
  footer,
  closeOnBackdrop = true,
  maxWidth = 520,
  style,
}: DialogProps) {
  const { tokens } = useHostTheme()
  const [internal, setInternal] = useState(defaultOpen)
  const isOpen = open ?? internal
  const panel = useRef<HTMLDivElement | null>(null)
  const titleId = useId()

  const close = useCallback(() => {
    if (open === undefined) setInternal(false)
    onOpenChange?.(false)
  }, [onOpenChange, open])

  useEffect(() => {
    if (!isOpen) return
    panel.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [close, isOpen])

  if (!isOpen) return null

  return (
    <div
      role="presentation"
      onClick={closeOnBackdrop ? close : undefined}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        background: 'rgba(0, 0, 0, 0.45)',
      }}
    >
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        // Stop the backdrop handler from firing for clicks inside the panel.
        onClick={(event) => event.stopPropagation()}
        style={{
          width: '100%',
          maxWidth,
          maxHeight: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: tokens.bg.elevated,
          border: `1px solid ${tokens.stroke.primary}`,
          borderRadius: tokens.radius.md,
          boxShadow: tokens.shadow.lg,
          outline: 'none',
          ...style,
        }}
      >
        <Stack gap="micro" style={{ padding: '14px 16px 0' }}>
          <span
            id={titleId}
            style={{
              fontSize: tokens.typography.h2.fontSize,
              fontWeight: tokens.weight.semibold,
              color: tokens.text.primary,
            }}
          >
            {title}
          </span>
          {description ? (
            <Text tone="secondary" size="small">
              {description}
            </Text>
          ) : null}
        </Stack>
        <div data-canvas-scroll style={{ padding: 16, overflow: 'auto', minHeight: 0 }}>
          {children}
        </div>
        <Row
          gap="inline"
          justify="end"
          style={{ padding: '0 16px 14px' }}
        >
          {footer ?? (
            <Button variant="secondary" onClick={close}>
              Close
            </Button>
          )}
        </Row>
      </div>
    </div>
  )
}

export interface ZoomableViewportProps {
  children?: ReactNode
  initialZoom?: number
  minZoom?: number
  maxZoom?: number
  /** Fixed viewport height. Content larger than this pans inside it. */
  height?: number | string
  style?: CSSProperties
  contentStyle?: CSSProperties
}

/**
 * A pannable, zoomable frame for content that is wider than the page — a large
 * diagram, a wide table, a dense graph.
 *
 * Wheel zoom requires Ctrl/Cmd. A bare wheel gesture belongs to the page: a
 * viewport that swallowed it would trap the reader's scroll the moment the cursor
 * crossed a diagram, which is the single most common complaint about embedded
 * zoomable canvases.
 */
export function ZoomableViewport({
  children,
  initialZoom = 1,
  minZoom = 0.25,
  maxZoom = 3,
  height = 420,
  style,
  contentStyle,
}: ZoomableViewportProps) {
  const { tokens } = useHostTheme()
  const clamp = useCallback(
    (value: number) => Math.min(maxZoom, Math.max(minZoom, value)),
    [maxZoom, minZoom],
  )
  const [zoom, setZoom] = useState(() => clamp(initialZoom))
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; panX: number; panY: number } | null>(null)

  const reset = useCallback(() => {
    setZoom(clamp(initialZoom))
    setPan({ x: 0, y: 0 })
  }, [clamp, initialZoom])

  return (
    <div style={{ position: 'relative', ...style }}>
      <div
        onWheel={(event) => {
          if (!event.ctrlKey && !event.metaKey) return
          event.preventDefault()
          setZoom((value) => clamp(value * (event.deltaY < 0 ? 1.1 : 1 / 1.1)))
        }}
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y }
          event.currentTarget.setPointerCapture(event.pointerId)
        }}
        onPointerMove={(event) => {
          const start = drag.current
          if (!start) return
          setPan({
            x: start.panX + (event.clientX - start.x),
            y: start.panY + (event.clientY - start.y),
          })
        }}
        onPointerUp={() => {
          drag.current = null
        }}
        style={{
          height,
          overflow: 'hidden',
          border: `1px solid ${tokens.stroke.primary}`,
          borderRadius: tokens.radius.sm,
          background: tokens.bg.editor,
          cursor: 'grab',
          touchAction: 'none',
        }}
      >
        <div
          style={{
            transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
            transformOrigin: '0 0',
            ...contentStyle,
          }}
        >
          {children}
        </div>
      </div>
      <Row
        gap="micro"
        style={{ position: 'absolute', right: 8, bottom: 8 }}
      >
        <IconButton size="sm" title="Zoom out" onClick={() => setZoom((v) => clamp(v / 1.25))}>
          −
        </IconButton>
        <IconButton size="sm" title="Reset view" onClick={reset}>
          {Math.round(zoom * 100)}%
        </IconButton>
        <IconButton size="sm" title="Zoom in" onClick={() => setZoom((v) => clamp(v * 1.25))}>
          +
        </IconButton>
      </Row>
    </div>
  )
}
