// The `window.klausQuickInput` surface for the Quick Input mini window.
//
// Deliberately NOT the full klaus API: the mini window only submits a line of
// text, hides itself, and records voice. Giving it the whole surface would hand a
// global-hotkey window every host capability for no reason.
//
// Voice reuses the main voice:* channels — the shell routes them per channel
// name, not per window.
import { call, subscribe, expose } from './ipc.js'

expose('klausQuickInput', {
  submit: (text: string) => call('quick-input:submit', { text }),
  hide: (activationId?: string) => call('quick-input:hide', { activationId }),
  getLanguage: () => call('quick-input:language'),
  onFocus: (cb: (payload: { language: 'zh' | 'en'; activationId?: string; preserveDraft?: boolean }) => void) => {
    subscribe('quick-input:focus', (payload: { language: 'zh' | 'en'; activationId?: string; preserveDraft?: boolean }) => cb(payload))
  },
  // Voice remains scoped to this attached renderer and its operation ids.
  voiceConfig: (operationId?: string) => call('voice:config:get', { operationId }),
  micPermission: (operationId?: string) => call('voice:mic-permission', { operationId }),
  transcribe: (data: ArrayBuffer, mimeType?: string, operationId?: string, options?: { source: string; context?: string; durationMs?: number; partial?: boolean; segmentIds?: string[] }) =>
    call('voice:transcribe', { data, mimeType, operationId, ...options }),
  sessionStart: (options: { operationId: string; context?: string; source?: string }) => call('voice:session:start', options),
  sessionAudio: (sessionId: string, data: ArrayBuffer, seq: number) => call('voice:session:audio', { sessionId, data, seq }),
  sessionStop: (sessionId: string) => call('voice:session:stop', { sessionId }),
  sessionCancel: (sessionId: string) => call('voice:session:cancel', { sessionId }),
  onSessionEvent: (cb: (event: unknown) => void) => subscribe('voice:session:event', cb),
})
