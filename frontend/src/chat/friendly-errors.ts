// User-facing wording for host envelope failures. The transport prefixes
// ("channel 'x' failed: app-server rpc error -32000: ...") are diagnostics for
// logs; the transcript shows a sentence that names the problem and the remedy
// instead of the wire jargon. Bare engine strings keep their existing
// kind-based wording, so only envelope-wrapped host failures are remapped.

export interface HostEnvelope {
  channel?: string
  inner: string
  enveloped: boolean
}

const CHANNEL_PREFIX = /^channel '([^']+)' failed: /
const RPC_PREFIX = /^app-server rpc error -?\d+: /

/** Strip the host/router envelopes and keep the channel plus the inner reason. */
export function parseHostEnvelope(raw: string): HostEnvelope {
  let rest = raw.trim()
  let channel: string | undefined
  const channelMatch = CHANNEL_PREFIX.exec(rest)
  if (channelMatch) {
    channel = channelMatch[1]
    rest = rest.slice(channelMatch[0].length)
  }
  const rpcMatch = RPC_PREFIX.exec(rest)
  const enveloped = channelMatch !== null || rpcMatch !== null
  if (rpcMatch) rest = rest.slice(rpcMatch[0].length)
  return { channel, inner: rest.trim(), enveloped }
}

const AUTH_FAILURE =
  /OAuth token refresh failed|OAuth refresh failed|refresh_token_invalidated|login_expired|Your session has ended|credential (?:is )?(?:missing|invalid|no longer stored)|requires (?:re-?)?login|not (?:logged in|authenticated)/i
const NETWORK_FAILURE =
  /timed? ?out|\btimeout\b|connection (?:refused|reset|closed|failed)|network (?:is )?unreachable|ECONN[A-Z]+|ENOTFOUND|EAI_AGAIN|dns (?:lookup )?(?:failed|error)/i
const STARTUP_CHANNEL = /^session:(?:new|start)$|^session\/prepare$/

/**
 * Map an envelope failure to localized, actionable copy. Returns undefined when
 * the text is not an envelope failure or not one of these families, so callers
 * keep their own wording.
 */
export function friendlyErrorText(raw: string, t: (key: string) => string): string | undefined {
  const { channel, inner, enveloped } = parseHostEnvelope(raw)
  if (!enveloped) return undefined
  if (AUTH_FAILURE.test(inner)) return t('error_auth_expired')
  if (NETWORK_FAILURE.test(inner)) return t('error_network_unreachable')
  if (channel && STARTUP_CHANNEL.test(channel) && inner) {
    return t('error_startup_generic').replace('{detail}', inner)
  }
  return undefined
}
