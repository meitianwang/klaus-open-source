import { VoiceSessionCapture, type PcmCaptureHandle } from './chat/voice-session-capture'
import { DictationPipeline } from './chat/voice-pipeline'
import { voiceErrorKey } from './chat/voice-errors'
import { VOICE_AUDIO_MAX_MS, isVoiceInputSource, type VoiceInputSource } from '../../shared/voice-input'
import { installTabFocusPolicy } from './app/tab-focus-policy'

installTabFocusPolicy()

// Vite inlines this page and its narrow bridge into quick-input.html.
const api = (window as any).klausQuickInput
const input = document.getElementById('qi-input') as HTMLInputElement
const hintSend = document.getElementById('qi-hint-send')!
const hintClose = document.getElementById('qi-hint-close')!
const micBtn = document.getElementById('qi-mic') as HTMLButtonElement | null
const liveText = document.getElementById('qi-live-text')
let submitting = false, pageGeneration = 0, focusedOnce = false
let activationId: string | undefined
const COPY = {
  en: { placeholder: 'Ask Klaus anything…', send: 'Send', close: 'Close', micDenied: 'Microphone access is denied. Grant it in System Settings, then try again.', noCreds: 'Custom voice input needs a transcription key. Configure an OpenAI API model in Klaus Settings → Model Sources, or choose an account source in Settings → Voice.', failed: 'Transcription failed', submitFailed: 'Could not send', unconfirmed: 'Open the main Klaus window to check this message before sending again.', tooLarge: 'The recording is too large.', sourceUnavailable: 'The selected voice input source is unavailable. Choose a supported source in Klaus Settings → Voice.', sourceChanged: 'The voice input source changed. Start a new recording.', providerAuth: 'Sign in to the selected speech provider in Klaus Settings → Voice.', providerUsage: 'The selected speech provider reached a usage or billing limit. Check its account allowance before retrying.', providerFailed: 'The selected speech provider could not transcribe this recording. Check its account connection and try again.' },
  zh: { placeholder: '让 Klaus 帮你做点什么…', send: '发送', close: '关闭', micDenied: '麦克风权限被拒绝，请在系统设置中授权后重试。', noCreds: '自定义语音输入需要转写密钥，请在 Klaus 设置 → 模型来源中添加 OpenAI API 模型，或在设置 → 语音中选择账号来源。', failed: '转写失败', submitFailed: '发送失败', unconfirmed: '请先在 Klaus 主窗口检查这条消息，再决定是否重新发送。', tooLarge: '录音过大。', sourceUnavailable: '所选语音输入来源不可用，请在 Klaus 设置 → 语音中选择受支持的来源。', sourceChanged: '语音输入来源已更改，请重新录音。', providerAuth: '请在 Klaus 设置 → 语音中登录所选语音服务。', providerUsage: '所选语音服务已达到用量或计费限制，请检查账号额度后重试。', providerFailed: '所选语音服务未能转写此录音，请检查账号连接后重试。' },
}
function voiceFailure(code: string): string {
  const key = voiceErrorKey(code), copy = COPY[lang]
  if (key === 'voice_source_unavailable') return copy.sourceUnavailable
  if (key === 'voice_source_changed') return copy.sourceChanged
  if (key === 'voice_provider_auth_required') return copy.providerAuth
  if (key === 'voice_provider_usage_limit') return copy.providerUsage
  if (key) return copy.providerFailed
  return `${copy.failed}: ${code}`
}
let lang: 'en' | 'zh' = 'en'
function applyLanguage(next: unknown) {
  lang = next === 'zh' ? 'zh' : 'en'
  input.placeholder = COPY[lang].placeholder
  hintSend.textContent = COPY[lang].send
  hintClose.textContent = COPY[lang].close
}
api?.getLanguage?.().then((value: unknown) => { if (!focusedOnce) applyLanguage(value) }).catch(() => {})

