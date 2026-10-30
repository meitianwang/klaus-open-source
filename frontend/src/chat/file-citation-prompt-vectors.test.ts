// Contract vectors for the citation grammar the reply prompt documents.
//
// The host prompt section teaches the model a specific way to cite a file, and
// the transcript renderer is the only thing that decides whether that form opens
// for the user or degrades to inert text. Neither side is derivable from the
// other: the renderer follows markdown's link grammar plus this repo's own
// location-suffix contract, and the prompt is prose. So each documented form is
// run through the REAL pipeline here — renderMarkdownHtml, the file-citation
// contract, and the chip's open path — and pinned against the committed vectors.
//
// The point of measuring rather than reasoning is that the plausible-sounding
// claims are the ones that were wrong. A prompt revision once asserted that
// commas cut a link destination short; they do not, and a comma path renders a
// working chip. The same revision asserted that a `~/…` citation resolves to the
// user's home; it resolves literally against the session workdir. Both are
// pinned below as measured facts, which is what keeps
// a confident paraphrase from replacing an observation.
//
// Assertion style: `expect` takes one argument, so the diagnostic context is the
// test NAME (one vector per test, name included) rather than a second parameter.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import vectors from '../../../contracts/vectors/file-citation-prompt-vectors.json'

interface Expectation {
  chip?: boolean
  anchor?: boolean
  code?: boolean
  literal?: boolean
  figure?: boolean
  player?: boolean
  kind?: string
  path?: string
  mediaPath?: string
  line?: number
  column?: number
  endLine?: number
  noLine?: boolean
  directiveConsumed?: boolean
  wrongFile?: boolean
}
interface FormVector { name: string; input: string; expect: Expectation; documentedBy: string | null; note?: string }
interface ResolutionVector {
  name: string; citedPath: string; workdir: string; opensPath: string; line?: number; documentedBy: string
}
interface OwnershipRule {
  name: string
  hostSectionHeader?: string
  hostMustSay?: string[]
  hostMustNotSay?: string[]
}

const typed = vectors as unknown as {
  citationForms: FormVector[]
  brokenForms: FormVector[]
  resolutionForms: ResolutionVector[]
  mediaForms: FormVector[]
  ownershipRules: OwnershipRule[]
}

// The render pipeline reads `window.klaus.media.url` for every local image and
// the chip's open path reads `window.klaus.session.getResolvedWorkdir`. Both are
// stubbed per-suite and the PREVIOUS global is restored afterwards: a window
// shim installed at module-collection time leaks into every other test file in
// the run, which is how unrelated suites start failing for no visible reason.
let previousWindow: unknown
const openedCalls: Array<{ path: string; location: unknown }> = []
const WORKDIR = '/Users/u/proj'

beforeAll(() => {
  previousWindow = (globalThis as any).window
  openedCalls.length = 0
  ;(globalThis as any).window = {
    addEventListener: () => {},
    currentLang: 'en',
    currentSessionId: 'vec-session',
    klausOpenWorkspaceFilePath: (path: string, location: unknown) => { openedCalls.push({ path, location }) },
    klaus: {
      media: {
        url: (path: string, sessionId?: string) =>
          `klaus-media://localhost/${Buffer.from(`${path}|${sessionId ?? ''}`).toString('base64url')}`,
      },
      session: { getResolvedWorkdir: async () => ({ workdir: WORKDIR }) },
    },
  }
})

afterAll(() => {
  ;(globalThis as any).window = previousWindow
})

const { renderMarkdownHtml } = await import('./markdown')
const { openFileCitation, openFileCitationFromElement } = await import('./file-citation-open')
const { parseFileCitation } = await import('../../../contracts/file-citation')

const attribute = (html: string, name: string): string | undefined =>
  new RegExp(`data-${name}="([^"]*)"`).exec(html)?.[1]

/** Everything one rendered form is claimed to do, checked against its HTML. */
function assertRendered(vector: FormVector): void {
  const html = renderMarkdownHtml(vector.input, 'vec-session')
  const expected = vector.expect

  if (expected.chip !== undefined) {
    expect(html.includes('class="md-file-citation"')).toBe(expected.chip)
  }
  if (expected.anchor !== undefined) {
    expect(html.includes('<a href=')).toBe(expected.anchor)
  }
  if (expected.code !== undefined) {
    expect(html.includes('<code')).toBe(expected.code)
  }
  if (expected.literal === true) {
    // Nothing consumed the source: the user reads the markdown back as text.
    expect(html).toContain(vector.input)
    const renderedSomething = html.includes('md-file-citation')
      || html.includes('md-media-figure')
      || html.includes('md-media-player')
    expect(renderedSomething).toBe(false)
  }
  if (expected.figure !== undefined) {
    expect(html.includes('md-media-figure')).toBe(expected.figure)
  }
  if (expected.player !== undefined) {
    expect(html.includes('md-media-player')).toBe(expected.player)
  }
  if (expected.kind !== undefined) {
    expect(attribute(html, 'media-kind')).toBe(expected.kind)
  }
  if (expected.path !== undefined) {
    expect(attribute(html, 'file-path')).toBe(expected.path)
  }
  if (expected.mediaPath !== undefined) {
    expect(attribute(html, 'media-path')).toBe(expected.mediaPath)
  }
  if (expected.line !== undefined) {
    expect(attribute(html, 'file-line')).toBe(String(expected.line))
  }
  if (expected.column !== undefined) {
    expect(attribute(html, 'file-column')).toBe(String(expected.column))
  }
  if (expected.endLine !== undefined) {
    expect(attribute(html, 'file-end-line')).toBe(String(expected.endLine))
  }
  if (expected.noLine === true) {
    expect(attribute(html, 'file-line')).toBeUndefined()
  }
  if (expected.directiveConsumed === true) {
    expect(html).not.toContain(':klaus-file-cite')
  }
  if (expected.wrongFile === true) {
    // The chip rendered, but the destination the link grammar produced is a
    // truncation of what was written — so it opens the wrong file.
    const cited = attribute(html, 'file-path') ?? ''
    expect(vector.input.includes(cited)).toBe(true)
    expect(cited.length < vector.input.length).toBe(true)
  }
}

