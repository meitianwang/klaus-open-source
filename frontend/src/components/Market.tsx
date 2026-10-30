// 市场档卡片网格（MCP 市场 / 技能广场 / 插件广场共用的唯一市场组件，React 版）。
//
// 市场是「逸而发现」场景：双列卡片网格（图标砖 + 名称/副标 + 两行描述 +
// 行尾态度控件）给得起信息密度；安装档才是「管理」场景，走各页自己的
// 单列行式列表。三页市场档必须共用本组件，不得各自再起卡片骨架。
// 类名/DOM 结构与 js/ui-shared.js 的 klsMarket 工厂逐一对应。
import type { ReactNode } from 'react'

export interface MarketCardProps {
  /** 卡体点击路由键（data-card-key）。 */
  cardKey?: string
  datasets?: Record<string, string>
  /** 完整 <svg> 字符串（图标砖）。 */
  iconHtml?: string
  /** 追加到图标砖 span 的类：品牌 logo 图等自带完整外形的内容用它卸掉砖壳。 */
  iconClassName?: string
  title: string
  badge?: ReactNode
  subtitle?: ReactNode
  desc?: string
  /** 行尾控件：四态态度图标 / 安装钮。 */
  controls?: ReactNode
  onOpen?: () => void
}

export function MarketCard(props: MarketCardProps) {
  const dataAttrs: Record<string, string> = {}
  for (const [k, v] of Object.entries(props.datasets || {})) dataAttrs[`data-${k}`] = String(v)
  const openContent = (
    <>
      <span className={`kls-market-icon${props.iconClassName ? ` ${props.iconClassName}` : ''}`} aria-hidden="true" dangerouslySetInnerHTML={{ __html: props.iconHtml || '' }} />
      <div className="kls-market-text">
        <div className="kls-market-name-row">
          <span className="kls-market-name">{props.title}</span>
          {props.subtitle}
          {props.badge}
        </div>
        <div className="kls-market-desc">{props.desc || ''}</div>
      </div>
    </>
  )
  return (
    <div
      className="kls-market-card"
      {...(props.cardKey ? { 'data-card-key': props.cardKey } : {})}
      {...dataAttrs}
    >
      <div className="kls-market-body">
        {props.onOpen ? (
          <button type="button" className="kls-market-open" data-card-open aria-label={props.title} onClick={props.onOpen}>
            {openContent}
          </button>
        ) : <div className="kls-market-open">{openContent}</div>}
        {props.controls != null && <span className="kls-market-controls">{props.controls}</span>}
      </div>
    </div>
  )
}

/** 市场档网格容器（空态兼底同列表容器语汇）。 */
export function MarketGrid({ empty, emptyText, children }: {
  empty: boolean
  emptyText: string
  children: ReactNode
}) {
  if (empty) return <div className="kls-market-empty">{emptyText}</div>
  return <div className="kls-market-grid">{children}</div>
}
