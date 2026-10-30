// 连接器条目弹窗的统一外壳。
//
// 一页里点开任何一个条目——市场里的服务、已安装的服务、项目里的服务、内置连接器
// 组、浏览器、电脑操控——弹出来的都得是同一张卡：双砖 hero + 中缝状态徽 + 状态化
// 标题 + 一句话 + 内容区 + 底部全宽动作。以前这里有两套版式（hero 版的启停弹窗和
// 480px 单砖的详情弹窗），同一页里点两个条目弹出两种东西。
//
// 内容区按条目类型不同（安心栏 / 工具明细 / 连接状态 / 凭据表单）是允许的，外壳
// 不许不同。
import { Fragment, useEffect, useId, useRef } from 'react'
import type { ReactNode, RefObject } from 'react'
import { useT } from '../../i18n'
import { rawIconHtml } from '../../components/Icon'
import styles from './mcp.module.css'

/// hero 中缝状态徽：ⱆ 待安装 / 虚线圆 已装未启用 / 绿底白勾 已启用 / 红底白叉 失败。
/// `checking` 留白——状态是探测出来的，探测没回来时中缝不押注哪一边。
const STATE_BADGE_ICON: Record<string, string> = {
  install: 'install-3',
  off: 'off-2',
  on: 'on-2',
  failed: 'failed-2',
}

export type EntryModalState = 'install' | 'off' | 'on' | 'failed' | 'checking'

/// 安心栏三行的图标：工具 / 盾 / 人形，细线描边同连接器视觉语言。
const POINT_ICONS = [
  'mcp-handle-mcp-market-action',
  'mcp-handle-mcp-market-action-2',
  'mcp-assure-person',
]

/**
 * 安心栏：三条「这东西会做什么、守什么规矩、你怎么收回」。标题三页共用一套
 * （同一件事只有一种说法），描述由各条目给自己的话。
 */
export function EntryPoints({ descKeys }: { descKeys: [string, string, string] }) {
  const t = useT()
  return (
    <div className={styles['mcp-enable-points']}>
      {descKeys.map((descKey, index) => (
        <div className={styles['mcp-enable-point']} key={descKey}>
          <span
            className={styles['mcp-enable-point-icon']}
            dangerouslySetInnerHTML={{ __html: rawIconHtml(POINT_ICONS[index] || '') }}
          />
          <div className="mcp-enable-point-text">
            <div className={styles['mcp-enable-point-title']}>{t(`mcp_enable_point${index + 1}_title`)}</div>
            <div className={styles['mcp-enable-point-desc']}>{t(descKey)}</div>
          </div>
        </div>
      ))}
    </div>
  )
}

