// Shared unpacking for the `skills:builtin` host channel reply.
// The host returns `{ items, error }` where `error` reports an engine lookup
// failure while `items` still carries bundled fallback rows; older callers
// treated a bare array as the only success shape and misread the object as a
// load failure. Both shapes are accepted here so every consumer agrees.

export function skillErrorText(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message
  if (reason && typeof reason === 'object' && 'message' in reason) return String((reason as { message?: unknown }).message || reason)
  return String(reason || 'Unknown error')
}

export interface BuiltinSkillsReply<T = unknown> {
  items: T[]
  error: string | null
}

export function unpackBuiltinSkillsReply<T = unknown>(value: unknown): BuiltinSkillsReply<T> {
  if (Array.isArray(value)) return { items: value as T[], error: null }
  if (value && typeof value === 'object') {
    const reply = value as { items?: unknown; error?: unknown }
    if (Array.isArray(reply.items)) {
      const nested = reply.error
      return { items: reply.items as T[], error: nested ? skillErrorText(nested) : null }
    }
  }
  return { items: [], error: 'Built-in skills returned an invalid response' }
}
