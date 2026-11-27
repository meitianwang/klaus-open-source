// Bottom-docked composer pill and expandable floating composer card for the
// maximized right-side work panel (`body.artifacts-maximized`).
//
// Re-docks the single shared `#input-wrapper` instead of mounting a second
// composer instance, so ProseMirror state, attachments, slash/@ menus, model
// and permission pickers, follow-up queues, and voice dictation stay intact.
// Mounted as a sibling of `#artifacts-panel` inside `#app` so the panel's
// `[data-klaus-tooltips="off"]` observer never strips composer attributes.

export type MaximizedComposerWaitKind = 'approval' | 'input'

export interface MaximizedComposerEligibilityInput {
  panelMaximized: boolean
  panelOpen: boolean
  panelMode: string
  inChatSurface: boolean
  archivedSession: boolean
}

export type MaximizedComposerPillKind = 'idle' | 'draft' | 'running' | 'attention' | 'unread'
export type MaximizedComposerTrailingAction = 'stop' | 'view-reply' | 'review' | null

export interface MaximizedComposerUnreadReply {
  sessionId: string
  preview: string
}

export interface MaximizedComposerPillStateInput {
  waitCount: number
  waitKind: MaximizedComposerWaitKind
  unreadReply: MaximizedComposerUnreadReply | null
  running: boolean
  runningLabel: string | null
  draftText: string
  attachmentCount: number
  t: (key: string) => string
  tCount: (key: string, count: number) => string
}

export interface MaximizedComposerPillState {
  kind: MaximizedComposerPillKind
  leading: 'chat' | 'pencil' | 'spinner' | 'warning-dot' | 'info-dot'
  text: string
  trailingAction: MaximizedComposerTrailingAction
  trailingLabel: string
}

const COMPOSER_PORTAL_POPUP_SELECTOR = [
  '.kls-select-panel',
  '.slash-menu',
  '.ctx-pop',
  '.project-picker-popover',
  '[role="dialog"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[aria-modal="true"]',
  'dialog',
  '.klaus-dialog-overlay',
  '.kls-modal-overlay',
  '.image-preview-overlay',
  '.follow-up-full-preview',
].join(',')

const CHAT_ICON_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3.2 3.5h9.6c.77 0 1.4.63 1.4 1.4v5.2c0 .77-.63 1.4-1.4 1.4H6.6l-2.95 2.15a.4.4 0 0 1-.65-.32V11.5h.2c-.99 0-1.4-.63-1.4-1.4V4.9c0-.77.63-1.4 1.4-1.4Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>'
const PENCIL_ICON_SVG = '<svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M11.35 2.65a1.2 1.2 0 0 1 1.7 1.7l-7.1 7.1-2.55.65.65-2.55 7.3-6.9Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>'
const STOP_ICON_SVG = '<svg width="10" height="10" viewBox="0 0 12 12" fill="none" aria-hidden="true"><rect x="2.2" y="2.2" width="7.6" height="7.6" rx="1.6" fill="currentColor"/></svg>'
const CHEVRON_DOWN_SVG = '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M4.25 6.25 8 10l3.75-3.75" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>'

export function isMaximizedComposerEligible(input: MaximizedComposerEligibilityInput): boolean {
  if (!input.panelMaximized || !input.panelOpen) return false
  if (input.panelMode === 'side-chat') return false
  if (!input.inChatSurface || input.archivedSession) return false
  return true
}

export function truncateSingleLine(raw: string, maxChars = 60): string {
  const collapsed = String(raw || '').replace(/\s+/g, ' ').trim()
  if (!collapsed) return ''
  if (collapsed.length <= maxChars) return collapsed
  return `${collapsed.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`
}

