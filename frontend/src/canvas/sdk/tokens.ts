// Canvas design tokens — the semantic palette a `.canvas.tsx` is allowed to use.
//
// A canvas is authored by the model against `useHostTheme().tokens`, so this
// object IS the colour vocabulary of the feature. Two properties matter more
// than the individual values:
//
//   - It mirrors `css/styles.css`. A canvas renders in its isolated panel webview, and a
//     canvas that looked like a different product would read as a bug. The
//     literal values below are the SAME values the renderer's `:root` and
//     `[data-theme="dark"]` blocks define, and `canvas-tokens.test.ts` pins that
//     equality by parsing the stylesheet — so a palette change in the app cannot
//     silently leave the canvas behind.
//   - It is self-contained. The values are literals rather than
//     `var(--fg-secondary)` reads, because the canvas page does not load the
//     app stylesheet: it evaluates model-authored code and must render the same
//     whether or not anything else on the page succeeded.
//
// The token PATHS follow the shape the authoring contract documents (bg / text /
// stroke / fill / accent / status / chart / diff / syntax plus the numeric
// scales). Names the model might guess from CSS, Tailwind, or another product
// deliberately do not exist: an invented path yields `undefined`, which paints
// nothing, so the contract states the paths and `canvas_check` cannot catch a
// bad one.

/** A resolved colour. Always a literal — never a `var()` reference. */
type TokenColor = string

export type CanvasTextStyle = {
  fontSize: string
  lineHeight: string
  fontWeight: number
}

/** The status ramp, in the four semantic states plus their surfaces. */
export type CanvasStatusTokens = Record<
  | 'success' | 'successBg' | 'successBorder'
  | 'warning' | 'warningBg' | 'warningBorder'
  | 'danger' | 'dangerBg' | 'dangerBorder'
  | 'info' | 'infoBg' | 'infoBorder',
  TokenColor
>

export interface CanvasTokens {
  bg: {
    /** The canvas surface itself. */
    editor: TokenColor
    /** Recessed chrome behind the surface. */
    chrome: TokenColor
    /** A raised card or panel. */
    elevated: TokenColor
    /** The deepest recess, for a page behind a page. */
    under: TokenColor
    /** Hover wash over any surface. */
    hover: TokenColor
  }
  text: {
    primary: TokenColor
    secondary: TokenColor
    tertiary: TokenColor
    quaternary: TokenColor
    link: TokenColor
    /** Text sitting ON an accent fill. */
    onAccent: TokenColor
  }
  stroke: {
    primary: TokenColor
    secondary: TokenColor
  }
  fill: {
    primary: TokenColor
    secondary: TokenColor
    tertiary: TokenColor
  }
  accent: {
    /** The ink accent: near-black on light, white on dark. */
    primary: TokenColor
    /** Interactive control fill. */
    control: TokenColor
    controlHover: TokenColor
    /** The blue highlight, for selection and focus. */
    highlight: TokenColor
    highlightBg: TokenColor
  }
  status: CanvasStatusTokens
  /** Alias of `status`, because "tone" is what the component props call it. */
  tone: CanvasStatusTokens
  diff: {
    added: TokenColor
    addedBg: TokenColor
    removed: TokenColor
    removedBg: TokenColor
  }
  syntax: {
    keyword: TokenColor
    string: TokenColor
    number: TokenColor
    comment: TokenColor
    type: TokenColor
    property: TokenColor
    punctuation: TokenColor
    plain: TokenColor
  }
  chart: {
    blue: TokenColor
    teal: TokenColor
    green: TokenColor
    amber: TokenColor
    orange: TokenColor
    red: TokenColor
    purple: TokenColor
    pink: TokenColor
    brown: TokenColor
    muted: TokenColor
    /** The gridline / axis colour. */
    gridline: TokenColor
    /** Categorical order. Index into this for series colour; do not hand-pick. */
    sequence: TokenColor[]
  }
  radius: Record<'none' | 'xxs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl', number>
  shadow: Record<'md' | 'lg', string>
  typography: Record<'h1' | 'h2' | 'h3' | 'body' | 'small' | 'mono', CanvasTextStyle>
  fontSize: Record<
    'badge' | 'caption' | 'small' | 'bodySm' | 'body' | 'emphasis' | 'title' | 'hero' | 'display',
    string
  >
  weight: Record<'regular' | 'medium' | 'semibold', number>
  motion: { durationFast: string; durationBase: string; easeOut: string; easeInOut: string }
  fontFamily: { sans: string; mono: string }
}

