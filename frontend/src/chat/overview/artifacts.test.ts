import { describe, expect, test } from 'bun:test'

;(globalThis as any).window = { addEventListener() {} }

const { aggregateArtifactTurns, specArtifactDocuments, renderArtifactsSection } = await import('./artifacts')
const { setOverviewDeps } = await import('./shared')
const { publishEndResources } = await import('../end-resources')
const { tt } = await import('../../app/i18n')
type ArtifactTurn = import('./artifacts').ArtifactTurn

const turn = (turnId: string, files: ArtifactTurn['files']): ArtifactTurn => ({
  turnId,
  files,
  added: 0,
  removed: 0,
})

describe('artifact projections', () => {
  test('shows only this session’s distinct Spec documents', () => {
    const documents = [
      { sessionId: 's1', path: '/project/.klaus/specs/design.md', title: 'Design' },
      { sessionId: 's1', path: '/project/.klaus/specs/design.md', title: 'Renamed' },
      { sessionId: 's2', path: '/project/.klaus/specs/other.md', title: 'Other' },
      { sessionId: 's1', path: '', title: 'Missing path' },
    ]
    expect(specArtifactDocuments(documents, 's1')).toEqual([documents[0]])
    expect(specArtifactDocuments(documents, 's2')).toEqual([documents[2]])
    expect(specArtifactDocuments(documents, 'missing')).toEqual([])
    expect(specArtifactDocuments(documents, '')).toEqual([])
  })

  test('folds all turns into one conversation-wide file list', () => {
    const result = aggregateArtifactTurns([
      turn('turn-1', [
        { path: '/repo/a.ts', relativePath: 'a.ts', name: 'a.ts', kind: 'create', added: 10, removed: 0, turnDiff: null },
        { path: '/repo/b.ts', relativePath: 'b.ts', name: 'b.ts', kind: 'modify', added: 2, removed: 1, turnDiff: null },
      ]),
      turn('turn-2', [
        { path: '/repo/a.ts', relativePath: 'a.ts', name: 'a.ts', kind: 'modify', added: 3, removed: 2, turnDiff: null },
        { path: '/repo/c.ts', relativePath: 'c.ts', name: 'c.ts', kind: 'delete', added: 0, removed: 5, turnDiff: null },
      ]),
    ])

    expect(result.files).toEqual([
      { path: '/repo/a.ts', relativePath: 'a.ts', name: 'a.ts', kind: 'create', added: 13, removed: 2, turnDiff: null },
      { path: '/repo/b.ts', relativePath: 'b.ts', name: 'b.ts', kind: 'modify', added: 2, removed: 1, turnDiff: null },
      { path: '/repo/c.ts', relativePath: 'c.ts', name: 'c.ts', kind: 'delete', added: 0, removed: 5, turnDiff: null },
    ])
    expect(result.added).toBe(15)
    expect(result.removed).toBe(8)
  })

  test('keeps unknown line counts unknown across the conversation', () => {
    const result = aggregateArtifactTurns([
      turn('turn-1', [
        { path: '/repo/a.ts', relativePath: 'a.ts', name: 'a.ts', kind: 'modify', added: 2, removed: 1, turnDiff: null },
      ]),
      turn('turn-2', [
        { path: '/repo/a.ts', relativePath: 'a.ts', name: 'a.ts', kind: 'delete', added: null, removed: null, turnDiff: null },
      ]),
    ])

    expect(result.files[0]).toMatchObject({ kind: 'delete', added: null, removed: null })
    expect(result.added).toBeNull()
    expect(result.removed).toBeNull()
  })

  test('derives file kind from the session start and final state', () => {
    const result = aggregateArtifactTurns([
      turn('turn-1', [
        { path: '/repo/existing.ts', relativePath: 'old/existing.ts', name: 'existing.ts', kind: 'delete', added: 0, removed: 5, turnDiff: null },
        { path: '/repo/new.ts', relativePath: 'new.ts', name: 'new.ts', kind: 'create', added: 3, removed: 0, turnDiff: null },
      ]),
      turn('turn-2', [
        { path: '/repo/existing.ts', relativePath: 'existing.ts', name: 'existing.ts', kind: 'create', added: 4, removed: 0, turnDiff: null },
        { path: '/repo/new.ts', relativePath: 'new.ts', name: 'new.ts', kind: 'delete', added: 0, removed: 3, turnDiff: null },
      ]),
      turn('turn-3', [
        { path: '/repo/new.ts', relativePath: 'src/new.ts', name: 'new.ts', kind: 'create', added: 6, removed: 0, turnDiff: null },
      ]),
    ])

    expect(result.files).toEqual([
      { path: '/repo/existing.ts', relativePath: 'existing.ts', name: 'existing.ts', kind: 'modify', added: 4, removed: 5, turnDiff: null },
      { path: '/repo/new.ts', relativePath: 'src/new.ts', name: 'new.ts', kind: 'create', added: 9, removed: 3, turnDiff: null },
    ])
  })
})


