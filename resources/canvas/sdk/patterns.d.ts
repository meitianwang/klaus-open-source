import type { CSSProperties, ReactNode } from 'react';
import type { Tone } from './core-primitives';
export interface MetricItem {
    label: ReactNode;
    value: ReactNode;
    unit?: ReactNode;
    /** Percent change. Rendered as a `Delta`; omit when there is no baseline. */
    change?: number;
    /** Which direction is good for THIS metric. Defaults to up-is-good. */
    changeDirection?: 'normal' | 'inverse';
    tone?: Tone;
    description?: ReactNode;
}
export interface MetricsGridProps {
    metrics: MetricItem[];
    /** Boxed cards, or a plain row of figures. Plain reads better above a chart. */
    variant?: 'card' | 'plain';
    columns?: number;
    style?: CSSProperties;
}
/**
 * The headline figures of a report or dashboard.
 *
 * `change` is per-metric rather than a grid-wide flag because direction is a
 * property of the metric: cost down is good, throughput down is not. A single
 * grid routinely mixes both, and getting it wrong paints a regression green.
 */
export declare function MetricsGrid({ metrics, variant, columns, style }: MetricsGridProps): import("react").JSX.Element;
export type RiskLevel = 'low' | 'moderate' | 'high' | 'critical';
export interface RiskItem {
    /** 1-based position on the likelihood axis. */
    likelihood: number;
    /** 1-based position on the impact axis. */
    impact: number;
    label: string;
    detail?: ReactNode;
}
export interface RiskHeatmapProps {
    /** Likelihood axis labels, lowest first. */
    likelihoodLabels: string[];
    /** Impact axis labels, lowest first. */
    impactLabels: string[];
    items: RiskItem[];
    title?: ReactNode;
    /** Called when a populated cell is clicked. */
    onSelect?: (item: RiskItem) => void;
    style?: CSSProperties;
}
/**
 * Likelihood against impact, with items placed in cells.
 *
 * The level is DERIVED from the two axes rather than taken as an input, because a
 * matrix whose colours disagree with its own axes is worse than no matrix: the
 * reader trusts the colour and the colour is a lie. Normalizing by axis length
 * keeps a 3×3 and a 5×5 grid on the same scale.
 */
export declare function RiskHeatmap({ likelihoodLabels, impactLabels, items, title, onSelect, style, }: RiskHeatmapProps): import("react").JSX.Element;
export interface RiskCalloutProps {
    title: ReactNode;
    level: RiskLevel;
    /** What happens if this lands. */
    impact: ReactNode;
    /** What would stop it. */
    mitigation?: ReactNode;
    style?: CSSProperties;
}
/** One risk, stated as level + impact + mitigation. A risk without a stated
 *  impact is a worry; with one it is something that can be decided about. */
export declare function RiskCallout({ title, level, impact, mitigation, style }: RiskCalloutProps): import("react").JSX.Element;
export type ReferenceKind = 'file' | 'url' | 'commit' | 'doc' | 'note';
export interface ReferenceItem {
    kind: ReferenceKind;
    label: string;
    /** A path, a URL, a SHA. Rendered monospace. */
    locator?: string;
    note?: ReactNode;
}
export interface ReferencePanelProps {
    references: ReferenceItem[];
    title?: ReactNode;
    style?: CSSProperties;
}
/**
 * Where the canvas's claims came from.
 *
 * Its own component because provenance is the first thing a reader challenges and
 * the first thing a generated report drops. A `url` becomes a real link; every
 * other kind stays inert text, since a file path is not something the preview
 * window can or should open.
 */
export declare function ReferencePanel({ references, title, style }: ReferencePanelProps): import("react").JSX.Element;
export interface DocsSectionProps {
    title: ReactNode;
    /** A one-line summary under the heading. */
    summary?: ReactNode;
    children?: ReactNode;
    /** Right-aligned header content: a tag, a count, a control. */
    trailing?: ReactNode;
    /** A rule above the heading. Use between sibling sections, not on the first. */
    divided?: boolean;
    level?: 2 | 3;
    style?: CSSProperties;
}
/** A titled section with optional summary. The structural unit a long report is
 *  built from, so the spacing between title, summary, and body is decided once. */
export declare function DocsSection({ title, summary, children, trailing, divided, level, style, }: DocsSectionProps): import("react").JSX.Element;
export interface FindingItem {
    id?: string;
    title: ReactNode;
    severity: 'critical' | 'high' | 'medium' | 'low';
    /** Where it is: a file and line, a component, an endpoint. */
    location?: string;
    /** The concrete consequence. */
    impact?: ReactNode;
    /** What to change. */
    fix?: ReactNode;
    /** Rendered at the right of the header, e.g. a SendToChatButton. */
    action?: ReactNode;
}
export interface FindingsListProps {
    findings: FindingItem[];
    /** Group under severity headings instead of one flat list. */
    grouped?: boolean;
    style?: CSSProperties;
}
/**
 * A prioritized list of problems, each with evidence and a fix.
 *
 * Sorted by severity here rather than trusting input order: a review is only
 * actionable in the order things should be fixed, and a generated list arrives in
 * whatever order the files were read. An empty severity group is dropped rather
 * than rendered as a bare heading.
 */
