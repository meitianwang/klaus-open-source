import { describe, expect, test } from 'bun:test'
import { composerDocumentFromText, composerDocumentSchema as schema, composerTokenNode, snapshotComposerDocument } from '../composer/document-model'
import { renderUserDocument } from './user-document'

describe('submitted authored documents', () => {
  test('literal Markdown and command-looking prose remain literal', () => {
    const result = renderUserDocument(snapshotComposerDocument(composerDocumentFromText('**literal** /review @"src/file.ts"\n  spaced')))
    expect(result!.html).toBe('<p>**literal** /review @&quot;src/file.ts&quot;<br>  spaced</p>')
    expect(result!.plainText).toBe('**literal** /review @"src/file.ts"\n  spaced')
  })
  test('authored marks, lists, code and safe links retain their structure', () => {
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [schema.text('bold', [schema.marks.strong.create()]), schema.text(' link', [schema.marks.link.create({ href: 'https://example.com' })])]),
      schema.nodes.bullet_list.create(null, schema.nodes.list_item.create(null, schema.nodes.paragraph.create(null, schema.text('item')))),
      schema.nodes.code_block.create(null, schema.text('  a < b\n\tcode')),
    ])
    const result = renderUserDocument(snapshotComposerDocument(doc))!
    expect(result.html).toContain('<strong>bold</strong>')
    expect(result.html).toContain('<ul><li><p>item</p></li></ul>')
    expect(result.html).toContain('<pre><code>  a &lt; b\n\tcode</code></pre>')
    expect(result.html).toContain('href="https://example.com"')
    expect(result.plainText).not.toContain('**')
  })
  test('unsafe link schemes are inert text', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'java\nscript:x', 'tel:12345']) {
      const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('label', [schema.marks.link.create({ href })])))
      expect(renderUserDocument(snapshotComposerDocument(doc))!.html).toBe('<p>label</p>')
    }
  })
  test('protocol-relative web links use an explicit supported destination', () => {
    const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('Site', [schema.marks.link.create({ href: '//example.com/page' })])))
    expect(renderUserDocument(snapshotComposerDocument(doc))!.html).toContain('href="https://example.com/page"')
  })
  test('each repeated atom reaches the renderer with its own identity and position', () => {
    const first = { value: '@device-one', label: 'Device', data: { kind: 'device', id: 'one' } }
    const second = { value: '@device-two', label: 'Device', data: { kind: 'device', id: 'two' } }
    const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [composerTokenNode(first), schema.text(' between '), composerTokenNode(second)]))
    const ids: string[] = []
    const result = renderUserDocument(snapshotComposerDocument(doc), token => { ids.push((token.data as { id: string }).id); return `<span>${token.label}</span>` })!
    expect(ids).toEqual(['one', 'two'])
    expect(result.html).toContain(' between ')
    expect(result.html.match(/data-klaus-document-token=/g)).toHaveLength(2)
    expect(result.html).toContain('&quot;id&quot;:&quot;one&quot;')
    expect(result.html).toContain('&quot;id&quot;:&quot;two&quot;')
    expect(result.plainText).toBe('Device between Device')
  })
  test('malformed persisted documents use the legacy fallback', () => {
    expect(renderUserDocument(undefined)).toBeNull()
    expect(renderUserDocument({ version: 1, content: { type: 'unavailable' } })).toBeNull()
  })
})
