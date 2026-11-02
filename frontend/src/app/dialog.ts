// Klaus Desktop — Custom dialog (replaces native confirm/alert)
// DO NOT use window.confirm / window.alert / window.prompt in the renderer.
// Use klausDialog.confirm({...}) / klausDialog.alert({...}) instead.
//（迁自 js/dialog.js，逻辑原样。）
import { icon } from '../icons/registry'

const ESC_MAP: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC_MAP[c])
const tt = (k: string, fb?: string) => {
  const v = (window as any).tt ? (window as any).tt(k) : k
  return v === k ? (fb ?? k) : v
}

interface DialogOptions {
  type?: 'confirm' | 'alert' | 'prompt'
  title?: string
  message?: string
  detail?: string
  variant?: '' | 'error'
  confirmText?: string
  cancelText?: string
  danger?: boolean
  checkbox?: { label: string; defaultChecked?: boolean } | null
  placeholder?: string
  initialValue?: string
  selectInitialValue?: boolean
  multiline?: boolean
  rows?: number
  inputClassName?: string
  /**
   * Async confirmation handler. When provided, the dialog stays open while the
   * handler runs, disables both buttons, and shows a spinner on the confirm
   * button. The dialog only closes if the handler resolves to `true`; resolving
   * to `false` leaves the dialog open so the user can retry or cancel.
   */
  onConfirm?: (value: string, checked: boolean) => Promise<boolean>
  signal?: AbortSignal
}

function ensureRoot() {
  let root = document.getElementById('klaus-dialog-root')
  if (!root) {
    root = document.createElement('div')
    root.id = 'klaus-dialog-root'
    document.body.appendChild(root)
  }
  return root
}

