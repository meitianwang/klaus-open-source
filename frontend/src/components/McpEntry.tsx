// 安装档条目卡组件族（React 版）：MCP 页与插件页共用的单列描边列表。
// 类名/DOM 结构与旧 js/pages/mcp.js（已退役）的 renderMcpEntry* 工厂逐一对应；
// mcp-* 类名家族归这里独有，其他页只准用组件不准手写类名。
import type { ReactNode } from 'react'
import { icon, strokeGlyph24 } from '../icons/registry'
import { StatusDot } from './StatusDot'
import type { StatusDotState } from './StatusDot'

// 自建/插件 server 无目录图标时的通用 MCP 字形（插头，细线描边同连接器图标集）。
export const MCP_GENERIC_SERVER_ICON = '<path d="M9 7V3"/><path d="M15 7V3"/><path d="M7 7h10v4a5 5 0 0 1-5 5 5 5 0 0 1-5-5V7z"/><path d="M12 16v5"/>'

// 市场卡片行尾态度图标四态：+ 安装 / 虚线空圆 已装未启用 / 绿对号 已启用 / 红叉 连接失败。
// 惰性取字形：避免模块求值时序依赖 raw-glyphs 注册。
const STATE_ICON_NAMES: Record<string, string> = {
  install: 'install-2',
  off: 'off',
  on: 'on',
  failed: 'failed',
}
export function stateIconHtml(state: string): string {
  const name = STATE_ICON_NAMES[state]
  return name ? icon(name) : ''
}

/** 行尾四态态度图标按钮（市场档与插件页共用的统一控件）。 */
export function StateIconButton({ state, label, onClick, disabled = false, busy = false }: {
  state: string
  label: string
  onClick?: (e: React.MouseEvent) => void
  disabled?: boolean
  /** 操作已受理：图标换成 spinner，忙态归这个控件自己表达，不另起漂浮进度行。 */
  busy?: boolean
}) {
  return (
    <button
      className={`mcp-state-btn is-${state}${busy ? ' is-busy' : ''}`}
      aria-label={label}
      disabled={disabled || busy}
      onClick={onClick}
      {...(busy ? {} : { dangerouslySetInnerHTML: { __html: stateIconHtml(state) } })}
    >
      {busy ? <span className="mcp-state-btn-spinner" aria-hidden="true" /> : null}
    </button>
  )
}

/** 条目卡竖排容器（描边列表 + 空态兼底）：各档/各页统一的列表外壳。 */
export function EntryList({ empty, emptyText, children }: {
  empty: boolean
  emptyText: string
  children: ReactNode
}) {
  return <div className="mcp-list">{empty ? <div className="mcp-empty">{emptyText}</div> : children}</div>
}

/** 行尾次墨 meta 文本槽。 */
export function EntryMeta({ text }: { text: string }) {
  return <span className="mcp-entry-meta">{text}</span>
}

/** 行尾启停开关。 */
export function EntryToggle({ checked, title, onChange, dataAttrs, disabled = false }: {
  checked: boolean
  title: string
  onChange?: (checked: boolean) => void
  dataAttrs?: Record<string, string>
  disabled?: boolean
}) {
  return (
    <label className="mcp-toggle" aria-label={title}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange?.(e.target.checked)}
        {...(dataAttrs || {})}
      />
      <span className="mcp-toggle-slider" />
    </label>
  )
}

/** 行尾无字图标按钮（编辑/删除/卸载这类低频动作）。 */
export function EntryIconButton({ iconName, size = 15, title, onClick, disabled = false }: {
  iconName: string
  size?: number
  title: string
  onClick?: (e: React.MouseEvent) => void
  disabled?: boolean
}) {
  return (
    <button
      className="mcp-icon-btn"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      dangerouslySetInnerHTML={{ __html: icon(iconName, { size }) }}
    />
  )
}

/** 名称旁的来源/作用域徽标（插件贡献、project/local 作用域这类出处标注）。 */
export function SourceBadge({ text, title }: { text: string; title?: string }) {
  return <span className="mcp-source-badge" {...(title ? { title } : {})}>{text}</span>
}

export interface EntryCardProps {
  cardKey: string
  datasets?: Record<string, string>
  /** 完整 <svg>；缺省时用 iconSvg（内联 path body）包描边壳。 */
  iconHtml?: string
  iconSvg?: string
  title: string
  desc?: string
  descMono?: boolean
  /**
   * 状态点：传【状态 + 可读标签】，不传颜色。两者必须同行，所以合成一个
   * 对象——拆成 dot + dotLabel 两个可选属性就存在“摆了点却忘了标签”的缺口。
   */
  dot?: { state: StatusDotState; label: string } | null
  badge?: ReactNode
  meta?: ReactNode
  controls?: ReactNode
  onOpen?: () => void
  /**
   * 行内键盘语义：space 切启停。传了才会让行本体可聚焦——没有开关的行
   * （比如只能看详情的）不应该凭空多一个 tab 停留点。
   */
  onToggleKey?: () => void
}

/**
 * 安装列表唯一的条目组件：单容器内的分隔线行——图标砖 + 名称/描述两行 +
 * 右侧次墨 meta + 控件；行本体点击（避开控件）弹详情弹窗。
 * 全局 server / 连接器组 / 项目 server / 插件都用它，只允许在
 * meta/控件/描述上分流，禁止另起条目组件。
 */
export function EntryCard(props: EntryCardProps) {
  const dataAttrs: Record<string, string> = {}
  for (const [k, v] of Object.entries(props.datasets || {})) dataAttrs[`data-${k}`] = String(v)
  const glyph = props.iconHtml || strokeGlyph24(props.iconSvg || MCP_GENERIC_SERVER_ICON, 20)
  // Every clickable detail row is keyboard reachable; rows with a toggle also
  // reserve Space for toggling while Enter opens the detail.
  const keyboard = props.onOpen != null || props.onToggleKey != null
  return (
    <div className="mcp-entry" data-card-key={props.cardKey} {...dataAttrs}>
      <div className="mcp-entry-main">
        <div
          className="mcp-entry-open"
          data-card-open
          {...(keyboard ? { tabIndex: 0, role: 'button' } : {})}
          onKeyDown={keyboard ? (e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              props.onOpen?.()
              return
            }
            // Space normally scrolls the page; on a switchable row it toggles
            // the entry, and on a detail-only row it opens the detail.
            if (e.key === ' ' || e.key === 'Spacebar') {
              e.preventDefault()
              if (props.onToggleKey) props.onToggleKey()
              else props.onOpen?.()
            }
          } : undefined}
          onClick={() => props.onOpen?.()}
        >
          <div className="mcp-logo" dangerouslySetInnerHTML={{ __html: glyph }} />
          <div className="mcp-entry-text">
            <div className="mcp-entry-name">
              {props.title}
              {props.dot && <StatusDot state={props.dot.state} label={props.dot.label} />}
              {props.badge}
            </div>
            {props.desc ? <div className={`mcp-entry-desc ${props.descMono ? 'mcp-desc-mono' : ''}`}>{props.desc}</div> : null}
          </div>
          {props.meta}
        </div>
        {props.controls != null && <span className="mcp-entry-controls">{props.controls}</span>}
      </div>
    </div>
  )
}
