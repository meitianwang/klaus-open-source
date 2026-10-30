interface AdditionRequest {
  sessionId: string
  id: string
  item: unknown
  afterId: string | null
  beforeId: string | null
  clientMutationId: string
  mutationFingerprint: string
}

/** Replay one durable addition identity when its transport acknowledgement is lost. */
export async function addQueuedWithReceipt<T>(
  send: (request: AdditionRequest) => Promise<T>,
  input: Omit<AdditionRequest, 'clientMutationId' | 'mutationFingerprint'>,
): Promise<T> {
  const bytes = new TextEncoder().encode(JSON.stringify(input))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const mutationFingerprint = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('')
  const request = { ...input, clientMutationId: input.id, mutationFingerprint }
  for (let attempt = 0; ; attempt++) {
    try { return await send(request) }
    catch (error) { if (attempt === 2) throw error }
  }
}