export function extractReplyPreviewLine(raw: string, maxChars = 56): string {
  const lines = String(raw || '').split(/\r?\n/)
  let inFence = false
  for (const rawLine of lines) {
    const trimmed = rawLine.trim()
    if (trimmed.startsWith('```')) {
      inFence = !inFence
      continue
    }
    if (inFence || !trimmed || trimmed.startsWith('::')) continue
    const cleaned = trimmed
      .replace(/^(?:#{1,6}\s+|[-*+]\s+|\d+\.\s+|>\s+)/, '')
      .replace(/`+/g, '')
      .replace(/\*\*([^*]+)\*\*/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
    if (!cleaned) continue
    return truncateSingleLine(cleaned, maxChars)
  }
  return ''
}

export function deriveMaximizedComposerPillState(
  input: MaximizedComposerPillStateInput,
): MaximizedComposerPillState {
  const { t, tCount } = input
  if (input.waitCount > 0) {
    if (input.waitKind === 'input') {
      return {
        kind: 'attention',
        leading: 'warning-dot',
        text: t('maximized_composer_has_question'),
        trailingAction: null,
        trailingLabel: '',
      }
    }
    return {
      kind: 'attention',
      leading: 'warning-dot',
      text: t('maximized_composer_needs_approval'),
      trailingAction: 'review',
      trailingLabel: t('maximized_composer_review'),
    }
  }

  if (input.unreadReply) {
    const preview = input.unreadReply.preview
    return {
      kind: 'unread',
      leading: 'info-dot',
      text: preview
        ? t('maximized_composer_reply_with_preview').replace('{preview}', preview)
        : t('maximized_composer_reply_ready'),
      trailingAction: 'view-reply',
      trailingLabel: t('maximized_composer_view_reply'),
    }
  }

  if (input.running) {
    return {
      kind: 'running',
      leading: 'spinner',
      text: input.runningLabel || t('voice_chat_thinking'),
      trailingAction: 'stop',
      trailingLabel: t('maximized_composer_stop'),
    }
  }

  const trimmedDraft = truncateSingleLine(input.draftText, 60)
  if (trimmedDraft || input.attachmentCount > 0) {
    const parts = [t('maximized_composer_draft')]
    if (trimmedDraft) parts.push(trimmedDraft)
    if (input.attachmentCount > 0) parts.push(tCount('follow_up_summary_files', input.attachmentCount))
    return {
      kind: 'draft',
      leading: 'pencil',
      text: parts.join(' · '),
      trailingAction: null,
      trailingLabel: '',
    }
  }

  return {
    kind: 'idle',
    leading: 'chat',
    text: t('maximized_composer_placeholder'),
    trailingAction: null,
    trailingLabel: '',
  }
}

export interface MaximizedComposerDeps {
  appRoot: HTMLElement
  artifactsPanel: HTMLElement
  inputWrapper: HTMLElement
  inputEl: HTMLElement & { value?: string; selectionStart?: number; selectionEnd?: number; setSelectionRange?: (start: number, end: number) => void }
  currentSessionId: () => string | null
  inChatSurface: () => boolean
  isArchivedSession: () => boolean
  waitState: (sessionId: string) => { count: number; kind: MaximizedComposerWaitKind }
  isRunning: () => boolean
  runningLabel: () => string | null
  draftText: () => string
  attachmentCount: () => number
  isVoiceActive: () => boolean
  hasOpenComposerOverlay: () => boolean
  restoreHomeDock: () => void
  restoreSplitPanel: () => void
  scrollTranscriptToBottom: () => void
  stopTurn: () => void
  onExpand?: () => void
  onDropFiles?: (files: File[]) => void
  t: (key: string) => string
  tCount: (key: string, count: number) => string
}

export interface MaximizedComposerController {
  refresh: () => void
  isEligible: () => boolean
  isExpanded: () => boolean
  ownsComposerDock: () => boolean
  expand: (options?: { focusInput?: boolean }) => boolean
  collapse: (options?: { restoreFocusToPill?: boolean }) => void
  handleEscape: () => boolean
  noteSubmitted: () => void
  noteTurnCompleted: (sessionId: string, replyText: string) => void
  clearUnread: (sessionId?: string | null) => void
  dispose: () => void
}

export function mountMaximizedComposer(deps: MaximizedComposerDeps): MaximizedComposerController {
  const doc = deps.appRoot.ownerDocument
  const win = doc.defaultView
  let expanded = false
  let unreadBySession = new Map<string, string>()
  let dragDepth = 0

  const root = doc.createElement('div')
  root.id = 'maximized-composer-root'
  root.className = 'maximized-composer-root'
  root.hidden = true

  const park = doc.createElement('div')
  park.id = 'maximized-composer-park'
  park.hidden = true
  park.setAttribute('aria-hidden', 'true')

  const strip = doc.createElement('div')
  strip.className = 'maximized-composer-strip'

  const pill = doc.createElement('div')
  pill.className = 'maximized-composer-pill'
  pill.dataset.pillState = 'idle'

  const pillTrigger = doc.createElement('button')
  pillTrigger.type = 'button'
  pillTrigger.className = 'maximized-composer-pill-trigger'

  const pillLead = doc.createElement('span')
  pillLead.className = 'maximized-composer-pill-lead'
  pillLead.setAttribute('aria-hidden', 'true')

  const pillText = doc.createElement('span')
  pillText.className = 'maximized-composer-pill-text'
  pillText.setAttribute('aria-live', 'polite')

  pillTrigger.append(pillLead, pillText)

  const pillAction = doc.createElement('button')
  pillAction.type = 'button'
  pillAction.className = 'maximized-composer-pill-action'
  pillAction.hidden = true

  pill.append(pillTrigger, pillAction)
  strip.appendChild(pill)

  const card = doc.createElement('div')
  card.className = 'maximized-composer-card'
  card.hidden = true
  card.setAttribute('data-klaus-native-suspend', '')

  const cardHeader = doc.createElement('div')
  cardHeader.className = 'maximized-composer-card-header'

  const cardStatus = doc.createElement('span')
  cardStatus.className = 'maximized-composer-card-status'

  const cardActions = doc.createElement('div')
  cardActions.className = 'maximized-composer-card-actions'

  const restoreBtn = doc.createElement('button')
  restoreBtn.type = 'button'
  restoreBtn.className = 'maximized-composer-card-restore'

  const collapseBtn = doc.createElement('button')
  collapseBtn.type = 'button'
  collapseBtn.className = 'maximized-composer-card-collapse'
  collapseBtn.innerHTML = CHEVRON_DOWN_SVG

  cardActions.append(restoreBtn, collapseBtn)
  cardHeader.append(cardStatus, cardActions)

  const cardSlot = doc.createElement('div')
  cardSlot.className = 'maximized-composer-card-slot'

  card.append(cardHeader, cardSlot)
  root.append(park, strip, card)

  if (deps.artifactsPanel.nextSibling) {
    deps.appRoot.insertBefore(root, deps.artifactsPanel.nextSibling)
  } else {
    deps.appRoot.appendChild(root)
  }

  let currentAction: MaximizedComposerTrailingAction = null
  let lastLeadKind: MaximizedComposerPillState['leading'] | '' = ''

  function syncPanelGeometry(): void {
    const rect = deps.artifactsPanel.getBoundingClientRect()
    const left = Math.max(0, Math.round(rect.left))
    const width = Math.max(0, Math.round(rect.width))
    root.style.setProperty('--maximized-composer-left', `${left}px`)
    root.style.setProperty('--maximized-composer-width', `${width}px`)
  }

  function computeEligible(): boolean {
    const body = doc.body
    return isMaximizedComposerEligible({
      panelMaximized: body.classList.contains('artifacts-maximized'),
      panelOpen: !deps.artifactsPanel.classList.contains('collapsed'),
      panelMode: deps.artifactsPanel.getAttribute('data-mode') || '',
      inChatSurface: deps.inChatSurface(),
      archivedSession: deps.isArchivedSession(),
    })
  }

  function moveComposerWithBtw(target: HTMLElement): void {
    if (deps.inputWrapper.parentElement === target) return
    const hadFocus = doc.activeElement === deps.inputEl
    target.appendChild(deps.inputWrapper)
    const btwPanel = doc.getElementById('btw-panel')
    if (btwPanel) target.insertBefore(btwPanel, deps.inputWrapper)
    if (hadFocus && target === cardSlot) deps.inputEl.focus()
  }

  function focusInputAtEnd(): void {
    deps.inputEl.focus()
    const text = typeof deps.inputEl.value === 'string' ? deps.inputEl.value : (deps.inputEl.textContent || '')
    const end = text.length
    try {
      deps.inputEl.setSelectionRange?.(end, end)
    } catch {
      // Custom ProseMirror control handles selection internally when focused.
    }
  }

  function renderLead(leading: MaximizedComposerPillState['leading']): void {
    if (leading === lastLeadKind) return
    lastLeadKind = leading
    pillLead.dataset.leadKind = leading
    if (leading === 'chat') pillLead.innerHTML = CHAT_ICON_SVG
    else if (leading === 'pencil') pillLead.innerHTML = PENCIL_ICON_SVG
    else pillLead.innerHTML = ''
  }

  function renderState(): void {
    const eligible = computeEligible()
    doc.body.classList.toggle('maximized-composer-eligible', eligible)

    if (!eligible) {
      if (expanded) expanded = false
      if (!card.hidden) card.hidden = true
      if (!root.hidden) root.hidden = true
      if (deps.inputWrapper.parentElement === cardSlot || deps.inputWrapper.parentElement === park) {
        deps.restoreHomeDock()
      }
      const sid = deps.currentSessionId()
      if (sid && !doc.body.classList.contains('artifacts-maximized')) {
        unreadBySession.delete(sid)
      }
      return
    }

    syncPanelGeometry()
    if (root.hidden) root.hidden = false

    const sessionId = deps.currentSessionId() || ''
    const wait = sessionId ? deps.waitState(sessionId) : { count: 0, kind: 'approval' as const }
    const hasUnread = sessionId ? unreadBySession.has(sessionId) : false
    const pillState = deriveMaximizedComposerPillState({
      waitCount: wait.count,
      waitKind: wait.kind,
      unreadReply: hasUnread ? { sessionId, preview: unreadBySession.get(sessionId) || '' } : null,
      running: deps.isRunning(),
      runningLabel: deps.runningLabel(),
      draftText: deps.draftText(),
      attachmentCount: deps.attachmentCount(),
      t: deps.t,
      tCount: deps.tCount,
    })

    pill.dataset.pillState = pillState.kind
    renderLead(pillState.leading)
    if (pillText.textContent !== pillState.text) pillText.textContent = pillState.text
    pillTrigger.setAttribute('aria-expanded', String(expanded))

    currentAction = pillState.trailingAction
    if (!pillState.trailingAction) {
      pillAction.hidden = true
      pillAction.dataset.actionKind = ''
      pillAction.removeAttribute('aria-label')
      pillAction.replaceChildren()
    } else if (pillState.trailingAction === 'stop') {
      pillAction.hidden = false
      pillAction.dataset.actionKind = 'stop'
      pillAction.setAttribute('aria-label', pillState.trailingLabel)
      if (!pillAction.querySelector('svg')) pillAction.innerHTML = STOP_ICON_SVG
    } else {
      pillAction.hidden = false
      pillAction.dataset.actionKind = pillState.trailingAction
      pillAction.removeAttribute('aria-label')
      pillAction.textContent = pillState.trailingLabel
    }

    cardStatus.textContent = pillState.kind === 'idle' ? '' : pillState.text
    restoreBtn.textContent = deps.t('maximized_composer_show_conversation')
    collapseBtn.setAttribute('aria-label', deps.t('maximized_composer_collapse'))

    if (expanded) {
      strip.hidden = true
      moveComposerWithBtw(cardSlot)
      if (card.hidden) card.hidden = false
    } else {
      if (!card.hidden) card.hidden = true
      strip.hidden = false
      moveComposerWithBtw(park)
    }
  }

  function expand(options: { focusInput?: boolean } = {}): boolean {
    if (!computeEligible()) return false
    const wasExpanded = expanded
    expanded = true
    renderState()
    deps.onExpand?.()
    if (options.focusInput !== false) {
      focusInputAtEnd()
    } else if (!wasExpanded) {
      deps.inputEl.focus()
    }
    return true
  }

  function collapse(options: { restoreFocusToPill?: boolean } = {}): void {
    if (!expanded) return
    const focusWasInside = card.contains(doc.activeElement)
    expanded = false
    renderState()
    if (options.restoreFocusToPill && computeEligible() && (focusWasInside || options.restoreFocusToPill === true)) {
      pillTrigger.focus()
    }
  }

  function viewConversationAndScroll(): void {
    const sid = deps.currentSessionId()
    if (sid) unreadBySession.delete(sid)
    expanded = false
    deps.restoreSplitPanel()
    renderState()
    deps.scrollTranscriptToBottom()
  }

  pillTrigger.addEventListener('click', () => {
    expand({ focusInput: true })
  })

  pillAction.addEventListener('click', (event) => {
    event.stopPropagation()
    if (currentAction === 'stop') {
      deps.stopTurn()
      renderState()
    } else if (currentAction === 'view-reply' || currentAction === 'review') {
      viewConversationAndScroll()
    }
  })

  restoreBtn.addEventListener('click', () => {
    viewConversationAndScroll()
  })

  collapseBtn.addEventListener('click', () => {
    collapse({ restoreFocusToPill: true })
  })

  const onDocumentPointerDown = (event: PointerEvent) => {
    if (!expanded || dragDepth > 0 || deps.isVoiceActive()) return
    const target = event.target instanceof Element ? event.target : null
    if (!target) return
    if (card.contains(target)) return
    if (target.closest(COMPOSER_PORTAL_POPUP_SELECTOR)) return
    collapse({ restoreFocusToPill: false })
  }

  const onCardKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return
    if (handleEscape()) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  function handleEscape(): boolean {
    if (!expanded) return false
    if (deps.isVoiceActive() || deps.hasOpenComposerOverlay()) return false
    collapse({ restoreFocusToPill: true })
    return true
  }

  strip.addEventListener('dragenter', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return
    dragDepth += 1
    strip.classList.add('is-drag-over')
  })
  strip.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
  })
  strip.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1)
    if (dragDepth === 0) strip.classList.remove('is-drag-over')
  })
  strip.addEventListener('drop', (event) => {
    dragDepth = 0
    strip.classList.remove('is-drag-over')
    doc.getElementById('drop-overlay')?.classList.remove('active')
    const files = event.dataTransfer?.files ? Array.from(event.dataTransfer.files) : []
    if (!files.length) return
    event.preventDefault()
    event.stopPropagation()
    if (expand({ focusInput: true })) {
      deps.onDropFiles?.(files)
    }
  })

  doc.addEventListener('pointerdown', onDocumentPointerDown, true)
  card.addEventListener('keydown', onCardKeyDown)

  const bodyObserver = new MutationObserver(() => renderState())
  bodyObserver.observe(doc.body, { attributes: true, attributeFilter: ['class'] })

  const panelAttrObserver = new MutationObserver(() => renderState())
  panelAttrObserver.observe(deps.artifactsPanel, { attributes: true, attributeFilter: ['class', 'data-mode'] })

  const resizeObserver = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(() => {
        if (!root.hidden) syncPanelGeometry()
      })
    : null
  resizeObserver?.observe(deps.artifactsPanel)

  const onWindowResize = () => {
    if (!root.hidden) syncPanelGeometry()
  }
  const onLangChange = () => renderState()
  win?.addEventListener('resize', onWindowResize)
  win?.addEventListener('klaus:lang-change', onLangChange)

  renderState()

  return {
    refresh: renderState,
    isEligible: computeEligible,
    isExpanded: () => expanded && computeEligible(),
    ownsComposerDock: () => computeEligible(),
    expand,
    collapse,
    handleEscape,
    noteSubmitted: () => {
      const sid = deps.currentSessionId()
      if (sid) unreadBySession.delete(sid)
      if (expanded) collapse({ restoreFocusToPill: false })
      else renderState()
    },
    noteTurnCompleted: (sessionId: string, replyText: string) => {
      if (!sessionId) return
      if (sessionId === deps.currentSessionId() && computeEligible()) {
        unreadBySession.set(sessionId, extractReplyPreviewLine(replyText))
        renderState()
      }
    },
    clearUnread: (sessionId?: string | null) => {
      if (sessionId) unreadBySession.delete(sessionId)
      else unreadBySession.clear()
      renderState()
    },
    dispose: () => {
      doc.removeEventListener('pointerdown', onDocumentPointerDown, true)
      card.removeEventListener('keydown', onCardKeyDown)
      bodyObserver.disconnect()
      panelAttrObserver.disconnect()
      resizeObserver?.disconnect()
      win?.removeEventListener('resize', onWindowResize)
      win?.removeEventListener('klaus:lang-change', onLangChange)
      doc.body.classList.remove('maximized-composer-eligible')
      if (deps.inputWrapper.parentElement === cardSlot || deps.inputWrapper.parentElement === park) {
        deps.restoreHomeDock()
      }
      root.remove()
    },
  }
}
