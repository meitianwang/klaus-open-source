// 详情弹窗骨架与正文部件（迁自 js/pages/mcp.js）：MCP / 插件 / 快捷命令
// 三页共用的 DOM 字符串弹窗外壳。mcp-detail-* 类名家族归这里独有，
// 其他页只准调函数拼正文，不准手写类名。
import { t } from '../i18n'
import { icon } from '../icons/registry'

let detailDialogSequence = 0

/** HTML 转义（与 settings.js 的 esc 同实现；空值返空串）。 */
export function escHtml(str: unknown): string {
  return str
    ? String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
    : ''
}

/** Shared modal lifecycle: close affordances, Escape, focus trap and restoration. */
export function wireMcpModalClose(modal: HTMLElement): () => void {
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  let closed = false
  const focusable = () => Array.from(modal.querySelectorAll<HTMLElement>(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
  )).filter(element => !element.hasAttribute('hidden') && element.getAttribute('aria-hidden') !== 'true')
  const closeModal = () => {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKeyDown)
    modal.remove()
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  }
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      closeModal()
      return
    }
    if (event.key !== 'Tab') return
    const elements = focusable()
    if (!elements.length) {
      event.preventDefault()
      modal.querySelector<HTMLElement>('[role="dialog"]')?.focus()
      return
    }
    const first = elements[0]!
    const last = elements[elements.length - 1]!
    const active = document.activeElement
    if (!modal.contains(active)) {
      event.preventDefault()
      ;(event.shiftKey ? last : first).focus()
    } else if (event.shiftKey && active === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && active === last) {
      event.preventDefault()
      first.focus()
    }
  }
  modal.querySelectorAll('[data-close]').forEach(btn => btn.addEventListener('click', closeModal))
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal() })
  document.addEventListener('keydown', onKeyDown)
  ;(focusable()[0] ?? modal.querySelector<HTMLElement>('[role="dialog"]'))?.focus()
  return closeModal
}

export interface McpDetailShellOptions {
  iconHtml?: string
  title?: string
  desc?: string
  bodyHtml?: string
}

export interface McpDetailShellHandle {
  modal: HTMLElement
  closeModal: () => void
  body: HTMLElement | null
}

/**
 * 详情弹窗骨架（居中图标砖 + 标题/描述 + 正文体）：MCP 页各详情弹窗与
 * 插件页/快捷命令页共用的弹窗外壳。
 * 返回 { modal, closeModal, body }，动作绑定由调用方在 modal 上自行挂。
 */
export function openMcpDetailShell({ iconHtml = '', title = '', desc = '', bodyHtml = '' }: McpDetailShellOptions = {}): McpDetailShellHandle {
  const modal = document.createElement('div')
  const titleId = `mcp-detail-title-${++detailDialogSequence}`
  modal.className = 'kls-modal-overlay'
  modal.innerHTML = `
    <div class="kls-modal mcp-detail-card" role="dialog" aria-modal="true" aria-labelledby="${titleId}" tabindex="-1">
      <button class="kls-modal-close mcp-enable-close" data-close aria-label="${escHtml(t('cancel'))}">${icon('close', { size: 18 })}</button>
      <div class="mcp-detail-head">
        <div class="mcp-logo mcp-logo-lg">${iconHtml}</div>
        <h3 class="mcp-enable-title" id="${titleId}">${escHtml(title)}</h3>
        ${desc ? `<p class="mcp-enable-desc">${escHtml(desc)}</p>` : ''}
      </div>
      <div class="mcp-detail-body">${bodyHtml}</div>
    </div>`
  document.body.appendChild(modal)
  const closeModal = wireMcpModalClose(modal)
  return { modal, closeModal, body: modal.querySelector('.mcp-detail-body') }
}

/** 详情弹窗正文部件：告警块（标题 + 逐行明细，插件加载异常这类已经是人话的原文）。 */
export function renderMcpDetailErrorLines(title: string, lines: string[]): string {
  return `<div class="mcp-detail-error">
      <div class="mcp-detail-error-title">${escHtml(title)}</div>
      ${lines.map(line => `<div class="mcp-detail-error-text">${escHtml(line)}</div>`).join('')}
    </div>`
}

export interface McpDetailMetaRow {
  label: string
  value: string
  mono?: boolean
}

/** 详情弹窗正文部件：标签-值 meta 网格（空项容忍 —— 调用方惯用 filter(Boolean)，TS 不收窄）。 */
export function renderMcpDetailMetaGrid(rows: Array<McpDetailMetaRow | null | undefined | false>): string {
  const cleanRows = rows.filter((row): row is McpDetailMetaRow => !!row)
  if (!cleanRows.length) return ''
  return `<div class="mcp-row-detail">${cleanRows.map(row =>
    `<span class="mcp-meta-label">${escHtml(row.label)}</span><span class="mcp-meta-value ${row.mono ? 'mcp-meta-mono' : ''}">${escHtml(row.value) || '—'}</span>`,
  ).join('')}</div>`
}

/** 详情弹窗正文部件：尾部动作按钮栏（按钮自身用 kls-* 套件）。 */
export function renderMcpDetailActions(buttonsHtml: string): string {
  return buttonsHtml ? `<div class="mcp-detail-actions">${buttonsHtml}</div>` : ''
}
