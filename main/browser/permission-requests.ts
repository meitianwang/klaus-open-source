// Browser permission prompts the renderer answers with its own dialog.
//
// The host must not ask a permission question through an operating-system box:
// the confirmation surface belongs to the product window, which already owns
// the dialog component every other confirmation uses and knows the current
// theme and language. So the host parks each request here, pushes it to the
// renderer and waits for the matching answer channel.
//
// Three exits settle a parked request: the renderer's answer, the timeout, and
// host shutdown. Only an explicit allow resolves true — a permission question
// the user never answered must not grant anything.

export interface BrowserPermissionPrompt {
  sessionId: string
  permission: string
  origin: string
  pageUrl: string
}

export interface PendingBrowserPermission extends BrowserPermissionPrompt {
  requestId: string
}

interface Parked {
  resolve: (allowed: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

/** How long a question stays open before it settles as a denial. */
export const BROWSER_PERMISSION_TIMEOUT_MS = 120_000

export class PendingBrowserPermissions {
  private readonly pending = new Map<string, Parked>()
  private sequence = 0

  constructor(private readonly timeoutMs: number = BROWSER_PERMISSION_TIMEOUT_MS, private readonly onSettled?: (requestId: string) => void) {}

  /**
   * Park one request. The returned promise settles exactly once, on the first
   * of answer/timeout/clear, so the caller can await it without racing the
   * other two exits.
   */
  request(prompt: BrowserPermissionPrompt): { requestId: string; answered: Promise<boolean> } {
    const requestId = `bp-${++this.sequence}`
    let resolve!: (allowed: boolean) => void
    const answered = new Promise<boolean>(done => { resolve = done })
    const timer = setTimeout(() => { this.settle(requestId, false) }, this.timeoutMs)
    this.pending.set(requestId, { resolve, timer })
    return { requestId, answered }
  }

  /** Answer one parked request. False when the id is unknown or already settled. */
  answer(requestId: string, allowed: boolean): boolean {
    return this.settle(requestId, allowed === true)
  }

  /** How many questions are still open, for diagnostics and tests. */
  size(): number {
    return this.pending.size
  }

  /** Reject everything open, so no caller hangs forever on host shutdown. */
  clear(): void {
    for (const requestId of [...this.pending.keys()]) this.settle(requestId, false)
  }

  private settle(requestId: string, allowed: boolean): boolean {
    const parked = this.pending.get(requestId)
    if (!parked) return false
    this.pending.delete(requestId)
    clearTimeout(parked.timer)
    parked.resolve(allowed)
    this.onSettled?.(requestId)
    return true
  }
}

/**
 * Remembered permission decisions of the embedded browser, keyed by
 * [conversation, origin, permission].
 *
 * A page re-asks for the same permission whenever its own state changes: a
 * screen wake lock is released the moment the page loses visibility, and a
 * well-behaved page requests it again on the way back. Only an explicit allow
 * used to be remembered, so every refusal (or every question the user never
 * answered before it expired) opened the dialog again on the next request.
 * Decisions therefore stick in both directions for the lifetime of the
 * conversation, and concurrent requests for the same keys share one question
 * instead of queueing a second dialog behind the first.
 */
export class BrowserPermissionDecisions {
  private readonly grants = new Set<string>()
  private readonly denials = new Set<string>()
  private readonly inflight = new Map<string, Promise<boolean>>()

  /** Screen wake locks need no prompt; explicit denials still take precedence. */
  granted(keys: string[], permission?: string): boolean {
    return keys.length > 0 && keys.every(key =>
      !this.denials.has(key) && (this.grants.has(key) || permission === 'screen-wake-lock'))
  }

  denied(keys: string[]): boolean {
    return keys.some(key => this.denials.has(key))
  }

  /**
   * Settle one permission request. Already-decided keys settle without asking;
   * a question still open for the same keys is shared with the new caller.
   * A refusal, explicit or by expiry, is remembered as a denial; an allow is
   * remembered only while `accept` still holds at answer time, so an allow
   * answered after the page moved away grants nothing and asks again later.
   */
  resolve(keys: string[], ask: () => Promise<boolean>, accept: () => boolean, permission?: string): Promise<boolean> {
    if (this.denied(keys)) return Promise.resolve(false)
    if (this.granted(keys, permission)) return Promise.resolve(true)
    const promptKey = [...keys].sort().join('|')
    const open = this.inflight.get(promptKey)
    if (open) return open
    const settled = ask().then(allowed => {
      this.inflight.delete(promptKey)
      if (allowed !== true) {
        // A fresh grant made while the question was open outranks the stale
        // refusal, so only undecided keys become denials.
        for (const key of keys) if (!this.grants.has(key)) this.denials.add(key)
        return false
      }
      if (!accept()) return false
      for (const key of keys) this.grants.add(key)
      return true
    }, () => {
      this.inflight.delete(promptKey)
      return false
    })
    this.inflight.set(promptKey, settled)
    return settled
  }

  /** Apply an explicit setting: granted, denied, or back to asking. */
  set(keys: string[], setting: string): void {
    for (const key of keys) {
      this.grants.delete(key)
      this.denials.delete(key)
      if (setting === 'granted') this.grants.add(key)
      else if (setting === 'denied') this.denials.add(key)
    }
  }

  /** Drop every remembered decision whose key the predicate owns. */
  forget(owned: (key: string) => boolean): void {
    for (const state of [this.grants, this.denials]) for (const key of [...state]) if (owned(key)) state.delete(key)
  }

  clear(): void {
    this.grants.clear()
    this.denials.clear()
  }
}
