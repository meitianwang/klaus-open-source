export interface SpecAnnotation {
  content: string
  comment: string
  startLine?: number | null
  endLine?: number | null
  path?: string
  anchorText?: string
}

export interface SpecAnnotationHandle {
  count(): number
  peek(): SpecAnnotation[]
  clear(): void
  destroy(): void
}

/** Keep drafts until the composer accepts them, including edits made in flight. */
export async function submitSpecAnnotationDraft(handle: SpecAnnotationHandle, submit: (items: SpecAnnotation[]) => boolean | Promise<boolean>): Promise<boolean> {
  const items = handle.peek()
  const snapshot = JSON.stringify(items)
  if (!items.length || !await submit(items)) return false
  if (JSON.stringify(handle.peek()) === snapshot) handle.clear()
  return true
}
