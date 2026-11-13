import { installContenteditableTextControl, dispatchComposerEditCommand } from '../frontend/src/chat/composer/contenteditable-control'
import { mountComposerPredictions, type PredictionTarget, type PredictionSession, type PredictionSourceReply } from '../frontend/src/chat/composer/predictions'

const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())))
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
const results: string[] = []
let dispose: (() => void) | null = null
function fixture(manualSource = false) {
  dispose?.()
  document.body.innerHTML = '<main><div id="slash-input-line"><div id="input" contenteditable="true" role="textbox" data-placeholder="Send a message..."></div></div></main>'
  const input = document.getElementById('input') as unknown as HTMLTextAreaElement
  const editor = installContenteditableTextControl(input as unknown as HTMLElement, () => [])!
  let session: PredictionSession | null = { sessionId: 'session-a', sourceRevision: {} }
  const turns = new Map([['session-a', 'turn-a']])
  let blocked = false, sends = 0
  const settings = new Map<string, unknown>()
  const calls: Array<{ target: PredictionTarget; trigger: string; resolve(value: { suggestion: string | null }): void; reject(error: Error): void }> = []
  const sources: Array<{ sessionId: string; resolve(value: PredictionSourceReply): void; reject(error: Error): void }> = []
  const cancelled: string[] = []
  const controller = mountComposerPredictions({
    input, session: () => session, blocked: () => blocked,
    source: sessionId => new Promise((resolve, reject) => {
      sources.push({ sessionId, resolve, reject })
      if (!manualSource) resolve({ turnId: turns.get(sessionId) ?? null })
    }),
    predict: (current, trigger) => new Promise((resolve, reject) => { calls.push({ target: current, trigger, resolve, reject }) }),
    cancel: async id => { cancelled.push(id) },
    get: async key => settings.get(key), set: async (key, value) => { settings.set(key, value) }, text: () => 'Press Tab to accept',
  })
  dispose = controller.dispose
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.defaultPrevented && input.value) sends++ })
  const ghost = () => document.querySelector<HTMLElement>('.composer-prediction')!
  const key = (value: string, options: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options })
    input.dispatchEvent(event)
    return event
  }
  const text = (value: string) => editor.replaceRange(0, input.value.length, value, 'insertText')
  return { input, controller, settings, calls, sources, cancelled, ghost, key, text, sends: () => sends,
    target: (value: PredictionTarget | null) => {
      session = value ? { sessionId: value.sessionId, sourceRevision: {} } : null
      if (value) turns.set(value.sessionId, value.turnId)
      controller.paint()
    },
    revision: (value: unknown) => { if (session) session = { ...session, sourceRevision: value }; controller.paint() },
    blocked: (value: boolean) => { blocked = value; controller.paint() } }
}

