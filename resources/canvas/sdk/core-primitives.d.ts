import type { CSSProperties, MouseEventHandler, ReactNode } from 'react';
import type { CanvasSpacingValue, CanvasTokens } from './tokens';
/** The semantic tones a component can carry. `neutral` is the default. */
export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';
export type ControlSize = 'sm' | 'md' | 'lg';
export type TextTone = 'primary' | 'secondary' | 'tertiary' | 'quaternary';
export type TextWeight = 'regular' | 'medium' | 'semibold';
export type Align = 'start' | 'center' | 'end' | 'stretch';
export type Justify = 'start' | 'center' | 'end' | 'space-between';
export type CellAlign = 'left' | 'right' | 'center';
export type TrendDirection = 'up' | 'down' | 'flat';
/** Resolve a tone to its foreground / surface / border triple. */
export declare function toneColors(tokens: CanvasTokens, tone: Tone | undefined): {
    fg: string;
    bg: string;
    border: string;
};
export interface StackProps {
    children?: ReactNode;
    gap?: CanvasSpacingValue;
    align?: Align;
    justify?: Justify;
    className?: string;
    style?: CSSProperties;
    onClick?: MouseEventHandler<HTMLDivElement>;
}
/** Vertical flex group. A spacing helper — reach for a section or card first. */
export declare function Stack({ children, gap, align, justify, className, style, onClick }: StackProps): import("react").JSX.Element;
export interface RowProps extends Omit<StackProps, 'onClick'> {
    wrap?: boolean;
}
/** Horizontal flex group. Defaults to centred items, which is what a row of
 *  labels, tags, and controls almost always wants. */
export declare function Row({ children, gap, align, justify, wrap, className, style }: RowProps): import("react").JSX.Element;
export interface GridProps {
    children?: ReactNode;
    /** A column count, or a raw `grid-template-columns` string. */
    columns: number | string;
    gap?: CanvasSpacingValue;
    align?: Align;
    /** Below this width a numeric column count collapses. Ignored for a string. */
    minColumnWidth?: number;
    /** False keeps the exact column count at every width. */
    responsive?: boolean;
    className?: string;
    style?: CSSProperties;
}
/**
 * Grid. A numeric `columns` is responsive by default via `auto-fit`/`minmax`,
 * because a canvas is viewed in a window the user resizes and a fixed 4-column
 * grid of stat cards becomes unreadable well before it becomes narrow.
 */
export declare function Grid({ children, columns, gap, align, minColumnWidth, responsive, className, style, }: GridProps): import("react").JSX.Element;
/** A horizontal rule at the section boundary. */
export declare function Divider({ style }: {
    style?: CSSProperties;
}): import("react").JSX.Element;
/** Flexible gap that pushes what follows to the far edge of a Row. */
export declare function Spacer(): import("react").JSX.Element;
export interface ScrollAreaProps {
    children?: ReactNode;
    axis?: 'x' | 'y' | 'both';
    maxHeight?: number | string;
    ariaLabel?: string;
    style?: CSSProperties;
}
/** A bounded scrolling region, for a long table or a wide diagram. */
export declare function ScrollArea({ children, axis, maxHeight, ariaLabel, style }: ScrollAreaProps): import("react").JSX.Element;
export interface TextProps {
    children?: ReactNode;
    tone?: TextTone;
    size?: 'body' | 'small';
    weight?: TextWeight;
    as?: 'p' | 'span' | 'div';
    italic?: boolean;
    /** Single-line ellipsis. Needs a bounded width from the parent. */
    truncate?: boolean;
    style?: CSSProperties;
}
export declare function Text({ children, tone, size, weight, as, italic, truncate, style, }: TextProps): import("react").JSX.Element;
/** The largest type a canvas may use. */
export declare const H1: ({ children, style }: {
    children?: ReactNode;
    style?: CSSProperties;
}) => import("react").JSX.Element;
export declare const H2: ({ children, style }: {
    children?: ReactNode;
    style?: CSSProperties;
}) => import("react").JSX.Element;
export declare const H3: ({ children, style }: {
    children?: ReactNode;
    style?: CSSProperties;
}) => import("react").JSX.Element;
/** Inline monospace, for an identifier or a short literal. */
export declare function Code({ children, style }: {
    children?: ReactNode;
    style?: CSSProperties;
}): import("react").JSX.Element;
/**
 * A link. `rel="noreferrer"` is unconditional: a canvas renders untrusted-ish
 * generated markup in a window that holds the host bridge, and handing an
 * external page a `window.opener` handle to it is not worth any convenience.
 */
