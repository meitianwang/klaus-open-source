export interface RemovalRequest {
  sessionId: string
  id: string
  expectedRevision?: number
  clientMutationId: string
  mutationFingerprint: string
}

export async function createQueueRemovalRequest(input: Omit<RemovalRequest, 'clientMutationId' | 'mutationFingerprint'>): Promise<RemovalRequest> {
  const bytes = new TextEncoder().encode(JSON.stringify(input))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const mutationFingerprint = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
  return { ...input, clientMutationId: crypto.randomUUID(), mutationFingerprint }
}

/** Replay the same durable removal receipt when its transport acknowledgement is lost. */
export async function removeQueuedWithReceipt<T>(
  send: (request: RemovalRequest) => Promise<T>,
  input: { sessionId: string; id: string; expectedRevision?: number },
  identity?: Pick<RemovalRequest, 'clientMutationId' | 'mutationFingerprint'>,
): Promise<T> {
  const request = identity ? { ...input, ...identity } : await createQueueRemovalRequest(input)
  for (let attempt = 0; ; attempt++) {
    try { return await send(request) }
    catch (error) { if (attempt === 2) throw error }
  }
}
