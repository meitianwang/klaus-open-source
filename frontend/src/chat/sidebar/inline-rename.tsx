import React, { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'

export const MAX_SESSION_TITLE_LENGTH = 200
const TITLEBAR_INPUT_MIN_WIDTH_PX = 160
const TITLEBAR_INPUT_CHROME_PX = 22

export type RenameSurface = 'sidebar' | 'titlebar'

export interface ActiveInlineRename {
  id: number
  sessionId: string
  surface: RenameSurface
  rowKey: string | null
  initialValue: string
  placeholder: string
  ariaLabel: string
  onCommit: (sessionId: string, nextTitle: string) => void
  restoreFocus?: () => void
}

let nextRenameId = 0
let activeRename: ActiveInlineRename | null = null
let activeInputEl: HTMLInputElement | null = null
const listeners = new Set<() => void>()

function emitChange(): void {
  for (const listener of Array.from(listeners)) {
    listener()
  }
}

export function subscribeInlineRename(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function getActiveInlineRename(): ActiveInlineRename | null {
  return activeRename
}

export function useInlineRenameForRow(sessionId: string, rowKey: string): ActiveInlineRename | null {
  const current = useSyncExternalStore(subscribeInlineRename, getActiveInlineRename, getActiveInlineRename)
  if (!current || current.surface !== 'sidebar' || current.sessionId !== sessionId) return null
  if (current.rowKey !== null && current.rowKey !== rowKey) return null
  return current
}

export function registerActiveRenameInput(input: HTMLInputElement | null): void {
  activeInputEl = input
}

export function startInlineRename(init: Omit<ActiveInlineRename, 'id'>): ActiveInlineRename {
  if (activeInputEl && typeof activeInputEl.blur === 'function') {
    // Settle any in-progress inline edit via its blur rule before opening another.
    activeInputEl.blur()
  }
  const next: ActiveInlineRename = {
    ...init,
    id: ++nextRenameId,
  }
  activeRename = next
  emitChange()
  return next
}

export function clearActiveInlineRename(renameId?: number): boolean {
  if (!activeRename) return false
  if (renameId !== undefined && activeRename.id !== renameId) return false
  activeRename = null
  activeInputEl = null
  emitChange()
  return true
}

export function cancelInlineRename(options?: { restoreFocus?: boolean }): void {
  const previous = activeRename
  if (!previous) return
  activeRename = null
  activeInputEl = null
  emitChange()
  if (options?.restoreFocus && previous.restoreFocus) {
    scheduleFocusRestore(previous.restoreFocus)
  }
}

export function resetInlineRenameForTests(): void {
  activeRename = null
  activeInputEl = null
  emitChange()
}

function scheduleFocusRestore(restoreFocus: () => void): void {
  const genAtClose = nextRenameId
  const runIfIdle = () => {
    if (nextRenameId !== genAtClose || activeRename !== null) return
    restoreFocus()
  }
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(runIfIdle)
  } else {
    setTimeout(runIfIdle, 0)
  }
}

export function isImeComposingKeyEvent(event: {
  isComposing?: boolean
  keyCode?: number
  which?: number
  nativeEvent?: { isComposing?: boolean; keyCode?: number; which?: number }
}): boolean {
  const native = event.nativeEvent
  return Boolean(
    event.isComposing
    || native?.isComposing
    || event.keyCode === 229
    || native?.keyCode === 229
    || event.which === 229
    || native?.which === 229,
  )
}

export function settleInlineRenameValue(
  rename: ActiveInlineRename,
  rawDraft: string,
  options: { restoreFocus: boolean; cancelled?: boolean },
): void {
  const cleared = clearActiveInlineRename(rename.id)
  if (!cleared) return
  if (!options.cancelled) {
    const trimmed = String(rawDraft || '').trim()
    if (trimmed && trimmed !== rename.initialValue) {
      rename.onCommit(rename.sessionId, trimmed)
    }
  }
  if (options.restoreFocus && rename.restoreFocus) {
    scheduleFocusRestore(rename.restoreFocus)
  }
}

function stopPropagationOnly(event: { stopPropagation(): void }): void {
  event.stopPropagation()
}

let measureCanvasContext: CanvasRenderingContext2D | null | undefined

function measureTitlebarInputWidthPx(input: HTMLInputElement, text: string): number {
  const sample = text || input.placeholder || ''
  let textWidth = 0
  if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    try {
      if (measureCanvasContext === undefined) {
        const canvas = document.createElement('canvas')
        measureCanvasContext = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
      }
      if (measureCanvasContext && typeof window.getComputedStyle === 'function') {
        const computed = window.getComputedStyle(input)
        const font = computed.font || `${computed.fontWeight || '600'} ${computed.fontSize || '13px'} ${computed.fontFamily || 'sans-serif'}`
        measureCanvasContext.font = font
        textWidth = measureCanvasContext.measureText(sample).width
      }
    } catch {
      textWidth = 0
    }
  }
  if (!(textWidth > 0)) {
    let units = 0
    for (const ch of Array.from(sample)) {
      units += (ch.codePointAt(0) ?? 0) > 0x2e7f ? 1.75 : 0.95
    }
    textWidth = units * 8
  }
  return Math.max(TITLEBAR_INPUT_MIN_WIDTH_PX, Math.ceil(textWidth + TITLEBAR_INPUT_CHROME_PX))
}