export declare function Link({ children, href, style, }: {
    children?: ReactNode;
    href: string;
    style?: CSSProperties;
}): import("react").JSX.Element;
export interface CardProps {
    children?: ReactNode;
    variant?: 'default' | 'borderless';
    size?: 'sm' | 'md' | 'lg';
    style?: CSSProperties;
}
export declare function Card({ children, variant, size, style }: CardProps): import("react").JSX.Element;
export interface CardHeaderProps {
    children?: ReactNode;
    title?: ReactNode;
    /** Right-aligned content: a tag, a count, a control. */
    trailing?: ReactNode;
    style?: CSSProperties;
}
export declare function CardHeader({ children, title, trailing, style }: CardHeaderProps): import("react").JSX.Element;
export declare function CardBody({ children, style }: {
    children?: ReactNode;
    style?: CSSProperties;
}): import("react").JSX.Element;
export interface CollapsibleSectionProps {
    children?: ReactNode;
    title: ReactNode;
    trailing?: ReactNode;
    /**
     * A line that stays visible whether the section is open or shut — a severity, a
     * count, a one-sentence verdict. It sits between the header and the body, so a
     * closed section still says why it is worth opening.
     */
    summary?: ReactNode;
    defaultOpen?: boolean;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    style?: CSSProperties;
    bodyStyle?: CSSProperties;
}
/**
 * Disclosure for evidence, appendices, and long tails. Controlled when `open` is
 * passed, uncontrolled otherwise — the pattern a canvas needs to pair it with
 * `useCanvasState` so the user's open sections survive a reload.
 */
export declare function CollapsibleSection({ children, title, trailing, summary, defaultOpen, open, onOpenChange, style, bodyStyle, }: CollapsibleSectionProps): import("react").JSX.Element;
export interface CollapsibleCardProps extends CollapsibleSectionProps {
}
/**
 * A collapsible that starts open and keeps its summary visible when shut.
 *
 * The preset exists because the two uses pull opposite ways. An appendix should
 * be closed and give nothing away; a finding should be open, and when the reader
 * closes it the severity has to stay on screen or a page of collapsed findings is
 * a row of titles with no way to tell which one matters.
 */
export declare function CollapsibleCard(props: CollapsibleCardProps): import("react").JSX.Element;
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export interface ButtonProps {
    children?: ReactNode;
    variant?: ButtonVariant;
    size?: ControlSize;
    prefixIcon?: ReactNode;
    suffixIcon?: ReactNode;
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
    style?: CSSProperties;
    onClick?: () => void;
}
/**
 * A button. Always a micro-rounded rectangle at the small radius — the app has
 * no capsule or circular buttons, and a canvas that grew one would read as
 * belonging to a different product. That is why there is no `rounded` prop.
 */
export declare function Button({ children, variant, size, prefixIcon, suffixIcon, disabled, type, style, onClick, }: ButtonProps): import("react").JSX.Element;
export interface IconButtonProps {
    children: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    title?: string;
    size?: 'sm' | 'md';
    style?: CSSProperties;
}
/** A square icon-only button. Same radius rule as `Button`. */
export declare function IconButton({ children, onClick, disabled, title, size, style }: IconButtonProps): import("react").JSX.Element;
export interface TagProps {
    children?: ReactNode;
    tone?: Tone;
    size?: 'sm' | 'md';
    style?: CSSProperties;
}
/** A small status label. Reads state; never an action. */
export declare function Tag({ children, tone, size, style }: TagProps): import("react").JSX.Element;
export interface PillProps {
    children?: ReactNode;
    tone?: Tone;
    style?: CSSProperties;
}
/**
 * A count or short value in a rounded container.
 *
 * Distinct from `Tag` by role, not by looks: a Tag names a STATE ("resolved",
 * "critical"), a Pill carries a QUANTITY ("12", "3 open"). Keeping them separate
 * is what lets the two be restyled independently later without hunting through
 * canvases to work out which meaning each call site intended.
 */
