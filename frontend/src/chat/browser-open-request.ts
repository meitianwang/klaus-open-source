import type { BrowserUseOpenRequest } from '../../bridge/types'

export interface BrowserOpenSurface {
  sessionId: string | null
  visible: boolean
  generation: number
}

/** A scoped open may finish only in the visible task that received it. */
export function browserOpenGuard(request: BrowserUseOpenRequest | undefined, read: () => BrowserOpenSurface): () => boolean {
  if (request?.sessionId === undefined) return () => true
  const generation = read().generation
  return () => {
    const surface = read()
    return request.sessionId !== '' && surface.sessionId === request.sessionId
      && surface.visible && surface.generation === generation
  }
}
