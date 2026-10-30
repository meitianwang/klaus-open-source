import type { ComposerDocumentToken } from './document-model'

/** Plain clipboard data keeps linked identities and complete file addresses. */
export function composerTokenClipboardText(token: ComposerDocumentToken): string {
  if (/^\[(?:\\.|[^\\\]])*\]\(klaus:[^\s)]+\)$/.test(token.value)) return token.value
  const data = token.data as Record<string, unknown> | null
  if (data?.kind === 'file' || data?.kind === 'folder') {
    const path = data.path || data.rel || data.id
    if (typeof path === 'string' && path) return path
  }
  return token.label
}