export declare function FindingsList({ findings, grouped, style }: FindingsListProps): import("react").JSX.Element;
export interface ComparisonOption {
    name: string;
    /** Verdict tag shown under the column head. */
    verdict?: {
        label: string;
        tone: Tone;
    };
}
export interface ComparisonCriterion {
    name: string;
    /** Why this criterion matters. */
    note?: ReactNode;
    /** One value per option, in the same order. `null` renders the unknown mark. */
    values: (ReactNode | null)[];
}
export interface ComparisonMatrixProps {
    options: ComparisonOption[];
    criteria: ComparisonCriterion[];
    /** Shown for a `null` value, with a footnote explaining it. */
    unknownMark?: string;
    style?: CSSProperties;
}
/**
 * Options against shared criteria.
 *
 * `null` renders as an explicit unknown mark with a footnote, because a blank
 * cell in a comparison reads as zero when it almost always means "not
 * investigated" — and that misreading decides things.
 */
export declare function ComparisonMatrix({ options, criteria, unknownMark, style, }: ComparisonMatrixProps): import("react").JSX.Element;
export interface MethodologyProps {
    /** What was covered. */
    scope: ReactNode;
    /** How it was done. */
    method: ReactNode;
    /** What was deliberately left out. Stating this is the point. */
    notCovered?: ReactNode;
    /** When the work was done. */
    asOf?: ReactNode;
    style?: CSSProperties;
}
/**
 * Scope, method, and exclusions.
 *
 * `notCovered` is a first-class field, not a free-text note, because "what this
 * did NOT look at" is the single most useful line in an audit and the first one
 * a generated report leaves out.
 */
export declare function Methodology({ scope, method, notCovered, asOf, style }: MethodologyProps): import("react").JSX.Element;
export interface BeforeAfterProps {
    before: {
        label?: ReactNode;
        children: ReactNode;
    };
    after: {
        label?: ReactNode;
        children: ReactNode;
    };
    style?: CSSProperties;
}
/** Two panels side by side, stacking when narrow. For state comparisons that are
 *  not code (a config, a layout, a policy). */
export declare function BeforeAfter({ before, after, style }: BeforeAfterProps): import("react").JSX.Element;
export interface DisclosureProps {
    summary: ReactNode;
    children: ReactNode;
    /** Right-aligned summary content. */
    trailing?: ReactNode;
    defaultOpen?: boolean;
    style?: CSSProperties;
}
/** A one-line disclosure, lighter than `CollapsibleSection`: no card, no border.
 *  For a long tail of rows where a bordered box per row would be noise. */
export declare function Disclosure({ summary, children, trailing, defaultOpen, style }: DisclosureProps): import("react").JSX.Element;
export type ReportShellWidth = 'narrow' | 'default' | 'wide' | 'full';
export type ReportShellDensity = 'comfortable' | 'compact';
export interface ReportShellProps {
    children?: ReactNode;
    title?: ReactNode;
    subtitle?: ReactNode;
    /** Line under the title: who ran it, over what, when. */
    meta?: ReactNode;
    /** Top-right slot — a SendToChatButton, a status Tag. */
    action?: ReactNode;
    width?: ReportShellWidth;
    density?: ReportShellDensity;
    style?: CSSProperties;
}
/**
 * The outer frame of a report: measured column, one header, consistent rhythm.
 *
 * Reading width is the reason this is a component and not advice in a recipe. Set
 * loose in a maximised window, body text runs to 1600px and the eye loses the
 * line it was on. Every generated report re-deciding its own max width is how a
 * set of reports stops looking like one product.
 */
export declare function ReportShell({ children, title, subtitle, meta, action, width, density, style, }: ReportShellProps): import("react").JSX.Element;
export interface ReportSectionHeaderProps {
    title: ReactNode;
    /** One line saying what the section answers. */
    description?: ReactNode;
    /** Right-aligned slot: a count, a Tag, a jump link. */
    trailing?: ReactNode;
    style?: CSSProperties;
}
/**
 * A section heading with its own one-line brief.
 *
 * Separate from `ReportSection` so a section that needs custom layout under the
 * heading can still use the same heading treatment instead of hand-rolling an
 * `H3` and hoping the spacing matches.
 */
export declare function ReportSectionHeader({ title, description, trailing, style, }: ReportSectionHeaderProps): import("react").JSX.Element;
export interface ReportSectionProps extends ReportSectionHeaderProps {
    children?: ReactNode;
    /** Rule above the heading. On for every section but the first. */
    divided?: boolean;
}
/** One section of a report: heading, brief, body. */
export declare function ReportSection({ children, divided, style, ...header }: ReportSectionProps): import("react").JSX.Element;
export interface ImprovementItem {
    title: ReactNode;
    /** What it buys, stated as an outcome rather than an activity. */
    outcome?: ReactNode;
    /** Rough cost: `1 day`, `one sprint`. */
    effort?: ReactNode;
    /** Where it applies — a path, a service, a team. */
    scope?: ReactNode;
    tone?: Tone;
    /** A per-item action, usually a SendToChatButton that starts the work. */
    action?: ReactNode;
}
export interface ImprovementListProps {
    items: ImprovementItem[];
    /** Number the rows. On by default: a recommendation list is a priority order. */
    ordered?: boolean;
    style?: CSSProperties;
}
/**
 * Ranked recommendations.
 *
 * Numbered by default, because an unordered list of improvements invites the
 * reader to start with the easiest one. If the order does not carry priority the
 * caller should say so by turning it off, not by leaving it ambiguous.
 */
export declare function ImprovementList({ items, ordered, style }: ImprovementListProps): import("react").JSX.Element;