type VoiceState = 'idle' | 'starting' | 'recording' | 'transcribing'
interface Capture {
  id: string
  source: VoiceInputSource
  streaming?: boolean
  pcm?: PcmCaptureHandle
  pipeline?: DictationPipeline
  sequence: number
  startedAt: number
  cancelled: boolean
  stream?: MediaStream
  timer?: ReturnType<typeof setTimeout>
}
let state: VoiceState = 'idle', capture: Capture | undefined
const VOICE_MAX_MS = VOICE_AUDIO_MAX_MS
function setVoiceState(next: VoiceState) {
  state = next
  if (micBtn) { micBtn.dataset.voiceState = next; micBtn.disabled = next === 'transcribing' || next === 'starting' }
}
function current(value: Capture) { return capture === value && !value.cancelled }
function release(value: Capture) {
  if (value.timer) clearTimeout(value.timer)
  value.timer = undefined
  try { value.stream?.getTracks().forEach(track => track.stop()) } catch {}
  value.stream = undefined
}
function cancelVoice() {
  const value = capture
  capture = undefined
  if (value) {
    value.cancelled = true
    void value.pcm?.close()
    void value.pipeline?.cancel()
    void api?.sessionCancel?.(value.id).catch(() => {})
    release(value)
  }
  if (liveText) { liveText.hidden = true; liveText.textContent = '' }
  setVoiceState('idle')
}
function hide() {
  pageGeneration++; cancelVoice()
  void api?.hide?.(activationId).catch(() => {})
}
api?.onFocus?.((payload: { language?: unknown; preserveDraft?: boolean; activationId?: string }) => {
  focusedOnce = true; pageGeneration++
  activationId = payload?.activationId
  applyLanguage(payload?.language); cancelVoice()
  if (!payload?.preserveDraft) input.value = ''
  submitting = false
  requestAnimationFrame(() => input.focus())
})
async function startRecording() {
  if (capture) return
  const value: Capture = { id: crypto.randomUUID(), source: 'custom', sequence: 0, startedAt: 0, cancelled: false }
  capture = value; setVoiceState('starting')
  try {
    const config = await api?.voiceConfig?.(value.id)
    if (!current(value)) return
    if (config?.ok === false || !isVoiceInputSource(config?.source) || config.sourceAvailable === false) throw new Error('voice-source-unavailable')
    value.source = config.source
    value.streaming = config.source === 'system' || config.streaming === true
    const permission = await api?.micPermission?.(value.id)
    if (!current(value)) return
    if (!permission?.ok) throw new Error(COPY[lang].micDenied)
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    if (!current(value)) { stream.getTracks().forEach(track => track.stop()); return }
    value.stream = stream
    if (value.streaming) {
      value.pcm = new VoiceSessionCapture(stream, { transport: api, operationId: value.id, source: value.source, context: input.value.slice(-4000),
        ready: id => { if (current(value)) value.id = id }, failed: error => { if (current(value)) { cancelVoice(); alert(`${COPY[lang].failed}: ${error.message}`) } } })
      await value.pcm.start()
      if (!current(value)) { await value.pcm.close(); return }
      if (liveText) { liveText.hidden = false; liveText.textContent = lang === 'zh' ? '聆听中…' : 'Listening…' }
      value.startedAt = Date.now(); setVoiceState('recording'); value.timer = setTimeout(stopRecording, VOICE_MAX_MS)
      return
    }
    // Cloud sources stream through the shared pipeline. This popup inserts
    // only final text, so rolling partials stay disabled and one dictation
    // remains a single provider transcription call.
    const pipeline = new DictationPipeline({
      transport: {
        transcribe: (data, mimeType, operationId, options) => api.transcribe(data, mimeType, operationId, options),
        cancel: operationId => api.sessionCancel?.(operationId) ?? Promise.resolve(null),
      },
      source: value.source, operationId: value.id, context: input.value.slice(-4000),
      livePartials: false,
      hooks: {
        final: result => finishRecording(value, result.text),
        empty: () => { if (current(value)) cancelVoice() },
        error: code => {
          if (!current(value)) return
          cancelVoice()
          alert(code === 'no-credentials' ? COPY[lang].noCreds : code === 'audio-too-large' ? COPY[lang].tooLarge : voiceFailure(code))
        },
      },
    })
    value.pipeline = pipeline
    await pipeline.start(stream)
    if (!current(value)) { await pipeline.cancel(); return }
    value.startedAt = Date.now(); setVoiceState('recording')
    value.timer = setTimeout(stopRecording, VOICE_MAX_MS)
  } catch (error: any) {
    if (current(value)) { cancelVoice(); alert(voiceFailure(String(error?.message || error))) }
    else release(value)
  }
}
function stopRecording() {
  const value = capture
  if (!value || state !== 'recording') return
  if (value.timer) clearTimeout(value.timer)
  value.timer = undefined
  if (value.streaming) {
    setVoiceState('transcribing')
    void (async () => {
      await value.pcm?.stop()
    })().catch(error => { if (current(value)) { cancelVoice(); alert(`${COPY[lang].failed}: ${String(error?.message || error)}`) } })
  } else {
    setVoiceState('transcribing')
    void value.pipeline?.stop()
  }
}
function finishRecording(value: Capture, text: string | undefined) {
  release(value)
  if (!current(value)) return
  capture = undefined
  const trimmed = text?.trim()
  if (trimmed) {
    const existing = input.value
    input.value = existing + (existing && !/\s$/.test(existing) ? ' ' : '') + trimmed
    input.focus()
  }
  setVoiceState('idle')
}
api?.onSessionEvent?.((event: { sessionId?: string; seq?: number; type?: string; text?: string; code?: string }) => {
  const value = capture
  if (!value || !current(value) || !value.streaming || event.sessionId !== value.id) return
  if (event.seq !== undefined) {
    if (event.seq <= value.sequence) return
    if (event.seq !== value.sequence + 1) { cancelVoice(); alert(`${COPY[lang].failed}: speech-event-sequence`); return }
    value.sequence = event.seq
  }
  if (event.type === 'partial' && liveText) { liveText.textContent = event.text || ''; liveText.scrollTop = liveText.scrollHeight }
  if (event.type === 'error') { cancelVoice(); alert(voiceFailure(event.code || 'speech-failed')); return }
  if (event.type === 'final') {
    const text = event.text?.trim()
    if (text) input.value += (input.value && !/\s$/.test(input.value) ? ' ' : '') + text
    cancelVoice(); input.focus()
  }
})
micBtn?.addEventListener('click', () => {
  if (state === 'recording') stopRecording()
  else if (state === 'idle') void startRecording()
})
input.addEventListener('keydown', async event => {
  if (event.key === 'Escape') {
    event.preventDefault()
    // Recorded audio is still local, so the first Escape can cancel without hiding.
    if (state === 'recording') cancelVoice()
    else hide()
    return
  }
  if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return
  event.preventDefault()
  const text = input.value.trim(), generation = pageGeneration
  if (!text || submitting) return
  submitting = true
  try {
    const result = await api?.submit?.(text)
    if (generation !== pageGeneration) return
    if (result?.ok) input.value = ''
    else alert(result?.error === 'quick-input-submission-unconfirmed' ? COPY[lang].unconfirmed : `${COPY[lang].submitFailed}: ${result?.error || 'unknown'}`)
  } catch (error: any) {
    if (generation === pageGeneration) alert(`${COPY[lang].submitFailed}: ${String(error?.message || error)}`)
  } finally { if (generation === pageGeneration) submitting = false }
})
window.addEventListener('focus', () => input.focus())
window.addEventListener('blur', () => { if (!document.hasFocus()) hide() })
window.addEventListener('pagehide', () => { pageGeneration++; cancelVoice() })
document.addEventListener('visibilitychange', () => { if (document.hidden) hide() })
export {}
