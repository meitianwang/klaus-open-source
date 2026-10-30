export const VOICE_CORRECTION_START_MS = 200
export const VOICE_CORRECTION_IDLE_MS = 15000
const normalize = (text: string) => text.replace(/[\r\n\u200B-\u200F\uFEFF]/g, '')

/** Ignore unmodified dictation, discarded drafts and wholesale rewrites. */
export function isVoiceCorrection(original: string, current: string, inserted: string[]): boolean {
  const before = normalize(original), after = normalize(current)
  if (!after.trim() || before === after || inserted.every(text => after.includes(normalize(text)))) return false
  if (current.length < original.length * 0.2) return false
  const a = before.slice(0, 1000), b = after.slice(0, 1000)
  // Bounded character LCS counts additions and removals without retaining drafts.
  let previous = new Uint16Array(b.length + 1)
  for (let i = 0; i < a.length; i++) {
    const row = new Uint16Array(b.length + 1)
    for (let j = 0; j < b.length; j++) row[j + 1] = a[i] === b[j] ? previous[j]! + 1 : Math.max(previous[j + 1]!, row[j]!)
    previous = row
  }
  const common = previous[b.length]!, removed = a.length - common, added = b.length - common
  return removed <= a.length * 0.5 && removed + added <= a.length * 2
}

interface TrackerOptions {
  read(): string | null
  valid(): boolean
  finish(value: string): void
  schedule?(run: () => void, milliseconds: number): () => void
}

/** One bounded correction window, reset only by edits to its original composer. */
export class VoiceCorrectionTracker {
  private cancel?: () => void
  private active = false
  private started = false
  private readonly schedule: NonNullable<TrackerOptions['schedule']>
  constructor(private readonly options: TrackerOptions) {
    this.schedule = options.schedule ?? ((run, milliseconds) => { const timer = setTimeout(run, milliseconds); return () => clearTimeout(timer) })
  }
  start(): void {
    this.stop(); this.started = true
    this.cancel = this.schedule(() => {
      if (!this.options.valid() || this.options.read() === null) { this.stop(); return }
      this.active = true; this.arm()
    }, VOICE_CORRECTION_START_MS)
  }
  edited(): void { if (this.active) this.arm() }
  private arm(): void {
    this.cancel?.()
    this.cancel = this.schedule(() => this.finish(), VOICE_CORRECTION_IDLE_MS)
  }
  finish(): void {
    if (!this.started) return
    const current = this.options.valid() ? this.options.read() : null
    this.stop()
    if (current !== null) this.options.finish(current)
  }
  stop(): void { this.cancel?.(); this.cancel = undefined; this.active = false; this.started = false }
}
