export interface ChannelPresentationState {
  enabled?: boolean
  connected?: boolean
  credentials?: Record<string, string>
}

export function isChannelConfigured(
  state: ChannelPresentationState | null | undefined,
  requiredCredentialKeys: readonly string[],
): boolean {
  if (state?.enabled !== true) return false
  return requiredCredentialKeys.every(key => Boolean(state.credentials?.[key]?.trim()))
}

export function isSavedChannelFailure(result: unknown): result is { ok: false; saved: true; error?: string } {
  if (!result || typeof result !== 'object') return false
  const value = result as { ok?: unknown; saved?: unknown }
  return value.ok === false && value.saved === true
}
