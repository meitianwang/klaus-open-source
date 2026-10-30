// The local file-reference contract: destination shapes, location suffixes,
// and the playable-media extension sets the transcript renderer branches on.
import { describe, expect, test } from 'bun:test'
import { fileExtension, isLocalPathLikeHref, matchFileCiteDirective, parseFileCitation, parseFileCiteDirectives, playableMediaKind, splitLocationSuffix } from '../../../contracts/file-citation'

describe('isLocalPathLikeHref', () => {
  test('accepts the destination shapes a reply can carry', () => {
    for (const href of ['/abs/report.md', '~/notes/a.md', './rel.md', '../up/a.md', 'C:/work/a.md', '\\\\server\\share\\a.md', 'file:///abs/a.md']) {
      expect(isLocalPathLikeHref(href)).toBe(true)
    }
  })
  test('rejects ordinary URLs', () => {
    for (const href of ['https://example.com/a.md', 'mailto:x@y.z', '#anchor', '']) {
      expect(isLocalPathLikeHref(href)).toBe(false)
    }
  })
})

describe('splitLocationSuffix', () => {
  test('hash forms win over colon forms and keep the path intact', () => {
    expect(splitLocationSuffix('/a/b.ts#L12C3')).toEqual({ path: '/a/b.ts', location: { line: 12, column: 3 }, suffix: '#L12C3' })
    expect(splitLocationSuffix('/a/b.ts#L12C3-L14C9')).toEqual({ path: '/a/b.ts', location: { line: 12, column: 3, endLine: 14, endColumn: 9 }, suffix: '#L12C3-L14C9' })
    // A non-location hash stays part of the path text.
    expect(splitLocationSuffix('/a/b.md#section')).toEqual({ path: '/a/b.md#section', suffix: '' })
  })
  test('colon forms parse at the end only, so drive letters survive', () => {
    expect(splitLocationSuffix('/a/b.ts:12:3')).toEqual({ path: '/a/b.ts', location: { line: 12, column: 3 }, suffix: ':12:3' })
    expect(splitLocationSuffix('/a/b.ts:12-14')).toEqual({ path: '/a/b.ts', location: { line: 12, endLine: 14 }, suffix: ':12-14' })
    expect(splitLocationSuffix('C:/a/b.ts')).toEqual({ path: 'C:/a/b.ts', suffix: '' })
  })
})

describe('parseFileCitation', () => {
  test('resolves file URLs, including a Windows drive path', () => {
    expect(parseFileCitation('file:///abs/a.md#L4')).toEqual({ path: '/abs/a.md', citedPath: '/abs/a.md', location: { line: 4 } })
    expect(parseFileCitation('file:///C:/work/a.md')?.path).toBe('C:/work/a.md')
  })
  test('resolves relative and home shapes against the given roots', () => {
    expect(parseFileCitation('./docs/a.md', '/proj', '/home/u')).toEqual({ path: '/proj/docs/a.md', citedPath: './docs/a.md' })
    expect(parseFileCitation('~/a.md', '/proj', '/home/u')).toEqual({ path: '/home/u/a.md', citedPath: '~/a.md' })
    // Unresolvable relative keeps its raw text: the panel scope check is the refusal.
    expect(parseFileCitation('./a.md')?.path).toBe('./a.md')
  })
  test('refuses non-local destinations and credential-bearing URLs', () => {
    expect(parseFileCitation('https://example.com/a.md')).toBeNull()
    expect(parseFileCitation('file://user:pw@host/a.md')).toBeNull()
  })
})

describe('playableMediaKind', () => {
  test('audio and video extension sets', () => {
    expect(playableMediaKind('/a/b.mp3')).toBe('audio')
    expect(playableMediaKind('/a/b.MP4')).toBe('video')
    expect(playableMediaKind('/a/b.ogg')).toBe('audio')
    expect(playableMediaKind('/a/b.png')).toBeNull()
    expect(playableMediaKind('/a/b.mov')).toBe('video')
    expect(playableMediaKind('/a/b.m4v')).toBe('video')
    expect(fileExtension('/a/b.tar.gz')).toBe('gz')
  })
})

describe('file-cite directive parsing', () => {
  test('matches a directive at the start, quoted or bare path, extra attributes tolerated', () => {
    expect(matchFileCiteDirective(':klaus-file-cite{path="/a/b.md"}')?.directive).toEqual({ path: '/a/b.md' })
    expect(matchFileCiteDirective(':klaus-file-cite[Report]{path=/a/b.md} rest')?.directive).toEqual({ path: '/a/b.md', caption: 'Report' })
    expect(matchFileCiteDirective(':klaus-file-cite{purpose="output", path="/a/b.md"}')?.directive.path).toBe('/a/b.md')
    expect(matchFileCiteDirective(':klaus-file-cite{path="/a/b.md"}')?.length).toBe(':klaus-file-cite{path="/a/b.md"}'.length)
  })
  test('refuses a directive without a readable path, and text that merely contains the prefix', () => {
    expect(matchFileCiteDirective(':klaus-file-cite{purpose="output"}')).toBeNull()
    expect(matchFileCiteDirective(':klaus-file-cite')).toBeNull()
    expect(matchFileCiteDirective('plain :klaus-file-cite{path="/a/b.md"}')).toBeNull()
  })
  test('the whole-text scan finds every directive with exact offsets', () => {
    const text = 'wrote :klaus-file-cite[Draft]{path="/a/b.md"} and :klaus-file-cite{path="/c/d.md"} done'
    const found = parseFileCiteDirectives(text)
    expect(found.map(item => item.path)).toEqual(['/a/b.md', '/c/d.md'])
    expect(text.slice(found[0]!.start, found[0]!.end)).toBe(':klaus-file-cite[Draft]{path="/a/b.md"}')
    expect(parseFileCiteDirectives('no directive here')).toEqual([])
  })
})
