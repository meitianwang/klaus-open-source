import type { CSSProperties, ReactNode } from 'react';
import type { Tone, CellAlign } from './core-primitives';
export type TableDensity = 'compact' | 'default' | 'comfortable';
/** Row tint. Semantic, not decorative — tint a row only when its STATE differs. */
export type TableRowTone = 'default' | 'muted' | Tone;
export interface TableColumn<T = Record<string, unknown>> {
    /** Property to read when there is no `render`. */
    key: string;
    /** Header cell. Falls back to `key`. */
    title?: ReactNode;
    align?: CellAlign;
    width?: string;
    /** Single-line ellipsis for this column's cells. */
    truncate?: boolean;
    render?: (row: T, index: number) => ReactNode;
}
interface TableCommon {
    /** Bound the height and the header sticks while the body scrolls. */
    maxHeight?: number | string;
    density?: TableDensity;
    /** Shown instead of the body when there are no rows. */
    emptyText?: ReactNode;
    ariaLabel?: string;
    style?: CSSProperties;
}
export interface DataTableProps<T = Record<string, unknown>> extends TableCommon {
    columns: TableColumn<T>[];
    rows: T[];
    /** Stable key per row. Falls back to the index. */
    rowKey?: (row: T, index: number) => string;
    rowTone?: (row: T, index: number) => TableRowTone;
}
export interface SimpleTableProps extends TableCommon {
    headers: ReactNode[];
    rows: ReactNode[][];
    rowTone?: TableRowTone[];
}
export type TableProps<T = Record<string, unknown>> = DataTableProps<T> | SimpleTableProps;
export declare function Table<T = Record<string, unknown>>(props: TableProps<T>): import("react").JSX.Element;
export interface StatProps {
    label: ReactNode;
    value: ReactNode;
    /** A unit shown small next to the value: `%`, `ms`, `req/s`. */
    unit?: ReactNode;
    tone?: Tone;
    /** One line under the value: what it means, or where it came from. */
    description?: ReactNode;
    /** A `Delta` or `Tag` sitting beside the value. */
    trailing?: ReactNode;
    align?: CellAlign;
    size?: 'sm' | 'md' | 'lg';
    style?: CSSProperties;
}
/** One headline number with its label. The unit is separate so it can be set
 *  smaller than the number — a unit at value size reads as part of the value. */
export declare function Stat({ label, value, unit, tone, description, trailing, align, size, style, }: StatProps): import("react").JSX.Element;
export interface DeltaProps {
    value: number;
    /** Appended to the formatted number. Defaults to `%`. */
    suffix?: string;
    /**
     * Which direction is good. `normal` means up is good (throughput); `inverse`
     * means down is good (latency, error rate, cost). Getting this right is the
     * whole point of the component — a red −40% on a latency chart is wrong.
     */
    direction?: 'normal' | 'inverse';
    precision?: number;
    style?: CSSProperties;
}
/** A signed change, coloured by whether it is good rather than by its sign. */
export declare function Delta({ value, suffix, direction, precision, style }: DeltaProps): import("react").JSX.Element;
export interface ProgressProps {
    value: number;
    max?: number;
    tone?: Tone;
    label?: ReactNode;
    /** `percent` shows `62%`, `fraction` shows `31/50`, `none` shows no readout. */
    format?: 'percent' | 'fraction' | 'none';
    height?: number;
    style?: CSSProperties;
}
export declare function Progress({ value, max, tone, label, format, height, style, }: ProgressProps): import("react").JSX.Element;
export interface CalloutProps {
    children?: ReactNode;
    title?: ReactNode;
    tone?: Tone;
    style?: CSSProperties;
}
/** A tinted note. For a caveat, a limitation, or a conclusion worth isolating. */
export declare function Callout({ children, title, tone, style }: CalloutProps): import("react").JSX.Element;
export interface BannerProps {
    children?: ReactNode;
    title?: ReactNode;
    tone?: Tone;
    /** An action on the right — a SendToChatButton, usually. */
    action?: ReactNode;
    style?: CSSProperties;
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
export declare function Banner({ children, title, tone, action, style }: BannerProps): import("react").JSX.Element;
export interface SkeletonProps {
    width?: number | string;
    height?: number | string;
    style?: CSSProperties;
}
/** A loading placeholder. Rare in a canvas — the data is embedded — but a
 *  canvas that computes something on interaction has a moment to fill. */
export declare function Skeleton({ width, height, style }: SkeletonProps): import("react").JSX.Element;
export interface TimelineEvent {
    /** When it happened. Rendered as given — format it for the reader. */
    time: ReactNode;
    title: ReactNode;
    description?: ReactNode;
    tone?: Tone;
}
export interface TimelineProps {
    events: TimelineEvent[];
    style?: CSSProperties;
}
/** An ordered sequence of events with a connecting rail. */
export declare function Timeline({ events, style }: TimelineProps): import("react").JSX.Element;
export interface FieldListProps {
    items: {
        label: ReactNode;
        value: ReactNode;
    }[];
    /** Label column width. A fixed width keeps the values aligned. */
    labelWidth?: number | string;
    style?: CSSProperties;
}
/** Aligned label/value pairs. For metadata, config, and provenance — the things
 *  a table would over-structure and a paragraph would bury. */
export declare function FieldList({ items, labelWidth, style }: FieldListProps): import("react").JSX.Element;
export interface TabsProps {
    tabs: {
        id: string;
        label: ReactNode;
        content: ReactNode;
    }[];
    /** Uncontrolled initial tab. Defaults to the first. */
    defaultTab?: string;
    /** Controlled selection, to pair with `useCanvasState`. */
    active?: string;
    onActiveChange?: (id: string) => void;
    style?: CSSProperties;
}
/** A tab strip. For alternative views of one subject — not for navigation, and
 *  not as a place to hide content the reader needs to compare side by side. */
export declare function Tabs({ tabs, defaultTab, active, onActiveChange, style }: TabsProps): import("react").JSX.Element;
export {};
