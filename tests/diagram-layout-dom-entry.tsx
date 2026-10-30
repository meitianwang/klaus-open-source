import DiagramLayoutWorker from 'elkjs/lib/elk.bundled.js'
import workerUrl from 'elkjs/lib/elk-worker.min.js?url'

const originalWorker = window.Worker
const workers: { url: string; terminated: boolean }[] = []
window.Worker = class extends originalWorker {
  private readonly record: { url: string; terminated: boolean }
  constructor(url: string | URL, options?: WorkerOptions) {
    super(url, options)
    this.record = { url: new URL(String(url), location.href).href, terminated: false }
    workers.push(this.record)
  }
  terminate() { this.record.terminated = true; super.terminate() }
}

const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message) }
const graph = () => ({ id: 'root', children: [{ id: 'a', width: 40, height: 30, x: 0, y: 0 }, { id: 'b', width: 40, height: 30, x: 80, y: 60 }], edges: [{ id: 'ab', sources: ['a'], targets: ['b'] }] })

;(window as any).diagramLayoutReady = (async () => {
  const checks: string[] = []
  const { default: mermaid } = await import('mermaid')
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', suppressErrorRendering: true })
  const beforeDiagram = workers.length
  const flowchart = await mermaid.render('worker-flowchart', '---\nconfig:\n  layout: elk\n---\nflowchart LR\n A[API] --> B[Database]')
  check(flowchart.svg.includes('<svg') && flowchart.svg.includes('Database'), 'The ELK flowchart did not render')
  check(workers.length > beforeDiagram, 'The ELK flowchart did not create a real worker')
  checks.push('Mermaid ELK flowchart renders through the real worker')
  const architecture = await mermaid.render('offline-architecture', 'architecture-beta\n service api(server)[API]\n service db(database)[Database]\n api:R -- L:db')
  check(architecture.svg.includes('<svg') && architecture.svg.includes('Database'), 'The offline architecture diagram did not render')
  checks.push('Mermaid architecture renders with built-in offline icons')
  // The diagram creates its own adapter; release it before counting API workers.
  await new Promise(resolve => setTimeout(resolve, 5_200))
  check(workers.every(worker => worker.terminated), 'The diagram worker remained active')
  workers.length = 0
  const engine = new DiagramLayoutWorker()
  try {
    const callback = () => 42
    const element = document.createElement('div')
    const metadata = { callback, element }
    const opaque = graph() as any
    opaque.renderer = metadata
    opaque.children[0].renderer = metadata
    opaque.rendererGraph = opaque
    const point = { x: 0, y: 0, renderer: metadata }
    opaque.edges[0].sourcePoint = point
    opaque.edges[0].sections = [{ id: 'ab_s0', startPoint: { x: 0, y: 0, renderer: metadata }, endPoint: { x: 10, y: 10, renderer: metadata }, bendPoints: [{ x: 5, y: 5, renderer: metadata }] }]
    const originalChild = opaque.children[0]
    const originalOptions = { 'elk.algorithm': 'layered' }
    const opaqueResult = await engine.layout(opaque, { layoutOptions: originalOptions }) as any
    check(opaqueResult === opaque && opaqueResult.children[0] === originalChild, 'Layout changed graph identities')
    check(opaqueResult.renderer === metadata && opaqueResult.renderer.element === element && opaqueResult.children[0].renderer.callback === callback, 'Layout lost opaque renderer metadata')
    check(opaqueResult.edges[0].sourcePoint === point && point.renderer === metadata, 'Layout lost opaque point metadata')
    check(opaqueResult.rendererGraph === opaque && Number.isFinite(originalChild.x), 'Layout lost cycles or in-place coordinates')
    check(originalOptions['elk.algorithm'] === 'layered', 'Layout mutated caller arguments')
    checks.push('Opaque callback, DOM, cycle, child, and graph identities survive real-worker layout')
    const algorithms = await engine.knownLayoutAlgorithms()
    for (const algorithm of ['layered', 'stress', 'mrtree', 'radial', 'force', 'disco', 'sporeOverlap', 'sporeCompaction', 'rectpacking']) {
      check(algorithms.some(item => item.id === 'org.eclipse.elk.' + algorithm), algorithm + ' was not registered')
      const result = await engine.layout(graph(), { layoutOptions: { 'elk.algorithm': algorithm } })
      check(result.children?.length === 2 && result.children.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)), algorithm + ' did not produce coordinates')
      checks.push(algorithm + ' layout completed')
    }
    check((await engine.knownLayoutOptions()).length > 100, 'Layout option metadata is missing')
    check((await engine.knownLayoutCategories()).length > 0, 'Layout category metadata is missing')
    checks.push('Layout metadata methods retained')
    check(workers.length === 1 && workers[0].url === new URL(workerUrl, location.href).href, 'Unexpected worker URL')
    check(new URL(workers[0].url).origin === location.origin, 'Worker did not load from the app origin')
    check(!workers[0].url.startsWith('blob:'), 'Worker used a blob URL')
    checks.push('Worker loaded from a same-origin emitted asset under the page policy')
    await new Promise(resolve => setTimeout(resolve, 5_200))
    check(workers[0].terminated, 'Idle worker was not released')
    const resumed = await engine.layout(graph(), { layoutOptions: { 'elk.algorithm': 'layered' } })
    check(workers.length === 2 && resumed.children?.length === 2, 'Layout did not resume after idle release')
    checks.push('Idle worker released and recreated for the next request')
    const [options, concurrent] = await Promise.all([engine.knownLayoutOptions(), engine.layout(graph(), { layoutOptions: { 'elk.algorithm': 'layered' } })])
    check(options.length > 100 && concurrent.children?.length === 2 && !workers[1].terminated, 'Concurrent requests were interrupted')
    checks.push('Concurrent requests share an active worker without interruption')
    let rejected = false
    try { await engine.layout(undefined as any) } catch { rejected = true }
    check(rejected, 'Invalid layout input did not reject')
    await new Promise(resolve => setTimeout(resolve, 5_200))
    check(workers[1].terminated, 'Worker remained active after a rejected layout')
    checks.push('Invalid input rejected and idle worker released')
  } finally { engine.terminateWorker() }
  check(workers.every(worker => worker.terminated), 'Default worker was not terminated')
  checks.push('Default worker terminated')
  const defaults = { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT' }
  const mutable = new DiagramLayoutWorker({ defaultLayoutOptions: defaults })
  defaults['elk.direction'] = 'DOWN'
  try {
    const down = await mutable.layout(graph())
    check(down.children![0].y! < down.children![1].y!, 'Caller default option changes were ignored')
    ;(mutable as typeof mutable & { defaultLayoutOptions: Record<string, string> }).defaultLayoutOptions = { 'elk.algorithm': 'layered', 'elk.direction': 'RIGHT' }
    const right = await mutable.layout(graph())
    check(right.children![0].x! < right.children![1].x!, 'Replaced default options were ignored')
    checks.push('Caller default option updates and replacements affect later layouts')
  } finally { mutable.terminateWorker() }
  let factoryUrl: string | undefined
  const custom = new DiagramLayoutWorker({
    workerUrl,
    workerFactory: url => { factoryUrl = url; return new Worker(url!) },
    algorithms: ['layered'],
    defaultLayoutOptions: { 'elk.algorithm': 'layered', 'elk.direction': 'DOWN' },
  })
  try {
    const result = await custom.layout(graph())
    check(factoryUrl === workerUrl, 'Custom worker factory URL was changed')
    check(result.children![0].y! < result.children![1].y!, 'Default layout options were ignored')
    checks.push('Custom factory, URL, algorithm selection, and default options retained')
  } finally { custom.terminateWorker() }
  check(workers.every(worker => worker.terminated), 'A custom worker remained active')
  const interrupted = new DiagramLayoutWorker()
  void interrupted.knownLayoutOptions().catch(() => {})
  interrupted.terminateWorker()
  const replacement = await interrupted.layout(graph(), { layoutOptions: { 'elk.algorithm': 'layered' } })
  check(replacement.children?.length === 2, 'A terminated request prevented a replacement layout')
  await new Promise(resolve => setTimeout(resolve, 5_200))
  check(workers.every(worker => worker.terminated), 'A retired request prevented replacement cleanup')
  checks.push('Terminating an active generation does not prevent replacement work or idle cleanup')
  checks.push('Custom worker terminated')
  return { passed: checks.length, checks, workers }
})()
