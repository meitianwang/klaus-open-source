import { resourceReferenceValue } from '../../../../shared/composer-reference-scan'
import type { ComposerReferenceToken } from './reference-token'

export interface WorkspaceReferenceTarget {
  rel: string
  name?: string
  path?: string
  isDir?: boolean
}

/** Keep the authored target in the input, including repeated occurrences. */
export function workspaceReference(target: WorkspaceReferenceTarget): Omit<ComposerReferenceToken, 'range'> {
  const rel = target.isDir ? target.rel.replace(/[\\/]+$/, '') || target.rel : target.rel
  const name = target.name || rel.split(/[\\/]/).filter(Boolean).pop() || rel
  const kind = target.isDir ? 'folder' : 'file'
  const path = target.path && /^(?:\/|[A-Za-z]:[\\/]|~[\\/])/.test(target.path) ? target.path : undefined
  const id = path || rel
  const address = target.isDir && !/[\\/]$/.test(rel) ? `${rel}/` : rel
  // Quoted native addresses cannot represent a literal quote in a filename.
  // A typed target preserves that exact path for model context and navigation.
  const value = (/["#]/.test(address)) ? resourceReferenceValue(kind, name, id) : `@"${address}"`
  return { kind, name, value, id, rel, ...(path ? { path } : {}) }
}

/** Import older text-only drafts without moving path references ahead of prose. */
export function workspaceReferencesIn(text: string): ComposerReferenceToken[] {
  const references: ComposerReferenceToken[] = []
  for (const match of text.matchAll(/(^|\s)@"([^"\n]+)"/g)) {
    if (match[2].endsWith(' (agent)')) continue
    const start = match.index + match[1].length
    const isDir = /[\\/]$/.test(match[2])
    const reference = workspaceReference({ rel: match[2], isDir, path: match[2] })
    references.push({ ...reference, value: match[0].slice(match[1].length), range: { start, end: start + match[0].length - match[1].length } })
  }
  return references
}