/**
 * The two theme kinds a canvas renders under. The host reports which one is
 * active; there is no "auto" here because the bridge has already resolved it.
 */
export type CanvasThemeKind = 'light' | 'dark'

/** `--font` / `--font-mono` from the app stylesheet. */
const SANS =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
const MONO =
  "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace"

/**
 * Scales that do not change with the theme. Split out because duplicating them
 * per theme is how one of the two copies eventually goes stale.
 */
const SHARED = {
  radius: { none: 0, xxs: 4, xs: 6, sm: 8, md: 12, lg: 16, xl: 20 },
  fontSize: {
    badge: '10px',
    caption: '12px',
    small: '13px',
    bodySm: '13px',
    body: '14px',
    emphasis: '16px',
    title: '18px',
    hero: '24px',
    display: '28px',
  },
  // regular / medium / semibold only. The app converged on three weights and a
  // canvas stacking `bold` on top would read as a different product.
  weight: { regular: 430, medium: 500, semibold: 600 },
  motion: {
    durationFast: '100ms',
    durationBase: '150ms',
    easeOut: 'cubic-bezier(0, 0, 0.2, 1)',
    easeInOut: 'cubic-bezier(0.4, 0, 0.2, 1)',
  },
  fontFamily: { sans: SANS, mono: MONO },
  // No size above h1: the authoring contract caps a canvas at the H1 scale, so a
  // larger style existing here would be an invitation to break it.
  typography: {
    h1: { fontSize: '18px', lineHeight: '24px', fontWeight: 500 },
    h2: { fontSize: '16px', lineHeight: '22px', fontWeight: 500 },
    h3: { fontSize: '14px', lineHeight: '21px', fontWeight: 500 },
    body: { fontSize: '14px', lineHeight: '22.75px', fontWeight: 430 },
    small: { fontSize: '13px', lineHeight: '19.5px', fontWeight: 430 },
    mono: { fontSize: '13px', lineHeight: '23.4px', fontWeight: 400 },
  },
} as const

// The theme-independent scales, exported one by one.
//
// Everything here is already reachable as `useHostTheme().tokens.radius` and so
// on. These exist for the place that is NOT inside a render: a style object at
// module level, a helper outside the component, a constant shared by two
// components in one file. A hook cannot be called there, and what a canvas reaches
// for instead is a hardcoded `8` — which is how a generated canvas ends up with a
// radius the app does not use.
//
// Colours are deliberately absent. Those DO change with the theme, so a
// module-level colour constant would pin one appearance.

/** Corner radii, in px. */
export const canvasRadius = SHARED.radius

/** Font sizes, as CSS lengths. */
export const canvasFontSize = SHARED.fontSize

/** The three font weights the app uses. */
export const canvasFontWeight = SHARED.weight

/** Durations and easings, for a transition a canvas writes by hand. */
export const canvasMotion = SHARED.motion

/** Complete text styles — size, line height and weight together. */
export const canvasTypography = SHARED.typography

/** The sans and mono stacks. */
export const canvasFontFamily = SHARED.fontFamily

/**
 * Categorical chart order. Hue-separated rather than a ramp, because a canvas
 * series list is nominal data: adjacent entries must be tellable apart at a
 * glance, which a lightness ramp does not deliver.
 */
function sequence(chart: Omit<CanvasTokens['chart'], 'sequence'>): TokenColor[] {
  return [
    chart.blue,
    chart.green,
    chart.amber,
    chart.purple,
    chart.teal,
    chart.red,
    chart.orange,
    chart.pink,
    chart.brown,
    chart.muted,
  ]
}

/** Light tokens. Colours track `:root` in `css/styles.css`. */
export const canvasTokensLight: CanvasTokens = buildLight()

