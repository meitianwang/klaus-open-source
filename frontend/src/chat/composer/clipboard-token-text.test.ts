import { expect, test } from 'bun:test'
import { composerDocumentSchema as schema, composerTokenNode, snapshotComposerDocument } from './document-model'
import { composerTokenClipboardText } from './clipboard-token-text'
import { renderUserDocument } from '../transcript/user-document'

test('linked mentions preserve their authored label and target in plain clipboard text', () => {
  const value = '[Project skill](klaus:skill/review?path=%2Fproject%2FSKILL.md)'
  const token = { value, label: 'Project skill', data: { kind: 'skill', id: 'review' } }
  expect(composerTokenClipboardText(token)).toBe(value)
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [schema.text('use '), composerTokenNode(token)]))
  const rendered = renderUserDocument(snapshotComposerDocument(doc))!
  expect(rendered.plainText).toBe('use Project skill')
  expect(rendered.clipboardText).toBe(`use ${value}`)
  expect(rendered.html).toContain('data-klaus-document-token')
})

test('native file mentions copy the complete address rather than the displayed basename', () => {
  expect(composerTokenClipboardText({ value: '@"src/file.ts"', label: 'file.ts',
    data: { kind: 'file', path: '/workspace/src/file.ts', rel: 'src/file.ts' } })).toBe('/workspace/src/file.ts')
  expect(composerTokenClipboardText({ value: '@"folder/"', label: 'folder',
    data: { kind: 'folder', rel: 'nested/folder/' } })).toBe('nested/folder/')
})

test('quote previews and unresolved literal tokens remain readable', () => {
  expect(composerTokenClipboardText({ value: '\uFFFC', label: 'Quoted passage', data: { kind: 'selected-text' } })).toBe('Quoted passage')
  expect(composerTokenClipboardText({ value: '@legacy', label: 'Legacy', data: null })).toBe('Legacy')
})
