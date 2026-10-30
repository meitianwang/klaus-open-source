import type { SelectedLineRange } from '@pierre/diffs'

export interface ReviewComment {
  id: string
  fileKey: string
  path: string
  range: SelectedLineRange
  body: string
  localDiffHunk: string
  snapshotId?: string
}
export interface ReviewCommentDraft {
  id?: string
  range: SelectedLineRange
  body: string
  localDiffHunk: string
  snapshotId?: string
}
const cache = new Map<string, ReviewComment[]>()
const drafts = new Map<string, ReviewCommentDraft | null>()
export function readCommentDraft(owner: string, path: string): ReviewCommentDraft | null {
  const key = JSON.stringify([owner, path])
  if (drafts.has(key)) return drafts.get(key)!
  try {
    const value = JSON.parse(localStorage.getItem(`klaus.diff.commentDraft.${key}`) ?? 'null')
    const draft = value && typeof value.body === 'string' && typeof value.localDiffHunk === 'string'
      && Number.isSafeInteger(value.range?.start) && value.range.start > 0 && Number.isSafeInteger(value.range?.end) && value.range.end > 0 ? value : null
    drafts.set(key, draft); return draft
  } catch { return null }
}
export function writeCommentDraft(owner: string, path: string, draft: ReviewCommentDraft | null): void {
  const key = JSON.stringify([owner, path])
  drafts.set(key, draft)
  try {
    if (draft) localStorage.setItem(`klaus.diff.commentDraft.${key}`, JSON.stringify(draft))
    else localStorage.removeItem(`klaus.diff.commentDraft.${key}`)
  } catch {}
}
export function readComments(scope: string): ReviewComment[] {
  if (cache.has(scope)) return cache.get(scope)!
  try {
    const saved = JSON.parse(localStorage.getItem(`klaus.diff.comments.${scope}`) ?? '[]')
    const comments = Array.isArray(saved) ? saved.filter(row => typeof row.id === 'string' && typeof row.body === 'string'
      && typeof row.fileKey === 'string' && typeof row.path === 'string' && Number.isSafeInteger(row.range?.start)
      && Number.isSafeInteger(row.range?.end) && row.range.start > 0 && row.range.end > 0) : []
    const normalized = comments.map(row => ({ ...row, localDiffHunk: typeof row.localDiffHunk === 'string' ? row.localDiffHunk : '' }))
    cache.set(scope, normalized); return normalized
  } catch { return [] }
}
export function writeComments(scope: string, comments: ReviewComment[]): void {
  cache.set(scope, comments)
  try { localStorage.setItem(`klaus.diff.comments.${scope}`, JSON.stringify(comments)) } catch {}
}
export function commentFeedback(comments: readonly ReviewComment[], heading: string): string {
  return `${heading}\n\n` + comments.map(comment => {
    const side = comment.range.side === 'deletions' ? 'before' : 'after'
    const endSide = (comment.range.endSide ?? comment.range.side) === 'deletions' ? 'before' : 'after'
    const location = side === endSide ? `${comment.range.start}-${comment.range.end} (${side})`
      : `${comment.range.start} (${side}) to ${comment.range.end} (${endSide})`
    const context = comment.localDiffHunk || ''
    const fence = '`'.repeat(Math.max(3, ...[...context.matchAll(/`+/g)].map(match => match[0].length + 1)))
    return `${comment.path}:${location}\n${comment.body}${context ? `\n\n${fence}diff\n${context}${fence}` : ''}`
  }).join('\n\n')
}
