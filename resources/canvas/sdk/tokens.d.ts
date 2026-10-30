/** A resolved colour. Always a literal — never a `var()` reference. */
type TokenColor = string;
export type CanvasTextStyle = {
    fontSize: string;
    lineHeight: string;
    fontWeight: number;
};
/** The status ramp, in the four semantic states plus their surfaces. */
export type CanvasStatusTokens = Record<'success' | 'successBg' | 'successBorder' | 'warning' | 'warningBg' | 'warningBorder' | 'danger' | 'dangerBg' | 'dangerBorder' | 'info' | 'infoBg' | 'infoBorder', TokenColor>;
export interface CanvasTokens {
    bg: {
        /** The canvas surface itself. */
        editor: TokenColor;
        /** Recessed chrome behind the surface. */
        chrome: TokenColor;
        /** A raised card or panel. */
        elevated: TokenColor;
        /** The deepest recess, for a page behind a page. */
        under: TokenColor;
        /** Hover wash over any surface. */
        hover: TokenColor;
    };
    text: {
        primary: TokenColor;
        secondary: TokenColor;
        tertiary: TokenColor;
        quaternary: TokenColor;
        link: TokenColor;
        /** Text sitting ON an accent fill. */
        onAccent: TokenColor;
    };
    stroke: {
        primary: TokenColor;
        secondary: TokenColor;
    };
    fill: {
        primary: TokenColor;
        secondary: TokenColor;
        tertiary: TokenColor;
    };
    accent: {
        /** The ink accent: near-black on light, white on dark. */
        primary: TokenColor;
        /** Interactive control fill. */
        control: TokenColor;
        controlHover: TokenColor;
        /** The blue highlight, for selection and focus. */
        highlight: TokenColor;
        highlightBg: TokenColor;
    };
    status: CanvasStatusTokens;
    /** Alias of `status`, because "tone" is what the component props call it. */
    tone: CanvasStatusTokens;
    diff: {
        added: TokenColor;
        addedBg: TokenColor;
        removed: TokenColor;
        removedBg: TokenColor;
    };
    syntax: {
        keyword: TokenColor;
        string: TokenColor;
        number: TokenColor;
        comment: TokenColor;
        type: TokenColor;
        property: TokenColor;
        punctuation: TokenColor;
        plain: TokenColor;
    };
    chart: {
        blue: TokenColor;
        teal: TokenColor;
        green: TokenColor;
        amber: TokenColor;
        orange: TokenColor;
        red: TokenColor;
        purple: TokenColor;
        pink: TokenColor;
        brown: TokenColor;
        muted: TokenColor;
        /** The gridline / axis colour. */
        gridline: TokenColor;
        /** Categorical order. Index into this for series colour; do not hand-pick. */
        sequence: TokenColor[];
    };
    radius: Record<'none' | 'xxs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl', number>;
    shadow: Record<'md' | 'lg', string>;
    typography: Record<'h1' | 'h2' | 'h3' | 'body' | 'small' | 'mono', CanvasTextStyle>;
    fontSize: Record<'badge' | 'caption' | 'small' | 'bodySm' | 'body' | 'emphasis' | 'title' | 'hero' | 'display', string>;
    weight: Record<'regular' | 'medium' | 'semibold', number>;
    motion: {
        durationFast: string;
        durationBase: string;
        easeOut: string;
        easeInOut: string;
    };
    fontFamily: {
        sans: string;
        mono: string;
    };
}
/**
 * The two theme kinds a canvas renders under. The host reports which one is
 * active; there is no "auto" here because the bridge has already resolved it.
 */
export type CanvasThemeKind = 'light' | 'dark';
/** Corner radii, in px. */
export declare const canvasRadius: {
    readonly none: 0;
    readonly xxs: 4;
    readonly xs: 6;
    readonly sm: 8;
    readonly md: 12;
    readonly lg: 16;
    readonly xl: 20;
};
/** Font sizes, as CSS lengths. */
export declare const canvasFontSize: {
    readonly badge: "10px";
    readonly caption: "12px";
    readonly small: "13px";
    readonly bodySm: "13px";
    readonly body: "14px";
    readonly emphasis: "16px";
    readonly title: "18px";
    readonly hero: "24px";
    readonly display: "28px";
};
/** The three font weights the app uses. */
export declare const canvasFontWeight: {
    readonly regular: 430;
    readonly medium: 500;
    readonly semibold: 600;
};
/** Durations and easings, for a transition a canvas writes by hand. */
export declare const canvasMotion: {
    readonly durationFast: "100ms";
    readonly durationBase: "150ms";
    readonly easeOut: "cubic-bezier(0, 0, 0.2, 1)";
    readonly easeInOut: "cubic-bezier(0.4, 0, 0.2, 1)";
};
/** Complete text styles — size, line height and weight together. */
export declare const canvasTypography: {
    readonly h1: {
        readonly fontSize: "18px";
        readonly lineHeight: "24px";
        readonly fontWeight: 500;
    };
    readonly h2: {
        readonly fontSize: "16px";
        readonly lineHeight: "22px";
        readonly fontWeight: 500;
    };
    readonly h3: {
        readonly fontSize: "14px";
        readonly lineHeight: "21px";
        readonly fontWeight: 500;
    };
    readonly body: {
        readonly fontSize: "14px";
        readonly lineHeight: "22.75px";
        readonly fontWeight: 430;
    };
    readonly small: {
        readonly fontSize: "13px";
        readonly lineHeight: "19.5px";
        readonly fontWeight: 430;
    };
    readonly mono: {
        readonly fontSize: "13px";
        readonly lineHeight: "23.4px";
        readonly fontWeight: 400;
    };
};
/** The sans and mono stacks. */
export declare const canvasFontFamily: {
    readonly sans: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif";
    readonly mono: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace";
};
/** Light tokens. Colours track `:root` in `css/styles.css`. */
export declare const canvasTokensLight: CanvasTokens;
/** Dark tokens. Colours track `[data-theme="dark"]` in `css/styles.css`. */
export declare const canvasTokensDark: CanvasTokens;
/** The tokens for a theme kind. Anything but `light` resolves dark. */
export declare function canvasTokensFor(kind: CanvasThemeKind | string | undefined): CanvasTokens;
/**
 * Named spacing. A canvas passes either a role or a raw pixel number to `gap`;
 * roles exist so a generated layout is consistent without the model having to
 * remember which number it used three sections ago.
 */
export declare const canvasSpacing: {
    /** 4 — inside a label, between an icon and its text. */
    readonly micro: 4;
    /** 8 — between controls on one row. */
    readonly inline: 8;
    /** 12 — between the parts of one component. */
    readonly component: 12;
    /** 16 — inside a card or panel. */
    readonly container: 16;
    /** 24 — between sibling blocks in a section. */
    readonly block: 24;
    /** 32 — between sections. */
    readonly section: 32;
    /** 40 — the page's outer inset. */
    readonly page: 40;
};
export type CanvasSpacingRole = keyof typeof canvasSpacing;
export type CanvasSpacingValue = CanvasSpacingRole | number;
/** Resolve a `gap`-style prop to pixels, falling back to a named role. */
export declare function resolveSpacing(value: CanvasSpacingValue | undefined, fallback: CanvasSpacingRole): number;
/** Control heights, so a button and an input on one row line up. */
export declare const canvasControlHeight: {
    readonly sm: 22;
    readonly md: 28;
    readonly lg: 34;
};
export {};
