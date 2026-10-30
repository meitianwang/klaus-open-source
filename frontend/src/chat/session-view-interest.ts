interface SessionViewBridge {
  retainView(sessionId: string, viewId: string): Promise<unknown>
  releaseView(sessionId: string, viewId: string): Promise<unknown>
}

let sequence = 0

/** Keep a mounted transcript's runtime available until that exact view leaves. */
export function retainSessionView(sessionId: string): () => void {
  if (!/^[a-zA-Z0-9_-]{1,256}$/.test(sessionId) || sessionId.startsWith('__') || typeof window === 'undefined') return () => {}
  const session = (window as unknown as { klaus?: { session?: Partial<SessionViewBridge> } }).klaus?.session
  if (!session?.retainView || !session.releaseView) return () => {}
  const viewId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID() : `view-${Date.now()}-${++sequence}`
  let retained: Promise<unknown>
  try { retained = Promise.resolve(session.retainView(sessionId, viewId)) }
  catch { return () => {} }
  // Teardown may precede the IPC acknowledgement. Release after that operation
  // settles, including an unknown outcome, without retiring any newer view token.
  void retained.catch(() => {})
  let released = false
  return () => {
    if (released) return
    released = true
    void retained.catch(() => {}).then(() => session.releaseView!(sessionId, viewId)).catch(() => {})
  }
}
