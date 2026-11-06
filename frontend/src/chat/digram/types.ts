// digram 文档的渲染面类型，与 Rust 侧 `crates/klaus-shell/src/digram.rs` 的 wire
// 形状逐字段对齐（serde camelCase）。
//
// 这里只描述形状，不带任何行为：文档的唯一真相在 Rust 侧，前端拿到的是它序列化
// 出来的东西。字段名必须和 Rust 一致，因为模型 patch 用的键名、面板拖拽写回用的
// 键名、和这里读的键名是同一套——错开一个名字就是「改了没生效」。

/** 形状表。闭集：每一项在 render.ts 里有一条手写路径 + 一条 golden 断言。 */
export type Shape =
  | 'rect'
  | 'rounded'
  | 'pill'
  | 'ellipse'
  | 'diamond'
  | 'hexagon'
  | 'parallelogram'
  | 'cylinder'
  | 'document'
  | 'note'
  | 'actor'
  | 'cloud'
  | 'icon'
  | 'text'
  | 'group'

/** 语义色键。文档里不写 hex，明暗两套由 theme.ts 解析。 */
export type Tone =
  | 'neutral'
  | 'accent'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'violet'
  | 'teal'

/** 语义色的施加方式。soft 是主力，outline 是「层上的组件」，solid 留给必须压场
 *  的一两个框，ghost 是无描边的淡底。 */
export type Variant = 'soft' | 'solid' | 'outline' | 'ghost'

export type Align = 'start' | 'center' | 'end'
export type Valign = 'top' | 'middle' | 'bottom'
export type LabelPlacement = 'inside' | 'below' | 'above'
export type FontWeight = 'regular' | 'medium'
export type Route = 'orthogonal' | 'straight' | 'curve'
export type Side = 'auto' | 'top' | 'right' | 'bottom' | 'left'
export type Arrow = 'none' | 'arrow' | 'dot' | 'diamond'
export type Background = 'paper' | 'transparent'

export interface Point {
  x: number
  y: number
}

/** 数据图表。chart 是节点级字段：节点的框就是图表的画框，label 是图表标题。
 *  数据形状按 kind 判别，宿主 model.ts 的 chartSpec 是同一套规则的校验端。 */
export type ChartKind =
  | 'bar'
  | 'line'
  | 'area'
  | 'pie'
  | 'donut'
  | 'scatter'
  | 'heatmap'
  | 'gantt'
  | 'sankey'

export interface ChartSeries {
  name?: string
  tone?: Tone
  /** 按 categories 对齐的数值序列。 */
  values?: number[]
  /** 散点坐标。 */
  points?: Point[]
  dash?: boolean
}

export interface ChartSlice {
  label: string
  value: number
  tone?: Tone
}

export interface ChartTask {
  label: string
  /** ISO 日期字符串或毫秒数。 */
  start: string | number
  end: string | number
  tone?: Tone
  section?: string
}

export interface ChartFlow {
  from: string
  to: string
  value: number
  tone?: Tone
}

export interface ChartSpec {
  kind: ChartKind
  /** heatmap 强度色与图表级默认色；缺省 accent。 */
  tone?: Tone
  categories?: string[]
  series?: ChartSeries[]
  slices?: ChartSlice[]
  /** heatmap 行标签。 */
  rows?: string[]
  /** heatmap 列标签。 */
  columns?: string[]
  /** heatmap 数值矩阵（rows × columns）。 */
  values?: number[][]
  tasks?: ChartTask[]
  flows?: ChartFlow[]
  stacked?: boolean
  min?: number
  max?: number
  unit?: string
}

/** 文档级品牌主题的一个颜色：单一 hex 同时用于明暗，或分别指定。 */
export type ThemeColor = string | { light?: string; dark?: string }

/** 文档级品牌覆盖。hex 由宿主校验；渲染端再做一次防御性检查。 */
export interface DocumentTheme {
  palette?: Partial<Record<Tone, ThemeColor>>
  paper?: ThemeColor
  fontFamily?: string
  fontSize?: number
  radius?: number
  strokeWidth?: number
  cornerRadius?: number
}

export interface Size {
  w: number
  h: number
}