function openDialog(opts: DialogOptions): Promise<any> {
  if (opts.signal?.aborted) return Promise.resolve(opts.type === 'prompt' ? null : false)
  const {
    type = 'confirm', // 'confirm' | 'alert' | 'prompt'
    title = '',
    message = '',
    detail = '', // technical detail (raw error output) — de-emphasized mono block
    variant = '', // '' | 'error' — error renders a red status icon beside the title
    confirmText,
    cancelText,
    danger = false,
    checkbox = null, // { label: string, defaultChecked?: boolean } — when set, confirm result is { confirmed, checked }
    placeholder = '',
    initialValue = '',
    multiline = false,
  } = opts || {}

  return new Promise((resolve) => {
    const root = ensureRoot()
    const overlay = document.createElement('div')
    overlay.className = 'klaus-dialog-overlay'

    const okFallback = danger ? tt('delete_title', 'Delete') : tt('dialog_ok', 'OK')
    const ct = esc(confirmText ?? okFallback)
    const cx = esc(cancelText ?? tt('cancel', 'Cancel'))
    const checkboxId = checkbox ? `klaus-dialog-cb-${Math.random().toString(36).slice(2, 8)}` : ''
    const inputId = type === 'prompt' ? `klaus-dialog-input-${Math.random().toString(36).slice(2, 8)}` : ''

    const errorIcon = variant === 'error'
      ? `<span class="klaus-dialog-title-icon" aria-hidden="true">${icon('klaus-dialog-title')}</span>`
      : ''
    // 勾选框自绘：原生 checkbox 只留焦点与语义（透明铺满整行），
    // 视觉由 box + 勾形字形承担，勾选态跟随主题 accent。
    // input 内嵌在 label 里已是隐式关联，不能再写 for：那会让一次点击
    // 被 input 自己和 label 转发各翻一次，勾选态看上去根本不变。
    const checkGlyph = icon('check-glyph')

    overlay.innerHTML = `
      <div class="klaus-dialog-backdrop"></div>
      <div class="klaus-dialog-card" role="dialog" aria-modal="true">
        ${title ? `<div class="klaus-dialog-title">${errorIcon}<span>${esc(title)}</span></div>` : ''}
        ${message ? `<div class="klaus-dialog-message">${esc(message)}</div>` : ''}
        ${detail ? `<div class="klaus-dialog-detail">${esc(detail)}</div>` : ''}
        ${type === 'prompt' ? (
          multiline
            ? `<textarea class="klaus-dialog-input klaus-dialog-textarea ${esc(opts.inputClassName || '')}" rows="${opts.rows || 5}" id="${inputId}" placeholder="${esc(placeholder)}">${esc(initialValue)}</textarea>`
            : `<input class="klaus-dialog-input" id="${inputId}" type="text" placeholder="${esc(placeholder)}" value="${esc(initialValue)}" />`
        ) : ''}
        ${checkbox ? `
          <label class="klaus-dialog-checkbox">
            <input class="klaus-dialog-checkbox-input" type="checkbox" id="${checkboxId}" ${checkbox.defaultChecked ? 'checked' : ''} />
            <span class="klaus-dialog-checkbox-box" aria-hidden="true">${checkGlyph}</span>
            <span class="klaus-dialog-checkbox-text">${esc(checkbox.label || '')}</span>
          </label>
        ` : ''}
        <div class="klaus-dialog-footer">
          ${type === 'confirm' || type === 'prompt' ? `<button class="klaus-dialog-btn klaus-dialog-cancel" type="button">${cx}</button>` : ''}
          <button class="klaus-dialog-btn klaus-dialog-confirm${danger ? ' klaus-dialog-danger' : ''}" type="button">${ct}</button>
        </div>
      </div>
    `
    root.appendChild(overlay)
    requestAnimationFrame(() => overlay.classList.add('active'))

    const cb = checkbox ? overlay.querySelector<HTMLInputElement>(`#${checkboxId}`) : null
    const field = type === 'prompt' ? overlay.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${inputId}`) : null

    let closed = false
    const close = (confirmed: boolean | undefined) => {
      if (closed || submitting) return
      closed = true
      overlay.classList.remove('active')
      document.removeEventListener('keydown', onKey, true)
      opts.signal?.removeEventListener('abort', onAbort)
      setTimeout(() => overlay.remove(), 160)
      if (checkbox && type === 'confirm') {
        resolve({ confirmed, checked: !!(confirmed && cb?.checked) })
      } else if (type === 'prompt') {
        resolve(confirmed ? (field?.value ?? '') : null)
      } else {
        resolve(confirmed)
      }
    }
    const cancelValue = type === 'confirm' ? false : type === 'prompt' ? false : undefined
    const confirmValue = type === 'confirm' || type === 'prompt' ? true : undefined

    let submitting = false
    const submit = async () => {
      if (submitting || closed) return
      if (!opts.onConfirm) { close(confirmValue); return }
      submitting = true
      const confirmBtn = overlay.querySelector<HTMLButtonElement>('.klaus-dialog-confirm')!
      const cancelBtn = overlay.querySelector<HTMLButtonElement>('.klaus-dialog-cancel')
      confirmBtn.disabled = true
      cancelBtn && (cancelBtn.disabled = true)
      confirmBtn.classList.add('klaus-dialog-loading')
      const originalContent = confirmBtn.innerHTML
      const spinner = document.createElement('span')
      spinner.className = 'klaus-dialog-spinner'
      spinner.setAttribute('aria-hidden', 'true')
      confirmBtn.prepend(spinner)
      try {
        const ok = await opts.onConfirm(field?.value || '', !!cb?.checked)
        if (ok) {
          // Release the in-flight guard before closing: close() deliberately
          // refuses while submitting so Escape/backdrop cannot dismiss a
          // request that is still running.
          submitting = false
          close(confirmValue)
        }
      } finally {
        submitting = false
        confirmBtn.disabled = false
        cancelBtn && (cancelBtn.disabled = false)
        confirmBtn.classList.remove('klaus-dialog-loading')
        confirmBtn.innerHTML = originalContent
      }
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(cancelValue) }
      else if (e.key === 'Enter') {
        if (type === 'prompt' && multiline && !e.metaKey && !e.ctrlKey) return
        e.preventDefault(); e.stopPropagation(); void submit()
      }
    }
    document.addEventListener('keydown', onKey, true)
    const onAbort = () => close(cancelValue)
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    if (opts.signal?.aborted) onAbort()

    overlay.querySelector('.klaus-dialog-backdrop')!.addEventListener('click', () => close(cancelValue))
    overlay.querySelector('.klaus-dialog-confirm')!.addEventListener('click', () => { void submit() })
    overlay.querySelector('.klaus-dialog-cancel')?.addEventListener('click', () => close(false))

    setTimeout(() => {
      if (field) {
        field.focus()
        // Rename selects the existing value; editing longer text can append.
        if (opts.selectInitialValue === false) field.setSelectionRange(field.value.length, field.value.length)
        else if (field.value) field.select()
      } else if (danger) {
        // 破坏性确认框把初始焦点给取消：打开就聚焦到红按钮，一下空格
        // 就把东西删了，焦点环也正好套在本就最重的那颗按钮上。
        // Enter 确认由键盘处理器接管，不依赖焦点落在哪颗按钮。
        ;(overlay.querySelector<HTMLElement>('.klaus-dialog-cancel') || overlay.querySelector<HTMLElement>('.klaus-dialog-confirm'))?.focus()
      } else {
        overlay.querySelector<HTMLElement>('.klaus-dialog-confirm')?.focus()
      }
    }, 0)
  })
}

function normalize(input: unknown, extra?: Record<string, unknown>) {
  if (input && typeof input === 'object' && !Array.isArray(input)) return { ...input, ...(extra || {}) }
  return { message: String(input ?? ''), ...(extra || {}) }
}

;(window as any).klausDialog = {
  confirm: (input: unknown, extra?: Record<string, unknown>) => openDialog({ type: 'confirm', ...normalize(input, extra) }),
  alert: (input: unknown, extra?: Record<string, unknown>) => openDialog({ type: 'alert', ...normalize(input, extra) }),
  prompt: (input: unknown, extra?: Record<string, unknown>) => openDialog({ type: 'prompt', ...normalize(input, extra) }),
}
