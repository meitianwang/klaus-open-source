import { describe, expect, test } from 'bun:test'
import vectors from '../../../../contracts/vectors/created-thread-directive-vectors.json'
import { parseCreatedThreadDirective, CREATED_THREAD_ID_ATTRIBUTE, CREATED_THREAD_PREFIX } from '../../../../contracts/created-thread-directive'

type JsonObject = Record<string, unknown>
const cases = (key: 'accepts' | 'rejects' | 'markdownStructure'): JsonObject[] => vectors[key] as JsonObject[]

describe('the ::created-thread directive contract', () => {
  for (const vector of cases('accepts')) {
    test(`accepts: ${vector.name}`, () => {
      const directive = parseCreatedThreadDirective(String(vector.line))
      expect(directive).not.toBe(null)
      expect(directive?.threadId).toBe(vector.expectedThreadId)
      // The matched text is the trimmed line, so the renderer consumes exactly
      // what it recognized and leaves nothing half-parsed behind.
      expect(directive?.matched).toBe(String(vector.line).trim())
    })
  }

  for (const vector of cases('rejects')) {
    test(`rejects: ${vector.name}`, () => {
      // The over-long case carries a placeholder so the committed vector stays
      // readable; expand it to a real id past the 512 bound.
      const line = vector.name === 'an over-long id past the 512 bound'
        ? `::created-thread{threadId="${'a'.repeat(513)}"}`
        : String(vector.line)
      expect(parseCreatedThreadDirective(line)).toBe(null)
    })
  }

  test('an id of exactly 512 characters parses and 513 does not', () => {
    const at = `::created-thread{threadId="${'a'.repeat(512)}"}`
    const over = `::created-thread{threadId="${'a'.repeat(513)}"}`
    expect(parseCreatedThreadDirective(at)?.threadId).toHaveLength(512)
    expect(parseCreatedThreadDirective(over)).toBe(null)
  })

  test('a non-string input is refused rather than thrown on', () => {
    // The argument is model-authored text routed through textContent, which is
    // always a string, but the guard keeps a future caller from crashing.
    expect(parseCreatedThreadDirective(undefined as unknown as string)).toBe(null)
    expect(parseCreatedThreadDirective(null as unknown as string)).toBe(null)
    expect(parseCreatedThreadDirective(42 as unknown as string)).toBe(null)
  })

  test('the exported constants describe the syntax the regex accepts', () => {
    expect(CREATED_THREAD_PREFIX).toBe('::created-thread')
    expect(CREATED_THREAD_ID_ATTRIBUTE).toBe('threadId')
    // The single-attribute form is the whole contract; a second attribute name
    // appearing here would mean the parser and the prompt drifted apart.
    expect(parseCreatedThreadDirective(`${CREATED_THREAD_PREFIX}{${CREATED_THREAD_ID_ATTRIBUTE}="x"}`)?.threadId).toBe('x')
  })
})

/**
 * What the DOM hands the card pass.
 *
 * Two transforms, because the renderer reads `textContent` and not `innerHTML`:
 * `marked` HTML-escapes the directive's quotes into `&quot;`, which `textContent`
 * decodes back, and highlight.js wraps tokens in `<span>` elements, which
 * `textContent` concatenates without any markup. Emulating only the first would
 * test a string the real code path never sees — a fenced directive would look
 * absent here while the renderer still reads it as text.
 */
function textContentOf(fragment: string): string {
  return fragment
    .replace(/<[^>]*>/g, '')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&')
}

describe('the renderer only ever sees a standalone directive as a paragraph', () => {
  // These vectors assert the markdown structure the card pass relies on. It
  // replaces `<p>` elements whose ENTIRE decoded text is a directive, so a
  // directive inside a fence or an inline code span can never become a card:
  // marked puts those inside `<pre><code>` / `<code>`, and the pass queries `p`
  // only. Rendering here is DOM-free (marked emits a string), so no jsdom needed.
  for (const vector of cases('markdownStructure')) {
    test(`markdown: ${vector.name}`, async () => {
      ;(globalThis as Record<string, unknown>).window = { addEventListener: () => {}, currentLang: 'en', currentSessionId: 'probe' }
      const { renderMarkdownHtml } = await import('../markdown')
      const html = renderMarkdownHtml(String(vector.source))
      const directiveLine = String(vector.source).split('\n').map(line => line.trim()).find(line => line.startsWith('::created-thread'))
      const paragraphs = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map(match => textContentOf(match[1]).trim())
      const codes = [...html.matchAll(/<code[^>]*>([\s\S]*?)<\/code>/g)].map(match => textContentOf(match[1]).trim())

      if (vector.expectOwnParagraph === true) {
        // The exact line the renderer's query would match, character for character.
        expect(paragraphs).toContain(directiveLine)
        expect(parseCreatedThreadDirective(paragraphs.find(p => p.startsWith('::created-thread'))!)).not.toBe(null)
      } else {
        // No paragraph is the directive on its own, so the pass leaves the text alone.
        for (const paragraph of paragraphs) expect(parseCreatedThreadDirective(paragraph)).toBe(null)
      }
      if (vector.expectInsideCode === true) {
        expect(codes.some(code => code.includes('::created-thread'))).toBe(true)
      }
    })
  }
})