/** Dark tokens. Colours track `[data-theme="dark"]` in `css/styles.css`. */
export const canvasTokensDark: CanvasTokens = buildDark()

function buildLight(): CanvasTokens {
  const chartBase = {
    blue: '#0071ea',
    teal: '#2aa7b8',
    green: '#00a240',
    amber: '#d97706',
    orange: '#bd5800',
    red: '#e02e2a',
    purple: '#751ed9',
    pink: '#c2418f',
    brown: '#8a5a2b',
    muted: 'rgba(26, 28, 31, 0.35)',
    gridline: 'rgba(26, 28, 31, 0.08)',
  }
  const status: CanvasStatusTokens = {
    success: '#0b8043',
    successBg: 'rgba(11, 128, 67, 0.12)',
    successBorder: 'rgba(11, 128, 67, 0.28)',
    warning: '#b8690a',
    warningBg: 'rgba(184, 105, 10, 0.12)',
    warningBorder: 'rgba(184, 105, 10, 0.28)',
    danger: '#c9241c',
    dangerBg: 'rgba(201, 36, 28, 0.12)',
    dangerBorder: 'rgba(201, 36, 28, 0.28)',
    info: '#1668c8',
    infoBg: 'rgba(22, 104, 200, 0.12)',
    infoBorder: 'rgba(22, 104, 200, 0.28)',
  }
  return {
    bg: {
      editor: '#ffffff',
      chrome: '#f9f9f9',
      elevated: '#ffffff',
      under: '#f2f2f2',
      hover: 'rgba(26, 28, 31, 0.05)',
    },
    text: {
      primary: '#1a1c1f',
      secondary: 'rgba(26, 28, 31, 0.7)',
      tertiary: 'rgba(26, 28, 31, 0.5)',
      quaternary: 'rgba(26, 28, 31, 0.35)',
      link: '#339cff',
      onAccent: '#ffffff',
    },
    stroke: { primary: 'rgba(26, 28, 31, 0.08)', secondary: 'rgba(26, 28, 31, 0.05)' },
    fill: {
      primary: 'rgba(26, 28, 31, 0.08)',
      secondary: 'rgba(26, 28, 31, 0.05)',
      tertiary: 'rgba(26, 28, 31, 0.03)',
    },
    accent: {
      primary: '#1a1c1f',
      control: '#1a1c1f',
      controlHover: '#303030',
      highlight: '#339cff',
      highlightBg: 'rgba(51, 156, 255, 0.12)',
    },
    status,
    tone: status,
    diff: {
      added: '#00a240',
      addedBg: 'rgba(0, 162, 64, 0.14)',
      removed: '#e02e2a',
      removedBg: 'rgba(224, 46, 42, 0.14)',
    },
    syntax: {
      keyword: '#751ed9',
      string: '#008809',
      number: '#0071ea',
      comment: 'rgba(26, 28, 31, 0.5)',
      type: '#751ed9',
      property: '#bd5800',
      punctuation: '#666666',
      plain: '#1a1c1f',
    },
    chart: { ...chartBase, sequence: sequence(chartBase) },
    shadow: {
      md: '0 6px 18px -8px rgba(0, 0, 0, 0.10), 0 1px 0 rgba(0, 0, 0, 0.03)',
      lg: '0 18px 40px -16px rgba(0, 0, 0, 0.18), 0 1px 0 rgba(0, 0, 0, 0.04)',
    },
    ...SHARED,
  }
}

