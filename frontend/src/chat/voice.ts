// Voice input owns one microphone operation at a time. Every asynchronous
// continuation checks that operation before changing the composer or capture.
import { tt } from '../app/i18n'
import { showToast } from '../app/ui-shared'
import { VoiceSessionCapture, type PcmCaptureHandle } from './voice-session-capture'
import { DictationPipeline, type DictationMetrics, type PipelineFinal } from './voice-pipeline'
import { voiceErrorKey } from './voice-errors'
import { publishDictionaryAdditions } from './voice-dictionary-learning'
import { VoiceCorrectionTracker, isVoiceCorrection } from './voice-correction-tracker'
import { voiceLiveSurface, type VoiceLiveSurface } from './voice-live-surface'
import { VOICE_AUDIO_MAX_MS, isVoiceInputSource, voiceInputSource, type VoiceInputSource } from '../../../shared/voice-input'
import { bindCommandHandler } from '../app/keybindings/use-command-handler'

interface Reply { ok?: boolean; text?: string; rawText?: string; error?: string; sessionId?: string; complete?: boolean }
interface VoiceSessionEvent { sessionId?: string; type?: string; text?: string; rawText?: string; code?: string; message?: string; seq?: number }
interface KlausVoiceApi {
  voice: {
    micPermission(operationId?: string): Promise<Reply | null>
    transcribe(data: ArrayBuffer, mime: string, operationId?: string, options?: { source: VoiceInputSource; context?: string; chatSessionId?: string; durationMs?: number; partial?: boolean; segmentIds?: string[] }): Promise<Reply | null>
    learn?(payload: { rawText: string; insertedText: string; finalText: string; chatSessionId?: string }): Promise<unknown>
    hotwords?: { remove(id: string): Promise<Reply | null> }
    config?(operationId?: string): Promise<{ ok?: boolean; source?: string; sourceAvailable?: boolean; systemAsr?: boolean; streaming?: boolean } | null>
    sessionStart(options: { context: string; operationId: string; source?: string; chatSessionId?: string }): Promise<Reply | null>
    sessionAudio(id: string, data: ArrayBuffer, seq?: number): Promise<Reply | null>
    sessionStop(id: string): Promise<Reply | null>
    sessionCancel(id: string | null): Promise<Reply | null>
    onSessionEvent?(callback: (event: VoiceSessionEvent) => void): unknown
  }
}
const api = () => (window as unknown as { klaus: KlausVoiceApi }).klaus.voice
const alert = (message: string) => (window as unknown as { klausDialog: { alert(message: string): Promise<void> } }).klausDialog.alert(message)
export interface VoiceDeps { mainComposerInsert(text: string): void; chatActive?(): boolean }
let deps!: VoiceDeps
const buttons: HTMLElement[] = []
type State = 'idle' | 'starting' | 'recording' | 'transcribing' | 'cancelling'
let state: State = 'idle'
interface Operation {
  id: string
  source: VoiceInputSource
  insert: ((text: string) => void) | null
  streaming: boolean
  stream: MediaStream | null
  pcm: PcmCaptureHandle | null
  pipeline: DictationPipeline | null
  sequence: number
  startedAt: number
  pressedAt: number
  live: VoiceLiveSurface
  stopWhenReady?: boolean
  tick?: ReturnType<typeof setInterval>
  max?: ReturnType<typeof setTimeout>
}
let current: Operation | null = null
const MAX_MS = VOICE_AUDIO_MAX_MS

