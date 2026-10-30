const target = window as unknown as Record<string, unknown>

target.editorAssetsReady = (async () => {
  const results: Array<{ name: string; detail?: unknown }> = []
  target.editorAssetsProgress = results
  const requests: string[] = []
  const violations: string[] = []
  const workers: Array<{ url: string; terminated: boolean }> = []
  const assert: (condition: unknown, message: string) => asserts condition = (condition, message) => {
    if (!condition) throw new Error(message)
  }
  const fetchResource = window.fetch.bind(window)
  window.fetch = (input, init) => {
    requests.push(new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, location.href).href)
    return fetchResource(input, init)
  }
  document.addEventListener('securitypolicyviolation', event => violations.push(`${event.violatedDirective}: ${event.blockedURI}`))
  const NativeWorker = window.Worker
  window.Worker = class extends NativeWorker {
    private readonly record: { url: string; terminated: boolean }
    constructor(url: string | URL, options?: WorkerOptions) {
      super(url, options)
      this.record = { url: String(url), terminated: false }
      workers.push(this.record)
    }
    override terminate() { this.record.terminated = true; super.terminate() }
  }

  try {
    const { bundledLanguages, createHighlighter, createJavaScriptRegexEngine } = await import('shiki')
    assert(requests.length === vectors.eagerGrammarRequests, 'Importing the highlighter must not preload language data')
    const modules = await Promise.all([
      bundledLanguages.cpp(), bundledLanguages['emacs-lisp'](), bundledLanguages.elisp(),
    ])
    const [cpp, lisp, alias] = modules.map(module => Array.isArray(module) ? module : module.default)
    assert(cpp.some(language => language.name === 'cpp') && cpp.some(language => language.name === 'glsl'), 'C++ keeps its embedded language registrations')
    assert(lisp.some(language => language.name === 'emacs-lisp'), 'The complete Emacs Lisp grammar remains available')
    assert(JSON.stringify(alias) === JSON.stringify(lisp), 'Language aliases resolve to the same registrations')
    assert([...cpp, ...lisp].every(Object.isFrozen), 'Language registrations remain immutable')
    results.push({ name: 'Lazy language data preserves embedded grammars, aliases and immutability', detail: { requests: requests.length } })

    const highlighter = await createHighlighter({
      themes: ['github-light'], langs: ['cpp', 'emacs-lisp'], engine: createJavaScriptRegexEngine(),
    })
    try {
      for (const { language, source, keyword, keywordColor } of vectors.highlighting) {
        const tokens = highlighter.codeToTokens(source, { lang: language, theme: 'github-light' }).tokens.flat()
        assert(tokens.some(token => token.content.includes(keyword) && token.color === keywordColor), `${language} retains keyword highlighting`)
        assert(new Set(tokens.map(token => token.color)).size > 1, `${language} retains distinct token styles`)
      }
      assert(!requests.some(url => new URL(url).pathname.endsWith('.wasm')), 'The JavaScript engine does not fetch an unused binary engine')
      results.push({ name: 'C++ and Emacs Lisp highlight under the production script policy' })
    } finally { highlighter.dispose() }

    const parser = await import('@mermaid-js/parser')
    const pie = await parser.parse('pie', 'pie\n"Tea": 42\n"Coffee": 58')
    assert(parser.isPie(pie) && pie.sections[0]?.value === 42, 'The pie parser retains numeric sections')
    const architecture = await parser.parse('architecture', 'architecture-beta\nservice db(database)[Database]\nservice api(server)[API]\napi:R --> L:db')
    assert(architecture.services.length === 2 && architecture.edges.length === 1, 'The architecture parser retains services and edges')
    const railroad = await parser.parse('railroadPeg', 'railroad-peg-beta\nrule <- "text";')
    assert(railroad.rules.length === 1, 'The railroad parser retains grammar rules')
    const radar = await parser.parse('radar', 'radar-beta\naxis a["A"], b["B"]\ncurve c["C"]{1, 2}')
    assert(radar.axes.length === 2, 'The radar parser retains axes')
    let invalidRejected = false
    try { await parser.parse('pie', '') } catch { invalidRejected = true }
    assert(invalidRejected, 'Invalid diagrams retain parser errors')
    results.push({ name: 'Split parser modules preserve diagram families and invalid-input errors' })

    const { default: mermaid } = await import('mermaid')
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true })
    const workersBeforeDiagram = workers.length
    const diagram = await mermaid.render('dependency-diagram', '---\nconfig:\n  layout: elk\n---\nflowchart TD\n  start[Start] --> done[Done]')
    assert(diagram.svg.includes('<svg') && diagram.svg.includes('Start') && diagram.svg.includes('Done'), 'Mermaid renders a complete diagram')
    assert(workers.length > workersBeforeDiagram, 'Mermaid itself executes layout in a real dedicated worker')
    const host = document.createElement('div')
    host.innerHTML = diagram.svg
    document.body.append(host)
    results.push({ name: 'Mermaid renders through the emitted layout worker', detail: { svgBytes: diagram.svg.length } })

    const architectureDiagram = await mermaid.render('dependency-architecture', 'architecture-beta\nservice a(server)[Start]\nservice b(database)[Done]\na:R --> L:b')
    assert(architectureDiagram.svg.includes('<svg') && architectureDiagram.svg.includes('Start'), 'Mermaid renders the architecture diagram')
    const architectureHost = document.createElement('div')
    architectureHost.innerHTML = architectureDiagram.svg
    document.body.append(architectureHost)
    results.push({ name: 'Mermaid architecture rendering retains its diagram backend' })

    const { default: ELK } = await import('elkjs/lib/elk.bundled.js')
    const layout = new ELK()
    try {
      const algorithms = await layout.knownLayoutAlgorithms()
      assert(algorithms.length >= vectors.minimumLayoutAlgorithms && algorithms.some(algorithm => algorithm.id === 'org.eclipse.elk.layered'), 'The full layout algorithm registry is available')
      const graph = await layout.layout({
        id: 'root', layoutOptions: { 'elk.algorithm': 'layered' },
        children: [{ id: 'start', width: 40, height: 30 }, { id: 'end', width: 40, height: 30 }],
        edges: [{ id: 'edge', sources: ['start'], targets: ['end'] }],
      })
      assert(graph.children?.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)), 'The worker computes node positions')
      assert(graph.edges?.[0]?.sections?.length, 'The worker computes edge routing')
      assert(workers.length > 0, 'Layout executes in a real dedicated worker')
      results.push({ name: 'A same-origin worker preserves layout algorithms and edge routing', detail: { algorithms: algorithms.length, workers: workers.length } })
    } finally { layout.terminateWorker() }
    assert(workers.some(worker => worker.terminated), 'Explicit shutdown releases the layout worker')
    const idleDeadline = Date.now() + vectors.workerIdleReleaseMs + 5_000
    while (workers.some(worker => !worker.terminated) && Date.now() < idleDeadline) await new Promise(resolve => setTimeout(resolve, 50))
    assert(workers.every(worker => worker.terminated), 'Idle diagram renderers release their layout workers')
    assert(workers.every(worker => new URL(worker.url, location.href).origin === location.origin), 'Workers stay on the application origin')
    assert(requests.every(url => new URL(url).origin === location.origin), 'Dependency resources load offline from the application origin')
    assert(violations.length === 0, `The existing content policy remains sufficient: ${violations.join('; ')}`)
    results.push({ name: 'Dependency assets keep same-origin loading, worker cleanup and the existing CSP' })
    target.editorAssetsResults = { passed: results.length, results, requests, workers }
  } catch (error) {
    target.editorAssetsError = error instanceof Error ? error.stack ?? error.message : String(error)
    throw error
  }
})()
import vectors from '../contracts/vectors/editor-resource-loading.json'