export function InlineRenameInput({
  rename,
  className,
}: {
  rename: ActiveInlineRename
  className?: string
}) {
  const [draft, setDraft] = useState(rename.initialValue)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const settledRef = useRef(false)
  const composingRef = useRef(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect

  useIsoLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    registerActiveRenameInput(input)
    input.focus({ preventScroll: true })
    if (rename.initialValue.length > 0) {
      input.select()
    }
    const rafId = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => {
          if (!settledRef.current && activeInputEl === input && typeof document !== 'undefined' && document.activeElement !== input) {
            input.focus({ preventScroll: true })
            if (rename.initialValue.length > 0 && draftRef.current === rename.initialValue) {
              input.select()
            }
          }
        })
      : 0
    return () => {
      if (rafId && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(rafId)
      }
      if (activeInputEl === input) {
        registerActiveRenameInput(null)
      }
    }
  }, [rename.id])

  const settle = (options: { restoreFocus: boolean; cancelled?: boolean }) => {
    if (settledRef.current) return
    settledRef.current = true
    settleInlineRenameValue(rename, draftRef.current, options)
  }

  return (
    <input
      ref={inputRef}
      type="text"
      className={className}
      data-inline-rename-input="sidebar"
      data-rename-id={String(rename.id)}
      value={draft}
      maxLength={MAX_SESSION_TITLE_LENGTH}
      placeholder={rename.placeholder}
      aria-label={rename.ariaLabel}
      dir="auto"
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => {
        const next = e.target.value
        draftRef.current = next
        setDraft(next)
      }}
      onCompositionStart={() => {
        composingRef.current = true
      }}
      onCompositionEnd={() => {
        composingRef.current = false
      }}
      onPointerDown={stopPropagationOnly}
      onMouseDown={stopPropagationOnly}
      onClick={stopPropagationOnly}
      onDoubleClick={stopPropagationOnly}
      onContextMenu={stopPropagationOnly}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (composingRef.current || isImeComposingKeyEvent(e)) return
        if (e.key === 'Enter') {
          e.preventDefault()
          settle({ restoreFocus: true })
        } else if (e.key === 'Escape') {
          e.preventDefault()
          settle({ restoreFocus: true, cancelled: true })
        }
      }}
      onBlur={() => {
        settle({ restoreFocus: false })
      }}
    />
  )
}

export function mountTitlebarInlineRenameInput(
  container: HTMLElement,
  rename: ActiveInlineRename,
): HTMLInputElement {
  const existing = container.querySelector<HTMLInputElement>(
    `input[data-inline-rename-input="titlebar"][data-rename-id="${rename.id}"]`,
  )
  if (existing) return existing

  container.replaceChildren()
  container.removeAttribute('title')
  container.toggleAttribute('aria-hidden', false)

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'titlebar-session-title-input'
  input.setAttribute('data-inline-rename-input', 'titlebar')
  input.setAttribute('data-rename-id', String(rename.id))
  input.value = rename.initialValue
  input.maxLength = MAX_SESSION_TITLE_LENGTH
  input.placeholder = rename.placeholder
  input.setAttribute('aria-label', rename.ariaLabel)
  input.dir = 'auto'
  input.spellcheck = false
  input.autocomplete = 'off'

  let settled = false
  let composing = false

  const syncWidth = () => {
    input.style.width = `${measureTitlebarInputWidthPx(input, input.value)}px`
  }

  const settle = (options: { restoreFocus: boolean; cancelled?: boolean }) => {
    if (settled) return
    settled = true
    if (activeInputEl === input) {
      registerActiveRenameInput(null)
    }
    settleInlineRenameValue(rename, input.value, options)
  }

  for (const eventName of ['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu'] as const) {
    input.addEventListener(eventName, (event) => {
      event.stopPropagation()
    })
  }

  input.addEventListener('compositionstart', () => {
    composing = true
  })
  input.addEventListener('compositionend', () => {
    composing = false
    syncWidth()
  })
  input.addEventListener('input', () => {
    syncWidth()
  })
  input.addEventListener('keydown', (event: KeyboardEvent) => {
    event.stopPropagation()
    if (composing || isImeComposingKeyEvent(event)) return
    if (event.key === 'Enter') {
      event.preventDefault()
      settle({ restoreFocus: true })
    } else if (event.key === 'Escape') {
      event.preventDefault()
      settle({ restoreFocus: true, cancelled: true })
    }
  })
  input.addEventListener('blur', () => {
    settle({ restoreFocus: false })
  })

  container.appendChild(input)
  syncWidth()
  registerActiveRenameInput(input)
  input.focus({ preventScroll: true })
  if (rename.initialValue.length > 0) {
    input.select()
  }
  return input
}
