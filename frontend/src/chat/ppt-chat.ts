import type { PptChatRequest } from '../../bridge/ppt-api'

export interface PptChatEnvironment {
  currentSession(): string | null
  stage(text: string): void
  focus(): void
  send(onAccepted: () => void, expectedSessionId: string): Promise<unknown>
  reply(requestId: string, ok: boolean, error?: string): Promise<unknown>
  toast(message: string): void
  text(key: string): string
}

/** Editor actions use the current chat's composer and acknowledge actual acceptance. */
export function createPptChatConsumer(env: PptChatEnvironment) {
  let queue: Promise<unknown> = Promise.resolve()
  const attempts = new Map<string, Promise<void>>()
  const completed = new Set<string>()
  async function consume(payload: PptChatRequest): Promise<void> {
    let ok = false, accepted = false, error: string | undefined
    try {
      if (!payload?.requestId || !payload.sessionId || !payload.id || typeof payload.text !== 'string' || typeof payload.submit !== 'boolean') throw new Error(env.text('ppt_chat_invalid_request'))
      if (payload.sessionId !== env.currentSession()) throw new Error(env.text('ppt_chat_wrong_session'))
      if (!payload.text.trim()) throw new Error(env.text('ppt_chat_empty_request'))
      env.stage(payload.text)
      if (payload.submit) {
        await env.send(() => { accepted = true }, payload.sessionId)
        ok = accepted
        if (!accepted) error = env.text(payload.sessionId === env.currentSession() ? 'ppt_chat_not_accepted' : 'ppt_chat_wrong_session')
      } else {
        env.focus()
        ok = true
      }
    } catch (reason) {
      const failure = reason instanceof Error ? reason.message : String(reason)
      // Acceptance remains true if later composer bookkeeping reports an error.
      ok = accepted
      if (!accepted) error = failure
      env.toast(failure)
    } finally {
      try { await env.reply(payload?.requestId || '', ok, error) }
      catch (reason) { env.toast(reason instanceof Error ? reason.message : String(reason)) }
    }
  }
  return (payload: PptChatRequest): Promise<void> => {
    const id = payload?.requestId || ''
    const prior = attempts.get(id)
    if (prior) return prior
    const pending = queue.then(() => consume(payload))
    attempts.set(id, pending)
    queue = pending.catch(() => undefined)
    const remember = () => {
      completed.add(id)
      while (completed.size > 128) {
        const oldest = completed.values().next().value
        if (oldest === undefined) break
        completed.delete(oldest)
        attempts.delete(oldest)
      }
    }
    void pending.then(remember, remember)
    return pending
  }
}
