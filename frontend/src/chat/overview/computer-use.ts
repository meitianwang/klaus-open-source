import { tt } from '../../app/i18n'
import { icon } from '../../icons/registry'
import { browserPanelHidesPip, computerUsePipError, computerUsePipState, currentPipSession, initComputerUsePip, setComputerUsePipVisibility, subscribeComputerUsePip } from '../computer-use-pip'
import { pipTaskActive, pipTaskShown } from '../computer-use-pip-model'
import styles from './computer-use.module.css'

let disposeMenu: (() => void) | null = null
let initialized = false

export function computerUseSummaryVisible(root: Pick<Document, 'hidden' | 'body' | 'querySelector' | 'getElementById'> = document): boolean {
  if (root.hidden || root.body.classList.contains('non-chat-view') || root.body.classList.contains('settings-open')) return false
  if (root.querySelector('#diff-view.active, #workspace-main-view.active')) return false
  const panel = root.getElementById('artifacts-panel')
  return panel !== null && panel.getAttribute('data-mode') === 'monitor' && !panel.classList.contains('collapsed')
}

/** A portal must not retain its old screen position when its anchor moves. */
export function bindPipMenuPositionDismissal(close: () => void, root: EventTarget = document, viewport: EventTarget = window): () => void {
  root.addEventListener('scroll', close, true)
  viewport.addEventListener('resize', close)
  return () => {
    root.removeEventListener('scroll', close, true)
    viewport.removeEventListener('resize', close)
  }
}

export function initComputerUseSection(): void {
  if (initialized) return
  initialized = true
  subscribeComputerUsePip(renderComputerUseSection)
  initComputerUsePip()
}

function openHideMenu(trigger: HTMLButtonElement, sessionId: string): void {
  disposeMenu?.()
  const menu = document.createElement('div')
  menu.className = styles.menu
  menu.id = 'computer-use-pip-hide-menu'
  menu.setAttribute('role', 'menu')
  menu.setAttribute('aria-label', tt('computer_use_pip_hide_label'))
  menu.setAttribute('data-pip-obstacle', 'visibility-menu')
  trigger.setAttribute('aria-expanded', 'true')
  trigger.setAttribute('aria-controls', menu.id)
  const buttons = (['task', 'all'] as const).map(scope => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = styles['menu-item']
    button.setAttribute('role', 'menuitem')
    button.textContent = tt(scope === 'task' ? 'computer_use_pip_hide_task' : 'computer_use_pip_hide_all')
    button.addEventListener('click', () => {
      close(true)
      void setComputerUsePipVisibility({ scope, sessionId: scope === 'task' ? sessionId : undefined, visible: false })
    })
    menu.appendChild(button)
    return button
  })
  document.body.appendChild(menu)
  const rect = trigger.getBoundingClientRect()
  menu.style.left = `${Math.max(8, Math.min(rect.right - menu.offsetWidth, window.innerWidth - menu.offsetWidth - 8))}px`
  menu.style.top = `${rect.bottom + menu.offsetHeight + 6 < window.innerHeight ? rect.bottom + 6 : Math.max(8, rect.top - menu.offsetHeight - 6)}px`
  const unbindPositionChanges = bindPipMenuPositionDismissal(() => close())

  function close(restoreFocus = false): void {
    menu.remove()
    trigger.setAttribute('aria-expanded', 'false')
    trigger.removeAttribute('aria-controls')
    document.removeEventListener('pointerdown', outside, true)
    document.removeEventListener('keydown', keyboard, true)
    unbindPositionChanges()
    disposeMenu = null
    if (restoreFocus && trigger.isConnected) trigger.focus()
  }
  function outside(event: PointerEvent): void {
    if (event.target instanceof Node && !menu.contains(event.target) && !trigger.contains(event.target)) close()
  }
  function keyboard(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(true); return }
    if (event.key === 'Tab') { close(); return }
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    let next: number | null = null
    if (event.key === 'ArrowDown') next = (current + 1) % buttons.length
    if (event.key === 'ArrowUp') next = (current - 1 + buttons.length) % buttons.length
    if (event.key === 'Home') next = 0
    if (event.key === 'End') next = buttons.length - 1
    if (next !== null) { event.preventDefault(); buttons[next].focus() }
  }
  document.addEventListener('pointerdown', outside, true)
  document.addEventListener('keydown', keyboard, true)
  disposeMenu = close
  buttons[0].focus()
}

export function renderComputerUseSection(): void {
  // Closing the summary does not change task activity. Dismiss its body portal
  // before checking the task render key, including host-driven route changes.
  if (!computerUseSummaryVisible()) disposeMenu?.()
  const section = document.getElementById('monitor-section-computer-use')
  const body = document.getElementById('monitor-computer-use-body')
  if (!section || !body) return
  const state = computerUsePipState()
  const sessionId = currentPipSession()
  const active = pipTaskActive(state, sessionId) && !browserPanelHidesPip()
  const shown = pipTaskShown(state, sessionId)
  const error = computerUsePipError()
  const key = JSON.stringify([sessionId, active, shown, error, tt('computer_use_pip_label')])
  if (body.dataset.renderKey === key) return
  body.dataset.renderKey = key
  disposeMenu?.()
  section.hidden = !active
  body.replaceChildren()
  if (!active || !sessionId) return
  const row = document.createElement('div')
  row.className = styles.row
  const leading = document.createElement('span')
  leading.className = styles.icon
  leading.setAttribute('aria-hidden', 'true')
  leading.innerHTML = icon('computer-use-pip')
  const label = document.createElement('span')
  label.className = styles.label
  label.textContent = tt('computer_use_pip_label')
  const action = document.createElement('button')
  action.type = 'button'
  action.className = styles.action
  action.textContent = tt(shown ? 'computer_use_pip_hide' : 'computer_use_pip_show')
  action.setAttribute('aria-label', tt(shown ? 'computer_use_pip_hide_label' : 'computer_use_pip_show_label'))
  if (shown) {
    action.setAttribute('aria-haspopup', 'menu')
    action.setAttribute('aria-expanded', 'false')
    action.addEventListener('click', () => {
      if (disposeMenu) disposeMenu()
      else openHideMenu(action, sessionId)
    })
  } else {
    action.addEventListener('click', () => { void setComputerUsePipVisibility({ scope: 'task', sessionId, visible: true }) })
  }
  row.append(leading, label, action)
  body.appendChild(row)
  if (error) {
    const notice = document.createElement('div')
    notice.className = styles.error
    notice.setAttribute('role', 'status')
    notice.textContent = error
    body.appendChild(notice)
  }
}
