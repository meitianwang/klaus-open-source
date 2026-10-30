export function questionShortcutIntent(event: {
  key: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean; isComposing?: boolean; keyCode?: number
}): 'submit-all' | 'advance' | null {
  if (event.key !== 'Enter' || event.isComposing || event.keyCode === 229 || event.altKey || event.shiftKey) return null
  return event.metaKey || event.ctrlKey ? 'submit-all' : 'advance'
}

/** A rejected transport response must keep both the pending question and its answers. */
export function createQuestionSubmissionController() {
  let state: { phase: 'pending' | 'submitting' | 'skipping' | 'submitted' | 'skipped'; failed: boolean } = { phase: 'pending', failed: false }
  const listeners = new Set<() => void>()
  let revision = 0
  const patch = (next: typeof state) => { state = next; listeners.forEach(listener => listener()) }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } },
    async send(action: () => unknown | Promise<unknown>, mode: 'submitted' | 'skipped'): Promise<boolean> {
      if (state.phase !== 'pending') return false
      const operation = ++revision
      patch({ phase: mode === 'submitted' ? 'submitting' : 'skipping', failed: false })
      try {
        const result = await action() as { ok?: boolean; error?: unknown } | undefined
        if (operation !== revision) return false
        if (result?.ok === false || result?.error) throw new Error('Question response failed')
        patch({ phase: mode, failed: false })
        return true
      } catch {
        if (operation === revision) patch({ phase: 'pending', failed: true })
        return false
      }
    },
    resolve(mode: 'submitted' | 'skipped') {
      revision++
      patch({ phase: mode, failed: false })
    },
  }
}