describe('the citation grammar the reply prompt documents', () => {
  test('every documented form is backed by a measured vector', () => {
    const forms = [...typed.citationForms, ...typed.brokenForms, ...typed.mediaForms]
    expect(forms.length).toBeGreaterThan(20)
    for (const vector of forms) {
      expect(vector.name.length).toBeGreaterThan(0)
      expect(vector.input.length).toBeGreaterThan(0)
      // A null documentedBy is deliberate and means "measured, not documented":
      // it pins behavior the prompt intentionally does not claim.
      if (vector.documentedBy !== null) {
        expect(vector.documentedBy!.length).toBeGreaterThan(0)
      }
    }
  })

  for (const vector of typed.citationForms) {
    test(`citation: ${vector.name}`, () => assertRendered(vector))
  }

  for (const vector of typed.brokenForms) {
    test(`broken form: ${vector.name}`, () => assertRendered(vector))
  }

  for (const vector of typed.mediaForms) {
    test(`media: ${vector.name}`, () => assertRendered(vector))
  }
})

describe('where a cited path actually opens', () => {
  for (const vector of typed.resolutionForms) {
    test(vector.name, async () => {
      // The prompt's claim is about the file the user lands on, which is the
      // click path's resolution, not the rendered attribute.
      const citation = parseFileCitation(vector.citedPath)
      expect(citation).not.toBeNull()
      openedCalls.length = 0
      openFileCitation(vector.citedPath, vector.line, 'vec-session')
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(openedCalls.length).toBe(1)
      expect(openedCalls[0]!.path).toBe(vector.opensPath)
      if (vector.line !== undefined) {
        expect(openedCalls[0]!.location).toEqual({ line: vector.line })
      }
      expect(vector.workdir).toBe(WORKDIR)
    })
  }

  test('the ~/ resolution retains the literal segment instead of expanding the home directory', () => {
    const tilde = typed.resolutionForms.find(vector => vector.citedPath.startsWith('~/'))
    expect(tilde).toBeDefined()
    // The literal segment is measurable without assumptions about which files
    // exist on disk. Documenting it avoids an unintended home-directory claim.
    expect(tilde!.opensPath).toBe(`${WORKDIR}/${tilde!.citedPath}`)
    expect(tilde!.opensPath.includes('/~/')).toBe(true)
  })
})

describe('the vectors and the prompt cannot drift apart', () => {
  test('a documented form whose rendering contradicts its own note fails here', () => {
    // The range form renders both ends but the click path consumes only the
    // start line, which is exactly why the prompt documents no range form. If
    // that ever changes, this note becomes false and the vector must be edited
    // deliberately rather than left to mislead the next reader.
    const range = typed.citationForms.find(vector => vector.input.includes('#L12-L20'))
    expect(range).toBeDefined()
    expect(range!.note).toContain('click path')
    expect(range!.documentedBy).toBe('#L12 to cite a line')
    const html = renderMarkdownHtml(range!.input, 'vec-session')
    expect(attribute(html, 'file-line')).toBe('12')
    expect(attribute(html, 'file-end-line')).toBe('20')
    openedCalls.length = 0
    openFileCitationFromElement({ dataset: {
      filePath: attribute(html, 'file-path'),
      fileLine: attribute(html, 'file-line'),
      fileEndLine: attribute(html, 'file-end-line'),
      fileSession: 'vec-session',
    } } as unknown as HTMLElement)
    expect(openedCalls).toEqual([{ path: '/abs/path/service.ts', location: { line: 12 } }])
  })

  test('a column suffix opens at the recorded line without claiming editor column support', () => {
    const column = typed.citationForms.find(vector => vector.input.includes('#L12C3'))
    expect(column).toBeDefined()
    const html = renderMarkdownHtml(column!.input, 'vec-session')
    openedCalls.length = 0
    openFileCitationFromElement({ dataset: {
      filePath: attribute(html, 'file-path'),
      fileLine: attribute(html, 'file-line'),
      fileColumn: attribute(html, 'file-column'),
      fileSession: 'vec-session',
    } } as unknown as HTMLElement)
    expect(openedCalls).toEqual([{ path: '/abs/path/service.ts', location: { line: 12 } }])
  })

  test('the comma vector stays a measured-not-documented pin', () => {
    const comma = typed.citationForms.find(vector => vector.name.includes('comma'))
    expect(comma).toBeDefined()
    expect(comma!.documentedBy).toBeNull()
    expect(comma!.note).toContain('commas cut the link grammar short')
    expect(comma!.expect.chip).toBe(true)
  })
})
