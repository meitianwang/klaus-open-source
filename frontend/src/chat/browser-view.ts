// Native browser pages paint and receive input in the host's WebContentsView.
// State replies still need the same task/revision filter as asynchronous frames.
import { BrowserFrameScope, type BrowserStateOwner } from './browser-frame-scope'

const scope = new BrowserFrameScope()

export function invalidateBrowserFrames(): void {
  scope.invalidate()
}

export function acceptBrowserViewState(state: BrowserStateOwner): boolean {
  const sessionId = (window as unknown as { currentSessionId?: string }).currentSessionId || 'manual'
  return scope.update(state, sessionId)
}