function setState(value: State): void {
  state = value
  const key = value === 'recording' ? 'voice_input_stop' : value === 'idle' ? 'voice_input_start' : value === 'starting' ? 'voice_input_starting' : 'voice_input_transcribing'
  for (const button of buttons) {
    button.dataset.voiceState = value
    button.setAttribute('aria-label', tt(key))
    button.removeAttribute('title')
    ;(button as HTMLButtonElement).disabled = value !== 'idle' && value !== 'recording'
  }
}
function stripText(value: string): void { current?.live.text(value || tt('voice_live_listening')) }
function hideStrip(op: Operation): void { op.live.hide() }
function clearTimers(op: Operation): void { clearInterval(op.tick); clearTimeout(op.max) }
function releaseStream(op: Operation): void { op.stream?.getTracks().forEach(track => track.stop()); op.stream = null }
async function release(op: Operation): Promise<void> {
  clearTimers(op); releaseStream(op)
  const pipeline = op.pipeline; op.pipeline = null
  const pcm = op.pcm; op.pcm = null
  if (pipeline) await pipeline.cancel()
  await pcm?.close()
}
function beginTimers(op: Operation): void {
  op.startedAt = Date.now(); setState('recording')
  // Both dictation routes show the live strip: the system session streams its
  // own partials, the cloud pipeline feeds joined segment text into it.
  op.live.show(tt('voice_live_listening'))
  const tick = () => {
    const seconds = Math.floor((Date.now() - op.startedAt) / 1000)
    op.live.timer(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`)
  }
  tick(); op.tick = setInterval(tick, 1000); op.max = setTimeout(voiceStop, MAX_MS)
}

interface LearnEntry { rawText: string; insertedText: string }
let pendingLearning: LearnEntry[] = []
let pendingLearningSnapshot = ''
let pendingLearningSession: unknown
let pendingLearningInput: HTMLElement | null = null
let correctionTracker: VoiceCorrectionTracker | null = null
let detachCorrectionListeners: (() => void) | null = null
function stopCorrectionTracking(): void {
  correctionTracker?.stop(); correctionTracker = null
  detachCorrectionListeners?.(); detachCorrectionListeners = null
}
function watchVoiceCorrections(): void {
  stopCorrectionTracking()
  const input = document.getElementById('input') as (HTMLElement & { value?: string }) | null
  if (!input) return
  const session = (window as any).currentSessionId
  const read = () => typeof input.value === 'string' ? input.value : input.textContent || ''
  pendingLearningSnapshot = read(); pendingLearningSession = session; pendingLearningInput = input
  const tracker = new VoiceCorrectionTracker({ read, valid: () => input.isConnected && document.getElementById('input') === input && (window as any).currentSessionId === session, finish: flushVoiceLearning })
  correctionTracker = tracker
  const edited = () => { if (!read().trim()) tracker.finish(); else tracker.edited() }
  const blurred = (event: FocusEvent) => { if (!input.contains(event.relatedTarget as Node | null)) tracker.finish() }
  const enter = (event: KeyboardEvent) => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) tracker.finish() }
  input.addEventListener('input', edited); input.addEventListener('focusout', blurred); input.addEventListener('keydown', enter)
  detachCorrectionListeners = () => { input.removeEventListener('input', edited); input.removeEventListener('focusout', blurred); input.removeEventListener('keydown', enter) }
  tracker.start()
}
export function flushVoiceLearning(finalText: string): void {
  const entries = pendingLearning.slice(), final = finalText.trim(), original = pendingLearningSnapshot || entries.map(row => row.insertedText).join(' ')
  const sameSession = pendingLearningSession === (window as any).currentSessionId && pendingLearningInput?.isConnected && document.getElementById('input') === pendingLearningInput
  const chatSessionId = typeof pendingLearningSession === 'string' && pendingLearningSession || undefined
  clearVoiceLearning()
  if (!entries.length || !sameSession || !isVoiceCorrection(original, final, entries.map(row => row.insertedText))) return
  void api().learn?.({ rawText: entries.map(row => row.rawText).join(' '), insertedText: original, finalText: final, chatSessionId }).then(value => {
    publishDictionaryAdditions(value, {
      changed: () => window.dispatchEvent(new Event('klaus:voice-dictionary-changed')),
      remove: id => api().hotwords?.remove(id) ?? Promise.resolve(null),
      notify: (terms, undo) => showToast(tt('voice_dictionary_auto_added').replace('{terms}', terms.join(', ')) + ' · ' + tt('voice_dictionary_undo'), {
        duration: 8000, onClick: () => { void undo().catch(() => showToast(tt('settings_failed'))) },
      }),
    })
  }).catch(() => {})
}
export function clearVoiceLearning(): void { pendingLearning = []; pendingLearningSnapshot = ''; pendingLearningSession = undefined; pendingLearningInput = null; stopCorrectionTracking() }
function insert(op: Operation, value: string | undefined, rawText?: string): void {
  const text = value?.trim(); if (!text) return
  if (op.insert) { op.insert(text); return }
  if (pendingLearning.length && pendingLearningSession !== (window as any).currentSessionId) clearVoiceLearning()
  pendingLearning.push({ rawText: rawText || text, insertedText: text }); deps.mainComposerInsert(text)
  watchVoiceCorrections()
}
function context(): string {
  return [...document.querySelectorAll('#messages .msg-group')].slice(-4).map(group => {
    const role = group.classList.contains('user') ? 'User' : 'Assistant'
    return `${role}: ${(group.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 600)}`
  }).join('\n').slice(-4000)
}
function reportVoiceMetrics(metrics: DictationMetrics): void {
  try { console.debug('[voice] dictation metrics', JSON.stringify(metrics)) } catch { /* Telemetry never blocks insertion. */ }
}
async function fail(op: Operation, error: string): Promise<void> {
  if (current !== op) return
  current = null; setState('cancelling'); hideStrip(op)
  await Promise.allSettled([release(op), api().sessionCancel(op.id)])
  if (!current) setState('idle')
  const errorKey = voiceErrorKey(error)
  if (errorKey) await alert(tt(errorKey))
  else if (error === 'empty-transcript') showToast(tt('voice_empty_result'))
  else if (error === 'speech-permission-denied') await alert(tt('voice_speech_denied'))
  else if (error === 'mic-denied') await alert(tt('voice_mic_denied'))
  else if (error === 'no-credentials') await alert(tt('voice_no_credentials'))
  else await alert(`${tt('voice_transcribe_failed')}：${error}`)
}
async function voiceStart(insertInto: ((text: string) => void) | null, button: HTMLElement | null = document.getElementById('voice-input-btn')): Promise<void> {
  if (state !== 'idle' || deps.chatActive?.()) return
  const op: Operation = { id: crypto.randomUUID(), source: 'custom', insert: insertInto, streaming: false,
    stream: null, pcm: null, pipeline: null, sequence: 0, startedAt: 0, pressedAt: Date.now(), live: voiceLiveSurface(button) }
  current = op; setState('starting'); op.live.show(tt('voice_input_starting'))
  try {
    const config = await api().config?.(op.id)
    if (current !== op) return
    if (!config || config.ok === false) throw new Error('voice-source-unavailable')
    const selected = config.source ?? voiceInputSource('', config?.systemAsr === true)
    if (!isVoiceInputSource(selected) || config?.sourceAvailable === false) throw new Error('voice-source-unavailable')
    op.source = selected; op.streaming = selected === 'system' || config.streaming === true
    const permission = await api().micPermission(op.id)
    if (current !== op) return
    if (!permission?.ok) throw new Error('mic-denied')
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    if (current !== op) { stream.getTracks().forEach(track => track.stop()); return }
    op.stream = stream
    const streamConnectedAt = Date.now()
    if (op.streaming) {
      op.pcm = new VoiceSessionCapture(stream, { transport: api(), operationId: op.id, source: op.source, context: context(), chatSessionId: (window as any).currentSessionId || undefined,
        ready: id => { if (current === op) op.id = id }, failed: error => { void fail(op, error.message) } })
      await op.pcm.start()
      if (current !== op) { await op.pcm?.close(); return }
    } else {
      // Cloud sources stream through the shared pipeline: acknowledged worklet
      // frames accumulate in a ledger, silence-aware segments transcribe live,
      // and final-request failure recovers only completely recognized segments.
      const pipeline = new DictationPipeline({
        transport: {
          transcribe: (data, mimeType, operationId, options) => api().transcribe(data, mimeType, operationId, options),
          cancel: operationId => api().sessionCancel(operationId),
        },
        source: op.source, operationId: op.id, context: context(), chatSessionId: (window as any).currentSessionId || undefined,
        pressedAt: op.pressedAt, streamConnectedAt,
        hooks: {
          partial: value => { if (current === op) stripText(value) },
          final: result => { completeCloud(op, result) },
          empty: () => { if (current !== op) return; current = null; hideStrip(op); setState('idle') },
          error: code => { void fail(op, code) },
        },
      })
      op.pipeline = pipeline
      await pipeline.start(stream)
      if (current !== op) { await pipeline.cancel(); return }
    }
    beginTimers(op)
    if (op.stopWhenReady) voiceStop()
  } catch (error) { await fail(op, error instanceof Error ? error.message : 'voice-start-failed') }
}
function completeCloud(op: Operation, result: PipelineFinal): void {
  if (current !== op) return
  current = null
  reportVoiceMetrics(result.metrics)
  hideStrip(op)
  insert(op, result.text, result.rawText)
  void release(op).finally(() => { if (!current) setState('idle') })
}
function voiceStop(): void {
  const op = current; if (!op || state !== 'recording') return
  clearTimers(op); setState('transcribing')
  if (op.streaming) {
    stripText(tt('voice_input_transcribing'))
    void (async () => {
      try {
        await op.pcm?.stop()
      } catch (error) { await fail(op, error instanceof Error ? error.message : 'voice-stop-failed') }
    })()
  } else {
    // The strip keeps the latest partial text while the full-audio pass runs;
    // the pipeline delivers final/empty/error through its hooks.
    void op.pipeline?.stop()
  }
}
async function voiceCancel(silent = false): Promise<void> {
  const op = current; if (!op) return
  current = null; setState('cancelling'); hideStrip(op)
  const results = await Promise.allSettled([release(op), api().sessionCancel(op.id)])
  if (!current) setState('idle')
  const reply = results[1]
  if (reply?.status === 'rejected' || reply?.status === 'fulfilled' && reply.value?.complete === false) {
    if (silent) throw new Error('The microphone operation did not finish closing')
    await alert(`${tt('voice_transcribe_failed')}：voice-cancel-incomplete`)
  } else if (!silent) showToast(tt('voice_cancelled'))
}
export function cancelVoiceForChat(): Promise<void> { return voiceCancel(true) }
function sessionEvent(event: VoiceSessionEvent): void {
  const op = current
  if (!op || !op.streaming || event.sessionId !== op.id) return
  if (event.seq !== undefined) {
    if (event.seq <= op.sequence) return
    if (event.seq !== op.sequence + 1) { void fail(op, 'speech-event-sequence'); return }
    op.sequence = event.seq
  }
  if (event.type === 'partial') { stripText(event.text || ''); return }
  if (event.type === 'status' && event.code === 'speech-recovering') { stripText(tt('voice_live_recovering')); return }
  if (event.type === 'error') { void fail(op, event.code || 'speech-failed'); return }
  if (event.type === 'final') {
    current = null; void release(op); hideStrip(op); insert(op, event.text, event.rawText); setState('idle')
  }
}

const HOLD_MS = 400
export function registerVoiceComposer(button: HTMLElement | null, insertInto: ((text: string) => void) | null): () => void {
  if (!button) return () => {}
  buttons.push(button)
  let pressed = false, pressedAt = 0
  const down = (event: Event) => {
    if ((event as PointerEvent).button !== 0) return
    if (state === 'idle') { pressed = true; pressedAt = Date.now(); void voiceStart(insertInto, button) }
    else pressed = false
  }
  const up = () => {
    if (!pressed || Date.now() - pressedAt < HOLD_MS) return
    if (state === 'recording') voiceStop()
    else if (state === 'starting' && current) current.stopWhenReady = true
  }
  const click = () => {
    if (state === 'recording' && !pressed) voiceStop()
    else if (state === 'idle' && !pressed) void voiceStart(insertInto, button)
    pressed = false
  }
  button.addEventListener('pointerdown', down)
  button.addEventListener('pointerup', up)
  button.addEventListener('click', click)
  return () => {
    button.removeEventListener('pointerdown', down)
    button.removeEventListener('pointerup', up)
    button.removeEventListener('click', click)
    const index = buttons.indexOf(button)
    if (index >= 0) buttons.splice(index, 1)
    if (insertInto && current?.insert === insertInto) void voiceCancel()
  }
}
export function initVoice(injected: VoiceDeps): void {
  deps = injected; registerVoiceComposer(document.getElementById('voice-input-btn'), null)
  // The toggle key is a configurable command now (composerToggleVoice, ⌘⇧V by
  // default), so the listener lives in the keybinding runtime instead of here —
  // hardcoding it would keep firing the old key after the user rebinds it.
  // Escape-to-cancel stays local: it is a property of an in-flight recording
  // rather than a command a user would expect to find in the shortcuts list.
  bindCommandHandler('composerToggleVoice', () => {
    if (state === 'recording') { voiceStop(); return true }
    if (state === 'idle') { void voiceStart(null); return true }
    return false
  })
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && current) { event.preventDefault(); event.stopPropagation(); void voiceCancel() }
  }, true)
  document.addEventListener('visibilitychange', () => { if (document.hidden && current) void voiceCancel() })
  window.addEventListener('pagehide', () => {
    const op = current; current = null
    if (op) { void release(op); void api().sessionCancel(op.id).catch(() => {}) }
  })
  setState('idle'); api().onSessionEvent?.(sessionEvent)
}
