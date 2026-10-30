import type { CSSProperties, ReactNode } from 'react';
export interface PresentationFragmentProps {
    children?: ReactNode;
    /**
     * Which forward press reveals this. 1 is the first press after the slide
     * appears. Explicit rather than derived from mount order, because mount order
     * in a conditional tree is not the order the reader sees.
     */
    at?: number;
    /** How it arrives. `fade` is the default; `none` for an instant appearance. */
    effect?: 'fade' | 'rise' | 'none';
    style?: CSSProperties;
}
/**
 * A part of a slide that appears on a later forward press.
 *
 * Outside a `Presentation` it renders its children plainly — a fragment that
 * vanished because someone reused the slide body elsewhere would be a silent
 * content loss, which is worse than showing it early.
 *
 * Hidden fragments keep their layout box (`visibility`, not `display`) so the
 * slide does not jump as each one arrives.
 */
export declare function PresentationFragment({ children, at, effect, style, }: PresentationFragmentProps): import("react").JSX.Element;
export interface PresentationStackProps {
    children?: ReactNode;
    /** Box height. Required in spirit: stacked children cannot size the box. */
    height?: number | string;
    style?: CSSProperties;
}
/**
 * Overlap children in one box instead of stacking them down the page.
 *
 * For a diagram that builds up: wrap each layer in a `PresentationFragment` and
 * put them here, and layer two lands ON layer one rather than below it. Without
 * this, every revealed fragment pushes the slide taller and the diagram walks
 * down the screen as the presenter talks.
 */
export declare function PresentationStack({ children, height, style }: PresentationStackProps): import("react").JSX.Element;
export interface PresentationSlideProps {
    /** Slide title, rendered by the slide chrome. */
    title?: ReactNode;
    /** A short line under the title. */
    subtitle?: ReactNode;
    children?: ReactNode;
    /** Center the content block vertically. Right for a title or section slide. */
    centered?: boolean;
    /** Presenter-only text, shown in the notes strip when notes are on. */
    notes?: ReactNode;
    style?: CSSProperties;
}
/**
 * One slide. Rendered by `Presentation`, which reads these props off its
 * children — so a slide is a declaration, not a component that draws itself.
 */
export declare function PresentationSlide(_props: PresentationSlideProps): null;
export interface PresentationProps {
    children: ReactNode;
    /** Deck title, shown in the chrome alongside the slide counter. */
    title?: ReactNode;
    /** Persist the position under this key so a reload returns to the same slide. */
    stateKey?: string;
    /** Show the presenter notes strip. */
    showNotes?: boolean;
    /** Slide area height. The deck does not grow with its longest slide. */
    height?: number;
    style?: CSSProperties;
}
export declare function Presentation({ children, title, stateKey, showNotes, height, style, }: PresentationProps): import("react").JSX.Element;
