export interface SpecReviewAnnotation {
  content: string
  comment: string
  startLine?: number | null
  endLine?: number | null
  path?: string
}

export interface SpecAnnotationHandle {
  peek(): SpecReviewAnnotation[]
  clear(): void
}

/** Keep a retryable copy when the resolved card detaches its selection surface. */
export function createSpecAnnotationDelivery(submit: (items: SpecReviewAnnotation[]) => boolean | Promise<boolean>) {
  let state = { items: [] as SpecReviewAnnotation[], sending: false, failed: false }
  let source: SpecAnnotationHandle | null = null
  const listeners = new Set<() => void>()
  const patch = (next: Partial<typeof state>) => {
    state = { ...state, ...next }
    listeners.forEach(listener => listener())
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    capture(handle: SpecAnnotationHandle | null) {
      if (!handle || state.sending) return
      source = handle
      patch({ items: handle.peek().map(item => ({ ...item })), failed: false })
    },
    async send(): Promise<boolean> {
      if (state.sending) return false
      if (!state.items.length) return true
      patch({ sending: true, failed: false })
      try {
        if (await submit(state.items.map(item => ({ ...item }))) !== true) throw new Error('Annotation delivery failed')
        source?.clear()
        source = null
        patch({ items: [], sending: false, failed: false })
        return true
      } catch {
        patch({ sending: false, failed: true })
        return false
      }
    },
  }
}
