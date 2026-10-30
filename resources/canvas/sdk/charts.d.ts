import type { CSSProperties, ReactNode } from 'react';
/** One named series. `color` overrides the palette slot for this series. */
export interface ChartSeries {
    /** Legend label and accessible name. */
    name: string;
    values: number[];
    color?: string;
}
export interface ChartContainerProps {
    title?: ReactNode;
    /** What the numbers are: `ms`, `requests`, `USD`. Shown next to the title. */
    unit?: ReactNode;
    /** Where the data came from, or the window it covers. */
    caption?: ReactNode;
    /**
     * Legend entries. Only the names and colours are read here, so a hand-drawn
     * chart can pass `[{ name: 'p95', values: [] }]` for a legend swatch alone.
     */
    series?: ChartSeries[];
    showLegend?: boolean;
    children: ReactNode;
    style?: CSSProperties;
}
export interface CartesianChartProps {
    /** Category labels along the x axis. */
    labels: string[];
    series: ChartSeries[];
    title?: ReactNode;
    unit?: ReactNode;
    caption?: ReactNode;
    height?: number;
    showLegend?: boolean;
    /** Pin the y axis maximum instead of deriving it from the data. */
    max?: number;
    style?: CSSProperties;
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
export declare function ChartContainer({ series, showLegend, ...rest }: ChartContainerProps): import("react").JSX.Element;
/** A trend over an ordered category axis. */
export declare function LineChart({ labels, series, title, unit, caption, height, showLegend, max, style, }: CartesianChartProps): import("react").JSX.Element;
/** A trend with the area under it filled. One or two series at most — stacked
 *  translucent fills stop being readable past that. */
export declare function AreaChart({ labels, series, title, unit, caption, height, showLegend, max, style, }: CartesianChartProps): import("react").JSX.Element;
export interface BarChartProps extends CartesianChartProps {
    /** Stack series instead of placing them side by side. */
    stacked?: boolean;
    /** Horizontal bars. Use when category names are long enough to need the room. */
    horizontal?: boolean;
}
/** Comparison across categories. */
export declare function BarChart({ labels, series, title, unit, caption, height, showLegend, max, stacked, horizontal, style, }: BarChartProps): import("react").JSX.Element;
export interface PieChartProps {
    slices: {
        name: string;
        value: number;
        color?: string;
    }[];
    title?: ReactNode;
    caption?: ReactNode;
    /** A hole in the middle, 0–0.9. Non-zero makes it a donut. */
    innerRadius?: number;
    height?: number;
    /** Shown in the middle of a donut: usually the total. */
    centerLabel?: ReactNode;
    style?: CSSProperties;
}
/** Composition of a whole. Only for parts that genuinely sum to something — a
 *  pie of unrelated quantities is a bar chart that lost its axis. */
export declare function PieChart({ slices, title, caption, innerRadius, height, centerLabel, style, }: PieChartProps): import("react").JSX.Element;
export interface HeatmapProps {
    /** Column headers, left to right. */
    columns: string[];
    /** One row per entry, with a value per column. */
    rows: {
        name: string;
        values: (number | null)[];
    }[];
    title?: ReactNode;
    caption?: ReactNode;
    /** Pin the top of the colour scale. Derived from the data otherwise. */
    max?: number;
    /** The ramp's hue. Defaults to the chart blue. */
    color?: string;
    style?: CSSProperties;
}
/** A value grid shaded by magnitude. For density over two dimensions — activity
 *  by day and hour, cost by service and region. */
export declare function Heatmap({ columns, rows, title, caption, max, color, style }: HeatmapProps): import("react").JSX.Element;
