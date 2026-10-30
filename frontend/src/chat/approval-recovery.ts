interface PendingApproval {
  requestId: string
  sessionId?: string
}

/** A host snapshot and live pushes share the same request identity. */
export function createApprovalRecovery<T extends PendingApproval>(options: {
  read(sessionId: string): Promise<T[]>
  contains(request: T): boolean
  receive(request: T): void
}) {
  const settled = new Set<string>()
  const versions = new Map<string, number>()
  const accepts = (request: T) => !!request?.requestId && !settled.has(request.requestId) && !options.contains(request)
  const invalidate = (sessionId: string) => {
    const version = (versions.get(sessionId) || 0) + 1
    versions.set(sessionId, version)
    return version
  }
  return {
    accepts,
    settle(requestId: string) { settled.add(requestId) },
    invalidate,
    async restore(sessionId: string): Promise<void> {
      if (!sessionId) return
      const version = invalidate(sessionId)
      try {
        const requests = await options.read(sessionId)
        if (versions.get(sessionId) !== version || !Array.isArray(requests)) return
        for (const request of requests) {
          if (request?.sessionId === sessionId && accepts(request)) options.receive(request)
        }
      } catch { /* A later session switch retries without changing the approval. */ }
    },
  }
}
