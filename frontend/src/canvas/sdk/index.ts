// `klaus/canvas` — the entire public surface a `.canvas.tsx` may import.
//
// This file IS the contract. The `.d.ts` files provisioned to
// `~/.klaus/canvas/sdk/` are generated from it, the model is told to read those
// declarations before writing a canvas, and `canvas_check` validates every named
// import against what this file re-exports. One source, three consumers, no
// drift: adding a component means exporting it here and nowhere else.
//
// What deliberately is NOT exported:
//   - React's own hooks. A canvas imports those from `react`, which the runtime
//     resolves. Two ways to get `useState` would show up as two conventions in
//     generated canvases.
//   - The bridge internals (`initCanvasHost`, `applyCanvasTheme`,
//     `flushCanvasState`). Those are the page's, and a canvas calling them would
//     be reaching past its own boundary.

// ── Tokens and scales ─────────────────────────────────────────────────────────
export type {
  CanvasTokens,
  CanvasStatusTokens,
  CanvasTextStyle,
  CanvasThemeKind,
  CanvasSpacingRole,
  CanvasSpacingValue,
} from './tokens'
export {
  canvasSpacing,
  canvasControlHeight,
  resolveSpacing,
  canvasRadius,
  canvasFontSize,
  canvasFontWeight,
  canvasFontFamily,
  canvasMotion,
  canvasTypography,
} from './tokens'

// ── Shell config ────────────────────────────────────────────
// A canvas that wants the window to frame it differently declares it:
//
//   export const canvasConfig: CanvasRuntimeConfig = { shell: { mode: 'full-bleed' } }
//
// Types only — there is nothing to call. The window reads the export after
// evaluating the module, which is why this is a named export on the canvas and
// not an argument to a hook: the frame has to know before the first render.
export type { CanvasShellMode, CanvasShellConfig, CanvasRuntimeConfig } from './shell'

// ── Host bridge ───────────────────────────────────────────────────────────────
export type {
  CanvasHostTheme,
  CanvasHostLanguage,
  CanvasTextDirection,
  LocalizedTextBundle,
  SetCanvasState,
  CanvasAction,
  CanvasAnnotationOptions,
  CanvasActionRequestOptions,
  SendToChat,
  SendToChatOptions,
} from './hooks'
export {
  useHostTheme,
  useHostLanguage,
  useLocalizedText,
  useCanvasState,
  useCanvasAction,
  useCanvasActionRequest,
  dispatchCanvasAction,
  startCanvasAnnotation,
  useCanvasAnnotation,
  sendToChat,
  useSendToChat,
  getCanvasFilePath,
  revealCanvasFile,
  canvasImage,
} from './hooks'

// ── Layout, text, containers, controls ────────────────────────────────────────
export type {
  Tone,
  ControlSize,
  TextTone,
  TextWeight,
  Align,
  Justify,
  CellAlign,
  TrendDirection,
  StackProps,
  RowProps,
  GridProps,
  ScrollAreaProps,
  TextProps,
  CardProps,
  CardHeaderProps,
  CollapsibleSectionProps,
  ButtonVariant,
  ButtonProps,
  IconButtonProps,
  TagProps,
  InputProps,
  TextAreaProps,
  CheckboxProps,
  SwitchProps,
  SelectOption,
  SelectProps,
  SendToChatButtonProps,
  PillProps,
  DialogProps,
  ZoomableViewportProps,
} from './core-primitives'
export {
  Stack,
  Row,
  Grid,
  Divider,
  Spacer,
  ScrollArea,
  Text,
  H1,
  H2,
  H3,
  Code,
  Link,
  Card,
  CardHeader,
  CardBody,
  CollapsibleSection,
  CollapsibleCard,
  Button,
  IconButton,
  Tag,
  Pill,
  Input,
  TextArea,
  Checkbox,
  Switch,
  Select,
  SendToChatButton,
  Dialog,
  ZoomableViewport,
  toneColors,
} from './core-primitives'

// ── Data display ──────────────────────────────────────────────────────────────
export type {
  TableDensity,
  TableRowTone,
  TableColumn,
  DataTableProps,
  SimpleTableProps,
  TableProps,
  StatProps,
  DeltaProps,
  ProgressProps,
  CalloutProps,
  BannerProps,
  SkeletonProps,
  TimelineEvent,
  TimelineProps,
  FieldListProps,
  TabsProps,
} from './data-primitives'
export {
  Table,
  Stat,
  Delta,
  Progress,
  Callout,
  Banner,
  Skeleton,
  Timeline,
  FieldList,
  Tabs,
} from './data-primitives'

// ── Charts ────────────────────────────────────────────────────────────────────
export type {
  ChartSeries,
  ChartContainerProps,
  CartesianChartProps,
  BarChartProps,
  PieChartProps,
  HeatmapProps,
} from './charts'
export { ChartContainer, LineChart, AreaChart, BarChart, PieChart, Heatmap } from './charts'
export type {
  RadarSeries,
  RadarChartProps,
  RadialBarChartProps,
  QuadrantItem,
  QuadrantChartProps,
  ChartComparisonGridProps,
  MultiplierBubbleChartDatum,
  MultiplierBubbleChartProps,
} from './charts-extra'
export {
  RadarChart,
  RadialBarChart,
  QuadrantChart,
  ChartComparisonGrid,
  MultiplierBubbleChart,
} from './charts-extra'

// ── Patterns ───────────────────────────────────────────────────────────
// Semantic blocks that carry an opinion about their content — a risk matrix knows
// what a risk level is, a findings list knows severity order.
export type {
  MetricItem,
  MetricsGridProps,
  RiskLevel,
  RiskItem,
  RiskHeatmapProps,
  RiskCalloutProps,
  ReferenceKind,
  ReferenceItem,
  ReferencePanelProps,
  DocsSectionProps,
  FindingItem,
  FindingsListProps,
  ComparisonOption,
  ComparisonCriterion,
  ComparisonMatrixProps,
  MethodologyProps,
  BeforeAfterProps,
  DisclosureProps,
  ReportShellWidth,
  ReportShellDensity,
  ReportShellProps,
  ReportSectionHeaderProps,
  ReportSectionProps,
  ImprovementItem,
  ImprovementListProps,
} from './patterns'
export {
  MetricsGrid,
  RiskHeatmap,
  RiskCallout,
  ReferencePanel,
  DocsSection,
  FindingsList,
  ComparisonMatrix,
  Methodology,
  BeforeAfter,
  Disclosure,
  ReportShell,
  ReportSection,
  ReportSectionHeader,
  ImprovementList,
} from './patterns'

// ── Code review ──────────────────────────────────────────────────────
export type {
  DiffLine,
  DiffSide,
  DiffAnchor,
  DiffGroupProps,
  ThreadComment,
  ReviewCommentProps,
  ReviewThreadProps,
  CommentDraftProps,
  ReviewThreadRecord,
  ReviewThreadStore,
  FileReviewProps,
  CodeBlockProps,
} from './code-view'
export {
  DiffGroup,
  ReviewComment,
  ReviewThread,
  CommentDraft,
  FileReview,
  CodeBlock,
  diffAnchorKey,
  useReviewThreadStore,
} from './code-view'

// ── Presentation ────────────────────────────────────────────────────
export type {
  PresentationProps,
  PresentationSlideProps,
  PresentationFragmentProps,
  PresentationStackProps,
} from './presentation'
export {
  Presentation,
  PresentationSlide,
  PresentationFragment,
  PresentationStack,
} from './presentation'
