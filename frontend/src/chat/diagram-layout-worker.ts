import Elk, { type ELK, type ELKConstructorArguments, type ElkLayoutArguments, type ElkNode, type LayoutOptions } from 'elkjs/lib/elk-api.js'
import workerUrl from 'elkjs/lib/elk-worker.min.js?url'
import { projectLayoutGraph } from './diagram-layout-graph'

const IDLE_RELEASE_MS = 5_000

type WorkerState = {
  engine: ELK
  outstanding: number
  idleTimer?: ReturnType<typeof setTimeout>
}

/** Keep the complete layout engine off the renderer and release idle workers. */
export default class DiagramLayoutWorker implements ELK {
  defaultLayoutOptions: LayoutOptions
  private readonly options: ELKConstructorArguments
  private current: WorkerState | undefined

  constructor(options: ELKConstructorArguments = {}) {
    this.defaultLayoutOptions = options.defaultLayoutOptions ?? {}
    this.options = {
      ...options,
      ...(options.algorithms ? { algorithms: [...options.algorithms] } : {}),
      defaultLayoutOptions: this.defaultLayoutOptions,
      ...(options.workerFactory === undefined && options.workerUrl === undefined ? { workerUrl } : {}),
    }
  }

  private cancelIdleRelease(state: WorkerState) {
    if (state.idleTimer !== undefined) clearTimeout(state.idleTimer)
    state.idleTimer = undefined
  }

  private async request<T>(operation: (engine: ELK) => Promise<T>): Promise<T> {
    const state = this.current ??= { engine: new Elk({ ...this.options, defaultLayoutOptions: this.defaultLayoutOptions }), outstanding: 0 }
    this.cancelIdleRelease(state)
    state.outstanding++
    try { return await operation(state.engine) }
    finally {
      state.outstanding--
      // Diagram renderers may discard the API without calling terminateWorker.
      // Never interrupt a request; recreate the engine if a later burst arrives.
      if (state.outstanding === 0 && this.current === state) {
        state.idleTimer = setTimeout(() => {
          state.idleTimer = undefined
          if (state.outstanding === 0 && this.current === state) {
            state.engine.terminateWorker()
            this.current = undefined
          }
        }, IDLE_RELEASE_MS)
      }
    }
  }

  layout(graph: ElkNode, args?: ElkLayoutArguments) {
    return this.request(async engine => {
      if (!graph) return engine.layout(graph, args)
      const projected = projectLayoutGraph(graph)
      const layoutArgs = args?.layoutOptions === undefined ? { ...args, layoutOptions: this.defaultLayoutOptions } : args
      return projected.apply(await engine.layout(projected.graph, layoutArgs))
    })
  }

  knownLayoutAlgorithms() { return this.request(engine => engine.knownLayoutAlgorithms()) }
  knownLayoutOptions() { return this.request(engine => engine.knownLayoutOptions()) }
  knownLayoutCategories() { return this.request(engine => engine.knownLayoutCategories()) }

  terminateWorker() {
    if (!this.current) return
    this.cancelIdleRelease(this.current)
    this.current.engine.terminateWorker()
    this.current = undefined
  }
}
