// Transcript roots keep conversation identity across optimistic promotion.
// The host owns user scroll intent; each transcript owns its measured rows.
import { createRoot, type Root } from 'react-dom/client'
import { StaticTranscriptView, TranscriptView, type TranscriptScrollMode } from './TranscriptView'
import { getSessionStream } from '../stream-store'
import { captureTranscriptViewport } from './viewport-state'

const roots = new Map<HTMLElement, Root>()
const mountedSessions = new Map<HTMLElement, string>()
const mountedBindings = new Map<HTMLElement, { sessionId: string; renderKey: string; provisional: boolean; scroll: string; liveKeys: Set<string> }>()

export function mountReactTranscript(sessionId: string, container: HTMLElement, options: { scroll?: TranscriptScrollMode; readOnly?: boolean; contextSessionId?: string } = {}): void {
  const key = `${sessionId}:${options.scroll || 'none'}:${!!options.readOnly}:${options.contextSessionId || ''}`
  const stream = getSessionStream(sessionId)
  const liveKeys = new Set(stream.liveUnits.filter(unit => unit.type === 'live-user').map(unit => unit.key))
  const previous = mountedBindings.get(container)
  const sameSurface = previous?.scroll === (options.scroll || 'none')
  const promotion = previous?.provisional && [...liveKeys].some(value => previous.liveKeys.has(value))
  if (previous && previous.sessionId !== sessionId && !promotion) captureTranscriptViewport(container)
  const renderKey = previous && sameSurface && (previous.sessionId === sessionId || promotion) ? previous.renderKey : key
  mountedBindings.set(container, { sessionId, renderKey, provisional: stream.provisional, scroll: options.scroll || 'none', liveKeys })
  if (mountedSessions.get(container) === key) return
  mountedSessions.set(container, key)
  let root = roots.get(container)
  if (!root) {
    root = createRoot(container)
    roots.set(container, root)
  }
  const view = <TranscriptView key={renderKey} sessionId={sessionId} container={container} scroll={options.scroll || 'none'} readOnly={options.readOnly} contextSessionId={options.contextSessionId} />
  // Keep the scroll viewport and root owner stable. A single content block
  // bounds transcript layout and gives height observers a persistent target.
  root.render(options.scroll === 'main' ? <div data-klaus-transcript-content="">{view}</div> : view)
}

export function unmountReactTranscript(container: HTMLElement): void {
  captureTranscriptViewport(container)
  roots.get(container)?.unmount()
  roots.delete(container)
  mountedSessions.delete(container)
  mountedBindings.delete(container)
}

// 静态消息数组渲染（teammate/sub-agent 只读视图）：不订阅 store。running 是它渲染
// 的那个子会话还在不在跑（折叠判定要用），由持有子任务快照的宿主传入。
// 同容器重复调用复用同一个 root（只换 props），所以刷新不丢展开态。
export function mountStaticTranscript(
  msgs: any[],
  container: HTMLElement,
  options: { running?: boolean; sessionId?: string } = {},
): void {
  let root = roots.get(container)
  if (!root) {
    root = createRoot(container)
    roots.set(container, root)
  }
  mountedSessions.delete(container)
  mountedBindings.delete(container)
  root.render(
    <StaticTranscriptView
      msgs={msgs}
      container={container}
      running={!!options.running}
      sessionId={options.sessionId}
    />,
  )
}

;(window as any).__klausMountReactTranscript = mountReactTranscript
;(window as any).__klausUnmountReactTranscript = unmountReactTranscript