export function EntryModal({ entryIconHtml, state, title, desc, children, actions, footer, onClose, closeDisabled = false, bodyRef }: {
  /// 条目自己的砖（服务图标 / 能力图标）。Klaus 砖由外壳固定摆左边。
  entryIconHtml: string
  state: EntryModalState
  title: string
  desc?: string
  children?: ReactNode
  /// 底部动作：全宽按钮，从上到下排。主动作在最上面。
  actions?: ReactNode
  /// 动作之下的一句补充（授权提示这类），不是按钮。
  footer?: ReactNode
  onClose: () => void
  closeDisabled?: boolean
  /// 市场弹窗要在正文里收集 env 输入，所以正文节点可以借出去。
  bodyRef?: RefObject<HTMLDivElement | null>
}) {
  const t = useT()
  const titleId = useId()
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  const closeDisabledRef = useRef(closeDisabled)
  onCloseRef.current = onClose
  closeDisabledRef.current = closeDisabled
  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    dialog?.querySelector<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        if (!closeDisabledRef.current) onCloseRef.current()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
        .filter(element => !element.hidden && element.getClientRects().length > 0)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      previousFocus?.focus()
    }
  }, [])
  return (
    <div className="kls-modal-overlay" onClick={e => { if (e.target === e.currentTarget && !closeDisabled) onClose() }}>
      <div
        ref={dialogRef}
        className={`kls-modal ${styles['mcp-enable-card']} ${styles['mcp-form-modal']}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <button
          className="kls-modal-close mcp-enable-close" aria-label={t('cancel')} onClick={onClose} disabled={closeDisabled}
          dangerouslySetInnerHTML={{ __html: rawIconHtml('close', { size: 18 }) }}
        />
        <div className={styles['mcp-enable-body']} data-state-body ref={bodyRef}>
          <div className={styles['mcp-state-hero']}>
            <div className="mcp-logo mcp-logo-lg" dangerouslySetInnerHTML={{ __html: rawIconHtml('mcp-klaus-brand-glyph') }} />
            <span
              className={`${styles['mcp-state-badge']} is-${state}`}
              dangerouslySetInnerHTML={{ __html: STATE_BADGE_ICON[state] ? rawIconHtml(STATE_BADGE_ICON[state]) : '' }}
            />
            <div className="mcp-logo mcp-logo-lg" dangerouslySetInnerHTML={{ __html: entryIconHtml }} />
          </div>
          <h3 className="mcp-enable-title" id={titleId}>{title}</h3>
          {desc ? <p className="mcp-enable-desc">{desc}</p> : null}
          {children}
          {actions ? <div className={styles['mcp-state-actions']}>{actions}</div> : null}
          {footer}
        </div>
      </div>
    </div>
  )
}

/** 全宽动作按钮：弹窗底部动作只有这一种形状。 */
export function EntryAction({ kind = 'primary', disabled, onClick, children, id }: {
  kind?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean
  onClick: () => void
  children: ReactNode
  id?: string
}) {
  const tone = kind === 'secondary' ? 'kls-submit-secondary' : kind === 'danger' ? styles['kls-submit-danger-soft'] : ''
  return (
    <button className={`kls-submit-btn ${tone} ${styles['mcp-enable-cta']}`} id={id} disabled={disabled} onClick={onClick}>
      {children}
    </button>
  )
}

export interface EntryTool {
  name: string
  description?: string
  exposure?: string
  enabled?: boolean
  approval?: string
}

/**
 * 工具明细列表。
 *
 * 每个工具的三档控件跨两个存储，因为它们回答两个不同的问题：`off` 写服务自己的
 * disabledTools（引擎在 tools/list 之前就把工具丢掉，模型根本看不到），`ask` 写
 * 一条落在完整名 `mcp__<server>__<tool>` 上的权限规则（工具仍可见，引擎每次调用
 * 前停下来问）。所以切到 `ask` 必须同时清掉 disabled 项，否则规则就落在一个永远
 * 不会跑的工具上。写失败以重载为准——失败就说失败，不留一个骗人的控件。
 */
export function EntryToolsList({ tools, toolCount, toggleServer, onChanged }: {
  tools?: EntryTool[]
  toolCount: number
  /// 给了服务名才有三档控件。插件贡献的服务写不进 per-tool 开关，所以只读。
  toggleServer?: string
  onChanged?: () => void
}) {
  const t = useT()
  const w = () => window as any
  const rawName = (name: string): string => {
    const prefix = toggleServer ? `mcp__${toggleServer}__` : ''
    return prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name
  }

  const onModeChange = async (toolName: string, mode: string, select: HTMLSelectElement, previous: string) => {
    const fullName = `mcp__${toggleServer}__${toolName}`
    select.disabled = true
    const fail = (message?: string) => {
      select.value = previous
      select.disabled = false
      w().showToast(message || t('settings_failed'))
    }
    let enabledChanged = false
    try {
      // The enabled state lands first because both `auto` and `ask` require the
      // tool to remain visible to the engine.
      const enabled = await w().klaus.mcp.setToolEnabled(toggleServer, toolName, mode !== 'off')
      if (enabled?.ok !== true) throw new Error(enabled?.error || t('settings_failed'))
      enabledChanged = true
      const rule = mode === 'ask'
        ? await w().klaus.settings.permissions.add({ toolName: fullName, behavior: 'ask' })
        : await w().klaus.settings.permissions.delete({ toolName: fullName, behavior: 'ask' })
      if (rule?.ok !== true) throw new Error(rule?.error || t('settings_failed'))
      onChanged?.()
    } catch (error) {
      if (enabledChanged) {
        await w().klaus.mcp.setToolEnabled(toggleServer, toolName, previous !== 'off').catch(() => undefined)
      }
      fail(error instanceof Error ? error.message : String(error || ''))
    } finally {
      if (document.contains(select)) select.disabled = false
    }
  }

  return (
    <div className={'mcp-tools-block'}>
      <div className={'mcp-tools-header'}>{t('mcp_tools_header').replace('{n}', String(toolCount))}</div>
      <div className={'mcp-tools-list'}>
        {tools?.length
          ? tools.map(tool => {
              // 暴露态徽标：模型能不能看见这个工具。
              const badge = tool.exposure === 'deferred'
                ? <span className={`${'mcp-tool-badge'} ${'mcp-tool-badge-deferred'}`}>deferred</span>
                : tool.exposure === 'hidden'
                  ? <span className={`${'mcp-tool-badge'} ${'mcp-tool-badge-hidden'}`}>hidden</span>
                  : null
              // 停用优先显示：一个被关掉的工具压根不跑，那么还挂在它上面的 ask
              // 规则不是这一行该说的话。
              const mode = tool.enabled === false ? 'off' : tool.approval === 'ask' ? 'ask' : 'auto'
              return (
                <div className={`${'mcp-tool-item'}${toggleServer && mode === 'off' ? ' ' + 'mcp-tool-item-off' : ''}`} key={tool.name}>
                  <div className={'mcp-tool-name'}>{tool.name}{badge}</div>
                  {tool.description ? <div className={'mcp-tool-desc'}>{tool.description}</div> : null}
                  {toggleServer ? (
                    <select
                      className={`kls-select-native ${'mcp-tool-mode'}`} defaultValue={mode}
                      aria-label={t('mcp_tool_approval_title')}
                      onChange={e => {
                        void onModeChange(rawName(tool.name), e.target.value, e.currentTarget, mode)
                      }}
                    >
                      <option value="auto">{t('mcp_tool_approval_auto')}</option>
                      <option value="ask">{t('mcp_tool_approval_ask')}</option>
                      <option value="off">{t('mcp_tool_approval_off')}</option>
                    </select>
                  ) : null}
                </div>
              )
            })
          : <div className={'mcp-tool-empty'}>{t('mcp_empty_tools')}</div>}
      </div>
    </div>
  )
}

/** 标签-值明细（Type / Target 这类），一行一对。 */
export function EntryMetaGrid({ rows }: { rows: Array<{ label: string; value: string; mono?: boolean } | null | false> }) {
  const clean = rows.filter((row): row is { label: string; value: string; mono?: boolean } => !!row)
  if (!clean.length) return null
  return (
    <div className="mcp-row-detail">
      {clean.map(row => (
        <Fragment key={row.label}>
          <span className="mcp-meta-label">{row.label}</span>
          <span className={`mcp-meta-value${row.mono ? ' mcp-meta-mono' : ''}`}>{row.value || '—'}</span>
        </Fragment>
      ))}
    </div>
  )
}
