import { describe, expect, test } from 'bun:test'
import { ByteBudgetLru, retainedBytes } from './byte-budget'
import { createStreamingMarkdownRenderer } from './markdown-streaming'
import { buildPipeline, cachedMarkdownHtml, createMarkdownMemoizer, forgetMarkdownSession, primeMarkdownHtml } from './markdown'

describe('bounded rendered content', () => {
  test('settled cache reads preserve rendering scope and retire with their session', () => {
    const source = '```ts\nconst cached = true\n```'
    primeMarkdownHtml(source, 'settled-owner-a', '<pre>Highlighted A</pre>')
    primeMarkdownHtml(source, 'settled-owner-b', '<pre>Highlighted B</pre>')
    expect(cachedMarkdownHtml(source, 'settled-owner-a')).toBe('<pre>Highlighted A</pre>')
    expect(cachedMarkdownHtml(source, 'settled-owner-b')).toBe('<pre>Highlighted B</pre>')
    expect(cachedMarkdownHtml(`${source}\nChanged`, 'settled-owner-a')).toBeUndefined()
    forgetMarkdownSession('settled-owner-a')
    expect(cachedMarkdownHtml(source, 'settled-owner-a')).toBeUndefined()
    expect(cachedMarkdownHtml(source, 'settled-owner-b')).toBe('<pre>Highlighted B</pre>')
    forgetMarkdownSession('settled-owner-b')
  })

  test('enforces byte limits independently of entry limits and preserves protected records', () => {
    const cache = new ByteBudgetLru<string, string>(20, 10)
    cache.set('protected', 'a', 16)
    cache.set('old', 'b', 16)
    expect(cache.trim(key => key === 'protected').map(([key]) => key)).toEqual(['old'])
    expect(cache.bytes).toBe(16)
    cache.set('new', 'c', 16)
    expect(cache.trim().map(([key]) => key)).toEqual(['protected'])
    expect(cache.get('new')).toBe('c')
    const cyclic: any = { text: 'hello' }; cyclic.self = cyclic
    expect(retainedBytes(cyclic)).toBeGreaterThan(10)
  })

  test('does not retain oversized HTML or duplicate every streamed prefix', () => {
    let calls = 0
    const cache = createMarkdownMemoizer(source => { calls++; return `<p>${source}</p>` }, 500, undefined, 512)
    for (let index = 1; index < 100; index++) cache('x'.repeat(index))
    expect(cache.stats().bytes).toBeLessThanOrEqual(512)
    cache('x'.repeat(1000)); cache('x'.repeat(1000))
    expect(calls).toBe(101)
    const renderer = createStreamingMarkdownRenderer(buildPipeline, 4096)
    let source = ''
    for (let index = 0; index < 100; index++) { source += `Paragraph ${index}.\n\n`; renderer.render(source, 'bytes', 'stream') }
    expect(renderer.stats().entries).toBeLessThanOrEqual(1)
    expect(renderer.stats().bytes).toBeLessThanOrEqual(4096)
    renderer.forget('bytes')
    expect(renderer.stats().bytes).toBe(0)
  })
})

describe('streaming document correctness', () => {
  const samples = [
    '# Heading\n\nFirst **bold** paragraph.\n\nSecond paragraph.',
    '- first\n\n- second\n\nEnd.',
    '> quote\n> continuation\n\nOutside.',
    '| A | B |\n| - | - |\n| 1 | 2 |\n\nAfter.',
    'Before.\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n\nAfter.',
    'Inline $x^2$ and $$y$$.\n\n$$\na + b\n\n+ c\n$$\n\nAfter.',
    '[reference][later]\n\nOther.\n\n[later]: https://example.com\n',
    ':klaus-file-cite[Result]{path="/tmp/a.ts#L3"}\n\nDone.',
    '<div>\n\nUntrusted <script>alert(1)</script>\n\n</div>',
  ]
  for (const [index, sample] of samples.entries()) test(`preserves complete HTML for streaming syntax case ${index}`, () => {
    const renderer = createStreamingMarkdownRenderer(buildPipeline)
    const expected = buildPipeline('syntax')
    for (let end = 1; end <= sample.length; end++) {
      const source = sample.slice(0, end)
      expect(renderer.render(source, 'syntax', String(index))).toBe(expected(source))
    }
    expect(renderer.render(sample, 'syntax', String(index), true)).toBe(expected(sample))
  })

  const nestedReferences = [
    { name: 'blockquote', definition: '> [label]: https://example.invalid\n', definesReference: true },
    { name: 'unordered list', definition: '- [label]: https://example.invalid\n', definesReference: true },
    { name: 'ordered list', definition: '1. [label]: https://example.invalid\n', definesReference: true },
    { name: 'escaped bracket label in a quote', reference: '[la\\]bel]', definition: '> [la\\]bel]: https://example.invalid\n', definesReference: true },
    { name: 'ordinary list continuation', definition: '- item\n  [label]: https://example.invalid\n', definesReference: false },
  ]
  for (const { name, definition, definesReference, reference = '[label]' } of nestedReferences) test(`preserves nested reference definitions in ${name} during every streamed character`, () => {
    const sample = reference + '\n\nA stable paragraph.\n\n' + definition
    const renderer = createStreamingMarkdownRenderer(buildPipeline)
    const expected = buildPipeline('nested-reference')
    expect(expected(sample).startsWith('<p><a href="https://example.invalid"')).toBe(definesReference)
    for (let end = 1; end <= sample.length; end++) {
      const source = sample.slice(0, end)
      expect(renderer.render(source, 'nested-reference', name)).toBe(expected(source))
    }
    expect(renderer.render(sample, 'nested-reference', name, true)).toBe(expected(sample))
  })

  test('reuses completed blocks and reparses edits without retaining previous versions', () => {
    const renderer = createStreamingMarkdownRenderer(buildPipeline)
    let source = ''
    let fullWork = 0
    for (let index = 0; index < 100; index++) {
      source += `Paragraph ${index}.\n\n`
      fullWork += source.length
      renderer.render(source, 'reuse', 'message')
    }
    expect(renderer.stats().parsedChars).toBeLessThan(fullWork / 5)
    expect(renderer.render('# Replacement', 'reuse', 'message')).toBe(buildPipeline('reuse')('# Replacement'))
  })
})