async function run() {
  for (const key of ['Tab', 'ArrowRight', 'Enter']) {
    const f = fixture(); await frame()
    check(f.calls.length === 1, 'Mount must request one catch-up prediction')
    f.calls[0]!.resolve({ suggestion: 'Implement the next step.' }); await frame()
    check(!f.ghost().hidden && f.input.value === '' && f.input.textContent === '', 'Ghost text must remain outside the draft')
    check(f.key(key).defaultPrevented && f.input.value === 'Implement the next step.' && f.sends() === 0, 'Adoption must fill without sending')
    check(f.input.selectionStart === f.input.value.length, 'Adoption must move the caret to the end')
    check(f.settings.get('composer_predictions_has_accepted') === 'on', 'First adoption must persist globally')
    f.input.focus()
    check(dispatchComposerEditCommand(document, 'undo') === true && f.input.value === '', 'Adoption must undo as one editor edit')
    await frame(); check(!f.ghost().hidden, 'Undo to empty must redisplay the prediction')
    f.key('Enter'); f.key('Enter'); check(f.sends() === 1, 'Only the second Enter may submit')
    results.push(`${key}: adopts as undoable draft without submission`)
  }
  {
    const f = fixture(); await frame(); f.calls[0]!.resolve({ suggestion: 'Continue.' }); await frame()
    for (const modifier of ['shiftKey', 'ctrlKey', 'altKey', 'metaKey']) for (const key of ['Tab', 'ArrowRight', 'Enter']) {
      f.text(''); await frame()
      f.key(key, { [modifier]: true })
      const newline = key === 'Enter' && (modifier === 'shiftKey' || modifier === 'altKey' || modifier === 'ctrlKey' && /Mac|iP(?:ad|hone|od)/.test(navigator.platform))
      check(f.input.value === (newline ? '\n' : ''), 'Modified keys retain native editor behavior without adopting the prediction')
      check(!f.settings.has('composer_predictions_has_accepted') && f.sends() === 0, 'Modified keys neither accept nor submit the prediction')
    }
    f.text('')
    f.text(' '); check(f.ghost().hidden, 'Whitespace is a nonempty document')
    f.text(''); check(!f.ghost().hidden, 'Deleting text must redisplay the same candidate')
    f.blocked(true); check(f.ghost().hidden, 'Autocomplete, attachments, disabled and recording state must suppress display')
    f.blocked(false); check(!f.ghost().hidden, 'Removing a display blocker must restore the candidate')
    const mouse = new MouseEvent('mousedown', { button: 0, bubbles: true, cancelable: true }); f.ghost().dispatchEvent(mouse)
    check(mouse.defaultPrevented && document.activeElement === f.input && f.input.value === '', 'Click only focuses')
    f.key('Escape'); check(!f.ghost().hidden, 'Escape does not dismiss a prediction')
    f.input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); check(f.ghost().hidden, 'Composition must hide prediction immediately')
    f.key('Enter', { isComposing: true }); check(f.input.value === '', 'Composition acceptance must remain with the IME')
    f.input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); await frame(); check(!f.ghost().hidden, 'Composition end restores the candidate after a frame')
    f.controller.submitted(); check(f.ghost().hidden, 'Submission dismisses this turn')
    await f.controller.refresh(); check(f.calls.length === 1, 'Submitted turns must not regenerate')
    results.push('display blockers, typing, click, Escape, IME and submission lifecycle')
  }
  {
    const f = fixture(); await frame()
    f.target({ sessionId: 'session-b', turnId: 'turn-b' }); void f.controller.refresh(); await frame()
    f.calls[0]!.resolve({ suggestion: 'Old suggestion.' }); await frame(); check(f.ghost().hidden, 'A switched-away result cannot appear in the active editor')
    f.calls[1]!.resolve({ suggestion: 'New suggestion.' }); await frame(); check(!f.ghost().hidden && f.ghost().textContent?.includes('New suggestion.'), 'Current result displays')
    f.target({ sessionId: 'session-a', turnId: 'turn-a' }); await f.controller.refresh(); check(f.calls.length === 2 && f.ghost().textContent?.includes('Old suggestion.'), 'Switching back reuses completed work')
    window.dispatchEvent(new Event('focus')); await frame(); check(f.calls.length === 2, 'Focus cannot retry settled work')
    f.settings.set('composer_predictions_enabled', 'off'); await f.controller.reloadSettings(); check(f.ghost().hidden && f.cancelled.includes('session-a'), 'Disable hides and cancels work')
    results.push('target isolation, cache reuse, focus deduplication and disabled preference')
  }
  {
    const f = fixture(); await frame(); f.controller.invalidate('session-a'); f.target(null)
    f.calls[0]!.resolve({ suggestion: 'Stale suggestion.' }); await frame(); check(f.ghost().hidden, 'Invalidated results must never reappear')
    results.push('late results after invalidation are discarded')
  }
  {
    const f = fixture(true); await frame()
    void f.controller.refresh('live', 'empty'); void f.controller.refresh('catch_up'); await frame()
    check(f.sources.length === 1 && f.calls.length === 0, 'Source lookup must be single-flight before inference')
    f.revision({ turnStatuses: { empty: 'failed', old: 'completed' }, turnStartedAtMs: { old: 100, empty: 100 }, turnFinishedAtMs: { empty: 100, old: 100 } })
    void f.controller.refresh(); await frame(); check(f.sources.length === 2, 'A new revision must revalidate the authoritative source')
    f.sources[0]!.resolve({ turnId: 'old' }); await frame(); check(f.calls.length === 0 && f.ghost().hidden, 'A late source read must not dispatch prediction')
    f.sources[1]!.resolve({ turnId: 'empty' }); await frame()
    check(f.calls.length === 1 && f.calls[0]!.target.turnId === 'empty' && f.calls[0]!.trigger === 'live', 'Host identity and the pending live trigger must survive metadata refresh')
    f.calls[0]!.resolve({ suggestion: 'Continue after failure.' }); await frame(); check(!f.ghost().hidden, 'An empty terminal source may display a prediction')
    results.push('authoritative empty terminal source, tied clocks, source single-flight and live trigger')
  }
  {
    const f = fixture(true); await frame()
    void f.controller.refresh('live', 'removed')
    f.target({ sessionId: 'session-a', turnId: 'retained' }); void f.controller.refresh(); await frame()
    f.sources[1]!.resolve({ turnId: 'retained' }); await frame()
    f.sources[0]!.resolve({ turnId: 'removed' }); await frame()
    check(f.calls.length === 1 && f.calls[0]!.target.turnId === 'retained' && f.calls[0]!.trigger === 'catch_up', 'A rollback must ignore the removed source and its live trigger even when its read finishes last')
    f.calls[0]!.resolve({ suggestion: 'Retained context.' }); await frame()
    check(f.ghost().textContent?.includes('Retained context.'), 'Only the current retained source may paint')
    results.push('rollback ignores an older source lookup that finishes last')
  }
  {
    const f = fixture(true); await frame()
    f.target({ sessionId: 'session-b', turnId: 'turn-b' }); void f.controller.refresh(); await frame()
    f.sources[0]!.resolve({ turnId: 'stale-a' }); await frame(); check(f.calls.length === 0, 'A switched-away unresolved source must not generate')
    f.sources[1]!.resolve({ turnId: 'turn-b' }); await frame()
    f.target({ sessionId: 'session-a', turnId: 'current-a' }); void f.controller.refresh(); await frame()
    f.sources[2]!.resolve({ turnId: 'current-a' }); await frame()
    check(f.calls.length === 2 && f.calls[1]!.target.turnId === 'current-a', 'Returning to a session must resolve a fresh actual source')
    f.calls[0]!.resolve({ suggestion: 'Cached B.' }); await frame(); check(f.ghost().hidden, 'Offscreen inference may not paint into another source')
    f.calls[1]!.resolve({ suggestion: 'Current A.' }); await frame(); check(f.ghost().textContent?.includes('Current A.'), 'Current A result must own the editor')
    f.target({ sessionId: 'session-b', turnId: 'turn-b' }); void f.controller.refresh(); await frame()
    f.sources[3]!.resolve({ turnId: 'turn-b' }); await frame()
    check(f.calls.length === 2 && f.ghost().textContent?.includes('Cached B.'), 'A confirmed actual source must reuse inference completed offscreen')
    results.push('late source isolation and actual-turn inference cache across session switches')
  }
  {
    const submitted = fixture(true); await frame(); submitted.controller.submitted()
    submitted.sources[0]!.resolve({ turnId: 'submitted' }); await frame()
    check(submitted.calls.length === 0 && submitted.ghost().hidden, 'Submission before source resolution must suppress the old draft source')
    const disabled = fixture(true); await frame(); disabled.settings.set('composer_predictions_enabled', 'off'); await disabled.controller.reloadSettings()
    disabled.sources[0]!.resolve({ turnId: 'disabled' }); await frame()
    check(disabled.calls.length === 0 && disabled.ghost().hidden && disabled.cancelled.includes('session-a'), 'Disable must invalidate pending source and cancel its owner')
    const closed = fixture(true); await frame(); closed.controller.dispose(); dispose = null
    closed.sources[0]!.resolve({ turnId: 'closed' }); await frame()
    check(closed.calls.length === 0 && !document.querySelector('.composer-prediction'), 'Dispose must ignore pending source without restoring editor nodes')
    results.push('submission, preference disable and close fence unresolved sources')
  }
  {
    const f = fixture(); await frame(); f.calls[0]!.reject(new Error('prediction unavailable')); await frame()
    f.revision({}); await f.controller.refresh(); window.dispatchEvent(new Event('focus')); await frame()
    check(f.calls.length === 1 && f.ghost().hidden, 'A settled actual-turn error must not retry on metadata refresh or focus')
    f.controller.invalidate('session-a'); void f.controller.refresh(); await frame()
    check(f.calls.length === 2, 'Explicit invalidation may start a new attempt')
    f.calls[1]!.resolve({ suggestion: null }); await frame(); await f.controller.refresh()
    check(f.calls.length === 2, 'A null suggestion is also settled for the actual turn')
    results.push('prediction errors and null results stay cached until explicit invalidation')
  }
  {
    const f = fixture(); await frame(); f.revision({}); void f.controller.refresh(); await frame()
    check(f.sources.length === 2 && f.calls.length === 1, 'A new source scope for the same actual turn must share in-flight inference')
    f.calls[0]!.resolve({ suggestion: 'Shared actual turn.' }); await frame()
    check(!f.ghost().hidden && f.ghost().textContent?.includes('Shared actual turn.'), 'The revalidated scope must display shared inference')
    results.push('source revision changes revalidate identity without duplicate inference')
  }
  {
    const f = fixture(true); await frame(); f.cancelled.length = 0
    f.revision({}); void f.controller.refresh(); await frame()
    check(f.sources.length === 2, 'Two scopes may have source reads pending for the same session')
    f.sources[0]!.resolve({ turnId: 'old-a' }); await frame()
    f.target({ sessionId: 'session-b', turnId: 'turn-b' }); void f.controller.refresh(); await frame()
    check(f.sources.length === 3 && f.calls.length === 0, 'The current and offscreen source lookups must remain tracked independently')
    f.controller.dispose(); dispose = null
    check(f.cancelled.includes('session-a') && f.cancelled.includes('session-b'), 'Close must cancel every pending source owner, including an offscreen session with one of several reads already settled')
    f.sources[1]!.resolve({ turnId: 'remaining-a' }); f.sources[2]!.resolve({ turnId: 'turn-b' }); await frame()
    check(f.calls.length === 0 && !document.querySelector('.composer-prediction'), 'Late source replies after close must not dispatch or restore the ghost')
    results.push('close cancels counted pending source lookups across current and offscreen sessions')
  }
  for (const failure of ['unavailable', 'rejected']) {
    const f = fixture(true); await frame()
    if (failure === 'rejected') f.sources[0]!.reject(new Error('Source RPC failed'))
    else f.sources[0]!.resolve({ turnId: null, reason: failure })
    await frame()
    for (let index = 0; index < 214; index++) await f.controller.refresh()
    check(f.sources.length === 1 && f.calls.length === 0, 'Ordinary refreshes must not retry a failed source')
    window.dispatchEvent(new Event('focus')); await frame()
    check(f.sources.length === 2 && f.calls.length === 0, 'Window focus must retry a transient source failure')
    window.dispatchEvent(new Event('focus')); void f.controller.refresh(); await frame()
    check(f.sources.length === 2, 'Focus during source recovery must share the pending lookup')
    f.sources[1]!.resolve({ turnId: 'turn-a' }); await frame()
    check(f.calls.length === 1 && f.calls[0]!.trigger === 'catch_up', 'A recovered source must request one catch-up prediction')
    window.dispatchEvent(new Event('focus')); await frame()
    check(f.sources.length === 2 && f.calls.length === 1, 'A resolved source and pending inference must not restart on focus')
    f.calls[0]!.resolve({ suggestion: 'Continue after recovery.' }); await frame()
    check(!f.ghost().hidden && f.ghost().textContent?.includes('Continue after recovery.'), 'Recovery must display the suggestion')
    check(f.key('Tab').defaultPrevented && f.input.value === 'Continue after recovery.' && f.sends() === 0, 'A recovered suggestion must adopt as an editable draft')
    results.push(`${failure}: focus recovers a transient source once and Tab adopts without sending`)
  }
  {
    const f = fixture(); await frame()
    f.calls[0]!.resolve({ suggestion: 'Keep across model switches.' }); await frame()
    const initialSources = f.sources.length; f.cancelled.length = 0
    f.controller.recheck('session-a'); f.controller.recheck(); await frame()
    check(!f.ghost().hidden && f.ghost().textContent?.includes('Keep across model switches.'), 'Model and mode switches must preserve a settled suggestion without hiding it')
    check(f.sources.length === initialSources && f.calls.length === 1 && f.cancelled.length === 0, 'Preserving a settled suggestion must not re-query source or inference')
    f.target(null); f.controller.suspend('session-a'); await frame()
    check(f.ghost().hidden, 'Entering Plan mode must hide the suggestion while suppressed')
    f.target({ sessionId: 'session-a', turnId: 'turn-a' }); await f.controller.refresh(); await frame()
    check(!f.ghost().hidden && f.ghost().textContent?.includes('Keep across model switches.') && f.calls.length === 1, 'Leaving Plan mode must restore the preserved suggestion without regenerating')
    results.push('model, mode and Plan transitions preserve settled suggestions')
  }
  {
    const f = fixture(); await frame()
    f.calls[0]!.resolve({ suggestion: null, reason: 'unsupported_model' }); await frame()
    check(f.ghost().hidden && f.calls.length === 1, 'An unsupported model suppresses generation until the model changes')
    f.controller.recheck('session-a'); await frame()
    check(f.calls.length === 2, 'Switching models must retry a model-dependent failure')
    f.controller.recheck('session-a'); await frame()
    f.calls[1]!.resolve({ suggestion: null, reason: 'prediction_failed' }); await frame()
    check(f.calls.length === 3, 'A model switch during an in-flight failure must retry once against the new selection')
    f.calls[2]!.resolve({ suggestion: 'Recovered after model switch.' }); await frame()
    check(!f.ghost().hidden && f.ghost().textContent?.includes('Recovered after model switch.'), 'Recovered suggestion must display')
    results.push('model switches recover unsupported and in-flight failed predictions')
  }
  const f = fixture(); await frame(); f.calls[0]!.resolve({ suggestion: 'Add regression coverage for the new behavior.' }); await frame()
  return { results, count: results.length, ghost: f.ghost().textContent, draft: f.input.value }
}

;(window as any).predictionFixture = { run, frame }