export declare function Pill({ children, tone, style }: PillProps): import("react").JSX.Element;
export interface InputProps {
    value?: string;
    onChange?: (value: string) => void;
    placeholder?: string;
    disabled?: boolean;
    type?: 'text' | 'number' | 'search' | 'url';
    style?: CSSProperties;
}
export declare function Input({ value, onChange, placeholder, disabled, type, style }: InputProps): import("react").JSX.Element;
export interface TextAreaProps extends Omit<InputProps, 'type'> {
    rows?: number;
}
export declare function TextArea({ value, onChange, placeholder, disabled, rows, style }: TextAreaProps): import("react").JSX.Element;
export interface CheckboxProps {
    checked?: boolean;
    onChange?: (checked: boolean) => void;
    disabled?: boolean;
    label?: ReactNode;
    style?: CSSProperties;
}
export declare function Checkbox({ checked, onChange, disabled, label, style }: CheckboxProps): import("react").JSX.Element;
export interface SwitchProps {
    checked?: boolean;
    onChange?: (checked: boolean) => void;
    disabled?: boolean;
    style?: CSSProperties;
}
/** A toggle. The one place a pill shape is correct, because a switch track is
 *  not a button. */
export declare function Switch({ checked, onChange, disabled, style }: SwitchProps): import("react").JSX.Element;
export interface SelectOption<T extends string = string> {
    value: T;
    label?: string;
    disabled?: boolean;
}
export interface SelectProps<T extends string = string> {
    value?: T;
    onChange?: (value: T) => void;
    options: SelectOption<T>[];
    disabled?: boolean;
    style?: CSSProperties;
}
export declare function Select<T extends string = string>({ value, onChange, options, disabled, style, }: SelectProps<T>): import("react").JSX.Element;
export interface SendToChatButtonProps {
    children?: ReactNode;
    /** The text to place in the composer. A function is called on click. */
    text: string | (() => string);
    variant?: ButtonVariant;
    icon?: ReactNode;
    disabled?: boolean;
    submit?: boolean;
    style?: CSSProperties;
}
/**
 * The bridge back to the conversation: turns something the user is looking at
 * into the next prompt. Shows its own pending / sent / failed state, because a
 * button whose whole job is a round trip must not look inert while it runs.
 */
export declare function SendToChatButton({ children, text, variant, icon, disabled, submit, style, }: SendToChatButtonProps): import("react").JSX.Element;
export interface DialogProps {
    /** Controlled visibility. Omit and pass `trigger` for the uncontrolled form. */
    open?: boolean;
    defaultOpen?: boolean;
    onOpenChange?: (open: boolean) => void;
    title: ReactNode;
    description?: ReactNode;
    children?: ReactNode;
    footer?: ReactNode;
    /** Click the backdrop to dismiss. On by default. */
    closeOnBackdrop?: boolean;
    maxWidth?: number | string;
    style?: CSSProperties;
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
export declare function Dialog({ open, defaultOpen, onOpenChange, title, description, children, footer, closeOnBackdrop, maxWidth, style, }: DialogProps): import("react").JSX.Element | null;
export interface ZoomableViewportProps {
    children?: ReactNode;
    initialZoom?: number;
    minZoom?: number;
    maxZoom?: number;
    /** Fixed viewport height. Content larger than this pans inside it. */
    height?: number | string;
    style?: CSSProperties;
    contentStyle?: CSSProperties;
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
export declare function ZoomableViewport({ children, initialZoom, minZoom, maxZoom, height, style, contentStyle, }: ZoomableViewportProps): import("react").JSX.Element;
