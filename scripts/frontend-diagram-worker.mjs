import { fileURLToPath } from 'node:url'

/**
 * Keep the layout API in the renderer and its full layout engine in a worker.
 * @returns {import('vite').Plugin}
 */
export function frontendDiagramWorker() {
  const adapter = fileURLToPath(new URL('../frontend/src/chat/diagram-layout-worker.ts', import.meta.url))
  return {
    name: 'klaus:diagram-layout-worker',
    enforce: 'pre',
    config() {
      // The dependency optimizer must retain the same worker boundary in dev.
      return { optimizeDeps: { exclude: ['elkjs/lib/elk.bundled.js'] } }
    },
    resolveId(source) {
      if (source === 'elkjs/lib/elk.bundled.js') return adapter
    },
  }
}
