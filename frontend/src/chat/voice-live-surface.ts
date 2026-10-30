export interface VoiceLiveSurface {
  show(value: string): void
  text(value: string): void
  timer(value: string): void
  hide(): void
}

/** Resolve the surface belonging to the pressed button, including cloned composers. */
export function voiceLiveSurface(button: HTMLElement | null): VoiceLiveSurface {
  const root = button?.closest<HTMLElement>('.proposed-plan-review, #input-area, #side-input-area')
    ?? document.getElementById('input-area') ?? button?.parentElement
  let strip = root?.querySelector<HTMLElement>('[data-voice-live], [id$="voice-live-strip"]') ?? null
  if (!strip && root) {
    strip = document.createElement('div')
    strip.hidden = true
    strip.dataset.voiceLive = ''
    const dot = document.createElement('span'); dot.className = 'voice-live-dot'; dot.setAttribute('aria-hidden', 'true')
    const text = document.createElement('span'); text.dataset.voiceLiveText = ''
    const timer = document.createElement('span'); timer.dataset.voiceLiveTimer = ''
    strip.append(dot, text, timer)
    root.prepend(strip)
  }
  strip?.setAttribute('data-voice-live', '')
  const text = strip?.querySelector<HTMLElement>('[data-voice-live-text], [id$="voice-live-text"]')
  const timer = strip?.querySelector<HTMLElement>('[data-voice-live-timer], [id$="voice-live-timer"]')
  text?.setAttribute('data-voice-live-text', '')
  timer?.setAttribute('data-voice-live-timer', '')
  // Partial changes are announced without moving the text selection or cursor.
  strip?.setAttribute('role', 'status')
  return {
    show(value) { if (strip) strip.hidden = false; if (text) text.textContent = value; if (timer) timer.textContent = '0:00' },
    text(value) { if (text) { text.textContent = value; text.scrollTop = text.scrollHeight } },
    timer(value) { if (timer) timer.textContent = value },
    hide() { if (strip) strip.hidden = true; if (text) text.textContent = '' },
  }
}
