import type { CSSProperties, ReactNode } from 'react';
import type { Tone } from './core-primitives';
export interface RadarSeries {
    name: string;
    /** One value per axis, in the same order as `axes`. */
    values: number[];
    color?: string;
}
export interface RadarChartProps {
    /** Dimension labels, clockwise from the top. */
    axes: string[];
    series: RadarSeries[];
    title?: ReactNode;
    /** Top of the scale. Every axis shares it, so the shape is comparable. */
    max?: number;
    /** Concentric rings drawn as reference. */
    rings?: number;
    size?: number;
    caption?: ReactNode;
    style?: CSSProperties;
}
/**
 * One or more subjects compared across shared dimensions.
 *
 * A single `max` across every axis on purpose. Per-axis normalization makes every
 * subject look balanced and the shape stops meaning anything — which is the
 * standard way a radar chart lies.
 */
export declare function RadarChart({ axes, series, title, max, rings, size, caption, style, }: RadarChartProps): import("react").JSX.Element;
export interface RadialBarChartProps {
    value: number;
    max?: number;
    label?: ReactNode;
    /** Overrides the centre readout, which is otherwise the percentage. */
    centerLabel?: ReactNode;
    tone?: Tone;
    size?: number;
    /** Ring thickness. */
    thickness?: number;
    style?: CSSProperties;
}
/**
 * One value against a target, as an arc.
 *
 * A 270° sweep rather than a full circle: with a full ring, 4% and 96% look
 * nearly the same at a glance because both are "almost all the way round". The
 * gap gives the eye a start and an end.
 */
export declare function RadialBarChart({ value, max, label, centerLabel, tone, size, thickness, style, }: RadialBarChartProps): import("react").JSX.Element;
export interface QuadrantItem {
    label: string;
    /** 0–1 along the x axis. */
    x: number;
    /** 0–1 along the y axis. */
    y: number;
    detail?: ReactNode;
}
export interface QuadrantChartProps {
    items: QuadrantItem[];
    /** Axis names, e.g. `effort` and `impact`. */
    xLabel: string;
    yLabel: string;
    /** Corner captions, clockwise from top-left. Four entries. */
    quadrantLabels?: [string, string, string, string];
    title?: ReactNode;
    height?: number;
    style?: CSSProperties;
}
/**
 * Items sorted by two axes into four quadrants.
 *
 * The quadrant captions are the payload: a scatter plot shows where things sit,
 * but "high impact, low effort → do first" is the recommendation the reader came
 * for. Labels are placed with an anchor chosen per corner so none of them
 * overhang the plot.
 */
export declare function QuadrantChart({ items, xLabel, yLabel, quadrantLabels, title, height, style, }: QuadrantChartProps): import("react").JSX.Element;
export interface ChartComparisonGridProps {
    children: ReactNode;
    /** Panels per row. Collapses when narrow. */
    columns?: number;
    /** One caption for the whole comparison, e.g. the shared scale or window. */
    caption?: ReactNode;
    style?: CSSProperties;
}
/**
 * Two or more charts side by side.
 *
 * Exists so the SHARED caption has somewhere to live. Side-by-side charts are
 * only honest when they use one scale and one time window, and stating that once
 * under the pair is how the reader knows they can compare heights directly.
 */
export declare function ChartComparisonGrid({ children, columns, caption, style, }: ChartComparisonGridProps): import("react").JSX.Element;
export interface MultiplierBubbleChartDatum {
    label: string;
    /** Horizontal position, in the same unit as every other point. */
    x: number;
    /** Vertical position. */
    y: number;
    /** The third dimension, drawn as AREA. Defaults to 1. */
    size?: number;
    color?: string;
}
export interface MultiplierBubbleChartProps {
    data: MultiplierBubbleChartDatum[];
    title?: ReactNode;
    xLabel?: ReactNode;
    yLabel?: ReactNode;
    /** What `size` counts, for the caption: `requests`, `files`, `USD`. */
    sizeLabel?: ReactNode;
    caption?: ReactNode;
    height?: number;
    style?: CSSProperties;
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
export declare function MultiplierBubbleChart({ data, title, xLabel, yLabel, sizeLabel, caption, height, style, }: MultiplierBubbleChartProps): import("react").JSX.Element;
