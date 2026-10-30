// 全端唯一的状态点组件。样式在 css/styles.css 的 .kls-status-dot 一族。
//
// 为什么要有这么个组件：状态点以前是各页手写的三套类名（mcp-dot / s-dot /
// ssh-conn-dot），颜色各自 var(--success) / var(--danger) 直连，语义只由颜色
// 一个通道承载，而且一个点都没有可读文本——屏幕阅读器完全无声，鼠标悬停也
// 没有提示。收成一个组件之后：状态是枚举而不是颜色名（调用方不再决定「绿」
// 还是「黄」，只说「连上了」还是「待授权」），标签是必填参数，形状差异由
// 样式层统一保证。
//
// 颜色名不进 API：调用方写 dot="green" 的时候，语义与呈现就已经耦合了，
// 换语义（黄=待授权 → 需要一个新状态）就只能继续加颜色名。
export type StatusDotState = 'ok' | 'attn' | 'error' | 'busy' | 'idle'

export interface StatusDotProps {
  state: StatusDotState
  /**
   * 给人读的状态名（如「已连接」）。点本身没有文本，所以默认就该传；
   * 只有旁边已经有等价文字（如 ssh 连接芯里的「已连接」）时才省略，
   * 那种情况下点是纯装饰的，要 aria-hidden 掉以免屏读器把状态念两遍。
   */
  label?: string
}

/**
 * 状态点。带 label 时 role=img + aria-label + title：屏读器能念出状态名、
 * 鼠标悬停也拿得到——两者缺一，这个点对键盘/读屏用户就等于不存在。
 */
export function StatusDot({ state, label }: StatusDotProps) {
  const a11y = label
    ? { role: 'img', 'aria-label': label, title: label }
    : { 'aria-hidden': true as const }
  return <span className={`kls-status-dot is-${state}`} {...a11y} />
}

/**
 * HTML 字符串形态（给还在拼模板字符串的宿主，如 ssh 连接面板）。
 * 与组件同一套类名与无障碍规则，避免那些地方各自再写一个点。
 * label 由调用方保证是已本地化的纯文本；这里只做引号转义。
 */
export function statusDotHtml(state: StatusDotState, label?: string): string {
  if (!label) return `<span class="kls-status-dot is-${state}" aria-hidden="true"></span>`
  const safe = String(label).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
  return `<span class="kls-status-dot is-${state}" role="img" aria-label="${safe}" title="${safe}"></span>`
}
