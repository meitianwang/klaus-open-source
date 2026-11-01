export const PREDICTIONS_ENABLED_KEY = 'composer_predictions_enabled'
export const PREDICTIONS_ACCEPTED_KEY = 'composer_predictions_has_accepted'

export interface PredictionTarget { sessionId: string; turnId: string }
export interface PredictionSession { sessionId: string; sourceRevision: unknown }
export interface PredictionSourceState {
  history: unknown
  historyGeneration: number
  turnStatuses: unknown
  activeTurnId: string | null
  liveTurnId: string | null
  lastTerminalStatus: string | null
  liveUnits?: readonly { type: string; msg?: { uuid?: unknown } }[]
}

/**
 * The newest user row added without a turn, such as a friend's message. It
 * becomes the conversation's suggestion source on its own, so its identity is
 * part of the revision. Only this scalar is compared: the live unit list itself
 * is replaced by unrelated stream updates and would restart every source read.
 */
function latestLiveUserId(units: PredictionSourceState['liveUnits']): unknown {
  if (!units) return null
  for (let index = units.length - 1; index >= 0; index--) {
    const unit = units[index]!
    if (unit.type === 'live-user') return unit.msg?.uuid ?? null
  }
  return null
}

/** Keep source reads alive through unrelated immutable stream updates. */
export function createPredictionSessionSelector() {
  let previous: { session: PredictionSession; values: unknown[] } | null = null
  return (sessionId: string, state: PredictionSourceState): PredictionSession => {
    const values = [state.history, state.historyGeneration, state.turnStatuses,
      state.activeTurnId, state.liveTurnId, state.lastTerminalStatus, latestLiveUserId(state.liveUnits)]
    if (previous?.session.sessionId === sessionId && values.every((value, index) => Object.is(value, previous!.values[index]))) {
      return previous.session
    }
    const session = { sessionId, sourceRevision: values }
    previous = { session, values }
    return session
  }
}
export interface PredictionSourceReply { turnId: string | null; reason?: string }
export interface PredictionReply { suggestion: string | null; reason?: string }
export type PredictionTrigger = 'live' | 'catch_up'

interface PredictionSourceScope extends PredictionSession {
  target: PredictionTarget | null
  settled: boolean
  retryable: boolean
  pending: Promise<void> | null
}
interface ResolvedPredictionSource { target: PredictionTarget; scope: PredictionSourceScope }
const retryableSourceReasons = new Set(['unavailable', 'engine_unavailable', 'cancelled'])

/** Resolve terminal identity on the host; renderer revisions only invalidate reads. */
export function createPredictionSourceResolver(deps: {
  session(): PredictionSession | null
  source(sessionId: string): Promise<PredictionSourceReply>
}) {
  let scope: PredictionSourceScope | null = null
  let disposed = false
  const liveRequests = new Map<string, string>()
  function current() {
    if (disposed) return null
    const session = deps.session()
    if (!session) { scope = null; return null }
    if (!scope || scope.sessionId !== session.sessionId || !Object.is(scope.sourceRevision, session.sourceRevision)) {
      scope = { ...session, target: null, settled: false, retryable: false, pending: null }
    }
    return scope
  }
  function isCurrent(resolved: ResolvedPredictionSource) { return current() === resolved.scope }
  return {
    target: () => current()?.target ?? null,
    sessionId: () => current()?.sessionId ?? null,
    isCurrent,
    async resolve(trigger: PredictionTrigger = 'catch_up', liveTurnId?: string): Promise<ResolvedPredictionSource | null> {
      const captured = current()
      if (!captured) return null
      if (trigger === 'live' && liveTurnId) liveRequests.set(captured.sessionId, liveTurnId)
      if (!captured.settled && !captured.pending) {
        captured.pending = Promise.resolve().then(() => current() === captured ? deps.source(captured.sessionId) : { turnId: null }).then(reply => {
          if (current() !== captured) return
          captured.target = typeof reply.turnId === 'string' && reply.turnId
            ? { sessionId: captured.sessionId, turnId: reply.turnId } : null
          captured.settled = true
          captured.retryable = !captured.target && retryableSourceReasons.has(reply.reason ?? '')
        }).catch(() => {
          if (current() === captured) { captured.settled = true; captured.retryable = true }
        }).finally(() => { captured.pending = null })
      }
      await captured.pending
      if (current() !== captured) return null
      if (!captured.target) { liveRequests.delete(captured.sessionId); return null }
      return { target: captured.target, scope: captured }
    },
    /** Explicit recovery retries only source reads, leaving inference caches intact. */
    retryFailed(): boolean {
      const captured = current()
      if (!captured?.retryable || captured.pending) return false
      captured.settled = false
      captured.retryable = false
      return true
    },
    takeTrigger(resolved: ResolvedPredictionSource): PredictionTrigger | null {
      if (!isCurrent(resolved)) return null
      const liveTurnId = liveRequests.get(resolved.target.sessionId)
      liveRequests.delete(resolved.target.sessionId)
      return liveTurnId === resolved.target.turnId ? 'live' : 'catch_up'
    },
    invalidate(sessionId?: string) {
      if (!sessionId || scope?.sessionId === sessionId) scope = null
      if (sessionId) liveRequests.delete(sessionId); else liveRequests.clear()
    },
    dispose() { disposed = true; scope = null; liveRequests.clear() },
  }
}