function buildDark(): CanvasTokens {
  const chartBase = {
    blue: '#6dcbf4',
    teal: '#2aa7b8',
    green: '#15b864',
    amber: '#f0b429',
    orange: '#e08b3a',
    red: '#ff6764',
    purple: '#b06dff',
    pink: '#e878b8',
    brown: '#c08b5a',
    muted: 'rgba(255, 255, 255, 0.35)',
    gridline: 'rgba(255, 255, 255, 0.08)',
  }
  const status: CanvasStatusTokens = {
    success: '#30c26a',
    successBg: 'rgba(48, 194, 106, 0.16)',
    successBorder: 'rgba(48, 194, 106, 0.32)',
    warning: '#f5a623',
    warningBg: 'rgba(245, 166, 35, 0.16)',
    warningBorder: 'rgba(245, 166, 35, 0.32)',
    danger: '#ff5f57',
    dangerBg: 'rgba(255, 95, 87, 0.16)',
    dangerBorder: 'rgba(255, 95, 87, 0.32)',
    info: '#5aa9f8',
    infoBg: 'rgba(90, 169, 248, 0.16)',
    infoBorder: 'rgba(90, 169, 248, 0.32)',
  }
  return {
    bg: {
      editor: '#181818',
      chrome: '#000000',
      elevated: '#212121',
      under: '#141414',
      hover: 'rgba(255, 255, 255, 0.06)',
    },
    text: {
      primary: '#dfdfdf',
      secondary: 'rgba(255, 255, 255, 0.7)',
      tertiary: 'rgba(255, 255, 255, 0.5)',
      quaternary: 'rgba(255, 255, 255, 0.35)',
      link: '#339cff',
      onAccent: '#0d0d0d',
    },
    stroke: { primary: 'rgba(255, 255, 255, 0.08)', secondary: 'rgba(255, 255, 255, 0.04)' },
    fill: {
      primary: 'rgba(255, 255, 255, 0.10)',
      secondary: 'rgba(255, 255, 255, 0.06)',
      tertiary: 'rgba(255, 255, 255, 0.04)',
    },
    accent: {
      primary: '#ffffff',
      control: '#ffffff',
      controlHover: 'rgba(255, 255, 255, 0.86)',
      highlight: '#339cff',
      highlightBg: 'rgba(51, 156, 255, 0.12)',
    },
    status,
    tone: status,
    diff: {
      added: '#15b864',
      addedBg: 'rgba(21, 184, 100, 0.16)',
      removed: '#ff6764',
      removedBg: 'rgba(255, 103, 100, 0.16)',
    },
    syntax: {
      keyword: '#b06dff',
      string: '#4cc76a',
      number: '#6dcbf4',
      comment: 'rgba(255, 255, 255, 0.5)',
      type: '#b06dff',
      property: '#e0a060',
      punctuation: '#999999',
      plain: '#dfdfdf',
    },
    chart: { ...chartBase, sequence: sequence(chartBase) },
    shadow: {
      md: '0 6px 18px -8px rgba(0, 0, 0, 0.40), 0 1px 0 rgba(0, 0, 0, 0.20)',
      lg: '0 18px 40px -16px rgba(0, 0, 0, 0.55), 0 1px 0 rgba(0, 0, 0, 0.25)',
    },
    ...SHARED,
  }
}

/** The tokens for a theme kind. Anything but `light` resolves dark. */
export function canvasTokensFor(kind: CanvasThemeKind | string | undefined): CanvasTokens {
  return kind === 'light' ? canvasTokensLight : canvasTokensDark
}

/**
 * Named spacing. A canvas passes either a role or a raw pixel number to `gap`;
 * roles exist so a generated layout is consistent without the model having to
 * remember which number it used three sections ago.
 */
export const canvasSpacing = {
  /** 4 — inside a label, between an icon and its text. */
  micro: 4,
  /** 8 — between controls on one row. */
  inline: 8,
  /** 12 — between the parts of one component. */
  component: 12,
  /** 16 — inside a card or panel. */
  container: 16,
  /** 24 — between sibling blocks in a section. */
  block: 24,
  /** 32 — between sections. */
  section: 32,
  /** 40 — the page's outer inset. */
  page: 40,
} as const

export type CanvasSpacingRole = keyof typeof canvasSpacing
export type CanvasSpacingValue = CanvasSpacingRole | number

/** Resolve a `gap`-style prop to pixels, falling back to a named role. */
export function resolveSpacing(
  value: CanvasSpacingValue | undefined,
  fallback: CanvasSpacingRole,
): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value in canvasSpacing) return canvasSpacing[value]
  return canvasSpacing[fallback]
}

/** Control heights, so a button and an input on one row line up. */
export const canvasControlHeight = { sm: 22, md: 28, lg: 34 } as const
