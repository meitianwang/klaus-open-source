import { createMarkdownPipeline } from './markdown-pipeline'
import { resolveImageSrc } from './markdown-media'
import { fileIconName } from './file-icon-name'
import { createStreamingMarkdownRenderer } from './markdown-streaming'

let icons: Record<string, string> = {}
const renderer = createStreamingMarkdownRenderer(sessionId => createMarkdownPipeline(sessionId, {
  resolveImageSrc,
  fileIconSvg: path => icons[fileIconName(path)] ?? '',
}))
const scope = globalThis as unknown as {
  postMessage(value: unknown): void
  onmessage: ((event: MessageEvent) => void) | null
}
scope.onmessage = ({ data }) => {
  if (data.type === 'initialize') { icons = data.icons; return }
  if (data.type === 'retire') {
    renderer.forget(data.sessionId)
    scope.postMessage({ type: 'retired', retirementId: data.retirementId, stats: renderer.stats() })
    return
  }
  try {
    const html = renderer.render(data.source, data.sessionId, data.streamId, data.settled)
    scope.postMessage({ id: data.id, html, stats: renderer.stats() })
  } catch (error) {
    scope.postMessage({ id: data.id, error: error instanceof Error ? error.message : String(error) })
  }
}