export interface DigramNode {
  id: string
  shape?: Shape
  x: number
  y: number
  w: number
  h: number
  label?: string
  labelAlign?: Align
  labelValign?: Valign
  labelPlacement?: LabelPlacement
  tone?: Tone
  variant?: Variant
  radius?: number
  /** 目录键（`phosphor:cpu`）或内联 `path:<svg path data>`。 */
  icon?: string
  /** 容器节点。坐标始终是绝对的——嵌套只改绘制次序与归属，不改坐标系。 */
  parent?: string
  fontSize?: number
  fontWeight?: FontWeight
  rotate?: number
  z?: number
  /** 数据图表。存在时框内画图表而不是普通标签（label 成为图表标题）。 */
  chart?: ChartSpec
}

export interface DigramEdge {
  id: string
  from: string
  to: string
  fromSide?: Side
  toSide?: Side
  route?: Route
  waypoints?: Point[]
  label?: string
  tone?: Tone
  dash?: boolean
  arrowFrom?: Arrow
  arrowTo?: Arrow
  z?: number
}

export interface DigramPage {
  id: string
  name?: string
  size?: Size
  grid?: number
  background?: Background
  nodes?: DigramNode[]
  edges?: DigramEdge[]
}

export interface DigramDocument {
  id: string
  sessionId?: string
  title?: string
  version?: number
  updatedAtMs?: number
  /** 品牌覆盖，渲染时合并进当前明暗主题。 */
  theme?: DocumentTheme
  pages: DigramPage[]
}

/** 一条编辑。与 Rust 的 `Op` 枚举同形（`op` 作 tag，camelCase）。 */
export type DigramOp =
  | { op: 'addNode'; page?: string; node: DigramNode }
  | { op: 'updateNode'; page?: string; id: string; patch: Record<string, unknown> }
  | { op: 'deleteNode'; page?: string; id: string }
  | { op: 'addEdge'; page?: string; edge: DigramEdge }
  | { op: 'updateEdge'; page?: string; id: string; patch: Record<string, unknown> }
  | { op: 'deleteEdge'; page?: string; id: string }
  | { op: 'setPageOptions'; page?: string; patch: Record<string, unknown> }
  | { op: 'addPage'; page: DigramPage }
  | { op: 'deletePage'; page: string }
  | { op: 'setTitle'; title: string }
  | { op: 'setTheme'; theme?: DocumentTheme | null }

/** 缺省值集中在这里，而不是散落在渲染各处：文档里省略的字段和渲染时假定的
 *  默认值必须是同一份，否则「省略」和「显式写默认值」会画出两种结果。 */
export const NODE_DEFAULTS = {
  shape: 'rect' as Shape,
  tone: 'neutral' as Tone,
  variant: 'soft' as Variant,
  labelAlign: 'center' as Align,
  labelValign: 'middle' as Valign,
  labelPlacement: 'inside' as LabelPlacement,
  fontWeight: 'regular' as FontWeight,
  rotate: 0,
  z: 0,
}

export const EDGE_DEFAULTS = {
  fromSide: 'auto' as Side,
  toSide: 'auto' as Side,
  route: 'orthogonal' as Route,
  tone: 'neutral' as Tone,
  dash: false,
  arrowFrom: 'none' as Arrow,
  arrowTo: 'arrow' as Arrow,
  z: 0,
}

export const PAGE_DEFAULTS = {
  size: { w: 1600, h: 900 } as Size,
  grid: 10,
  background: 'paper' as Background,
}

export const shapeOf = (node: DigramNode): Shape => node.shape ?? NODE_DEFAULTS.shape
export const toneOf = (item: { tone?: Tone }): Tone => item.tone ?? NODE_DEFAULTS.tone
export const variantOf = (node: DigramNode): Variant => node.variant ?? NODE_DEFAULTS.variant

/**
 * 标签位置。默认值是**随形状**的，不是一个常量：icon 的字必须在框外，
 * 放框内就正好盖死它要展示的字形。
 *
 * Rust 侧 `normalize_node` 写入时会把它落成显式值，但渲染器不能指望那一步
 * 已经发生——手改过的文件、编辑中的临时节点都会绕过它。两边必须得出同一
 * 个结果，所以规则写在这里只写一份。
 */
export const placementOf = (node: DigramNode): LabelPlacement =>
  node.labelPlacement ?? (shapeOf(node) === 'icon' ? 'below' : NODE_DEFAULTS.labelPlacement)

/** group 是容器：先画、画在自己的孩子后面。层就是这个。 */
export const isContainer = (node: DigramNode): boolean => shapeOf(node) === 'group'
