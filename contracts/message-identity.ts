function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

/** A submitted identity survives server UUID assignment and history hydration. */
export function clientMessageId(value: unknown): string | undefined {
  const row = record(value)
  const nested = record(row?.message)
  const metadata = record(row?.localRender) ?? record(nested?.localRender)
  const id = row?.clientMessageId ?? metadata?.clientMessageId
  return typeof id === 'string' && id.length > 0 && id.length <= 512 ? id : undefined
}

/** UUIDs identify server records; submitted identities identify the original input. */
export function sameUserMessage(left: unknown, right: unknown): boolean {
  const a = record(left), b = record(right)
  const leftClient = clientMessageId(left), rightClient = clientMessageId(right)
  if (leftClient && rightClient) return leftClient === rightClient
  return typeof a?.uuid === 'string' && a.uuid.length > 0 && a.uuid === b?.uuid
}