export function predictionAcceptanceKey(event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'ctrlKey' | 'metaKey' | 'isComposing' | 'keyCode'>): boolean {
  return !event.isComposing && event.keyCode !== 229 && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey
    && ['Tab', 'ArrowRight', 'Enter'].includes(event.key)
}

/** A prediction is presentation until the user explicitly adopts it as a draft. */
export function mountComposerPredictions(deps: {
  input: HTMLTextAreaElement
  session(): PredictionSession | null
  source(sessionId: string): Promise<PredictionSourceReply>
  blocked(): boolean
  predict(target: PredictionTarget, trigger: PredictionTrigger): Promise<PredictionReply>
  cancel(sessionId: string): Promise<unknown>
  get(key: string): Promise<unknown>
  set(key: string, value: string): Promise<unknown>
  text(key: string): string
}) {
  const input = deps.input
  const root = input as unknown as HTMLElement
  const doc = root.ownerDocument
  const ghost = doc.createElement('div')
  ghost.className = 'composer-prediction'
  ghost.setAttribute('aria-hidden', 'true')
  ghost.hidden = true
  const suggestion = doc.createElement('span')
  const hint = doc.createElement('span')
  hint.className = 'composer-prediction-hint'
  ghost.append(suggestion, hint)
  root.after(ghost)
  const candidates = new Map<string, PredictionReply>()
  const pending = new Map<string, { sessionId: string; valid: boolean; promise: Promise<void> }>()
  const dismissed = new Set<string>()
  const submittedSessions = new Set<string>()
  const sourceReads = new Map<string, number>()
  const sources = createPredictionSourceResolver({
    session: () => deps.session(),
    source: async sessionId => {
      sourceReads.set(sessionId, (sourceReads.get(sessionId) ?? 0) + 1)
      try { return await deps.source(sessionId) }
      finally {
        const remaining = (sourceReads.get(sessionId) ?? 1) - 1
        if (remaining) sourceReads.set(sessionId, remaining); else sourceReads.delete(sessionId)
      }
    },
  })
  let enabled = false
  let hasAccepted = false
  let composing = false
  let disposed = false
  let settingsRead = 0
  let visible: { key: string; value: string } | null = null
  const keyOf = (target: PredictionTarget) => JSON.stringify([target.sessionId, target.turnId])

  function paint() {
    const target = sources.target()
    const key = target && keyOf(target)
    const value = key && candidates.get(key)?.suggestion
    visible = !disposed && enabled && value && !dismissed.has(key!) && !submittedSessions.has(target!.sessionId) && !composing && input.value === '' && !deps.blocked()
      ? { key: key!, value } : null
    ghost.hidden = !visible
    root.classList.toggle('has-composer-prediction', !!visible)
    if (visible) {
      suggestion.textContent = visible.value
      hint.textContent = deps.text('composer_prediction_accept_hint')
      hint.hidden = hasAccepted
      root.setAttribute('aria-description', `${visible.value}. ${deps.text('composer_prediction_accept_hint')}`)
    } else root.removeAttribute('aria-description')
  }

  async function refresh(trigger: PredictionTrigger = 'catch_up', liveTurnId?: string) {
    paint()
    if (disposed || !enabled) return
    const resolved = await sources.resolve(trigger, liveTurnId)
    if (disposed || !enabled || !resolved || !sources.isCurrent(resolved)) return
    const target = resolved.target
    const key = keyOf(target)
    const generationTrigger = sources.takeTrigger(resolved)
    if (candidates.has(key) || dismissed.has(key) || submittedSessions.has(target.sessionId)) { paint(); return }
    let job = pending.get(key)
    if (!job) {
      job = { sessionId: target.sessionId, valid: true, promise: Promise.resolve() }
      pending.set(key, job)
      const captured = job
      captured.promise = (async () => {
        try {
          if (disposed || !captured.valid) return
          const reply = await deps.predict(target, generationTrigger ?? 'catch_up')
          if (!disposed && captured.valid) candidates.set(key, reply)
        } catch {
          // A failed attempt remains settled for its actual turn, including offscreen.
          if (!disposed && captured.valid) candidates.set(key, { suggestion: null, reason: 'unavailable' })
        } finally {
          if (pending.get(key) === captured) pending.delete(key)
          if (!disposed) paint()
        }
      })()
    }
    await job.promise
    if (!disposed) paint()
  }

  async function reloadSettings() {
    const read = ++settingsRead
    const [saved, accepted] = await Promise.all([deps.get(PREDICTIONS_ENABLED_KEY), deps.get(PREDICTIONS_ACCEPTED_KEY)]).catch(() => ['off', 'off'])
    if (disposed || read !== settingsRead) return
    const next = saved !== 'off'
    if (enabled !== next) invalidate()
    enabled = next
    hasAccepted = accepted === 'on'
    await refresh()
  }

  function invalidate(sessionId?: string) {
    const ids = new Set<string>()
    const currentSessionId = sources.sessionId()
    if (currentSessionId && (!sessionId || currentSessionId === sessionId)) ids.add(currentSessionId)
    for (const id of sourceReads.keys()) if (!sessionId || id === sessionId) ids.add(id)
    for (const [key, job] of pending) if (!sessionId || job.sessionId === sessionId) {
      job.valid = false
      ids.add(job.sessionId)
      pending.delete(key)
    }
    sources.invalidate(sessionId)
    if (sessionId) {
      for (const key of candidates.keys()) if (JSON.parse(key)[0] === sessionId) candidates.delete(key)
      for (const key of dismissed) if (JSON.parse(key)[0] === sessionId) dismissed.delete(key)
      submittedSessions.delete(sessionId)
      ids.add(sessionId)
    } else {
      for (const key of candidates.keys()) ids.add(JSON.parse(key)[0] as string)
      candidates.clear()
      dismissed.clear()
      submittedSessions.clear()
    }
    for (const id of ids) void deps.cancel(id).catch(() => {})
    paint()
  }

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.isComposing || event.keyCode === 229) { composing = true; paint(); return }
    paint()
    if (!visible || !predictionAcceptanceKey(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const accepted = visible
    input.value = accepted.value
    input.setSelectionRange(accepted.value.length, accepted.value.length)
    input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertReplacementText', data: accepted.value }))
    if (!hasAccepted) {
      hasAccepted = true
      void deps.set(PREDICTIONS_ACCEPTED_KEY, 'on').catch(() => {})
    }
    paint()
  }
  const onCompositionStart = () => { composing = true; paint() }
  const onCompositionEnd = () => { requestAnimationFrame(() => { composing = false; if (!disposed) paint() }) }
  const onMouseDown = (event: MouseEvent) => {
    if (event.button !== 0) return
    event.preventDefault()
    input.focus()
  }
  const onFocus = () => { sources.retryFailed(); void refresh() }
  root.addEventListener('keydown', onKeyDown, true)
  root.addEventListener('input', paint)
  root.addEventListener('compositionstart', onCompositionStart)
  root.addEventListener('compositionend', onCompositionEnd)
  ghost.addEventListener('mousedown', onMouseDown)
  window.addEventListener('focus', onFocus)
  const observer = new MutationObserver(paint)
  observer.observe(root, { childList: true, characterData: true, subtree: true })
  void reloadSettings()
  return {
    refresh, paint, invalidate, reloadSettings,
    submitted() {
      const sessionId = sources.sessionId()
      if (sessionId) submittedSessions.add(sessionId)
      const target = sources.target()
      if (target) dismissed.add(keyOf(target))
      paint()
    },
    dispose() {
      disposed = true
      invalidate()
      sources.dispose()
      observer.disconnect()
      root.removeEventListener('keydown', onKeyDown, true)
      root.removeEventListener('input', paint)
      root.removeEventListener('compositionstart', onCompositionStart)
      root.removeEventListener('compositionend', onCompositionEnd)
      ghost.removeEventListener('mousedown', onMouseDown)
      window.removeEventListener('focus', onFocus)
      ghost.remove()
    },
  }
}
