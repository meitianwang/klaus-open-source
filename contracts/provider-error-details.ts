export interface ProviderSourceErrorDetails {
  message: string
  kind?: string
  code?: string
  type?: string
  status?: number
  requestId?: string
  retryAfterMs?: number
}

export interface ProviderErrorDetails {
  message: string
  kind?: string
  code?: string
  status?: number
  requestId?: string
  retryAfterMs?: number
  providerCode?: string
  providerType?: string
  providerError?: ProviderSourceErrorDetails
  recoveryReason?: string
}

function diagnosticExtras(record: Record<string, unknown>, knownKeys: readonly string[]): Record<string, unknown> {
  const extras = Object.fromEntries(Object.entries(record).filter(([key]) => !knownKeys.includes(key)))
  try {
    return JSON.parse(JSON.stringify(extras)) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function providerErrorDetails(value: unknown): ProviderErrorDetails | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const details: Partial<ProviderErrorDetails> = { ...diagnosticExtras(record, ['message', 'kind', 'code', 'requestId', 'providerCode', 'providerType', 'status', 'retryAfterMs', 'providerError', 'recoveryReason']) }
  for (const key of ['message', 'kind', 'code', 'requestId', 'providerCode', 'providerType'] as const) {
    if (typeof record[key] === 'string') details[key] = record[key]
  }
  if (typeof record.status === 'number' && Number.isInteger(record.status) && record.status >= 100 && record.status <= 599) {
    details.status = record.status
  }
  if (typeof record.retryAfterMs === 'number' && Number.isSafeInteger(record.retryAfterMs) && record.retryAfterMs >= 0) {
    details.retryAfterMs = record.retryAfterMs
  }
  const source = record.providerError
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const raw = source as Record<string, unknown>
    const provider: Partial<ProviderSourceErrorDetails> = { ...diagnosticExtras(raw, ['message', 'kind', 'code', 'type', 'requestId', 'status', 'retryAfterMs']) }
    for (const key of ['message', 'kind', 'code', 'type', 'requestId'] as const) {
      if (typeof raw[key] === 'string') provider[key] = raw[key]
    }
    if (typeof raw.status === 'number' && Number.isInteger(raw.status) && raw.status >= 100 && raw.status <= 599) provider.status = raw.status
    if (typeof raw.retryAfterMs === 'number' && Number.isSafeInteger(raw.retryAfterMs) && raw.retryAfterMs >= 0) provider.retryAfterMs = raw.retryAfterMs
    if (Object.keys(provider).length) {
      details.providerError = { message: '', ...provider }
      for (const key of ['message', 'kind', 'requestId'] as const) {
        if (details[key] === undefined && provider[key] !== undefined) details[key] = provider[key]
      }
      for (const key of ['status', 'retryAfterMs'] as const) {
        if (details[key] === undefined && provider[key] !== undefined) details[key] = provider[key]
      }
      if (details.providerCode === undefined && provider.code !== undefined) details.providerCode = provider.code
      if (details.providerType === undefined && provider.type !== undefined) details.providerType = provider.type
    }
  }
  if (typeof record.recoveryReason === 'string') details.recoveryReason = record.recoveryReason
  if (!Object.keys(details).length) return undefined
  return { message: '', ...details }
}

export function providerErrorTextWithRequestId(message: string, requestId?: string): string {
  if (requestId === undefined) return message
  const suffix = `(request-id: ${requestId})`
  return message.includes(suffix) ? message : `${message} ${suffix}`
}