describe('output artifact surface', () => {
  test('lists every turn output once, newest turn first, and opens each without tooltips', async () => {
    function element(tag: string): any {
      const el: any = {
        tagName: tag.toUpperCase(), className: '', type: '', textContent: '', innerHTML: '',
        children: [], attributes: {}, listeners: {},
        setAttribute(name: string, value: string) { el.attributes[name] = value },
        append(...children: any[]) { el.children.push(...children) },
        appendChild(child: any) { el.children.push(child) },
        replaceChildren(...children: any[]) { el.children = children },
        addEventListener(name: string, fn: Function) { el.listeners[name] = fn },
      }
      return el
    }
    const body = element('div')
    const meta = element('span')
    const previousDocument = (globalThis as any).document
    const previousKlaus = (window as any).klaus
    const previousOpen = (window as any).klausOpenWorkspaceFilePath
    const requests: unknown[] = []
    let sessionId = 'output-artifact-session'
    ;(globalThis as any).document = {
      createElement: element,
      getElementById: (id: string) => id === 'monitor-artifacts-body' ? body : id === 'monitor-artifacts-count' ? meta : null,
    }
    ;(window as any).klaus = { browser: { openSite: async (request: unknown) => { requests.push(request); return { ok: true } } } }
    ;(window as any).klausOpenWorkspaceFilePath = (path: string) => requests.push({ file: path })
    setOverviewDeps({
      currentSessionId: () => sessionId,
      commandGroupKey: () => '', slashCommandDisplayName: () => '',
      specDocuments: () => [], subscribeSpecDocuments: () => () => {}, openSpecDocument: () => {},
    })
    try {
      publishEndResources(sessionId, [
        { turnId: 'turn-1', resources: [{ type: 'website', target: 'http://localhost:5173/' }] },
        { turnId: 'turn-2', resources: [{ type: 'file', path: '/work/out/report.pdf' }] },
        { turnId: 'turn-3', resources: [{ type: 'website', target: 'http://localhost:5173/' }] },
      ])
      renderArtifactsSection()
      expect(meta.textContent).toBe(`${tt('end_resource_outputs')} · 2`)
      expect(body.children).toHaveLength(1)
      const group = body.children[0]
      expect(group.children[0].textContent).toBe(`${tt('end_resource_outputs')} · 2`)
      const [site, file] = group.children[1].children
      expect(site.tagName).toBe('BUTTON')
      expect(site.attributes['data-kind']).toBe('website')
      expect(site.children[1].textContent).toBe('localhost:5173')
      expect(site.children[2].textContent).toBe(tt('end_resource_website_subtitle'))
      expect(file.attributes['data-kind']).toBe('output-file')
      expect(file.children[1].textContent).toBe('report.pdf')
      expect(file.children[2].textContent).toBe(tt('end_resource_output_file_type').replace('{extension}', 'PDF'))
      for (const row of [site, file]) {
        expect(row.attributes).not.toHaveProperty('title')
        expect(row.attributes).not.toHaveProperty('data-klaus-tip')
      }
      site.listeners.click()
      file.listeners.click()
      await Promise.resolve()
      expect(requests).toEqual([{ sessionId, url: 'http://localhost:5173/' }, { file: '/work/out/report.pdf' }])

      sessionId = 'unrelated-artifact-session'
      renderArtifactsSection()
      expect(meta.textContent).toBe('')
      expect(body.children).toHaveLength(1)
      expect(body.children[0].className).toBe('ctx-empty')
    } finally {
      publishEndResources('output-artifact-session', [])
      ;(globalThis as any).document = previousDocument
      ;(window as any).klaus = previousKlaus
      ;(window as any).klausOpenWorkspaceFilePath = previousOpen
    }
  })
})
