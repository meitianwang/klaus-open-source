export interface RecordingEndedPayload {
  recordingId: string
  sessionId: string
  generation: number
  mode: 'stop' | 'discard' | 'error'
  eventsPath?: string
  error?: string
}

/** Keep ambiguous send failures deduplicated too; an IPC retry cannot create another turn. */
export function createRecordingHandoff(deps: {
  hasSession(sessionId: string): boolean
  send(sessionId: string): Promise<void>
  discarded(): void
  failed(message: string): void
}) {
  const deliveries = new Map<string, Promise<void>>()
  const finished: string[] = []
  return (payload: RecordingEndedPayload): Promise<void> => {
    if (!payload || typeof payload.recordingId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(payload.recordingId)
      || typeof payload.sessionId !== 'string' || !payload.sessionId || payload.sessionId.length > 256
      || !Number.isSafeInteger(payload.generation) || payload.generation < 1
      || !['stop', 'discard', 'error'].includes(payload.mode)) return Promise.reject(new Error('recording-handoff-identity-invalid'))
    const key = `${payload.recordingId}:${payload.generation}`
    const previous = deliveries.get(key)
    if (previous) return previous
    if (deliveries.size >= 128 && !finished.length) return Promise.reject(new Error('recording-handoff-busy'))
    while (deliveries.size >= 128 && finished.length) deliveries.delete(finished.shift()!)
    const task = Promise.resolve().then(async () => {
      if (payload.mode === 'discard') { deps.discarded(); return }
      if (payload.mode === 'error') { deps.failed(payload.error || 'Recording could not be completed.'); return }
      if (!deps.hasSession(payload.sessionId)) throw new Error('recording-session-no-longer-available')
      await deps.send(payload.sessionId)
    }).finally(() => { finished.push(key) })
    deliveries.set(key, task)
    return task
  }
}
